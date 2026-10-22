import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client.ts';
import type { AdminUser, ApiKey, AuditEntry, DeliveryStatus, Role, WebhookDelivery, WebhookSummary } from '../../api/types.ts';
import { hasRole, useUser } from '../../auth/auth.tsx';
import { Badge, Button, Dialog, ErrorBanner, Ltr, SelectField, Spinner, TextField, useFormatDate } from '../../components/ui.tsx';

const TABS = ['delivery', 'account', 'users', 'apiKeys', 'webhooks', 'audit'] as const;
type Tab = (typeof TABS)[number];
const ADMIN_TABS = new Set<Tab>(['users', 'apiKeys', 'webhooks', 'audit']);

export function SettingsPage() {
  const { t } = useTranslation();
  const user = useUser();
  const [params, setParams] = useSearchParams();
  const visible = TABS.filter((tab) => !ADMIN_TABS.has(tab) || hasRole(user, 'admin'));
  const tab = (visible.find((x) => x === params.get('tab')) ?? 'delivery') as Tab;
  return (
    <section className="pe-stack">
      <h1>{t('nav.settings')}</h1>
      <div className="pe-tabs" role="tablist" aria-label={t('nav.settings')}>
        {visible.map((x) => <button key={x} type="button" role="tab" aria-selected={tab === x} className="pe-tab" onClick={() => setParams({ tab: x }, { replace: true })}>{t(`settings.tab.${x}`)}</button>)}
      </div>
      <div role="tabpanel">
        {tab === 'delivery' && <DeliveryTab />}
        {tab === 'account' && <AccountTab />}
        {tab === 'users' && <UsersTab />}
        {tab === 'apiKeys' && <ApiKeysTab />}
        {tab === 'webhooks' && <WebhooksTab />}
        {tab === 'audit' && <AuditTab />}
      </div>
    </section>
  );
}

/** Shows a secret once with a copy button. */
function SecretOnce({ value, onClose, title }: { value: string | null; onClose: () => void; title: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <Dialog open={!!value} onClose={onClose} title={title} footer={<Button variant="primary" onClick={onClose}>{t('settings.secretSaved')}</Button>}>
      <p>{t('settings.secretOnce')}</p>
      <code className="pe-secret"><Ltr>{value}</Ltr></code>
      <div><Button onClick={() => { void navigator.clipboard?.writeText(value ?? '').then(() => setCopied(true)); }}>{copied ? t('settings.copied') : t('settings.copy')}</Button></div>
    </Dialog>
  );
}

function DeliveryTab() {
  const { t } = useTranslation();
  const status = useQuery({ queryKey: ['delivery-status'], queryFn: () => api<DeliveryStatus>('/api/delivery/status') });
  if (!status.data) return <Spinner />;
  const s = status.data;
  return (
    <div className="pe-card pe-stack">
      <dl className="pe-dl">
        <dt>{t('settings.mode')}</dt><dd><Badge tone={s.mode === 'live' ? 'success' : 'warning'}>{t(`settings.modes.${s.mode}`)}</Badge></dd>
        <dt>{t('consent.channel_email')}</dt><dd><Badge>{s.providers.email}</Badge></dd>
        <dt>{t('consent.channel_sms')}</dt><dd><Badge>{s.providers.sms}</Badge></dd>
        <dt>{t('settings.allowlist')}</dt><dd>{s.allowlist ? t('settings.allowlistOn') : '—'}</dd>
      </dl>
      <p className="pe-muted">{t('settings.deliveryHint')}</p>
    </div>
  );
}

function AccountTab() {
  const { t } = useTranslation();
  const [form, setForm] = useState({ current_password: '', new_password: '' });
  const change = useMutation({ mutationFn: () => api('/api/auth/password', { method: 'POST', body: form }), onSuccess: () => setForm({ current_password: '', new_password: '' }) });
  const onSubmit = (e: FormEvent) => { e.preventDefault(); change.mutate(); };
  return (
    <form className="pe-card pe-stack" onSubmit={onSubmit} style={{ maxWidth: 480 }} noValidate>
      <h2>{t('settings.changePassword')}</h2>
      <TextField label={t('settings.currentPassword')} type="password" autoComplete="current-password" value={form.current_password} onChange={(e) => setForm({ ...form, current_password: e.target.value })} />
      <TextField label={t('settings.newPassword')} type="password" autoComplete="new-password" hint={t('settings.passwordRule')} value={form.new_password} onChange={(e) => setForm({ ...form, new_password: e.target.value })} />
      <ErrorBanner error={change.error} />
      {change.isSuccess && <p className="pe-ok" role="status">{t('settings.passwordChanged')}</p>}
      <div><Button type="submit" variant="primary" busy={change.isPending} disabled={!form.current_password || form.new_password.length < 12}>{t('settings.changePassword')}</Button></div>
    </form>
  );
}

function UsersTab() {
  const { t } = useTranslation();
  const me = useUser();
  const qc = useQueryClient();
  const formatDate = useFormatDate();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<{ data: AdminUser[] }>('/api/users') });
  const [form, setForm] = useState({ email: '', name: '', role: 'marketer' as Role, password: '' });
  const create = useMutation({ mutationFn: () => api('/api/users', { method: 'POST', body: form }), onSuccess: () => { setForm({ email: '', name: '', role: 'marketer', password: '' }); void qc.invalidateQueries({ queryKey: ['users'] }); } });
  const update = useMutation({ mutationFn: ({ id, body }: { id: string; body: Partial<AdminUser> }) => api(`/api/users/${id}`, { method: 'PATCH', body }), onSettled: () => void qc.invalidateQueries({ queryKey: ['users'] }) });
  const fieldErrors = create.error instanceof ApiError ? create.error.fieldErrors() : {};
  return (
    <div className="pe-stack">
      <div className="pe-card">
        <ErrorBanner error={update.error} />
        {!users.data ? <Spinner /> : (
          <div className="pe-table-wrap">
            <table className="pe-table">
              <thead><tr><th>{t('templates.field.name')}</th><th>{t('auth.email')}</th><th>{t('settings.role')}</th><th>{t('settings.lastLogin')}</th><th>{t('messages.statusLabel')}</th></tr></thead>
              <tbody>
                {users.data.data.map((u) => (
                  <tr key={u.id}>
                    <td>{u.name || '—'}</td><td><Ltr>{u.email}</Ltr></td>
                    <td>
                      <select aria-label={t('settings.roleFor', { email: u.email })} value={u.role} disabled={u.id === me.id} onChange={(e) => update.mutate({ id: u.id, body: { role: e.target.value as Role } })}>
                        {(['viewer', 'marketer', 'admin'] as const).map((r) => <option key={r} value={r}>{t(`roles.${r}`)}</option>)}
                      </select>
                    </td>
                    <td>{formatDate(u.last_login_at)}</td>
                    <td>{u.id === me.id ? <Badge tone="brand">{t('settings.you')}</Badge> : <Button variant="ghost" onClick={() => update.mutate({ id: u.id, body: { active: !u.active } })}>{u.active ? t('settings.deactivate') : t('settings.reactivate')}</Button>}{!u.active && <Badge>{t('settings.inactive')}</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <form className="pe-card pe-stack" onSubmit={(e) => { e.preventDefault(); create.mutate(); }} noValidate>
        <h2>{t('settings.addUser')}</h2>
        <div className="pe-form-grid">
          <TextField label={t('auth.email')} type="email" value={form.email} error={fieldErrors.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <TextField label={t('templates.field.name')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <SelectField label={t('settings.role')} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
            {(['viewer', 'marketer', 'admin'] as const).map((r) => <option key={r} value={r}>{t(`roles.${r}`)}</option>)}
          </SelectField>
          <TextField label={t('settings.initialPassword')} type="password" autoComplete="new-password" hint={t('settings.passwordRule')} error={fieldErrors.password} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </div>
        {create.error && !Object.keys(fieldErrors).length && <ErrorBanner error={create.error} />}
        <div><Button type="submit" variant="primary" busy={create.isPending} disabled={!form.email || form.password.length < 12}>{t('settings.addUser')}</Button></div>
      </form>
    </div>
  );
}

function ApiKeysTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const formatDate = useFormatDate();
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: () => api<{ data: ApiKey[] }>('/api/api-keys') });
  const [name, setName] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const create = useMutation({ mutationFn: () => api<{ key: string }>('/api/api-keys', { method: 'POST', body: { name } }), onSuccess: (r) => { setSecret(r.key); setName(''); void qc.invalidateQueries({ queryKey: ['api-keys'] }); } });
  const revoke = useMutation({ mutationFn: (id: string) => api(`/api/api-keys/${id}`, { method: 'DELETE' }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['api-keys'] }) });
  return (
    <div className="pe-stack">
      <div className="pe-card">
        {!keys.data ? <Spinner /> : !keys.data.data.length ? <p className="pe-muted">{t('settings.noKeys')}</p> : (
          <div className="pe-table-wrap">
            <table className="pe-table">
              <thead><tr><th>{t('templates.field.name')}</th><th>{t('settings.prefix')}</th><th>{t('messages.created')}</th><th>{t('settings.lastUsed')}</th><th /></tr></thead>
              <tbody>
                {keys.data.data.map((k) => (
                  <tr key={k.id}>
                    <td>{k.name}</td><td><code><Ltr>pe_{k.prefix}_…</Ltr></code></td><td>{formatDate(k.created_at)}</td><td>{formatDate(k.last_used_at)}</td>
                    <td>{k.revoked_at ? <Badge>{t('settings.revoked')}</Badge> : <Button variant="danger" busy={revoke.isPending && revoke.variables === k.id} onClick={() => revoke.mutate(k.id)}>{t('settings.revoke')}</Button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <form className="pe-card pe-row" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <TextField label={t('settings.keyName')} placeholder="PureNet bridge" value={name} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" variant="primary" busy={create.isPending} disabled={!name.trim()}>{t('settings.createKey')}</Button>
        <ErrorBanner error={create.error} />
      </form>
      <SecretOnce title={t('settings.newKey')} value={secret} onClose={() => setSecret(null)} />
    </div>
  );
}

function WebhooksTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const hooks = useQuery({ queryKey: ['webhooks'], queryFn: () => api<{ data: WebhookSummary[] }>('/api/webhooks') });
  const [form, setForm] = useState({ name: '', url: '', events: '*' });
  const [secret, setSecret] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['webhooks'] });
  const create = useMutation({
    mutationFn: () => api<{ secret: string }>('/api/webhooks', { method: 'POST', body: { name: form.name, url: form.url, events: form.events.split(',').map((s) => s.trim()).filter(Boolean) } }),
    onSuccess: (r) => { setSecret(r.secret); setForm({ name: '', url: '', events: '*' }); invalidate(); },
  });
  const toggle = useMutation({ mutationFn: (h: WebhookSummary) => api(`/api/webhooks/${h.id}`, { method: 'PATCH', body: { enabled: !h.enabled } }), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: (id: string) => api(`/api/webhooks/${id}`, { method: 'DELETE' }), onSuccess: invalidate });
  const rotate = useMutation({ mutationFn: (id: string) => api<{ secret: string }>(`/api/webhooks/${id}/rotate-secret`, { method: 'POST' }), onSuccess: (r) => setSecret(r.secret) });
  const test = useMutation({ mutationFn: (id: string) => api<WebhookDelivery>(`/api/webhooks/${id}/test`, { method: 'POST' }), onSuccess: (_d, id) => { setOpen(id); void qc.invalidateQueries({ queryKey: ['webhook-deliveries', id] }); } });
  const fieldErrors = create.error instanceof ApiError ? create.error.fieldErrors() : {};
  return (
    <div className="pe-stack">
      <p className="pe-muted">{t('settings.webhooksHint')}</p>
      {!hooks.data ? <Spinner /> : hooks.data.data.map((h) => (
        <div key={h.id} className="pe-card pe-stack">
          <div className="pe-row">
            <strong>{h.name}</strong>{!h.enabled && <Badge>{t('settings.disabled')}</Badge>}
            <code className="pe-muted"><Ltr>{h.url}</Ltr></code>
            <span className="pe-spacer" />
            <Button variant="ghost" busy={test.isPending && test.variables === h.id} onClick={() => test.mutate(h.id)}>{t('settings.sendTest')}</Button>
            <Button variant="ghost" onClick={() => setOpen(open === h.id ? null : h.id)}>{t('settings.deliveries')}</Button>
            <Button variant="ghost" onClick={() => rotate.mutate(h.id)}>{t('settings.rotate')}</Button>
            <Button variant="ghost" onClick={() => toggle.mutate(h)}>{h.enabled ? t('settings.disable') : t('settings.enable')}</Button>
            <Button variant="danger" onClick={() => remove.mutate(h.id)}>{t('common.delete')}</Button>
          </div>
          <small className="pe-muted">{t('settings.eventsLabel')}: <Ltr>{h.events.join(', ')}</Ltr></small>
          {open === h.id && <Deliveries id={h.id} />}
        </div>
      ))}
      <form className="pe-card pe-stack" onSubmit={(e) => { e.preventDefault(); create.mutate(); }} noValidate>
        <h2>{t('settings.addWebhook')}</h2>
        <div className="pe-form-grid">
          <TextField label={t('templates.field.name')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <TextField label="URL" dir="ltr" placeholder="https://" value={form.url} error={fieldErrors.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
          <TextField label={t('settings.eventsLabel')} dir="ltr" hint={t('settings.eventsHint')} value={form.events} onChange={(e) => setForm({ ...form, events: e.target.value })} />
        </div>
        {create.error && !Object.keys(fieldErrors).length && <ErrorBanner error={create.error} />}
        <div><Button type="submit" variant="primary" busy={create.isPending} disabled={!form.name || !form.url}>{t('settings.addWebhook')}</Button></div>
      </form>
      <SecretOnce title={t('settings.signingSecret')} value={secret} onClose={() => setSecret(null)} />
    </div>
  );
}

function Deliveries({ id }: { id: string }) {
  const { t } = useTranslation();
  const formatDate = useFormatDate();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['webhook-deliveries', id], queryFn: () => api<{ data: WebhookDelivery[] }>(`/api/webhooks/${id}/deliveries`) });
  const retry = useMutation({ mutationFn: (did: string) => api(`/api/webhook-deliveries/${did}/retry`, { method: 'POST' }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['webhook-deliveries', id] }) });
  if (!list.data) return <Spinner />;
  if (!list.data.data.length) return <p className="pe-muted">{t('settings.noDeliveries')}</p>;
  return (
    <div className="pe-table-wrap">
      <table className="pe-table">
        <thead><tr><th>{t('messages.created')}</th><th>{t('settings.event')}</th><th>{t('messages.statusLabel')}</th><th>{t('messages.attempts')}</th><th>{t('settings.response')}</th><th /></tr></thead>
        <tbody>
          {list.data.data.map((d) => (
            <tr key={d.id}>
              <td>{formatDate(d.created_at)}</td><td><code><Ltr>{d.event_name}</Ltr></code></td>
              <td><Badge tone={d.status === 'success' ? 'success' : d.status === 'failed' ? 'danger' : 'warning'}>{t(`settings.deliveryStatus.${d.status}`)}</Badge></td>
              <td>{d.attempts}</td><td><small className="pe-muted">{d.response_code ?? ''} {d.error ?? ''}</small></td>
              <td>{d.status === 'failed' && <Button variant="ghost" busy={retry.isPending && retry.variables === d.id} onClick={() => retry.mutate(d.id)}>{t('settings.retry')}</Button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AuditTab() {
  const { t } = useTranslation();
  const formatDate = useFormatDate();
  const [entity, setEntity] = useState('');
  const audit = useQuery({ queryKey: ['audit', entity], queryFn: () => api<{ data: AuditEntry[] }>(`/api/audit?limit=200${entity ? `&entity_id=${encodeURIComponent(entity)}` : ''}`) });
  return (
    <div className="pe-card pe-stack">
      <TextField label={t('settings.filterEntity')} dir="ltr" placeholder="00000000-…" value={entity} onChange={(e) => setEntity(e.target.value.trim())} />
      {!audit.data ? <Spinner /> : (
        <div className="pe-table-wrap">
          <table className="pe-table">
            <thead><tr><th>{t('settings.when')}</th><th>{t('settings.who')}</th><th>{t('settings.action')}</th><th>{t('settings.entity')}</th><th>{t('settings.details')}</th></tr></thead>
            <tbody>
              {audit.data.data.map((a) => (
                <tr key={a.id}>
                  <td>{formatDate(a.at)}</td>
                  <td><Ltr>{a.actor_type}{a.actor_id ? `:${a.actor_id.slice(0, 8)}` : ''}</Ltr></td>
                  <td><code><Ltr>{a.action}</Ltr></code></td>
                  <td><Ltr>{a.entity_type ?? ''}{a.entity_id ? `:${a.entity_id.slice(0, 8)}` : ''}</Ltr></td>
                  <td><small className="pe-muted"><Ltr>{Object.keys(a.details).length ? JSON.stringify(a.details) : ''}</Ltr></small></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
