// Segments: rule trees (packages/shared/src/segments.ts) compiled to parameterised SQL over `contacts`.
// Every user-supplied value, including attribute keys and event names, is a bound parameter.
import { sql, type Expression, type ExpressionBuilder, type Kysely, type SqlBool } from 'kysely';
import { segmentRulesSchema, type SegmentRule, type SegmentRules } from '@pure-engage/shared';
import type { Database } from '../db/schema.ts';
import { badRequest, notFound } from '../errors.ts';
import { audit, type Actor } from './audit.ts';

type EB = ExpressionBuilder<Database, 'contacts'>;

const NUMERIC = /^-?\d+(\.\d+)?$/;
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

export function parseRules(input: unknown): SegmentRules {
  const parsed = segmentRulesSchema.safeParse(input);
  if (!parsed.success) throw badRequest('Invalid segment rules', parsed.error.issues.map((i) => ({ path: `rules.${i.path.join('.')}`, message: i.message })));
  return parsed.data as SegmentRules;
}

function textCondition(eb: EB, col: Expression<unknown>, op: string, value: unknown): Expression<SqlBool> {
  const text = sql<string>`${col}::text`;
  const v = value === undefined || value === null ? '' : String(value);
  switch (op) {
    case 'eq': return sql<SqlBool>`lower(${text}) = lower(${v})`;
    case 'neq': return sql<SqlBool>`(${text} is null or lower(${text}) <> lower(${v}))`;
    case 'contains': return sql<SqlBool>`${text} ilike ${`%${likeEscape(v)}%`}`;
    case 'not_contains': return sql<SqlBool>`(${text} is null or ${text} not ilike ${`%${likeEscape(v)}%`})`;
    case 'starts_with': return sql<SqlBool>`${text} ilike ${`${likeEscape(v)}%`}`;
    case 'in': {
      const list = (Array.isArray(value) ? value : [value]).map((x) => String(x).toLowerCase());
      if (!list.length) return sql<SqlBool>`false`;
      return sql<SqlBool>`lower(${text}) = any(${list}::text[])`;
    }
    case 'exists': return sql<SqlBool>`(${text} is not null and ${text} <> '')`;
    case 'not_exists': return sql<SqlBool>`(${text} is null or ${text} = '')`;
    default: throw badRequest(`Operator "${op}" isn't valid here`);
  }
}

function compile(eb: EB, rule: SegmentRule, now: Date): Expression<SqlBool> {
  switch (rule.type) {
    case 'group': {
      if (!rule.rules.length) return sql<SqlBool>`${sql.raw(rule.op === 'and' ? 'true' : 'false')}`; // empty AND = everyone, empty OR = no one
      const parts = rule.rules.map((r) => compile(eb, r, now));
      return rule.op === 'and' ? eb.and(parts) : eb.or(parts);
    }
    case 'field': {
      const col = eb.ref(`contacts.${rule.field}`);
      if (rule.op === 'within_last_days' || rule.op === 'more_than_days_ago') {
        if (rule.field !== 'created_at') throw badRequest(`"${rule.op}" only applies to created_at`);
        const days = Number(rule.value);
        if (!Number.isInteger(days) || days < 0) throw badRequest('Days must be a whole number');
        const cutoff = sql`${now}::timestamptz - make_interval(days => ${days})`;
        return rule.op === 'within_last_days' ? sql<SqlBool>`${col} >= ${cutoff}` : sql<SqlBool>`${col} < ${cutoff}`;
      }
      return textCondition(eb, col, rule.op, rule.value);
    }
    case 'attribute': {
      const text = sql<string>`contacts.attributes ->> ${rule.key}`;
      if (rule.op === 'exists') return sql<SqlBool>`(contacts.attributes ? ${rule.key})`;
      if (rule.op === 'not_exists') return sql<SqlBool>`not (contacts.attributes ? ${rule.key})`;
      if (['gt', 'gte', 'lt', 'lte'].includes(rule.op)) {
        if (typeof rule.value !== 'number' && !NUMERIC.test(String(rule.value))) throw badRequest(`"${rule.op}" needs a number`);
        // Non-numeric values never match instead of making the query fail.
        const num = sql`(case when ${text} ~ ${NUMERIC.source} then (${text})::numeric end)`;
        const op = sql.raw({ gt: '>', gte: '>=', lt: '<', lte: '<=' }[rule.op as 'gt']);
        return sql<SqlBool>`${num} ${op} ${Number(rule.value)}`;
      }
      if (rule.op === 'eq' && typeof rule.value === 'number') {
        return sql<SqlBool>`(case when ${text} ~ ${NUMERIC.source} then (${text})::numeric end) = ${rule.value}`;
      }
      return textCondition(eb, text, rule.op, typeof rule.value === 'boolean' ? String(rule.value) : rule.value);
    }
    case 'consent': {
      const status = sql<string>`coalesce(contacts.consent -> ${rule.channel} ->> ${rule.purpose}, 'unknown')`;
      return sql<SqlBool>`${status} = ${rule.status}`;
    }
    case 'event': {
      let sub = eb.selectFrom('events').whereRef('events.contact_id', '=', 'contacts.id').where('events.name', '=', rule.name);
      if (rule.within_days) sub = sub.where('events.occurred_at', '>=', sql<Date>`${now}::timestamptz - make_interval(days => ${rule.within_days})`);
      if (rule.op === 'none') return eb.not(eb.exists(sub.select(sql`1`.as('one'))));
      if (rule.op === 'at_least' && rule.count <= 1) return eb.exists(sub.select(sql`1`.as('one')));
      const count = sub.select((e) => e.fn.countAll<number>().as('n'));
      return rule.op === 'at_least' ? sql<SqlBool>`(${count}) >= ${rule.count}` : sql<SqlBool>`(${count}) <= ${rule.count}`;
    }
  }
}

export function createSegmentsService(db: Kysely<Database>, clock: () => Date) {
  const where = (rules: SegmentRules) => (eb: EB) => compile(eb, rules, clock());

  async function getRow(id: string) {
    const s = await db.selectFrom('segments').selectAll().where('id', '=', id).executeTakeFirst();
    if (!s) throw notFound('Segment');
    return s;
  }

  async function count(rules: SegmentRules): Promise<number> {
    const { n } = await db.selectFrom('contacts').select((eb) => eb.fn.countAll<string>().as('n')).where(where(rules)).executeTakeFirstOrThrow();
    return Number(n);
  }

  return {
    where,
    count,
    get: getRow,

    async list() {
      const rows = await db.selectFrom('segments').selectAll().where('archived_at', 'is', null).orderBy('updated_at', 'desc').execute();
      return Promise.all(rows.map(async (s) => ({ ...s, size: await count(s.rules) })));
    },

    async preview(input: unknown) {
      const rules = parseRules(input);
      const [total, sample] = await Promise.all([
        count(rules),
        db.selectFrom('contacts').select(['id', 'external_id', 'first_name', 'last_name', 'email']).where(where(rules)).orderBy('updated_at', 'desc').limit(10).execute(),
      ]);
      return { count: total, sample };
    },

    async create(input: { name?: unknown; description?: unknown; rules?: unknown }, actor: Actor) {
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!name) throw badRequest('Name is required', [{ path: 'name', message: 'Required' }]);
      const rules = parseRules(input.rules);
      await count(rules); // proves it compiles and runs before saving
      const row = await db.insertInto('segments').values({
        name: name.slice(0, 200), description: typeof input.description === 'string' ? input.description.slice(0, 1000) : '',
        rules: JSON.stringify(rules), created_by: actor.type === 'user' ? actor.id : null, created_at: clock(), updated_at: clock(),
      }).returningAll().executeTakeFirstOrThrow();
      await audit(db, actor, { action: 'segment.create', entityType: 'segment', entityId: row.id });
      return row;
    },

    async update(id: string, input: { name?: unknown; description?: unknown; rules?: unknown }, actor: Actor) {
      await getRow(id);
      const set: Record<string, unknown> = { updated_at: clock() };
      if (typeof input.name === 'string' && input.name.trim()) set.name = input.name.trim().slice(0, 200);
      if (typeof input.description === 'string') set.description = input.description.slice(0, 1000);
      if (input.rules !== undefined) {
        const rules = parseRules(input.rules);
        await count(rules);
        set.rules = JSON.stringify(rules);
      }
      const row = await db.updateTable('segments').set(set).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await audit(db, actor, { action: 'segment.update', entityType: 'segment', entityId: id, details: { fields: Object.keys(set).filter((k) => k !== 'updated_at') } });
      return row;
    },

    async archive(id: string, actor: Actor) {
      await getRow(id);
      const inUse = await db.selectFrom('campaigns').select('id').where('segment_id', '=', id).where('status', 'in', ['scheduled', 'sending']).executeTakeFirst();
      if (inUse) throw badRequest('This segment is used by a scheduled or sending campaign');
      await db.updateTable('segments').set({ archived_at: clock(), updated_at: clock() }).where('id', '=', id).execute();
      await audit(db, actor, { action: 'segment.archive', entityType: 'segment', entityId: id });
    },

    /** Members in id order after `afterId`, for resumable batch processing. */
    async memberBatch(rules: SegmentRules, afterId: string | null, limit: number) {
      let q = db.selectFrom('contacts').selectAll().where(where(rules)).orderBy('id').limit(limit);
      if (afterId) q = q.where('id', '>', afterId);
      return q.execute();
    },
  };
}

export type SegmentsService = ReturnType<typeof createSegmentsService>;
