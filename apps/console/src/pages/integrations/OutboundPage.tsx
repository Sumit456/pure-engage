// Outbound webhooks (moved here from Settings): Pure Engage POSTs matching events to other apps, signed.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client.ts';
import type { WebhookDelivery, WebhookSummary } from '../../api/types.ts';
import { Badge, Button, EmptyState, ErrorBanner, Ltr, Spinner, TextField, useFormatDate } from '../../components/ui.tsx';
import { PageHeader } from '../../components/bits.tsx';
import { BackLink, CodeBlock, SecretOnce } from './common.tsx';

export function OutboundPage() {
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
    <section className="pe-stack">
      <BackLink to="/integrations">{t('nav.integrations')}</BackLink>
      <PageHeader title={t('integrations.cards.outbound.title')} subtitle={t('settings.webhooksHint')} />
      {!hooks.data ? <Spinner /> : !hooks.data.data.length ? <div className="pe-card"><EmptyState title={t('integrations.outbound.empty')}>{t('integrations.outbound.emptyHint')}</EmptyState></div> : hooks.data.data.map((h) => (
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
      <div className="pe-card pe-stack">
        <h2>{t('integrations.outbound.verifyTitle')}</h2>
        <p className="pe-muted">{t('integrations.outbound.verifyHint')}</p>
        <CodeBlock label="Node.js" code={`import { createHmac, timingSafeEqual } from 'node:crypto';

// header = req.headers['x-pe-signature'], e.g. "t=1767225600,v1=5f2c…"
export function verify(header, rawBody, secret) {
  const { t, v1 } = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest('hex');
  return v1?.length === expected.length && timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
}`} />
      </div>
      <SecretOnce title={t('settings.signingSecret')} value={secret} onClose={() => setSecret(null)} />
    </section>
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
