// REST API keys with scopes: create (presets or hand-picked permissions, optional expiry), revoke, see usage.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, KeyRound, Plus } from 'lucide-react';
import { API_SCOPES, SCOPE_PRESETS, type ApiScope } from '@pure-engage/shared';
import { api, ApiError } from '../../api/client.ts';
import type { ApiKey } from '../../api/types.ts';
import { Button, Dialog, EmptyState, ErrorBanner, Ltr, SelectField, Spinner, TextField, useFormatDate } from '../../components/ui.tsx';
import { PageHeader, Pill } from '../../components/bits.tsx';
import { BackLink, CodeBlock, RequestLog, SecretOnce } from './common.tsx';

const GROUPS: { id: string; scopes: ApiScope[] }[] = [
  { id: 'contacts', scopes: ['contacts:read', 'contacts:read_pii', 'contacts:write', 'consent:write', 'events:write'] },
  { id: 'messaging', scopes: ['journeys:trigger', 'messages:send', 'messages:read'] },
  { id: 'insights', scopes: ['segments:read', 'campaigns:read', 'reports:read'] },
  { id: 'drafts', scopes: ['drafts:write'] },
];
const PRESETS = Object.keys(SCOPE_PRESETS) as (keyof typeof SCOPE_PRESETS)[];
const EXPIRY = ['never', '30', '90', '365'] as const;

export const scopeLabel = (t: (k: string) => string, s: ApiScope) => t(`integrations.scopes.${s.replace(':', '_')}`);

export function ApiKeysPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const formatDate = useFormatDate();
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: () => api<{ data: ApiKey[] }>('/api/api-keys') });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const revoke = useMutation({ mutationFn: (id: string) => api(`/api/api-keys/${id}`, { method: 'DELETE' }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['api-keys'] }) });
  const origin = window.location.origin;

  return (
    <section className="pe-stack">
      <BackLink to="/integrations">{t('nav.integrations')}</BackLink>
      <PageHeader
        title={t('integrations.cards.api.title')}
        subtitle={t('integrations.api.subtitle')}
        actions={<>
          <Link to="/integrations/reference" className="pe-button pe-button--secondary"><BookOpen aria-hidden="true" />{t('integrations.cards.reference.title')}</Link>
          <Button variant="primary" onClick={() => setCreating(true)}><Plus aria-hidden="true" />{t('settings.createKey')}</Button>
        </>}
      />

      <div className="pe-card pe-stack">
        {!keys.data ? <Spinner /> : !keys.data.data.length ? (
          <EmptyState title={t('settings.noKeys')}>{t('integrations.api.emptyHint')}</EmptyState>
        ) : (
          <ul className="pe-keylist">
            {keys.data.data.map((k) => {
              const expired = !!k.expires_at && new Date(k.expires_at) <= new Date();
              const state = k.revoked_at ? 'revoked' : expired ? 'expired' : 'active';
              return (
                <li key={k.id} className="pe-keylist__item" data-state={state}>
                  <div className="pe-keylist__main">
                    <span className="pe-keylist__icon" aria-hidden="true"><KeyRound /></span>
                    <div className="pe-stack pe-stack--tight">
                      <div className="pe-row">
                        <strong>{k.name}</strong>
                        <code className="pe-muted"><Ltr>pe_{k.prefix}_…</Ltr></code>
                        <Pill tone={state === 'active' ? 'success' : 'muted'} dot>{t(`integrations.api.state.${state}`)}</Pill>
                      </div>
                      <div className="pe-scopechips">{k.scopes.map((s) => <span key={s} className="pe-scopechip" title={scopeLabel(t, s)}><Ltr>{s}</Ltr></span>)}</div>
                      <small className="pe-muted">
                        {t('messages.created')} {formatDate(k.created_at)} · {t('settings.lastUsed')} {formatDate(k.last_used_at)}
                        {k.expires_at && <> · {t('integrations.api.expires')} {formatDate(k.expires_at)}</>}
                      </small>
                    </div>
                  </div>
                  <div className="pe-row">
                    <Button variant="ghost" onClick={() => setOpen(open === k.id ? null : k.id)} aria-expanded={open === k.id}>{t('integrations.log.title')}</Button>
                    {state === 'active' && <Button variant="danger" busy={revoke.isPending && revoke.variables === k.id} onClick={() => revoke.mutate(k.id)}>{t('settings.revoke')}</Button>}
                  </div>
                  {open === k.id && <div className="pe-keylist__log"><RequestLog apiKeyId={k.id} /></div>}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="pe-card pe-stack">
        <h2>{t('integrations.api.quickstart')}</h2>
        <p className="pe-muted">{t('integrations.api.quickstartHint')}</p>
        <CodeBlock label={t('integrations.api.trackExample')} code={`curl -X POST ${origin}/api/v1/track \\
  -H "Authorization: Bearer $PE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "attributes": [{ "external_id": "MBR-TEST-0001", "email": "test.member@example.com", "consent": { "email": { "care": "granted" } } }],
    "events": [{ "external_id": "MBR-TEST-0001", "name": "appointment.booked", "properties": { "appointment_id": "APT-TEST-0001" }, "idempotency_key": "evt-0001" }]
  }'`} />
        <CodeBlock label={t('integrations.api.sdkExample')} code={`import { PureEngage } from '@pure-engage/sdk';

const pe = new PureEngage({ baseUrl: '${origin}', apiKey: process.env.PE_API_KEY });
await pe.identify({ external_id: 'MBR-TEST-0001', email: 'test.member@example.com' });
await pe.track({ external_id: 'MBR-TEST-0001', name: 'appointment.booked', properties: { appointment_id: 'APT-TEST-0001' } });`} />
      </div>

      <CreateKeyDialog open={creating} onClose={() => setCreating(false)} onCreated={(key) => { setCreating(false); setCreated(key); void qc.invalidateQueries({ queryKey: ['api-keys'] }); }} />
      <SecretOnce title={t('settings.newKey')} value={created} onClose={() => setCreated(null)} />
    </section>
  );
}

function CreateKeyDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (key: string) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiScope[]>(SCOPE_PRESETS.ingest);
  const [expiry, setExpiry] = useState<(typeof EXPIRY)[number]>('never');
  const create = useMutation({
    mutationFn: () => api<{ key: string }>('/api/api-keys', {
      method: 'POST',
      body: { name, scopes, expires_at: expiry === 'never' ? null : new Date(Date.now() + Number(expiry) * 86_400_000).toISOString() },
    }),
    onSuccess: (r) => { setName(''); setScopes(SCOPE_PRESETS.ingest); setExpiry('never'); onCreated(r.key); },
  });
  const fieldErrors = create.error instanceof ApiError ? create.error.fieldErrors() : {};
  const toggle = (s: ApiScope) => setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  const preset = PRESETS.find((p) => SCOPE_PRESETS[p].length === scopes.length && SCOPE_PRESETS[p].every((s) => scopes.includes(s)));

  return (
    <Dialog open={open} onClose={onClose} title={t('settings.createKey')} footer={<>
      <Button onClick={onClose}>{t('common.cancel')}</Button>
      <Button variant="primary" busy={create.isPending} disabled={!name.trim() || !scopes.length} onClick={() => create.mutate()}>{t('settings.createKey')}</Button>
    </>}>
      <div className="pe-stack">
        <TextField label={t('settings.keyName')} placeholder={t('integrations.api.namePlaceholder')} value={name} error={fieldErrors.name} onChange={(e) => setName(e.target.value)} autoFocus />
        <fieldset className="pe-fieldset">
          <legend>{t('integrations.api.preset')}</legend>
          <div className="pe-chips" role="group">
            {PRESETS.map((p) => (
              <button key={p} type="button" className="pe-chip" aria-pressed={preset === p} onClick={() => setScopes([...SCOPE_PRESETS[p]])}>{t(`integrations.presets.${p}`)}</button>
            ))}
          </div>
        </fieldset>
        <fieldset className="pe-fieldset">
          <legend>{t('integrations.api.permissions')}</legend>
          <div className="pe-scopegrid">
            {GROUPS.map((g) => (
              <div key={g.id} className="pe-stack pe-stack--tight">
                <strong className="pe-scopegrid__title">{t(`integrations.scopeGroups.${g.id}`)}</strong>
                {g.scopes.map((s) => (
                  <label key={s} className="pe-check">
                    <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} />
                    <span>{scopeLabel(t, s)}<small className="pe-muted"><Ltr>{s}</Ltr></small></span>
                  </label>
                ))}
              </div>
            ))}
          </div>
          {scopes.includes('contacts:read_pii') && <p className="pe-alert pe-alert--warning">{t('integrations.api.piiWarning')}</p>}
        </fieldset>
        <SelectField label={t('integrations.api.expiry')} value={expiry} onChange={(e) => setExpiry(e.target.value as (typeof EXPIRY)[number])}>
          {EXPIRY.map((x) => <option key={x} value={x}>{t(`integrations.api.expiryOptions.${x}`)}</option>)}
        </SelectField>
        {create.error && !Object.keys(fieldErrors).length && <ErrorBanner error={create.error} />}
        <small className="pe-muted">{t('integrations.api.scopeCount', { count: scopes.length, total: API_SCOPES.length })}</small>
      </div>
    </Dialog>
  );
}
