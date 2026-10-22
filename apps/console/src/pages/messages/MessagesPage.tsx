import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import type { MessageStatus, MessageSummary, Page } from '../../api/types.ts';
import { Button, EmptyState, ErrorBanner, Ltr, Spinner, useFormatDate } from '../../components/ui.tsx';
import { MessageStatusBadge } from './MessageStatusBadge.tsx';

const STATUSES: MessageStatus[] = ['queued', 'deferred', 'sent', 'delivered', 'failed', 'suppressed'];
const IN_FLIGHT = new Set<MessageStatus>(['queued', 'sending']);

/** Message list; with `contactId` it shows one contact's messages without filters. */
export function MessageList({ contactId, compact = false }: { contactId?: string; compact?: boolean }) {
  const { t } = useTranslation();
  const formatDate = useFormatDate();
  const [params, setParams] = useSearchParams();
  const status = contactId ? '' : params.get('status') ?? '';
  const channel = contactId ? '' : params.get('channel') ?? '';
  const campaign = contactId ? '' : params.get('campaign') ?? '';
  const setFilter = (k: string, v: string) => { const next = new URLSearchParams(params); if (v) next.set(k, v); else next.delete(k); setParams(next, { replace: true }); };

  const messages = useInfiniteQuery({
    queryKey: ['messages', { contactId, status, channel, campaign }],
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) => {
      const sp = new URLSearchParams({ limit: compact ? '10' : '50' });
      if (contactId) sp.set('contact_id', contactId);
      if (status) sp.set('status', status);
      if (channel) sp.set('channel', channel);
      if (campaign) sp.set('campaign_id', campaign);
      if (pageParam) sp.set('cursor', pageParam);
      return api<Page<MessageSummary>>(`/api/messages?${sp}`, { signal });
    },
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    // Keep refreshing while anything is still on its way, so statuses update without a reload.
    refetchInterval: (query) => (query.state.data?.pages.some((p) => p.data.some((m) => IN_FLIGHT.has(m.status))) ? 3000 : false),
  });
  const rows = messages.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <div className="pe-stack">
      {!contactId && (
        <div className="pe-row">
          <select className="pe-search" aria-label={t('messages.filterStatus')} value={status} onChange={(e) => setFilter('status', e.target.value)}>
            <option value="">{t('messages.allStatuses')}</option>
            {STATUSES.map((s) => <option key={s} value={s}>{t(`messages.status.${s}`)}</option>)}
          </select>
          <select className="pe-search" aria-label={t('messages.filterChannel')} value={channel} onChange={(e) => setFilter('channel', e.target.value)}>
            <option value="">{t('messages.allChannels')}</option>
            <option value="email">{t('consent.channel_email')}</option>
            <option value="sms">{t('consent.channel_sms')}</option>
          </select>
          {campaign && <Button variant="ghost" onClick={() => setFilter('campaign', '')}>{t('messages.clearCampaign')} ×</Button>}
        </div>
      )}
      <ErrorBanner error={messages.error} />
      {messages.isPending ? <div className="pe-center"><Spinner /></div> : !rows.length ? <EmptyState title={t('messages.empty')} /> : (
        <div className="pe-table-wrap">
          <table className="pe-table">
            <thead>
              <tr>
                <th>{t('messages.created')}</th>
                {!contactId && <th>{t('messages.to')}</th>}
                <th>{t('messages.template')}</th>
                <th>{t('templates.field.channel')}</th>
                <th>{t('messages.statusLabel')}</th>
                <th>{t('messages.engagement')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id}>
                  <td><Link to={`/messages/${m.id}`}>{formatDate(m.created_at)}</Link></td>
                  {!contactId && <td><Link to={`/contacts/${m.contact_id}`}><Ltr>{m.to_address ?? '—'}</Ltr></Link></td>}
                  <td>{m.template_name ?? '—'}</td>
                  <td>{t(`consent.channel_${m.channel}`)} · {t(`consent.purpose.${m.purpose}`)}</td>
                  <td><MessageStatusBadge status={m.status} reason={m.status_reason} /></td>
                  <td className="pe-muted">{[m.opened_at && t('messages.opened'), m.clicked_at && t('messages.clicked')].filter(Boolean).join(' · ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {messages.hasNextPage && <div className="pe-row" style={{ justifyContent: 'center' }}><Button onClick={() => void messages.fetchNextPage()} busy={messages.isFetchingNextPage}>{t('common.loadMore')}</Button></div>}
    </div>
  );
}

export function MessagesPage() {
  const { t } = useTranslation();
  return (
    <section>
      <div className="pe-page-header"><h1>{t('nav.messages')}</h1></div>
      <div className="pe-card"><MessageList /></div>
    </section>
  );
}
