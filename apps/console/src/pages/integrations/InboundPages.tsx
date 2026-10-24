// Inbound webhooks: any app that can POST JSON (Zapier, Make, n8n, booking and form tools) feeds contacts and
// events in. Paste a sample payload, pick which fields mean what, and the preview shows exactly what will be stored.
import { useEffect, useId, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowDownToLine, Plus, Send, Trash2, Wand2, X, Zap } from 'lucide-react';
import {
  MAPPABLE_CONTACT_FIELDS, applyMapping, emptyMapping, getPath, leafPaths,
  type FieldPath, type InboundMapping, type MappableContactField,
} from '@pure-engage/shared';
import { api, ApiError } from '../../api/client.ts';
import type { InboundWebhook, TrackResultView } from '../../api/types.ts';
import { Button, EmptyState, ErrorBanner, Ltr, SelectField, Spinner, TextField, useFormatDate } from '../../components/ui.tsx';
import { IconChip, PageHeader, Pill } from '../../components/bits.tsx';
import { BackLink, CodeBlock, CopyField, RequestLog, SecretOnce } from './common.tsx';

// Synthetic example (CLAUDE.md: no real data).
const EXAMPLE = {
  booking: { id: 'APT-TEST-0001', starts_at: '2026-12-01T09:00:00Z', clinic: 'Synthetic Clinic Dubai', type: 'follow-up' },
  patient: { member_no: 'MBR-TEST-0001', email: 'test.member@example.com', mobile: '+971500000001', given_name: 'Test', family_name: 'Member', language: 'ar', sms_ok: 'yes' },
};

const GUESS: Record<MappableContactField, RegExp> = {
  external_id: /(^|[._])(external_?id|member_?(id|no|number)|customer_?id|patient_?id|mrn)$/i,
  email: /(^|[._])e-?mail(_?address)?$/i,
  phone: /(^|[._])(phone|mobile|msisdn|cell)(_?number)?$/i,
  first_name: /(^|[._])(first_?name|given_?name|firstname)$/i,
  last_name: /(^|[._])(last_?name|family_?name|surname|lastname)$/i,
  preferred_language: /(^|[._])(preferred_?language|language|lang|locale)$/i,
  timezone: /(^|[._])(timezone|time_?zone|tz)$/i,
};

/** Fills in contact fields whose names make the meaning obvious. */
function guessContact(paths: string[], current: InboundMapping['contact']): InboundMapping['contact'] {
  const next = { ...current };
  for (const field of MAPPABLE_CONTACT_FIELDS) {
    if (next[field]) continue;
    const hit = paths.find((p) => GUESS[field].test(p));
    if (hit) next[field] = hit;
  }
  return next;
}

export function InboundListPage() {
  const { t } = useTranslation();
  const formatDate = useFormatDate();
  const list = useQuery({ queryKey: ['integrations'], queryFn: () => api<{ data: InboundWebhook[] }>('/api/integrations') });
  return (
    <section className="pe-stack">
      <BackLink to="/integrations">{t('nav.integrations')}</BackLink>
      <PageHeader
        title={t('integrations.cards.inbound.title')}
        subtitle={t('integrations.inbound.subtitle')}
        actions={<Link to="/integrations/inbound/new" className="pe-button pe-button--primary"><Plus aria-hidden="true" />{t('integrations.inbound.new')}</Link>}
      />
      {!list.data ? <Spinner /> : !list.data.data.length ? (
        <div className="pe-card"><EmptyState title={t('integrations.inbound.empty')}>{t('integrations.inbound.emptyHint')}</EmptyState></div>
      ) : (
        <div className="pe-catalog">
          {list.data.data.map((h) => (
            <Link key={h.id} to={`/integrations/inbound/${h.id}`} className="pe-card pe-catalog__card">
              <div className="pe-catalog__head">
                <IconChip icon={ArrowDownToLine} tone="info" />
                <Pill tone={h.enabled ? 'success' : 'muted'} dot live={h.enabled && !!h.last_seen_at}>{h.enabled ? t('integrations.inbound.on') : t('settings.disabled')}</Pill>
              </div>
              <strong className="pe-catalog__title">{h.name}</strong>
              <p className="pe-muted">
                {h.config.mapping.event?.name ? t('integrations.inbound.summaryEvent', { event: h.config.mapping.event.name }) : t('integrations.inbound.summaryContacts')}
              </p>
              <small className="pe-muted">{t('integrations.inbound.lastSeen')}: {formatDate(h.last_seen_at)}</small>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

export function InboundEditorPage() {
  const { id = 'new' } = useParams();
  const isNew = id === 'new';
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const existing = useQuery({ queryKey: ['integration', id], enabled: !isNew, queryFn: () => api<InboundWebhook>(`/api/integrations/${id}`) });

  const [name, setName] = useState('');
  const [auth, setAuth] = useState<'token' | 'hmac'>('token');
  const [mapping, setMapping] = useState<InboundMapping>(emptyMapping);
  const [sampleText, setSampleText] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(isNew);
  useEffect(() => {
    if (existing.data && !loaded) {
      setName(existing.data.name); setAuth(existing.data.config.auth);
      setMapping({ ...emptyMapping(), ...existing.data.config.mapping }); setLoaded(true);
    }
  }, [existing.data, loaded]);

  const sample = useMemo<{ value?: unknown; error?: boolean }>(() => {
    if (!sampleText.trim()) return {};
    try { return { value: JSON.parse(sampleText) }; } catch { return { error: true }; }
  }, [sampleText]);
  const arrays = useMemo(() => (sample.value === undefined ? [] : arrayPaths(sample.value)), [sample.value]);
  const record = mapping.records && sample.value !== undefined ? (getPath(sample.value, mapping.records) as unknown[] | undefined)?.[0] : sample.value;
  const paths = useMemo(() => (record === undefined ? [] : leafPaths(record)), [record]);
  const preview = useMemo(() => (sample.value === undefined ? null : applyMapping(sample.value, mapping)), [sample.value, mapping]);

  const applySample = (text: string) => {
    setSampleText(text);
    try {
      const v = JSON.parse(text);
      setMapping((m) => ({ ...m, contact: guessContact(leafPaths(m.records ? (getPath(v, m.records) as unknown[] | undefined)?.[0] : v).map((p) => p.path), m.contact) }));
    } catch { /* shown as an error below */ }
  };

  const save = useMutation({
    mutationFn: () => isNew
      ? api<InboundWebhook & { secret?: string }>('/api/integrations', { method: 'POST', body: { name, auth, mapping: clean(mapping) } })
      : api<InboundWebhook & { secret?: string }>(`/api/integrations/${id}`, { method: 'PATCH', body: { name, auth, mapping: clean(mapping) } }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['integrations'] });
      if (isNew) { setSecret(r.secret ?? null); navigate(`/integrations/inbound/${r.id}`, { replace: true }); }
      else void qc.invalidateQueries({ queryKey: ['integration', id] });
    },
  });
  const fieldErrors = save.error instanceof ApiError ? save.error.fieldErrors() : {};

  if (!isNew && !existing.data) return existing.error ? <ErrorBanner error={existing.error} /> : <Spinner />;
  const set = (patch: Partial<InboundMapping>) => setMapping((m) => ({ ...m, ...patch }));

  return (
    <section className="pe-stack">
      <BackLink to="/integrations/inbound">{t('integrations.cards.inbound.title')}</BackLink>
      <PageHeader
        title={isNew ? t('integrations.inbound.new') : name || existing.data?.name}
        subtitle={t('integrations.inbound.editorHint')}
        actions={<Button variant="primary" busy={save.isPending} disabled={!name.trim() || (!mapping.contact.external_id && !mapping.contact.email)} onClick={() => save.mutate()}>{isNew ? t('integrations.inbound.create') : t('common.save')}</Button>}
      />
      <ErrorBanner error={save.error && !Object.keys(fieldErrors).length ? save.error : null} />
      {save.isSuccess && !isNew && <p className="pe-ok" role="status">{t('integrations.inbound.saved')}</p>}

      {!isNew && existing.data && <Connection hook={existing.data} sample={sample.value} onSecret={setSecret} />}

      <div className="pe-grid-2 pe-grid-2--wide-first pe-inbound">
        <div className="pe-stack">
          <div className="pe-card pe-stack">
            <h2>{t('integrations.inbound.step1')}</h2>
            <div className="pe-form-grid">
              <TextField label={t('templates.field.name')} placeholder={t('integrations.inbound.namePlaceholder')} value={name} error={fieldErrors.name} onChange={(e) => setName(e.target.value)} />
              <SelectField label={t('integrations.inbound.auth')} value={auth} onChange={(e) => setAuth(e.target.value as 'token' | 'hmac')}>
                <option value="token">{t('integrations.inbound.authToken')}</option>
                <option value="hmac">{t('integrations.inbound.authHmac')}</option>
              </SelectField>
            </div>
          </div>

          <div className="pe-card pe-stack">
            <div className="pe-row">
              <h2>{t('integrations.inbound.step2')}</h2>
              <span className="pe-spacer" />
              <Button variant="ghost" onClick={() => applySample(JSON.stringify(EXAMPLE, null, 2))}><Wand2 aria-hidden="true" />{t('integrations.inbound.useExample')}</Button>
            </div>
            <p className="pe-muted">{t('integrations.inbound.sampleHint')}</p>
            <label className="pe-field">
              <span className="pe-sr-only">{t('integrations.inbound.sample')}</span>
              <textarea className="pe-code-input" dir="ltr" rows={10} spellCheck={false} value={sampleText} aria-label={t('integrations.inbound.sample')}
                placeholder='{ "member_id": "MBR-TEST-0001", "email": "test.member@example.com" }' onChange={(e) => applySample(e.target.value)} />
            </label>
            {sample.error && <p className="pe-field__error">{t('integrations.inbound.badJson')}</p>}
            {arrays.length > 0 && (
              <SelectField label={t('integrations.inbound.records')} value={mapping.records ?? ''} onChange={(e) => set({ records: e.target.value || undefined })}>
                <option value="">{t('integrations.inbound.recordsOne')}</option>
                {arrays.map((p) => <option key={p} value={p}>{t('integrations.inbound.recordsEach', { path: p })}</option>)}
              </SelectField>
            )}
          </div>

          <div className="pe-card pe-stack">
            <h2>{t('integrations.inbound.step3')}</h2>
            <p className="pe-muted">{t('integrations.inbound.contactHint')}</p>
            {fieldErrors.contact && <p className="pe-field__error">{fieldErrors.contact}</p>}
            <div className="pe-form-grid">
              {MAPPABLE_CONTACT_FIELDS.map((f) => (
                <PathField key={f} label={t(`integrations.fields.${f}`)} paths={paths} record={record} value={mapping.contact[f] ?? ''}
                  onChange={(v) => set({ contact: { ...mapping.contact, [f]: v || undefined } })} />
              ))}
            </div>

            <h3>{t('integrations.inbound.attributes')}</h3>
            <PairList items={mapping.attributes} paths={paths} record={record} keyLabel={t('integrations.inbound.attributeName')} onChange={(attributes) => set({ attributes })} addLabel={t('integrations.inbound.addAttribute')} />

            <h3>{t('integrations.inbound.consent')}</h3>
            <p className="pe-muted">{t('integrations.inbound.consentHint')}</p>
            {mapping.consent.map((c, i) => (
              <div key={i} className="pe-pairrow pe-pairrow--3">
                <SelectField label={t('consent.channel')} value={c.channel} onChange={(e) => set({ consent: mapping.consent.map((x, j) => (j === i ? { ...x, channel: e.target.value as 'email' | 'sms' } : x)) })}>
                  <option value="email">{t('consent.channel_email')}</option><option value="sms">{t('consent.channel_sms')}</option>
                </SelectField>
                <SelectField label={t('integrations.inbound.purpose')} value={c.purpose} onChange={(e) => set({ consent: mapping.consent.map((x, j) => (j === i ? { ...x, purpose: e.target.value as 'care' | 'marketing' } : x)) })}>
                  <option value="care">{t('consent.purpose.care')}</option><option value="marketing">{t('consent.purpose.marketing')}</option>
                </SelectField>
                <PathField label={t('integrations.inbound.field')} paths={paths} record={record} value={c.path} onChange={(v) => set({ consent: mapping.consent.map((x, j) => (j === i ? { ...x, path: v } : x)) })} />
                <button type="button" className="pe-icon-button" aria-label={t('integrations.remove')} onClick={() => set({ consent: mapping.consent.filter((_, j) => j !== i) })}><X aria-hidden="true" /></button>
              </div>
            ))}
            {mapping.consent.length < 4 && <div><Button variant="ghost" onClick={() => set({ consent: [...mapping.consent, { channel: 'email', purpose: 'care', path: '' }] })}><Plus aria-hidden="true" />{t('integrations.inbound.addConsent')}</Button></div>}

            <h3>{t('integrations.inbound.event')}</h3>
            <label className="pe-check">
              <input type="checkbox" checked={!!mapping.event} onChange={(e) => set({ event: e.target.checked ? { name: 'appointment.booked', properties: [] } : null })} />
              <span>{t('integrations.inbound.eventToggle')}<small className="pe-muted">{t('integrations.inbound.eventHint')}</small></span>
            </label>
            {mapping.event && (
              <div className="pe-stack">
                <div className="pe-form-grid">
                  <TextField label={t('integrations.inbound.eventName')} dir="ltr" value={mapping.event.name} onChange={(e) => set({ event: { ...mapping.event!, name: e.target.value } })} />
                  <PathField label={t('integrations.inbound.eventTime')} paths={paths} record={record} value={mapping.event.time ?? ''} onChange={(v) => set({ event: { ...mapping.event!, time: v || undefined } })} />
                  <PathField label={t('integrations.inbound.eventKey')} hint={t('integrations.inbound.eventKeyHint')} paths={paths} record={record} value={mapping.event.idempotency_key ?? ''} onChange={(v) => set({ event: { ...mapping.event!, idempotency_key: v || undefined } })} />
                </div>
                <PairList items={mapping.event.properties} paths={paths} record={record} keyLabel={t('integrations.inbound.propertyName')} onChange={(properties) => set({ event: { ...mapping.event!, properties } })} addLabel={t('integrations.inbound.addProperty')} />
              </div>
            )}
          </div>
        </div>

        <aside className="pe-card pe-stack pe-inbound__preview" aria-label={t('integrations.inbound.preview')}>
          <div className="pe-row"><Zap aria-hidden="true" /><h2>{t('integrations.inbound.preview')}</h2></div>
          {!preview ? <p className="pe-muted">{t('integrations.inbound.previewEmpty')}</p> : (
            <>
              {preview.problems.map((p, i) => <p key={i} className="pe-alert pe-alert--warning"><AlertTriangle aria-hidden="true" /> {p}</p>)}
              <PreviewList title={t('integrations.inbound.previewContacts', { count: preview.request.attributes.length })} items={preview.request.attributes} />
              <PreviewList title={t('integrations.inbound.previewEvents', { count: preview.request.events.length })} items={preview.request.events} />
            </>
          )}
        </aside>
      </div>
      <SecretOnce title={t('integrations.inbound.secretTitle')} value={secret} onClose={() => setSecret(null)}>
        <p className="pe-muted">{auth === 'hmac' ? t('integrations.inbound.secretHmac') : t('integrations.inbound.secretToken')}</p>
      </SecretOnce>
    </section>
  );
}

/** URL, auth instructions, a test button and the request log for a saved source. */
function Connection({ hook, sample, onSecret }: { hook: InboundWebhook; sample: unknown; onSecret: (s: string) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const invalidate = () => { void qc.invalidateQueries({ queryKey: ['integration', hook.id] }); void qc.invalidateQueries({ queryKey: ['integrations'] }); };
  const [logOpen, setLogOpen] = useState(false);
  const test = useMutation({ mutationFn: () => api<TrackResultView>(`/api/integrations/${hook.id}/test`, { method: 'POST', body: { payload: sample } }) });
  const rotate = useMutation({ mutationFn: () => api<{ secret: string }>(`/api/integrations/${hook.id}/rotate-secret`, { method: 'POST' }), onSuccess: (r) => onSecret(r.secret) });
  const toggle = useMutation({ mutationFn: () => api(`/api/integrations/${hook.id}`, { method: 'PATCH', body: { enabled: !hook.enabled } }), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: () => api(`/api/integrations/${hook.id}`, { method: 'DELETE' }), onSuccess: () => { invalidate(); navigate('/integrations/inbound'); } });
  const curl = hook.config.auth === 'hmac'
    ? `BODY='${JSON.stringify(sample ?? EXAMPLE)}'
T=$(date +%s)
SIG=$(printf '%s.%s' "$T" "$BODY" | openssl dgst -sha256 -hmac "$PE_HOOK_SECRET" | sed 's/^.* //')
curl -X POST '${hook.url}' -H 'Content-Type: application/json' -H "X-PE-Signature: t=$T,v1=$SIG" -d "$BODY"`
    : `curl -X POST '${hook.url}' \\
  -H "Authorization: Bearer $PE_HOOK_TOKEN" \\
  -H 'Content-Type: application/json' \\
  -d '${JSON.stringify(sample ?? EXAMPLE)}'`;
  return (
    <div className="pe-card pe-stack pe-connection">
      <div className="pe-row">
        <h2>{t('integrations.inbound.connect')}</h2>
        <Pill tone={hook.enabled ? 'success' : 'muted'} dot live={hook.enabled}>{hook.enabled ? t('integrations.inbound.on') : t('settings.disabled')}</Pill>
        <span className="pe-spacer" />
        <Button variant="ghost" onClick={() => rotate.mutate()} busy={rotate.isPending}>{t('settings.rotate')}</Button>
        <Button variant="ghost" onClick={() => toggle.mutate()} busy={toggle.isPending}>{hook.enabled ? t('settings.disable') : t('settings.enable')}</Button>
        <Button variant="danger" onClick={() => remove.mutate()} busy={remove.isPending}><Trash2 aria-hidden="true" />{t('common.delete')}</Button>
      </div>
      <CopyField label={t('integrations.inbound.url')} value={hook.url} hint={hook.config.auth === 'hmac' ? t('integrations.inbound.urlHintHmac') : t('integrations.inbound.urlHintToken')} />
      <CodeBlock label={t('integrations.inbound.curl')} code={curl} />
      <div className="pe-row">
        <Button variant="primary" busy={test.isPending} disabled={sample === undefined} onClick={() => test.mutate()}><Send aria-hidden="true" />{t('integrations.inbound.sendTest')}</Button>
        {sample === undefined && <small className="pe-muted">{t('integrations.inbound.sendTestHint')}</small>}
        {test.data && <Pill tone={test.data.errors.length || test.data.skipped?.length ? 'warning' : 'success'} dot>{t('integrations.inbound.testResult', { contacts: test.data.attributes_processed, events: test.data.events_processed, duplicates: test.data.duplicates })}</Pill>}
      </div>
      <ErrorBanner error={test.error ?? rotate.error ?? toggle.error ?? remove.error} />
      {test.data?.errors.map((e, i) => <small key={i} className="pe-field__error">{e.type} {e.index + 1}: {e.error}</small>)}
      <details className="pe-details" onToggle={(e) => setLogOpen(e.currentTarget.open)}>
        <summary>{t('integrations.log.title')}</summary>
        {logOpen && <RequestLog integrationId={hook.id} refetch={10_000} />}
      </details>
    </div>
  );
}

/** A path into the payload: free text with suggestions from the sample, plus what the sample has there. */
function PathField({ label, value, onChange, paths, record, hint }: { label: string; value: string; onChange: (v: string) => void; paths: { path: string; sample: string }[]; record: unknown; hint?: string }) {
  const { t } = useTranslation();
  const list = useId();
  const found = value && record !== undefined ? getPath(record, value) : undefined;
  const shown = found === undefined ? (value && record !== undefined ? t('integrations.inbound.notInSample') : hint) : `= ${typeof found === 'object' ? JSON.stringify(found) : String(found)}`.slice(0, 80);
  return (
    <div className="pe-field">
      <label htmlFor={`${list}-in`}>{label}</label>
      <input id={`${list}-in`} dir="ltr" list={list} value={value} placeholder={t('integrations.inbound.pathPlaceholder')} onChange={(e) => onChange(e.target.value.trim())} />
      <datalist id={list}>{paths.map((p) => <option key={p.path} value={p.path}>{p.sample}</option>)}</datalist>
      {shown && <small className={found === undefined && value ? 'pe-field__error' : 'pe-muted'}><Ltr>{shown}</Ltr></small>}
    </div>
  );
}

function PairList({ items, onChange, paths, record, keyLabel, addLabel }: { items: FieldPath[]; onChange: (v: FieldPath[]) => void; paths: { path: string; sample: string }[]; record: unknown; keyLabel: string; addLabel: string }) {
  const { t } = useTranslation();
  return (
    <div className="pe-stack pe-stack--tight">
      {items.map((it, i) => (
        <div key={i} className="pe-pairrow">
          <TextField label={keyLabel} dir="ltr" value={it.key} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, key: e.target.value.replace(/[^A-Za-z0-9_]/g, '_') } : x)))} />
          <PathField label={t('integrations.inbound.field')} paths={paths} record={record} value={it.path} onChange={(v) => onChange(items.map((x, j) => (j === i ? { ...x, path: v } : x)))} />
          <button type="button" className="pe-icon-button" aria-label={t('integrations.remove')} onClick={() => onChange(items.filter((_, j) => j !== i))}><X aria-hidden="true" /></button>
        </div>
      ))}
      <div><Button variant="ghost" onClick={() => onChange([...items, { key: '', path: '' }])}><Plus aria-hidden="true" />{addLabel}</Button></div>
    </div>
  );
}

function PreviewList({ title, items }: { title: string; items: Record<string, unknown>[] }) {
  return (
    <div className="pe-stack pe-stack--tight">
      <strong>{title}</strong>
      {items.slice(0, 5).map((item, i) => (
        <dl key={i} className="pe-previewcard" dir="ltr">
          {Object.entries(item).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd></div>)}
        </dl>
      ))}
    </div>
  );
}

function arrayPaths(value: unknown, prefix = '', depth = 0): string[] {
  if (depth > 4 || value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return prefix ? [prefix] : [];
  return Object.entries(value).flatMap(([k, v]) => arrayPaths(v, prefix ? `${prefix}.${k}` : k, depth + 1));
}

/** Drops half-filled rows before saving. */
function clean(m: InboundMapping): InboundMapping {
  const pairs = (xs: FieldPath[]) => xs.filter((x) => x.key && x.path);
  return {
    ...(m.records ? { records: m.records } : {}),
    contact: Object.fromEntries(Object.entries(m.contact).filter(([, v]) => v)),
    attributes: pairs(m.attributes),
    consent: m.consent.filter((c) => c.path),
    event: m.event?.name ? { ...m.event, properties: pairs(m.event.properties) } : null,
  };
}
