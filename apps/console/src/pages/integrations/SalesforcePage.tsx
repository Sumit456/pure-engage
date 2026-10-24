// Salesforce (ADR-0009): set up the customer's Connected App, connect over OAuth, choose what to sync, and watch
// the sync: counts, errors, the outbox of activity going back to Salesforce and the request log. Admin only.
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Plus, RefreshCw, X } from 'lucide-react';
import { api, ApiError } from '../../api/client.ts';
import { hasRole, useUser } from '../../auth/auth.tsx';
import { Button, Dialog, EmptyState, ErrorBanner, Ltr, SelectField, Spinner, TextField, useFormatDate } from '../../components/ui.tsx';
import { PageHeader, Pill, type Tone } from '../../components/bits.tsx';
import { BackLink, CopyField, RequestLog } from './common.tsx';

type SfObject = 'Contact' | 'Lead';
type Activity = 'sent' | 'open' | 'click' | 'unsubscribe';
const OBJECTS: SfObject[] = ['Contact', 'Lead'];
const ACTIVITIES: Activity[] = ['sent', 'open', 'click', 'unsubscribe'];
const FREQUENCIES = [5, 15, 30, 60, 240, 1440];
const HOSTS = { production: 'https://login.salesforce.com', sandbox: 'https://test.salesforce.com' } as const;
const COUNTS = ['created', 'updated', 'unchanged', 'skipped', 'errors', 'warnings'] as const;

interface ObjectSettings {
  enabled: boolean; external_id_field: string;
  fields: { field: string; attribute: string }[];
  consent: { field: string; channel: 'email' | 'sms'; purpose: 'care' | 'marketing'; unchecked_denies: boolean }[];
}
interface Settings { objects: Record<SfObject, ObjectSettings>; do_not_call_denies_sms: boolean; write_back: { activities: Activity[]; email_opt_out: boolean }; sync_minutes: number }
type Counts = Record<(typeof COUNTS)[number], number>;
interface Connection {
  id: string; status: 'not_connected' | 'connected' | 'error'; login_host: string; consumer_key: string; has_consumer_secret: boolean; connected: boolean;
  instance_url: string | null; org_id: string | null; username: string | null; connected_at: string | null; settings: Settings;
  last_run: { at: string; duration_ms: number; objects: Partial<Record<SfObject, Counts>>; error: string | null } | null;
  last_error: string | null; last_sync_at: string | null; next_sync_at: string | null; outbox: { pending: number; sent: number; failed: number };
}
interface SalesforceState { connection: Connection | null; callback_url: string; scopes: string }
interface DescribeField { name: string; label: string; type: string; custom: boolean; externalId: boolean; unique: boolean; idLookup: boolean }
interface OutboxItem { id: string; kind: 'task' | 'opt_out'; sf_object: string; status: 'pending' | 'sent' | 'failed'; attempts: number; error: string | null; subject: string | null; updated_at: string }

export const salesforceTone = (status: string | undefined): Tone => (status === 'connected' ? 'success' : status === 'error' ? 'danger' : 'muted');

export function SalesforcePage() {
  const { t } = useTranslation();
  const admin = hasRole(useUser(), 'admin');
  const [params, setParams] = useSearchParams();
  const sf = useQuery({ queryKey: ['salesforce'], enabled: admin, queryFn: () => api<SalesforceState>('/api/salesforce'), refetchInterval: 30_000 });
  const c = sf.data?.connection ?? null;
  const banner = params.get('connected') ? 'connected' : params.get('error');
  const step = !c ? 1 : !c.connected ? 2 : c.last_sync_at ? 4 : 3;
  const STEPS = ['app', 'credentials', 'connect', 'mapping', 'status'] as const;

  if (!admin) return <section className="pe-stack"><BackLink to="/integrations">{t('nav.integrations')}</BackLink><div className="pe-alert pe-alert--info">{t('integrations.adminOnly')}</div></section>;
  return (
    <section className="pe-stack">
      <BackLink to="/integrations">{t('nav.integrations')}</BackLink>
      <PageHeader title={t('integrations.cards.salesforce.title')} subtitle={t('integrations.salesforce.subtitle')}
        actions={c && <Pill tone={salesforceTone(c.status)} dot>{t(`integrations.salesforce.state.${c.status}`)}</Pill>} />

      {banner && (
        <div className={`pe-alert ${banner === 'connected' ? 'pe-alert--info' : 'pe-alert--danger'}`} role={banner === 'connected' ? 'status' : 'alert'}>
          {banner === 'connected' ? t('integrations.salesforce.connectedBanner') : t(`integrations.salesforce.errors.${banner}`, { defaultValue: t('integrations.salesforce.errors.generic') })}
          {' '}<button type="button" className="pe-linklike" onClick={() => setParams({}, { replace: true })}>{t('common.close')}</button>
        </div>
      )}

      <ol className="pe-stepper" aria-label={t('integrations.salesforce.stepsLabel')}>
        {STEPS.map((s, i) => (
          <li key={s} data-state={i < step ? 'done' : i === step ? 'current' : 'todo'} aria-current={i === step ? 'step' : undefined}>
            <span className="pe-stepper__dot">{i < step ? <Check aria-hidden="true" /> : i + 1}</span>
            <span>{t(`integrations.salesforce.steps.${s}`)}</span>
          </li>
        ))}
      </ol>

      {!sf.data ? <Spinner /> : (
        <>
          <div className="pe-grid-2">
            <AppCard state={sf.data} />
            <CredentialsCard connection={c} />
          </div>
          <ConnectCard connection={c} />
          {c?.connected && <MappingCard key={c.id} connection={c} />}
          {c && (c.connected || c.last_run) && <StatusCard connection={c} />}
        </>
      )}
    </section>
  );
}

function AppCard({ state }: { state: SalesforceState }) {
  const { t } = useTranslation();
  return (
    <div className="pe-card pe-stack">
      <h2>{t('integrations.salesforce.app.title')}</h2>
      <ol className="pe-steps">{[1, 2, 3, 4].map((n) => <li key={n}>{t(`integrations.salesforce.app.step${n}`)}</li>)}</ol>
      <CopyField label={t('integrations.salesforce.app.callback')} value={state.callback_url} />
      <CopyField label={t('integrations.salesforce.app.scopes')} value={state.scopes} />
    </div>
  );
}

function hostChoice(host: string | undefined): keyof typeof HOSTS | 'custom' {
  if (!host || host === HOSTS.production) return 'production';
  if (host === HOSTS.sandbox) return 'sandbox';
  return 'custom';
}

function CredentialsCard({ connection: c }: { connection: Connection | null }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [choice, setChoice] = useState(hostChoice(c?.login_host));
  const [custom, setCustom] = useState(choice === 'custom' ? (c?.login_host ?? '') : '');
  const [key, setKey] = useState(c?.consumer_key ?? '');
  const [secret, setSecret] = useState('');
  const save = useMutation({
    mutationFn: () => api<SalesforceState>('/api/salesforce/config', { method: 'PUT', body: { login_host: choice === 'custom' ? custom : HOSTS[choice], consumer_key: key, ...(secret ? { consumer_secret: secret } : {}) } }),
    onSuccess: (data) => { setSecret(''); qc.setQueryData(['salesforce'], data); },
  });
  const errors = save.error instanceof ApiError ? save.error.fieldErrors() : {};
  return (
    <form className="pe-card pe-stack" onSubmit={(e) => { e.preventDefault(); save.mutate(); }} noValidate>
      <h2>{t('integrations.salesforce.credentials.title')}</h2>
      <SelectField label={t('integrations.salesforce.credentials.host')} value={choice} error={choice !== 'custom' ? errors.login_host : undefined} onChange={(e) => setChoice(e.target.value as typeof choice)}>
        <option value="production">{t('integrations.salesforce.credentials.hostProduction')}</option>
        <option value="sandbox">{t('integrations.salesforce.credentials.hostSandbox')}</option>
        <option value="custom">{t('integrations.salesforce.credentials.hostCustom')}</option>
      </SelectField>
      {choice === 'custom' && <TextField label={t('integrations.salesforce.credentials.customHost')} dir="ltr" placeholder="acme.my.salesforce.com" hint={t('integrations.salesforce.credentials.customHint')} value={custom} error={errors.login_host} onChange={(e) => setCustom(e.target.value)} />}
      <TextField label={t('integrations.salesforce.credentials.key')} dir="ltr" autoComplete="off" value={key} error={errors.consumer_key} onChange={(e) => setKey(e.target.value)} />
      <TextField label={t('integrations.salesforce.credentials.secret')} dir="ltr" type="password" autoComplete="new-password" value={secret} error={errors.consumer_secret}
        hint={c?.has_consumer_secret ? t('integrations.salesforce.credentials.secretSaved') : undefined} onChange={(e) => setSecret(e.target.value)} />
      {save.error && !Object.keys(errors).length && <ErrorBanner error={save.error} />}
      <div className="pe-row">
        <Button type="submit" variant={c ? 'secondary' : 'primary'} busy={save.isPending} disabled={!key || (!c && !secret) || (choice === 'custom' && !custom)}>{t('integrations.salesforce.credentials.save')}</Button>
        {save.isSuccess && <span className="pe-ok" role="status">{t('integrations.salesforce.credentials.saved')}</span>}
      </div>
    </form>
  );
}

function ConnectCard({ connection: c }: { connection: Connection | null }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const formatDate = useFormatDate();
  const [confirm, setConfirm] = useState(false);
  const connect = useMutation({
    mutationFn: () => api<{ authorize_url: string }>('/api/salesforce/connect', { method: 'POST' }),
    onSuccess: (r) => window.location.assign(r.authorize_url),
  });
  const disconnect = useMutation({
    mutationFn: () => api<SalesforceState>('/api/salesforce/connection', { method: 'DELETE' }),
    onSuccess: (data) => { setConfirm(false); qc.setQueryData(['salesforce'], data); },
  });
  return (
    <div className="pe-card pe-stack">
      <h2>{t('integrations.salesforce.connect.title')}</h2>
      {c?.connected ? (
        <dl className="pe-dl">
          <dt>{t('integrations.salesforce.connect.user')}</dt><dd><Ltr>{c.username ?? '—'}</Ltr></dd>
          <dt>{t('integrations.salesforce.connect.org')}</dt><dd><Ltr>{c.org_id ?? '—'}</Ltr></dd>
          <dt>{t('integrations.salesforce.connect.instance')}</dt><dd><Ltr>{c.instance_url ?? '—'}</Ltr></dd>
          <dt>{t('integrations.salesforce.connect.since')}</dt><dd>{formatDate(c.connected_at)}</dd>
        </dl>
      ) : <p className="pe-muted">{c ? t('integrations.salesforce.connect.hint') : t('integrations.salesforce.connect.needDetails')}</p>}
      {c?.status === 'error' && c.last_error && !c.connected && <div className="pe-alert pe-alert--danger" role="alert">{c.last_error}</div>}
      <ErrorBanner error={connect.error} />
      <div className="pe-row">
        <Button variant={c?.connected ? 'secondary' : 'primary'} disabled={!c} busy={connect.isPending} onClick={() => connect.mutate()}>
          {c?.connected ? t('integrations.salesforce.connect.reconnect') : t('integrations.salesforce.connect.button')}
        </Button>
        {c?.connected && <Button variant="danger" onClick={() => setConfirm(true)}>{t('integrations.salesforce.connect.disconnect')}</Button>}
      </div>
      <Dialog open={confirm} onClose={() => setConfirm(false)} title={t('integrations.salesforce.connect.disconnectTitle')}
        footer={<><Button onClick={() => setConfirm(false)}>{t('common.cancel')}</Button><Button variant="danger" busy={disconnect.isPending} onClick={() => disconnect.mutate()}>{t('integrations.salesforce.connect.disconnect')}</Button></>}>
        <p>{t('integrations.salesforce.connect.disconnectBody')}</p>
        <ErrorBanner error={disconnect.error} />
      </Dialog>
    </div>
  );
}

function MappingCard({ connection: c }: { connection: Connection }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [s, setS] = useState<Settings>(c.settings);
  const save = useMutation({
    mutationFn: () => api<SalesforceState>('/api/salesforce/settings', { method: 'PATCH', body: s }),
    onSuccess: (data) => qc.setQueryData(['salesforce'], data),
  });
  const setObject = (o: SfObject, patch: Partial<ObjectSettings>) => setS({ ...s, objects: { ...s.objects, [o]: { ...s.objects[o], ...patch } } });
  const errors = save.error instanceof ApiError ? save.error.fieldErrors() : {};
  return (
    <form className="pe-card pe-stack" onSubmit={(e) => { e.preventDefault(); save.mutate(); }} noValidate>
      <h2>{t('integrations.salesforce.mapping.title')}</h2>
      {OBJECTS.map((o) => <ObjectMapping key={o} object={o} value={s.objects[o]} errors={errors} onChange={(patch) => setObject(o, patch)} />)}

      <fieldset className="pe-fieldset pe-stack pe-stack--tight">
        <legend>{t('integrations.salesforce.mapping.writeBack')}</legend>
        <span className="pe-muted">{t('integrations.salesforce.mapping.activities')}</span>
        <div className="pe-row">
          {ACTIVITIES.map((a) => (
            <label key={a} className="pe-check">
              <input type="checkbox" checked={s.write_back.activities.includes(a)}
                onChange={(e) => setS({ ...s, write_back: { ...s.write_back, activities: e.target.checked ? [...s.write_back.activities, a] : s.write_back.activities.filter((x) => x !== a) } })} />
              <span>{t(`integrations.salesforce.mapping.activity.${a}`)}</span>
            </label>
          ))}
        </div>
        <label className="pe-check">
          <input type="checkbox" checked={s.write_back.email_opt_out} onChange={(e) => setS({ ...s, write_back: { ...s.write_back, email_opt_out: e.target.checked } })} />
          <span>{t('integrations.salesforce.mapping.optOut')}<small className="pe-muted">{t('integrations.salesforce.mapping.optOutHint')}</small></span>
        </label>
        <label className="pe-check">
          <input type="checkbox" checked={s.do_not_call_denies_sms} onChange={(e) => setS({ ...s, do_not_call_denies_sms: e.target.checked })} />
          <span>{t('integrations.salesforce.mapping.doNotCall')}</span>
        </label>
      </fieldset>

      <div className="pe-form-grid">
        <SelectField label={t('integrations.salesforce.mapping.frequency')} value={String(s.sync_minutes)} onChange={(e) => setS({ ...s, sync_minutes: Number(e.target.value) })}>
          {FREQUENCIES.map((m) => <option key={m} value={m}>{m < 60 ? t('integrations.salesforce.mapping.minutes', { count: m }) : t('integrations.salesforce.mapping.hours', { count: m / 60 })}</option>)}
        </SelectField>
      </div>
      {save.error && <ErrorBanner error={save.error} />}
      <div className="pe-row">
        <Button type="submit" variant="primary" busy={save.isPending}>{t('integrations.salesforce.mapping.save')}</Button>
        {save.isSuccess && <span className="pe-ok" role="status">{t('integrations.salesforce.credentials.saved')}</span>}
      </div>
    </form>
  );
}

function ObjectMapping({ object, value, errors, onChange }: { object: SfObject; value: ObjectSettings; errors: Record<string, string>; onChange: (patch: Partial<ObjectSettings>) => void }) {
  const { t } = useTranslation();
  const describe = useQuery({ queryKey: ['salesforce-describe', object], enabled: value.enabled, staleTime: 5 * 60_000, queryFn: () => api<{ fields: DescribeField[] }>(`/api/salesforce/describe/${object}`) });
  const fields = describe.data?.fields ?? [];
  const identityFields = fields.filter((f) => f.type === 'id' || f.externalId || f.unique || f.idLookup || ['string', 'email'].includes(f.type));
  const consentFields = fields.filter((f) => ['boolean', 'picklist', 'string'].includes(f.type));
  const isBoolean = (name: string) => fields.find((f) => f.name === name)?.type === 'boolean';
  const options = (list: DescribeField[], current: string) => (
    <>
      <option value="">{t('integrations.salesforce.mapping.choose')}</option>
      {current && !list.some((f) => f.name === current) && <option value={current}>{current}</option>}
      {list.map((f) => <option key={f.name} value={f.name}>{f.label} ({f.name})</option>)}
    </>
  );
  const err = (path: string) => errors[`objects.${object}.${path}`];

  return (
    <fieldset className="pe-fieldset pe-stack pe-stack--tight" data-testid={`sf-object-${object}`}>
      <legend>{object}</legend>
      <label className="pe-check">
        <input type="checkbox" checked={value.enabled} onChange={(e) => onChange({ enabled: e.target.checked })} />
        <span>{t('integrations.salesforce.mapping.objectToggle', { object })}</span>
      </label>
      {value.enabled && (describe.isLoading ? <p className="pe-muted"><Spinner small /> {t('integrations.salesforce.mapping.loadingFields')}</p> : describe.error ? <ErrorBanner error={describe.error} /> : (
        <div className="pe-stack">
          <div className="pe-form-grid">
            <div>
              <SelectField label={t('integrations.salesforce.mapping.identity')} value={value.external_id_field} error={err('external_id_field')} onChange={(e) => onChange({ external_id_field: e.target.value || 'Id' })}>
                {options(identityFields, value.external_id_field)}
              </SelectField>
              <small className="pe-muted">{t('integrations.salesforce.mapping.identityHint')}</small>
            </div>
          </div>

          <h3>{t('integrations.salesforce.mapping.fields')}</h3>
          {value.fields.map((f, i) => (
            <div key={i} className="pe-pairrow">
              <SelectField label={t('integrations.salesforce.mapping.sfField')} value={f.field} error={err(`fields.${i}.field`)} onChange={(e) => onChange({ fields: value.fields.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)) })}>
                {options(fields, f.field)}
              </SelectField>
              <TextField label={t('integrations.salesforce.mapping.attribute')} dir="ltr" value={f.attribute} error={err(`fields.${i}.attribute`)}
                onChange={(e) => onChange({ fields: value.fields.map((x, j) => (j === i ? { ...x, attribute: e.target.value.replace(/[^A-Za-z0-9_]/g, '_') } : x)) })} />
              <button type="button" className="pe-icon-button" aria-label={t('integrations.remove')} onClick={() => onChange({ fields: value.fields.filter((_, j) => j !== i) })}><X aria-hidden="true" /></button>
            </div>
          ))}
          <div><Button variant="ghost" onClick={() => onChange({ fields: [...value.fields, { field: '', attribute: '' }] })}><Plus aria-hidden="true" />{t('integrations.salesforce.mapping.addField')}</Button></div>

          <h3>{t('integrations.salesforce.mapping.consent')}</h3>
          <p className="pe-muted">{t('integrations.salesforce.mapping.consentHint')}</p>
          {value.consent.map((c, i) => (
            <div key={i} className="pe-stack pe-stack--tight">
              <div className="pe-pairrow pe-pairrow--3">
                <SelectField label={t('integrations.salesforce.mapping.sfField')} value={c.field} error={err(`consent.${i}.field`)} onChange={(e) => onChange({ consent: value.consent.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)) })}>
                  {options(consentFields, c.field)}
                </SelectField>
                <SelectField label={t('consent.channel')} value={c.channel} onChange={(e) => onChange({ consent: value.consent.map((x, j) => (j === i ? { ...x, channel: e.target.value as 'email' | 'sms' } : x)) })}>
                  <option value="email">{t('consent.channel_email')}</option><option value="sms">{t('consent.channel_sms')}</option>
                </SelectField>
                <SelectField label={t('integrations.inbound.purpose')} value={c.purpose} onChange={(e) => onChange({ consent: value.consent.map((x, j) => (j === i ? { ...x, purpose: e.target.value as 'care' | 'marketing' } : x)) })}>
                  <option value="care">{t('consent.purpose.care')}</option><option value="marketing">{t('consent.purpose.marketing')}</option>
                </SelectField>
                <button type="button" className="pe-icon-button" aria-label={t('integrations.remove')} onClick={() => onChange({ consent: value.consent.filter((_, j) => j !== i) })}><X aria-hidden="true" /></button>
              </div>
              {isBoolean(c.field) && (
                <label className="pe-check">
                  <input type="checkbox" checked={c.unchecked_denies} onChange={(e) => onChange({ consent: value.consent.map((x, j) => (j === i ? { ...x, unchecked_denies: e.target.checked } : x)) })} />
                  <span>{t('integrations.salesforce.mapping.uncheckedDenies')}</span>
                </label>
              )}
            </div>
          ))}
          {value.consent.length < 8 && <div><Button variant="ghost" onClick={() => onChange({ consent: [...value.consent, { field: '', channel: 'email', purpose: 'marketing', unchecked_denies: false }] })}><Plus aria-hidden="true" />{t('integrations.salesforce.mapping.addConsent')}</Button></div>}
        </div>
      ))}
    </fieldset>
  );
}

function StatusCard({ connection: c }: { connection: Connection }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const formatDate = useFormatDate();
  const sync = useMutation({
    mutationFn: () => api<SalesforceState>('/api/salesforce/sync', { method: 'POST' }),
    onSuccess: (data) => { qc.setQueryData(['salesforce'], { connection: data.connection, callback_url: data.callback_url, scopes: data.scopes }); void qc.invalidateQueries({ queryKey: ['salesforce-outbox'] }); void qc.invalidateQueries({ queryKey: ['integration-requests'] }); },
  });
  const run = c.last_run;
  return (
    <>
      <div className="pe-card pe-stack">
        <div className="pe-row">
          <h2>{t('integrations.salesforce.status.title')}</h2>
          <span className="pe-spacer" />
          <Button variant="primary" busy={sync.isPending} disabled={!c.connected} onClick={() => sync.mutate()}><RefreshCw aria-hidden="true" />{t('integrations.salesforce.status.syncNow')}</Button>
        </div>
        <dl className="pe-dl">
          <dt>{t('integrations.salesforce.status.lastSync')}</dt><dd data-testid="sf-last-sync">{c.last_sync_at ? formatDate(c.last_sync_at) : t('integrations.salesforce.status.never')}</dd>
          <dt>{t('integrations.salesforce.status.nextSync')}</dt><dd>{c.connected && c.next_sync_at ? formatDate(c.next_sync_at) : '—'}</dd>
        </dl>
        <ErrorBanner error={sync.error} />
        {c.last_error && <div className="pe-alert pe-alert--danger" role="alert"><strong>{t('integrations.salesforce.status.lastError')}:</strong> {c.last_error}</div>}
        {run && Object.keys(run.objects).length > 0 && (
          <div className="pe-table-wrap">
            <table className="pe-table" aria-label={t('integrations.salesforce.status.title')}>
              <thead><tr><th>{t('integrations.salesforce.status.object')}</th>{COUNTS.map((k) => <th key={k}>{t(`integrations.salesforce.status.${k}`)}</th>)}</tr></thead>
              <tbody>
                {OBJECTS.filter((o) => run.objects[o]).map((o) => (
                  <tr key={o} data-testid={`sf-counts-${o}`}><td>{o}</td>{COUNTS.map((k) => <td key={k}>{run.objects[o]![k]}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <Outbox counts={c.outbox} />
      <div className="pe-card pe-stack">
        <h2>{t('integrations.salesforce.log')}</h2>
        <RequestLog integrationId={c.id} />
      </div>
    </>
  );
}

function Outbox({ counts }: { counts: Connection['outbox'] }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const formatDate = useFormatDate();
  const [status, setStatus] = useState<'pending' | 'failed' | 'sent'>(counts.failed ? 'failed' : 'pending');
  useEffect(() => { if (counts.failed) setStatus('failed'); }, [counts.failed]);
  const list = useQuery({ queryKey: ['salesforce-outbox', status], queryFn: () => api<{ data: OutboxItem[] }>(`/api/salesforce/outbox?status=${status}`), refetchInterval: 15_000 });
  const retry = useMutation({
    mutationFn: (id: string) => api(`/api/salesforce/outbox/${id}/retry`, { method: 'POST' }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['salesforce-outbox'] }); void qc.invalidateQueries({ queryKey: ['salesforce'] }); },
  });
  return (
    <div className="pe-card pe-stack">
      <h2>{t('integrations.salesforce.outbox.title')}</h2>
      <p className="pe-muted">{t('integrations.salesforce.outbox.hint')}</p>
      <div className="pe-tabs" role="tablist" aria-label={t('integrations.salesforce.outbox.title')}>
        {(['pending', 'failed', 'sent'] as const).map((s) => (
          <button key={s} type="button" role="tab" aria-selected={status === s} className="pe-tab" onClick={() => setStatus(s)}>{t(`integrations.salesforce.outbox.filter.${s}`)} ({counts[s]})</button>
        ))}
      </div>
      <ErrorBanner error={retry.error} />
      {!list.data ? <Spinner /> : !list.data.data.length ? <EmptyState title={t('integrations.salesforce.outbox.empty')} /> : (
        <div className="pe-table-wrap">
          <table className="pe-table">
            <thead><tr><th>{t('integrations.salesforce.outbox.item')}</th><th>{t('messages.statusLabel')}</th><th>{t('integrations.salesforce.outbox.attempts')}</th><th>{t('integrations.salesforce.outbox.updated')}</th><th /></tr></thead>
            <tbody>
              {list.data.data.map((o) => (
                <tr key={o.id}>
                  <td>
                    <strong>{t(`integrations.salesforce.outbox.kind.${o.kind}`)}</strong> · <Ltr>{o.sf_object}</Ltr>
                    {o.subject && <div><small className="pe-muted">{o.subject}</small></div>}
                    {o.error && <div><small className="pe-field__error">{o.error}</small></div>}
                  </td>
                  <td><Pill tone={o.status === 'sent' ? 'success' : o.status === 'failed' ? 'danger' : 'warning'} dot>{t(`integrations.salesforce.outbox.filter.${o.status}`)}</Pill></td>
                  <td>{o.attempts}</td>
                  <td>{formatDate(o.updated_at)}</td>
                  <td>{o.status === 'failed' && <Button variant="ghost" busy={retry.isPending && retry.variables === o.id} onClick={() => retry.mutate(o.id)}>{t('integrations.salesforce.outbox.retry')}</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
