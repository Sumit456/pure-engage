// AI assistants (MCP): how to connect Claude or another assistant, what it can and can't do, and the connections an
// admin has approved, each with its own permissions, activity log and a revoke button.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Bot, Eye, FilePlus2, ShieldCheck } from 'lucide-react';
import { api } from '../../api/client.ts';
import type { IntegrationsOverview, OAuthGrant } from '../../api/types.ts';
import { Button, EmptyState, Ltr, Spinner, useFormatDate } from '../../components/ui.tsx';
import { IconChip, PageHeader, Pill } from '../../components/bits.tsx';
import { BackLink, CodeBlock, CopyField, RequestLog } from './common.tsx';
import { scopeLabel } from './ApiKeysPage.tsx';

const CLIENTS = ['claude', 'claudeCode', 'other'] as const;

export function AiAssistantsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const formatDate = useFormatDate();
  const overview = useQuery({ queryKey: ['integrations-overview'], queryFn: () => api<IntegrationsOverview>('/api/integrations/overview') });
  const grants = useQuery({ queryKey: ['oauth-grants'], queryFn: () => api<{ data: OAuthGrant[] }>('/api/oauth/grants') });
  const revoke = useMutation({ mutationFn: (id: string) => api(`/api/oauth/grants/${id}`, { method: 'DELETE' }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['oauth-grants'] }) });
  const [client, setClient] = useState<(typeof CLIENTS)[number]>('claude');
  const [open, setOpen] = useState<string | null>(null);
  const url = overview.data?.mcp_url ?? `${window.location.origin}/mcp`;

  return (
    <section className="pe-stack">
      <BackLink to="/integrations">{t('nav.integrations')}</BackLink>
      <PageHeader title={t('integrations.cards.ai.title')} subtitle={t('integrations.ai.subtitle')} />

      <div className="pe-grid-2 pe-grid-2--wide-first">
        <div className="pe-card pe-stack">
          <h2>{t('integrations.ai.connectTitle')}</h2>
          <CopyField label={t('integrations.ai.url')} value={url} />
          <div className="pe-tabs" role="tablist" aria-label={t('integrations.ai.client')}>
            {CLIENTS.map((c) => <button key={c} type="button" role="tab" aria-selected={client === c} className="pe-tab" onClick={() => setClient(c)}>{t(`integrations.ai.clients.${c}.name`)}</button>)}
          </div>
          <ol className="pe-steps">{[1, 2, 3].map((n) => <li key={n}>{t(`integrations.ai.clients.${client}.step${n}`, { url })}</li>)}</ol>
          {client === 'claudeCode' && <CodeBlock label={t('integrations.ai.terminal')} code={`claude mcp add --transport http pure-engage ${url}`} />}
          {client === 'other' && <CodeBlock label="mcp.json" code={JSON.stringify({ mcpServers: { 'pure-engage': { type: 'http', url, headers: { Authorization: 'Bearer ${PE_API_KEY}' } } } }, null, 2)} />}
        </div>
        <div className="pe-card pe-stack">
          <h2>{t('integrations.ai.canTitle')}</h2>
          <ul className="pe-promises">
            <li><IconChip icon={Eye} tone="info" /><span><strong>{t('integrations.ai.can1')}</strong><small className="pe-muted">{t('integrations.ai.can1Hint')}</small></span></li>
            <li><IconChip icon={FilePlus2} tone="primary" /><span><strong>{t('integrations.ai.can2')}</strong><small className="pe-muted">{t('integrations.ai.can2Hint')}</small></span></li>
            <li><IconChip icon={Ban} tone="danger" /><span><strong>{t('integrations.ai.cannot')}</strong><small className="pe-muted">{t('integrations.ai.cannotHint')}</small></span></li>
            <li><IconChip icon={ShieldCheck} tone="success" /><span><strong>{t('integrations.ai.privacy')}</strong><small className="pe-muted">{t('integrations.ai.privacyHint')}</small></span></li>
          </ul>
        </div>
      </div>

      <div className="pe-card pe-stack">
        <h2>{t('integrations.ai.connected')}</h2>
        {!grants.data ? <Spinner /> : !grants.data.data.length ? <EmptyState title={t('integrations.ai.none')}>{t('integrations.ai.noneHint')}</EmptyState> : (
          <ul className="pe-keylist">
            {grants.data.data.map((g) => {
              const state = g.revoked_at ? 'revoked' : 'active';
              return (
                <li key={g.id} className="pe-keylist__item" data-state={state}>
                  <div className="pe-keylist__main">
                    <span className="pe-keylist__icon" aria-hidden="true"><Bot /></span>
                    <div className="pe-stack pe-stack--tight">
                      <div className="pe-row"><strong>{g.client_name}</strong><Pill tone={state === 'active' ? 'success' : 'muted'} dot>{t(`integrations.api.state.${state}`)}</Pill></div>
                      <div className="pe-scopechips">{g.scopes.map((s) => <span key={s} className="pe-scopechip" title={scopeLabel(t, s)}><Ltr>{s}</Ltr></span>)}</div>
                      <small className="pe-muted">{t('integrations.ai.approvedBy', { who: g.approved_by ?? '—' })} · {formatDate(g.created_at)} · {t('settings.lastUsed')} {formatDate(g.last_used_at)}</small>
                    </div>
                  </div>
                  <div className="pe-row">
                    <Button variant="ghost" onClick={() => setOpen(open === g.id ? null : g.id)} aria-expanded={open === g.id}>{t('integrations.ai.activity')}</Button>
                    {state === 'active' && <Button variant="danger" busy={revoke.isPending && revoke.variables === g.id} onClick={() => revoke.mutate(g.id)}>{t('integrations.ai.disconnect')}</Button>}
                  </div>
                  {open === g.id && <div className="pe-keylist__log"><RequestLog oauthGrantId={g.id} /></div>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
