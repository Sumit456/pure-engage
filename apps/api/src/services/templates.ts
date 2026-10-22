import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database, Template, TemplateContent } from '../db/schema.ts';
import { notFound } from '../errors.ts';
import { audit, type Actor } from './audit.ts';
import { validateContent } from './rendering.ts';

const emailPart = z.object({ subject: z.string().trim().min(1).max(300), html: z.string().min(1).max(500_000), text: z.string().max(200_000).optional() });
const smsPart = z.object({ body: z.string().trim().min(1).max(1600) });

export const templateInputSchema = z.discriminatedUnion('channel', [
  z.object({ channel: z.literal('email'), name: z.string().trim().min(1).max(200), purpose: z.enum(['care', 'marketing']), description: z.string().max(1000).default(''), content: z.object({ en: emailPart, ar: emailPart.optional() }) }),
  z.object({ channel: z.literal('sms'), name: z.string().trim().min(1).max(200), purpose: z.enum(['care', 'marketing']), description: z.string().max(1000).default(''), content: z.object({ en: smsPart, ar: smsPart.optional() }) }),
]);
export const templateUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  purpose: z.enum(['care', 'marketing']).optional(),
  content: z.unknown().optional(),
});

const contentSchemaFor = (channel: Template['channel']) => (channel === 'email' ? z.object({ en: emailPart, ar: emailPart.optional() }) : z.object({ en: smsPart, ar: smsPart.optional() }));

export function createTemplatesService(db: Kysely<Database>) {
  async function getRow(id: string) {
    const t = await db.selectFrom('templates').selectAll().where('id', '=', id).executeTakeFirst();
    if (!t) throw notFound('Template');
    return t;
  }

  async function getVersion(id: string, version: number) {
    const v = await db.selectFrom('template_versions').selectAll().where('template_id', '=', id).where('version', '=', version).executeTakeFirst();
    if (!v) throw notFound('Template version');
    return v;
  }

  return {
    async list({ includeArchived = false } = {}) {
      let q = db.selectFrom('templates').selectAll().orderBy('updated_at', 'desc');
      if (!includeArchived) q = q.where('archived_at', 'is', null);
      return q.execute();
    },

    /** Template with its current version's content. */
    async get(id: string) {
      const t = await getRow(id);
      const v = await getVersion(id, t.current_version);
      return { ...t, content: v.content };
    },

    getVersion,

    async create(input: unknown, actor: Actor) {
      const data = templateInputSchema.parse(input);
      validateContent(data.channel, data.content as TemplateContent);
      const createdBy = actor.type === 'user' ? actor.id : null;
      const t = await db.transaction().execute(async (tx) => {
        const row = await tx.insertInto('templates').values({ name: data.name, channel: data.channel, purpose: data.purpose, description: data.description, created_by: createdBy }).returningAll().executeTakeFirstOrThrow();
        await tx.insertInto('template_versions').values({ template_id: row.id, version: 1, content: JSON.stringify(data.content), created_by: createdBy }).execute();
        await audit(tx, actor, { action: 'template.create', entityType: 'template', entityId: row.id });
        return row;
      });
      return { ...t, content: data.content as TemplateContent };
    },

    /** Metadata changes update in place; a content change creates a new version. */
    async update(id: string, input: unknown, actor: Actor) {
      const data = templateUpdateSchema.parse(input);
      const current = await getRow(id);
      let content: TemplateContent | undefined;
      if (data.content !== undefined) {
        content = contentSchemaFor(current.channel).parse(data.content) as TemplateContent;
        validateContent(current.channel, content);
      }
      return db.transaction().execute(async (tx) => {
        let version = current.current_version;
        if (content) {
          const latest = await tx.selectFrom('template_versions').select((eb) => eb.fn.max('version').as('max')).where('template_id', '=', id).executeTakeFirstOrThrow();
          version = Number(latest.max) + 1;
          await tx.insertInto('template_versions').values({ template_id: id, version, content: JSON.stringify(content), created_by: actor.type === 'user' ? actor.id : null }).execute();
        }
        const row = await tx.updateTable('templates').set({
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.description !== undefined ? { description: data.description } : {}),
          ...(data.purpose !== undefined ? { purpose: data.purpose } : {}),
          current_version: version,
          updated_at: new Date(),
        }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
        await audit(tx, actor, { action: 'template.update', entityType: 'template', entityId: id, details: { fields: Object.keys(data), version } });
        const v = await tx.selectFrom('template_versions').select('content').where('template_id', '=', id).where('version', '=', version).executeTakeFirstOrThrow();
        return { ...row, content: v.content };
      });
    },

    async versions(id: string) {
      await getRow(id);
      return db.selectFrom('template_versions').innerJoin('templates', 'templates.id', 'template_versions.template_id')
        .leftJoin('users', 'users.id', 'template_versions.created_by')
        .select(['template_versions.version', 'template_versions.created_at', 'users.email as created_by_email'])
        .where('template_versions.template_id', '=', id).orderBy('template_versions.version', 'desc').execute();
    },

    /** Restoring copies an old version forward as the newest one, so history is never rewritten. */
    async restore(id: string, version: number, actor: Actor) {
      const v = await getVersion(id, version);
      return this.update(id, { content: v.content }, actor);
    },

    async archive(id: string, actor: Actor) {
      await getRow(id);
      await db.updateTable('templates').set({ archived_at: new Date(), updated_at: new Date() }).where('id', '=', id).execute();
      await audit(db, actor, { action: 'template.archive', entityType: 'template', entityId: id });
    },
  };
}

export type TemplatesService = ReturnType<typeof createTemplatesService>;
