// Shared pieces of the Integrations section: secrets shown once, copyable values, the request log and page chrome.
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Check, Copy } from 'lucide-react';
import { api } from '../../api/client.ts';
import type { IntegrationRequest } from '../../api/types.ts';
import { Button, Dialog, EmptyState, Ltr, Spinner, useFormatDate } from '../../components/ui.tsx';
import { Pill } from '../../components/bits.tsx';

export function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (value: string, id = value) => {
    void navigator.clipboard?.writeText(value).then(() => { setCopied(id); setTimeout(() => setCopied((c) => (c === id ? null : c)), 1600); });
  };
  return { copied, copy };
}

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const { t } = useTranslation();
  const { copied, copy } = useCopy();
  return (
    <Button variant="ghost" onClick={() => copy(value)} aria-label={label ?? t('settings.copy')}>
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      <span>{copied ? t('settings.copied') : t('settings.copy')}</span>
    </Button>
  );
}

/** A value to paste somewhere else (URL, header, key), always left-to-right. */
export function CopyField({ label, value, hint }: { label: string; value: string; hint?: ReactNode }) {
  return (
    <div className="pe-copyfield">
      <span className="pe-copyfield__label">{label}</span>
      <div className="pe-copyfield__row">
        <code dir="ltr">{value}</code>
        <CopyButton value={value} label={`${label}: copy`} />
      </div>
      {hint && <small className="pe-muted">{hint}</small>}
    </div>
  );
}

export function CodeBlock({ code, label }: { code: string; label: string }) {
  return (
    <figure className="pe-codeblock">
      <figcaption>
        <span>{label}</span>
        <CopyButton value={code} label={`${label}: copy`} />
      </figcaption>
      <pre dir="ltr"><code>{code}</code></pre>
    </figure>
  );
}

/** Shows a secret once with a copy button. */
export function SecretOnce({ value, onClose, title, children }: { value: string | null; onClose: () => void; title: string; children?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <Dialog open={!!value} onClose={onClose} title={title} footer={<Button variant="primary" onClick={onClose}>{t('settings.secretSaved')}</Button>}>
      <p>{t('settings.secretOnce')}</p>
      <code className="pe-secret"><Ltr>{value}</Ltr></code>
      <div><CopyButton value={value ?? ''} /></div>
      {children}
    </Dialog>
  );
}

export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return <Link to={to} className="pe-backlink"><ArrowLeft aria-hidden="true" className="pe-flip-rtl" />{children}</Link>;
}

const statusTone = (s: number) => (s >= 500 ? 'danger' : s >= 400 ? 'warning' : 'success');

/** Recent calls (metadata only) for one key, one source, or everything. */
export function RequestLog({ apiKeyId, integrationId, oauthGrantId, limit = 25, refetch }: { apiKeyId?: string; integrationId?: string; oauthGrantId?: string; limit?: number; refetch?: number }) {
  const { t } = useTranslation();
  const formatDate = useFormatDate();
  const scoped = !!(apiKeyId || integrationId || oauthGrantId);
  const qs = new URLSearchParams({ limit: String(limit), ...(apiKeyId ? { api_key_id: apiKeyId } : {}), ...(integrationId ? { integration_id: integrationId } : {}), ...(oauthGrantId ? { oauth_grant_id: oauthGrantId } : {}) });
  const log = useQuery({
    queryKey: ['integration-requests', apiKeyId, integrationId, oauthGrantId, limit],
    queryFn: () => api<{ data: IntegrationRequest[] }>(`/api/integrations/requests?${qs}`),
    refetchInterval: refetch ?? 15_000,
  });
  if (!log.data) return <Spinner />;
  if (!log.data.data.length) return <EmptyState title={t('integrations.log.empty')}>{t('integrations.log.emptyHint')}</EmptyState>;
  return (
    <div className="pe-table-wrap">
      <table className="pe-table" aria-label={t('integrations.log.title')}>
        <thead>
          <tr>
            <th>{t('settings.when')}</th>
            {!scoped && <th>{t('integrations.log.source')}</th>}
            <th>{t('integrations.log.request')}</th>
            <th>{t('messages.statusLabel')}</th>
            <th>{t('integrations.log.items')}</th>
            <th>{t('integrations.log.duration')}</th>
          </tr>
        </thead>
        <tbody>
          {log.data.data.map((r) => (
            <tr key={r.id}>
              <td>{formatDate(r.at)}</td>
              {!scoped && <td>{r.api_key_name ?? r.integration_name ?? r.oauth_client_name ?? '—'}</td>}
              <td><code><Ltr>{r.method} {r.route}</Ltr></code>{r.error && <div><small className="pe-muted">{r.error}</small></div>}</td>
              <td><Pill tone={statusTone(r.status)} dot>{r.status}</Pill></td>
              <td>{r.items ?? '—'}</td>
              <td><Ltr>{r.duration_ms} ms</Ltr></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
