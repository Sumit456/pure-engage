import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database, MessageChannel, PushContent, Template, TemplateChannel, TemplateContent, WhatsAppContent } from '../db/schema.ts';
import { badRequest, notFound } from '../errors.ts';
import { audit, type Actor } from './audit.ts';
import { validateContent } from './rendering.ts';

// `design` is the visual builder's block list; the builder turns it into `html`, which is what gets rendered and sent.
const design = z.object({ version: z.literal(1), blocks: z.array(z.record(z.unknown())).max(100) }).passthrough()
  .refine((d) => JSON.stringify(d).length <= 200_000, 'design is too large');
const emailPart = z.object({ subject: z.string().trim().min(1).max(300), html: z.string().min(1).max(500_000), text: z.string().max(200_000).optional(), design: design.optional() });
const smsPart = z.object({ body: z.string().trim().min(1).max(1600) });
const deepLink = z.string().trim().max(2000).regex(/^[a-z][a-z0-9+.-]*:\/\/\S+$/i, 'deep_link must be a URL or app link, e.g. pura://appointments');
const pushPart = z.object({
  title: z.string().trim().min(1).max(100),
  body: z.string().trim().min(1).max(500),
  image_asset_id: z.string().uuid().optional(),
  deep_link: deepLink.optional(),
  data: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/), z.string().max(500)).refine((d) => Object.keys(d).length <= 10, 'at most 10 data keys').optional(),
});
const waButton = z.discriminatedUnion('type', [
  z.object({ type: z.literal('quick_reply'), text: z.string().trim().min(1).max(25) }),
  z.object({ type: z.literal('url'), text: z.string().trim().min(1).max(25), url: z.string().trim().url().max(2000).refine((u) => /^https:\/\//.test(u), 'URL buttons must use https') }),
  z.object({ type: z.literal('call'), text: z.string().trim().min(1).max(25), phone: z.string().regex(/^\+[1-9]\d{6,14}$/, 'phone must be E.164') }),
]);
const whatsappPart = z.object({
  header: z.object({ type: z.enum(['none', 'text', 'image', 'video', 'document']), text: z.string().trim().max(60).optional(), asset_id: z.string().uuid().optional() })
    .refine((h) => h.type !== 'text' || !!h.text, 'A text header needs text')
    .refine((h) => !['image', 'video', 'document'].includes(h.type) || !!h.asset_id, 'Choose a file for the header'),
  body: z.string().trim().min(1).max(1024),
  footer: z.string().trim().max(60).optional(),
  buttons: z.array(waButton).max(3).default([]),
  category: z.enum(['marketing', 'utility']).default('marketing'),
  approval: z.enum(['draft', 'submitted', 'approved', 'rejected']).default('draft'),
});
const tags = z.array(z.string().trim().min(1).max(40)).max(20).transform((t) => [...new Set(t.map((x) => x.toLowerCase()))]);
const meta = { name: z.string().trim().min(1).max(200), purpose: z.enum(['care', 'marketing']), description: z.string().max(1000).default(''), folder_id: z.string().uuid().nullable().optional(), tags: tags.optional() };
const localized = <T extends z.ZodTypeAny>(part: T) => z.object({ en: part, ar: part.optional() });

export const templateInputSchema = z.discriminatedUnion('channel', [
  z.object({ channel: z.literal('email'), ...meta, content: localized(emailPart) }),
  z.object({ channel: z.literal('sms'), ...meta, content: localized(smsPart) }),
  z.object({ channel: z.literal('push'), ...meta, content: localized(pushPart) }),
  z.object({ channel: z.literal('whatsapp'), ...meta, content: localized(whatsappPart) }),
]);
export const templateUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  purpose: z.enum(['care', 'marketing']).optional(),
  folder_id: z.string().uuid().nullable().optional(),
  tags: tags.optional(),
  content: z.unknown().optional(),
});

const PARTS = { email: emailPart, sms: smsPart, push: pushPart, whatsapp: whatsappPart } as const;
const contentSchemaFor = (channel: Template['channel']) => localized(PARTS[channel]);

/** Files that push and WhatsApp content point at must exist and be the right kind. */
async function checkAssets(db: Kysely<Database>, channel: TemplateChannel, content: TemplateContent) {
  for (const [locale, part] of Object.entries(content)) {
    if (!part) continue;
    const wanted: { id: string; kind: string; path: string }[] = [];
    if (channel === 'push' && (part as PushContent).image_asset_id) wanted.push({ id: (part as PushContent).image_asset_id!, kind: 'image', path: `content.${locale}.image_asset_id` });
    if (channel === 'whatsapp') {
      const h = (part as WhatsAppContent).header;
      if (h.asset_id && h.type !== 'none' && h.type !== 'text') wanted.push({ id: h.asset_id, kind: h.type, path: `content.${locale}.header.asset_id` });
    }
    for (const w of wanted) {
      const a = await db.selectFrom('assets').select(['kind', 'content_type']).where('id', '=', w.id).executeTakeFirst();
      const ok = a && (w.kind === 'document' ? a.content_type === 'application/pdf' : a.kind === w.kind);
      if (!ok) throw badRequest('Choose a matching file from the library', [{ path: w.path, message: a ? `Must be ${w.kind === 'document' ? 'a PDF' : `an ${w.kind}`}` : 'File not found' }]);
    }
  }
}

/** Push and WhatsApp can be authored today; only email and SMS have delivery providers. */
export const isSendable = (c: TemplateChannel): c is MessageChannel => c === 'email' || c === 'sms';
export function assertSendable<T extends { channel: TemplateChannel }>(t: T): asserts t is T & { channel: MessageChannel } {
  if (!isSendable(t.channel)) throw badRequest(`${t.channel === 'push' ? 'Push' : 'WhatsApp'} messages can be authored but not sent yet`, [{ path: 'template_id', message: 'channel_not_available' }]);
}

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
      await checkAssets(db, data.channel, data.content as TemplateContent);
      const createdBy = actor.type === 'user' ? actor.id : null;
      const t = await db.transaction().execute(async (tx) => {
        const row = await tx.insertInto('templates').values({
          name: data.name, channel: data.channel, purpose: data.purpose, description: data.description, created_by: createdBy,
          folder_id: data.folder_id ?? null, tags: JSON.stringify(data.tags ?? []),
        }).returningAll().executeTakeFirstOrThrow();
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
        await checkAssets(db, current.channel, content);
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
          ...(data.folder_id !== undefined ? { folder_id: data.folder_id } : {}),
          ...(data.tags !== undefined ? { tags: JSON.stringify(data.tags) } : {}),
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
