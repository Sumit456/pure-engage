// Segment rule language, shared by the API (compiles it to SQL) and the console (rule builder).
import { z } from 'zod';
import { CHANNELS, PURPOSES } from './consent.ts';

export const CONTACT_FIELDS = ['external_id', 'email', 'phone', 'first_name', 'last_name', 'preferred_language', 'timezone', 'created_at'] as const;
export const TEXT_OPS = ['eq', 'neq', 'contains', 'not_contains', 'starts_with', 'in', 'exists', 'not_exists'] as const;
export const NUMBER_OPS = ['gt', 'gte', 'lt', 'lte'] as const;
export const DATE_OPS = ['within_last_days', 'more_than_days_ago'] as const;
export const EVENT_OPS = ['at_least', 'at_most', 'none'] as const;
export const MAX_RULE_DEPTH = 4;
export const MAX_RULES = 50;

const value = z.union([z.string().max(500), z.number(), z.boolean(), z.array(z.union([z.string().max(500), z.number()])).max(200)]).optional();
const attrKey = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, 'attribute names are letters, digits and _');

export const fieldRuleSchema = z.object({
  type: z.literal('field'),
  field: z.enum(CONTACT_FIELDS),
  op: z.enum([...TEXT_OPS, ...DATE_OPS]),
  value,
});
export const attributeRuleSchema = z.object({
  type: z.literal('attribute'),
  key: attrKey,
  op: z.enum([...TEXT_OPS, ...NUMBER_OPS]),
  value,
});
export const consentRuleSchema = z.object({
  type: z.literal('consent'),
  channel: z.enum(CHANNELS),
  purpose: z.enum(PURPOSES),
  status: z.enum(['granted', 'denied', 'unknown']),
});
export const eventRuleSchema = z.object({
  type: z.literal('event'),
  name: z.string().min(1).max(200),
  op: z.enum(EVENT_OPS),
  count: z.number().int().min(0).max(100_000).default(1),
  within_days: z.number().int().min(1).max(3650).optional(),
});

export type FieldRule = z.infer<typeof fieldRuleSchema>;
export type AttributeRule = z.infer<typeof attributeRuleSchema>;
export type ConsentRule = z.infer<typeof consentRuleSchema>;
export type EventRule = z.infer<typeof eventRuleSchema>;
export interface GroupRule { type: 'group'; op: 'and' | 'or'; rules: SegmentRule[] }
export type SegmentRule = FieldRule | AttributeRule | ConsentRule | EventRule | GroupRule;

export const ruleSchema: z.ZodType<SegmentRule> = z.lazy(() =>
  z.discriminatedUnion('type', [
    fieldRuleSchema, attributeRuleSchema, consentRuleSchema, eventRuleSchema,
    z.object({ type: z.literal('group'), op: z.enum(['and', 'or']), rules: z.array(ruleSchema).max(MAX_RULES) }),
  ]),
) as z.ZodType<SegmentRule>;

/** A segment's root is always a group. Depth and total size are bounded. */
export const segmentRulesSchema = z
  .object({ type: z.literal('group'), op: z.enum(['and', 'or']), rules: z.array(ruleSchema).max(MAX_RULES) })
  .superRefine((root, ctx) => {
    let count = 0;
    const walk = (r: SegmentRule, depth: number) => {
      count++;
      if (depth > MAX_RULE_DEPTH) ctx.addIssue({ code: 'custom', message: `Groups can be nested at most ${MAX_RULE_DEPTH} deep` });
      if (r.type === 'group') r.rules.forEach((c) => walk(c, depth + 1));
    };
    walk(root as GroupRule, 1);
    if (count > MAX_RULES) ctx.addIssue({ code: 'custom', message: `A segment can have at most ${MAX_RULES} rules` });
  });

export type SegmentRules = GroupRule;
