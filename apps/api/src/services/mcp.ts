// The MCP server an AI assistant talks to (POST /mcp). Tools are built per request from the caller's scopes, so an
// assistant only sees what it may use. It can read results and create drafts; there is deliberately no tool that
// sends, schedules or activates anything: a person does that in the console (ADR-0007).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  CHANNELS, CONTACT_FIELDS, DATE_OPS, EVENT_OPS, NUMBER_OPS, PURPOSES, TEXT_OPS,
  newBlock, renderEmailDesign, starterDesign, type ApiScope, type EmailBlock, type SegmentRules,
} from '@pure-engage/shared';
import type { DB } from '../db/index.ts';
import { HttpError, notFound } from '../errors.ts';
import { contactView } from './contact-view.ts';
import { audit, type Actor } from './audit.ts';
import type { Services } from './index.ts';

export const MCP_INSTRUCTIONS = `Pure Engage is a member engagement platform (email and SMS) for a UAE healthcare group.
- You can read results (campaigns, journeys, segments, reports, recent activity) and look up contacts.
- You can create drafts: segments, templates and draft campaigns. You cannot send, schedule or activate anything; tell the
  user to review the draft in the Pure Engage console and launch it there.
- Contact details are masked unless this connection was granted full personal details. Never ask for, repeat or guess
  personal health information; refer to members by their external ID where possible.
- Consent is per channel (email, sms) and purpose (care, marketing). Marketing needs explicit marketing consent; the
  platform enforces this when sending.`;

const condition = z.discriminatedUnion('type', [
  z.object({ type: z.literal('field'), field: z.enum(CONTACT_FIELDS), op: z.enum([...TEXT_OPS, ...DATE_OPS]), value: z.union([z.string(), z.number(), z.array(z.string())]).optional() }),
  z.object({ type: z.literal('attribute'), key: z.string().describe('Custom profile field name, e.g. city'), op: z.enum([...TEXT_OPS, ...NUMBER_OPS]), value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional() }),
  z.object({ type: z.literal('consent'), channel: z.enum(CHANNELS), purpose: z.enum(PURPOSES), status: z.enum(['granted', 'denied', 'unknown']) }),
  z.object({ type: z.literal('event'), name: z.string().describe('Event name, e.g. appointment.booked'), op: z.enum(EVENT_OPS), count: z.number().int().min(0).default(1), within_days: z.number().int().min(1).optional() }),
]);
const audienceShape = {
  match: z.enum(['all', 'any']).default('all').describe('all = every condition must hold; any = at least one'),
  conditions: z.array(condition).min(1).max(20),
};
const toRules = (a: { match: 'all' | 'any'; conditions: z.infer<typeof condition>[] }): SegmentRules => ({ type: 'group', op: a.match === 'all' ? 'and' : 'or', rules: a.conditions as SegmentRules['rules'] });

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

interface Ctx { services: Services; db: DB; scopes: ApiScope[]; actor: Actor; consoleUrl: string }

export function createMcpServer({ services, db, scopes, actor, consoleUrl }: Ctx): McpServer {
  const server = new McpServer({ name: 'pure-engage', title: 'Pure Engage', version: '1.0.0' }, { instructions: MCP_INSTRUCTIONS });
  const has = (s: ApiScope) => scopes.includes(s);
  const pii = has('contacts:read_pii');
  const link = (path: string) => `${consoleUrl.replace(/\/$/, '')}${path}`;
  // Validation and not-found errors go back to the assistant as tool errors it can act on; anything else is a bug.
  const safe = <A>(fn: (args: A) => Promise<ReturnType<typeof json>>) => async (args: A) => {
    try { return await fn(args); } catch (err) {
      if (err instanceof HttpError && err.statusCode < 500) return fail(`${err.message}${Array.isArray(err.details) ? `: ${err.details.map((d: { path?: string; message?: string }) => `${d.path ?? ''} ${d.message ?? ''}`.trim()).join('; ')}` : ''}`);
      if (err instanceof z.ZodError) return fail(err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      throw err;
    }
  };
  const read = { readOnlyHint: true, openWorldHint: false };
  const draft = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

  if (has('reports:read')) {
    server.registerTool('get_overview', {
      title: 'Engagement overview', annotations: read,
      description: 'Headline numbers for the last 30 days: contacts, consent coverage, messages sent, open and click rates, journey runs and campaigns sent.',
    }, safe(async () => json(await services.reports.overview())));

    server.registerTool('list_journeys', {
      title: 'Journeys and their runs', annotations: read,
      description: 'Every journey (automated flow) with its status and how many runs are active, completed or exited.',
    }, safe(async () => json(await services.reports.journeys())));

    server.registerTool('recent_activity', {
      title: 'Recent activity', annotations: read,
      description: 'The newest platform activity: message sends, opens and clicks, consent changes, journey entries and events. Labels only, no message content.',
      inputSchema: { limit: z.number().int().min(1).max(50).default(20), kinds: z.array(z.enum(['message', 'consent', 'journey', 'event'])).optional() },
    }, safe(async ({ limit, kinds }) => {
      const page = await services.activity.list({ limit, kinds });
      const initials = (name: string | null) => (name ? name.split(/\s+/).map((p) => `${p[0] ?? ''}.`).join(' ') : null);
      return json(page.data.map((i) => ({ ...i, contact: i.contact && { ...i.contact, name: pii ? i.contact.name : initials(i.contact.name) } })));
    }));
  }

  if (has('campaigns:read')) {
    server.registerTool('list_campaigns', {
      title: 'Campaigns', annotations: read,
      description: 'All campaigns with status, channel, audience, template and delivery stats (targeted, sent, opened, clicked, not sent and why).',
    }, safe(async () => json((await services.campaigns.list()).map((c) => ({
      id: c.id, name: c.name, status: c.status, channel: c.channel, purpose: c.purpose, template: c.template_name, segment: c.segment_name,
      scheduled_at: c.scheduled_at, completed_at: c.completed_at, stats: c.stats, console_url: link(`/campaigns/${c.id}`),
    })))));

    server.registerTool('get_campaign_report', {
      title: 'Campaign report', annotations: read,
      description: 'One campaign in detail: audience, template and delivery results.',
      inputSchema: { campaign_id: z.string().uuid() },
    }, safe(async ({ campaign_id }) => {
      const c = await services.campaigns.detail(campaign_id);
      return json({ id: c.id, name: c.name, status: c.status, template: c.template, segment: c.segment, scheduled_at: c.scheduled_at, completed_at: c.completed_at, stats: c.stats, console_url: link(`/campaigns/${c.id}`) });
    }));
  }

  if (has('campaigns:read') || has('drafts:write')) {
    server.registerTool('list_templates', {
      title: 'Message templates', annotations: read,
      description: 'Email and SMS templates (id, name, channel, purpose). Use a template id when drafting a campaign.',
    }, safe(async () => json((await services.templates.list()).map((t) => ({ id: t.id, name: t.name, channel: t.channel, purpose: t.purpose, updated_at: t.updated_at })))));
  }

  if (has('campaigns:read') || has('drafts:write')) {
    server.registerTool('list_content', {
      title: 'Content library', annotations: read,
      description: 'Browse the content library: emails, SMS, push and WhatsApp messages, content blocks and files (names, types and folders only).',
      inputSchema: { type: z.enum(['email', 'sms', 'push', 'whatsapp', 'block', 'image', 'document', 'video', 'audio']).optional(), q: z.string().max(100).optional(), limit: z.number().int().min(1).max(50).default(25) },
    }, safe(async ({ type, q, limit }) => {
      const [items, folders] = await Promise.all([services.content.list({ type, q, limit }), services.content.folders()]);
      const names = new Map(folders.map((f) => [f.id, f.name]));
      return json({ total: items.total, items: items.data.map((i) => ({ type: i.type, id: i.id, name: i.name, folder: i.folder_id ? names.get(i.folder_id) ?? null : null, tags: i.tags, updated_at: i.updated_at })) });
    }));
  }

  if (has('segments:read')) {
    server.registerTool('list_segments', {
      title: 'Segments', annotations: read,
      description: 'Saved audiences with their current size.',
    }, safe(async () => json((await services.segments.list()).map((s) => ({ id: s.id, name: s.name, description: s.description, size: s.size, rules: s.rules })))));

    server.registerTool('count_audience', {
      title: 'Count an audience', annotations: read,
      description: 'How many contacts match some conditions, without saving anything. Returns a number only.',
      inputSchema: audienceShape,
    }, safe(async (a) => json({ count: (await services.segments.preview(toRules(a))).count })));
  }

  if (has('contacts:read')) {
    server.registerTool('search_contacts', {
      title: 'Search contacts', annotations: read,
      description: `Find contacts by name, external ID, email or phone. ${pii ? 'Returns full details.' : 'Personal details are masked.'} Every lookup is audited.`,
      inputSchema: { query: z.string().min(2).max(100), limit: z.number().int().min(1).max(20).default(10) },
    }, safe(async ({ query, limit }) => {
      const page = await services.contacts.list({ q: query, limit });
      await audit(db, actor, { action: 'contact.search', entityType: 'contact', details: { via: 'mcp', results: page.data.length, pii } });
      return json(page.data.map((c) => contactView(c, pii)));
    }));

    server.registerTool('get_contact', {
      title: 'Get a contact', annotations: read,
      description: `One contact with consent and profile. ${pii ? 'Returns full details.' : 'Personal details are masked; only profile field names are shown.'} Audited as personal data access.`,
      inputSchema: { contact_id: z.string().uuid().optional(), external_id: z.string().optional(), email: z.string().email().optional() },
    }, safe(async (ref) => {
      if (!ref.contact_id && !ref.external_id && !ref.email) return fail('Give contact_id, external_id or email');
      const c = await services.contacts.findByRef(ref);
      if (!c) throw notFound('Contact');
      await audit(db, actor, { action: 'contact.view', entityType: 'contact', entityId: c.id, details: { via: 'mcp', pii } });
      return json({ ...contactView(c, pii), console_url: link(`/contacts/${c.id}`) });
    }));
  }

  if (has('drafts:write')) {
    server.registerTool('create_segment', {
      title: 'Save a segment', annotations: draft,
      description: 'Saves an audience definition (a filter, not a send). Check its size with count_audience first.',
      inputSchema: { name: z.string().min(1).max(200), description: z.string().max(1000).default(''), ...audienceShape },
    }, safe(async ({ name, description, ...a }) => {
      const s = await services.segments.create({ name, description, rules: toRules(a) }, actor);
      return json({ id: s.id, name: s.name, console_url: link(`/segments/${s.id}`) });
    }));

    server.registerTool('create_email_template', {
      title: 'Draft an email template', annotations: draft,
      description: 'Creates an email template built from blocks (heading, paragraphs, optional button) that a person can refine in the visual designer. Liquid such as {{ contact.first_name | default: \'there\' }} is allowed.',
      inputSchema: {
        name: z.string().min(1).max(200), purpose: z.enum(['care', 'marketing']),
        subject: z.string().min(1).max(300), heading: z.string().min(1).max(200),
        paragraphs: z.array(z.string().min(1).max(2000)).min(1).max(8).describe('Plain text; **bold**, *italic* and [link](https://…) are supported'),
        button: z.object({ label: z.string().min(1).max(60), url: z.string().url() }).optional(),
      },
    }, safe(async ({ name, purpose, subject, heading, paragraphs, button }) => {
      const base = starterDesign();
      const blocks: EmailBlock[] = [
        base.blocks[0]!,
        { ...newBlock('heading'), text: heading } as EmailBlock,
        ...paragraphs.map((p) => ({ ...newBlock('text'), text: p }) as EmailBlock),
        ...(button ? [{ ...newBlock('button'), label: button.label, href: button.url } as EmailBlock] : []),
        newBlock('footer'),
      ];
      const design = { ...base, blocks };
      const t = await services.templates.create({ name, channel: 'email', purpose, description: 'Drafted by an AI assistant', content: { en: { subject, html: renderEmailDesign(design), design } } }, actor);
      return json({ id: t.id, name: t.name, console_url: link(`/templates/${t.id}`), note: 'Review and edit it in the designer before using it in a campaign.' });
    }));

    server.registerTool('create_sms_template', {
      title: 'Draft an SMS template', annotations: draft,
      description: 'Creates an SMS template. Keep it under 160 characters (70 for Arabic) for a single segment.',
      inputSchema: { name: z.string().min(1).max(200), purpose: z.enum(['care', 'marketing']), body: z.string().min(1).max(1600) },
    }, safe(async ({ name, purpose, body }) => {
      const t = await services.templates.create({ name, channel: 'sms', purpose, description: 'Drafted by an AI assistant', content: { en: { body } } }, actor);
      return json({ id: t.id, name: t.name, console_url: link(`/templates/${t.id}`) });
    }));

    server.registerTool('create_push_draft', {
      title: 'Draft a push message', annotations: draft,
      description: 'Creates a push notification in the content library (authored only: push sending is not available yet). Title up to ~50 characters reads best on a lock screen.',
      inputSchema: { name: z.string().min(1).max(200), purpose: z.enum(['care', 'marketing']), title: z.string().min(1).max(100), body: z.string().min(1).max(500), deep_link: z.string().max(2000).optional().describe('App link such as pura://appointments') },
    }, safe(async ({ name, purpose, title, body, deep_link }) => {
      const t = await services.templates.create({ name, channel: 'push', purpose, description: 'Drafted by an AI assistant', content: { en: { title, body, ...(deep_link ? { deep_link } : {}) } } }, actor);
      return json({ id: t.id, name: t.name, console_url: link(`/content/push/${t.id}`) });
    }));

    server.registerTool('create_whatsapp_draft', {
      title: 'Draft a WhatsApp message', annotations: draft,
      description: 'Creates a WhatsApp message template in the content library (authored only; it still needs Meta approval and WhatsApp sending is not available yet).',
      inputSchema: {
        name: z.string().min(1).max(200), purpose: z.enum(['care', 'marketing']), header_text: z.string().max(60).optional(),
        body: z.string().min(1).max(1024), footer: z.string().max(60).optional(),
        quick_replies: z.array(z.string().min(1).max(25)).max(3).default([]),
      },
    }, safe(async ({ name, purpose, header_text, body, footer, quick_replies }) => {
      const t = await services.templates.create({
        name, channel: 'whatsapp', purpose, description: 'Drafted by an AI assistant',
        content: { en: { header: header_text ? { type: 'text', text: header_text } : { type: 'none' }, body, ...(footer ? { footer } : {}), buttons: quick_replies.map((text) => ({ type: 'quick_reply', text })), category: purpose === 'care' ? 'utility' : 'marketing' } },
      }, actor);
      return json({ id: t.id, name: t.name, console_url: link(`/content/whatsapp/${t.id}`) });
    }));

    server.registerTool('create_campaign_draft', {
      title: 'Draft a campaign', annotations: draft,
      description: 'Creates a campaign in draft status from a template and a segment. It is NOT scheduled or sent: a person must review it and launch it in the console.',
      inputSchema: { name: z.string().min(1).max(200), template_id: z.string().uuid(), segment_id: z.string().uuid() },
    }, safe(async (input) => {
      const c = await services.campaigns.create(input, actor);
      const estimate = await services.campaigns.estimate(c.id).catch(() => null);
      return json({ id: c.id, name: c.name, status: c.status, estimate, console_url: link(`/campaigns/${c.id}`), note: 'Draft only. Review and schedule it in Pure Engage.' });
    }));
  }

  return server;
}
