import { useState, type FormEvent } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client.ts';
import type { AdminUser, AuditEntry, DeliveryStatus, Role } from '../../api/types.ts';
import { hasRole, useUser } from '../../auth/auth.tsx';
import { Badge, Button, ErrorBanner, Ltr, SelectField, Spinner, TextField, useFormatDate } from '../../components/ui.tsx';

const TABS = ['delivery', 'account', 'users', 'audit'] as const;
type Tab = (typeof TABS)[number];
const ADMIN_TABS = new Set<Tab>(['users', 'audit']);
/** API keys and webhooks moved to Integrations; old links still land in the right place. */
const MOVED: Record<string, string> = { apiKeys: '/integrations/api', webhooks: '/integrations/outbound' };

export function SettingsPage() {
  const { t } = useTranslation();
  const user = useUser();
  const [params, setParams] = useSearchParams();
  const moved = MOVED[params.get('tab') ?? ''];
  const visible = TABS.filter((tab) => !ADMIN_TABS.has(tab) || hasRole(user, 'admin'));
  const tab = (visible.find((x) => x === params.get('tab')) ?? 'delivery') as Tab;
  if (moved) return <Navigate to={moved} replace />;
  return (
    <section className="pe-stack">
      <h1>{t('nav.settings')}</h1>
      {hasRole(user, 'admin') && <p className="pe-muted">{t('settings.movedHint')} <Link to="/integrations">{t('nav.integrations')}</Link></p>}
      <div className="pe-tabs" role="tablist" aria-label={t('nav.settings')}>
        {visible.map((x) => <button key={x} type="button" role="tab" aria-selected={tab === x} className="pe-tab" onClick={() => setParams({ tab: x }, { replace: true })}>{t(`settings.tab.${x}`)}</button>)}
      </div>
      <div role="tabpanel">
        {tab === 'delivery' && <DeliveryTab />}
        {tab === 'account' && <AccountTab />}
        {tab === 'users' && <UsersTab />}
        {tab === 'audit' && <AuditTab />}
      </div>
    </section>
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
