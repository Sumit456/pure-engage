// Visual editor for segment rules (packages/shared/src/segments.ts). Groups nest; each row edits one rule.
import { useTranslation } from 'react-i18next';
import { CHANNELS, CONTACT_FIELDS, PURPOSES, type GroupRule, type SegmentRule } from '@pure-engage/shared';
import { Button } from '../../components/ui.tsx';

const FIELD_OPS = ['eq', 'neq', 'contains', 'not_contains', 'starts_with', 'in', 'exists', 'not_exists'] as const;
const DATE_OPS = ['within_last_days', 'more_than_days_ago'] as const;
const ATTR_OPS = ['eq', 'neq', 'contains', 'starts_with', 'in', 'gt', 'gte', 'lt', 'lte', 'exists', 'not_exists'] as const;
const NO_VALUE = new Set(['exists', 'not_exists']);
const NUMERIC = new Set(['gt', 'gte', 'lt', 'lte', 'within_last_days', 'more_than_days_ago']);

const NEW_RULE: Record<SegmentRule['type'], () => SegmentRule> = {
  field: () => ({ type: 'field', field: 'preferred_language', op: 'eq', value: '' }),
  attribute: () => ({ type: 'attribute', key: '', op: 'eq', value: '' }),
  consent: () => ({ type: 'consent', channel: 'email', purpose: 'marketing', status: 'granted' }),
  event: () => ({ type: 'event', name: '', op: 'at_least', count: 1 }),
  group: () => ({ type: 'group', op: 'or', rules: [] }),
};

/** Converts what was typed into the value the API expects for this operator. */
function coerce(op: string, raw: string): string | number | (string | number)[] {
  if (op === 'in') return raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (NUMERIC.has(op)) return raw === '' ? '' : Number(raw);
  return raw;
}
const show = (v: unknown) => (Array.isArray(v) ? v.join(', ') : v === undefined || v === null ? '' : String(v));

export function GroupEditor({ group, onChange, onRemove, depth = 0, readOnly = false }: { group: GroupRule; onChange: (g: GroupRule) => void; onRemove?: () => void; depth?: number; readOnly?: boolean }) {
  const { t } = useTranslation();
  const setRule = (i: number, r: SegmentRule) => onChange({ ...group, rules: group.rules.map((x, j) => (j === i ? r : x)) });
  const removeRule = (i: number) => onChange({ ...group, rules: group.rules.filter((_, j) => j !== i) });

  return (
    <fieldset className="pe-group" data-depth={depth} disabled={readOnly}>
      <legend className="pe-row">
        <select aria-label={t('segments.matchLabel')} value={group.op} onChange={(e) => onChange({ ...group, op: e.target.value as 'and' | 'or' })}>
          <option value="and">{t('segments.matchAll')}</option>
          <option value="or">{t('segments.matchAny')}</option>
        </select>
        {onRemove && !readOnly && <Button variant="ghost" onClick={onRemove}>{t('segments.removeGroup')}</Button>}
      </legend>
      {group.rules.length === 0 && <p className="pe-muted">{group.op === 'and' ? t('segments.emptyAnd') : t('segments.emptyOr')}</p>}
      {group.rules.map((rule, i) =>
        rule.type === 'group'
          ? <GroupEditor key={i} group={rule} depth={depth + 1} readOnly={readOnly} onChange={(g) => setRule(i, g)} onRemove={() => removeRule(i)} />
          : <RuleRow key={i} rule={rule} readOnly={readOnly} onChange={(r) => setRule(i, r)} onRemove={() => removeRule(i)} />,
      )}
      {!readOnly && (
        <div className="pe-row">
          <span className="pe-muted">{t('segments.add')}</span>
          {(['field', 'attribute', 'consent', 'event'] as const).map((type) => (
            <Button key={type} variant="ghost" onClick={() => onChange({ ...group, rules: [...group.rules, NEW_RULE[type]()] })}>+ {t(`segments.type.${type}`)}</Button>
          ))}
          {depth < 3 && <Button variant="ghost" onClick={() => onChange({ ...group, rules: [...group.rules, NEW_RULE.group()] })}>+ {t('segments.type.group')}</Button>}
        </div>
      )}
    </fieldset>
  );
}

function RuleRow({ rule, onChange, onRemove, readOnly }: { rule: Exclude<SegmentRule, GroupRule>; onChange: (r: SegmentRule) => void; onRemove: () => void; readOnly: boolean }) {
  const { t } = useTranslation();
  const opLabel = (op: string) => t(`segments.op.${op}`);
  let body;
  switch (rule.type) {
    case 'field': {
      const ops = rule.field === 'created_at' ? DATE_OPS : FIELD_OPS;
      body = <>
        <select aria-label={t('segments.fieldLabel')} value={rule.field} onChange={(e) => {
          const field = e.target.value as typeof rule.field;
          onChange({ ...rule, field, op: field === 'created_at' ? 'within_last_days' : rule.op === 'within_last_days' || rule.op === 'more_than_days_ago' ? 'eq' : rule.op, value: '' });
        }}>
          {CONTACT_FIELDS.map((f) => <option key={f} value={f}>{t(`segments.field.${f}`)}</option>)}
        </select>
        <select aria-label={t('segments.operatorLabel')} value={rule.op} onChange={(e) => onChange({ ...rule, op: e.target.value as typeof rule.op })}>
          {ops.map((op) => <option key={op} value={op}>{opLabel(op)}</option>)}
        </select>
        {!NO_VALUE.has(rule.op) && <input aria-label={t('segments.valueLabel')} type={NUMERIC.has(rule.op) ? 'number' : 'text'} value={show(rule.value)} onChange={(e) => onChange({ ...rule, value: coerce(rule.op, e.target.value) })} />}
        {NUMERIC.has(rule.op) && <span className="pe-muted">{t('segments.days')}</span>}
      </>;
      break;
    }
    case 'attribute':
      body = <>
        <input aria-label={t('segments.attributeLabel')} dir="ltr" placeholder={t('segments.attributePlaceholder')} value={rule.key} onChange={(e) => onChange({ ...rule, key: e.target.value })} />
        <select aria-label={t('segments.operatorLabel')} value={rule.op} onChange={(e) => onChange({ ...rule, op: e.target.value as typeof rule.op, value: coerce(e.target.value, show(rule.value)) })}>
          {ATTR_OPS.map((op) => <option key={op} value={op}>{opLabel(op)}</option>)}
        </select>
        {!NO_VALUE.has(rule.op) && <input aria-label={t('segments.valueLabel')} type={NUMERIC.has(rule.op) ? 'number' : 'text'} value={show(rule.value)} onChange={(e) => onChange({ ...rule, value: coerce(rule.op, e.target.value) })} />}
      </>;
      break;
    case 'consent':
      body = <>
        <select aria-label={t('consent.channel')} value={rule.channel} onChange={(e) => onChange({ ...rule, channel: e.target.value as typeof rule.channel })}>
          {CHANNELS.map((c) => <option key={c} value={c}>{t(`consent.channel_${c}`)}</option>)}
        </select>
        <select aria-label={t('templates.field.purpose')} value={rule.purpose} onChange={(e) => onChange({ ...rule, purpose: e.target.value as typeof rule.purpose })}>
          {PURPOSES.map((p) => <option key={p} value={p}>{t(`consent.purpose.${p}`)}</option>)}
        </select>
        <span className="pe-muted">{t('segments.is')}</span>
        <select aria-label={t('segments.statusLabel')} value={rule.status} onChange={(e) => onChange({ ...rule, status: e.target.value as typeof rule.status })}>
          {(['granted', 'denied', 'unknown'] as const).map((s) => <option key={s} value={s}>{t(`consent.status.${s}`)}</option>)}
        </select>
      </>;
      break;
    case 'event':
      body = <>
        <input aria-label={t('segments.eventLabel')} dir="ltr" placeholder="purenet.appointment.booked" value={rule.name} onChange={(e) => onChange({ ...rule, name: e.target.value })} />
        <select aria-label={t('segments.operatorLabel')} value={rule.op} onChange={(e) => onChange({ ...rule, op: e.target.value as typeof rule.op })}>
          {(['at_least', 'at_most', 'none'] as const).map((op) => <option key={op} value={op}>{opLabel(op)}</option>)}
        </select>
        {rule.op !== 'none' && <><input aria-label={t('segments.countLabel')} type="number" min={0} className="pe-narrow" value={rule.count} onChange={(e) => onChange({ ...rule, count: Number(e.target.value) })} /><span className="pe-muted">{t('segments.times')}</span></>}
        <span className="pe-muted">{t('segments.inLast')}</span>
        <input aria-label={t('segments.withinLabel')} type="number" min={1} className="pe-narrow" placeholder="∞" value={rule.within_days ?? ''} onChange={(e) => {
          const { within_days: _drop, ...rest } = rule;
          onChange(e.target.value ? { ...rest, within_days: Number(e.target.value) } : rest);
        }} />
        <span className="pe-muted">{t('segments.days')}</span>
      </>;
      break;
  }
  return (
    <div className="pe-rule">
      <span className="pe-badge">{t(`segments.type.${rule.type}`)}</span>
      {body}
      {!readOnly && <Button variant="ghost" aria-label={t('segments.removeRule')} onClick={onRemove}>×</Button>}
    </div>
  );
}
