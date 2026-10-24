// Live activity: what Pure Engage did and what members did, newest first. Used on the dashboard and contact pages.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useInfiniteQuery } from '@tanstack/react-query';
import {
  BellOff, CheckCheck, Flag, LogOut, Mail, MailOpen, MessageSquare, MousePointerClick, RotateCw, ShieldAlert, ShieldCheck, Workflow, XCircle, Zap,
  type LucideIcon,
} from 'lucide-react';
import { api } from '../api/client.ts';
import type { ActivityItem, ActivityKind, Page } from '../api/types.ts';
import { IconChip, type Tone } from './bits.tsx';
import { Button, ErrorBanner, Ltr } from './ui.tsx';

const KINDS: ActivityKind[] = ['message', 'consent', 'journey', 'event'];

function look(item: ActivityItem): { icon: LucideIcon; tone: Tone } {
  const sms = item.data.channel === 'sms';
  switch (item.type) {
    case 'message.sent': return { icon: sms ? MessageSquare : Mail, tone: sms ? 'sms' : 'primary' };
    case 'message.delivered': return { icon: CheckCheck, tone: 'success' };
    case 'message.open': return { icon: MailOpen, tone: 'info' };
    case 'message.click': return { icon: MousePointerClick, tone: 'success' };
    case 'message.failed': return { icon: XCircle, tone: 'danger' };
    case 'message.unsubscribe': return { icon: BellOff, tone: 'warning' };
    case 'message.retry': return { icon: RotateCw, tone: 'warning' };
    case 'consent.changed': return item.data.status === 'granted' ? { icon: ShieldCheck, tone: 'success' } : { icon: ShieldAlert, tone: 'warning' };
    case 'journey.entered': return { icon: Workflow, tone: 'primary' };
    case 'journey.completed': return { icon: Flag, tone: 'success' };
    case 'journey.exited': return { icon: LogOut, tone: 'muted' };
    default: return { icon: Zap, tone: 'warning' };
  }
}

export function useRelativeTime() {
  const { i18n } = useTranslation();
  const rtf = new Intl.RelativeTimeFormat(i18n.language, { numeric: 'auto', style: 'short' });
  return (iso: string) => {
    const s = Math.round((Date.parse(iso) - Date.now()) / 1000);
    const abs = Math.abs(s);
    if (abs < 60) return rtf.format(s, 'second');
    if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
    if (abs < 86_400) return rtf.format(Math.round(s / 3600), 'hour');
    return rtf.format(Math.round(s / 86_400), 'day');
  };
}

export function ActivityFeed({ contactId, limit = 15, live = false, showFilters = true, showContact = true }: { contactId?: string; limit?: number; live?: boolean; showFilters?: boolean; showContact?: boolean }) {
  const { t } = useTranslation();
  const ago = useRelativeTime();
  const [kinds, setKinds] = useState<ActivityKind[]>([]);
  const qs = (cursor?: string) => {
    const sp = new URLSearchParams({ limit: String(limit) });
    if (kinds.length) sp.set('kinds', kinds.join(','));
    if (contactId) sp.set('contact_id', contactId);
    if (cursor) sp.set('cursor', cursor);
    return sp.toString();
  };
  const feed = useInfiniteQuery({
    queryKey: ['activity', contactId ?? null, kinds.join(','), limit],
    queryFn: ({ pageParam, signal }) => api<Page<ActivityItem>>(`/api/activity?${qs(pageParam)}`, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    refetchInterval: live ? 15_000 : false,
  });
  const toggle = (k: ActivityKind) => setKinds((ks) => (ks.includes(k) ? ks.filter((x) => x !== k) : [...ks, k]));
  const items = feed.data?.pages.flatMap((p) => p.data) ?? [];

  const title = (item: ActivityItem) => {
    const d = item.data;
    if (item.kind === 'message') return t(`activity.types.${item.type}`, { channel: t(`consent.channel_${d.channel}`), template: d.template ?? '' });
    if (item.kind === 'consent') return t('activity.consent', { channel: t(`consent.channel_${d.channel}`), purpose: t(`consent.purpose.${d.purpose}`), status: t(`consent.status.${d.status}`) });
    if (item.kind === 'journey') return t(`activity.types.${item.type}`, { journey: d.journey ?? '' });
    return t('activity.event', { name: d.name ?? '' });
  };
  const meta = (item: ActivityItem) => {
    const d = item.data;
    if (item.kind === 'consent' || item.kind === 'event') return t('activity.via', { source: d.source });
    if (item.kind === 'message' && d.template && item.type !== 'message.sent') return d.template;
    if (item.kind === 'journey' && d.exit_reason) return d.exit_reason;
    return null;
  };

  return (
    <div className="pe-stack" style={{ gap: 12 }}>
      {showFilters && (
        <div className="pe-chips" role="group" aria-label={t('activity.filter')}>
          {KINDS.map((k) => <button key={k} type="button" className="pe-chip" aria-pressed={kinds.includes(k)} onClick={() => toggle(k)}>{t(`activity.kinds.${k}`)}</button>)}
        </div>
      )}
      <ErrorBanner error={feed.error} />
      {feed.isPending ? (
        <div className="pe-stack" style={{ gap: 10 }} aria-busy="true" aria-label={t('common.loading')}>
          {Array.from({ length: 5 }, (_, i) => <span key={i} className="pe-skeleton" style={{ blockSize: 38 }} />)}
        </div>
      ) : items.length === 0 ? (
        <p className="pe-muted">{t('activity.empty')}</p>
      ) : (
        <ul className="pe-feed" aria-live={live ? 'polite' : undefined}>
          {items.map((item) => {
            const { icon, tone } = look(item);
            const m = meta(item);
            return (
              <li key={item.id} className="pe-feed__item">
                <IconChip icon={icon} tone={tone} />
                <div>
                  <div className="pe-feed__title">
                    {item.data.message_id ? <Link to={`/messages/${item.data.message_id}`}>{title(item)}</Link> : title(item)}
                  </div>
                  <div className="pe-feed__meta">
                    {showContact && item.contact && (
                      <Link to={`/contacts/${item.contact.id}`}>{item.contact.name ?? <Ltr>{item.contact.external_id ?? item.contact.id.slice(0, 8)}</Ltr>}</Link>
                    )}
                    {showContact && item.contact && m && <span aria-hidden="true">·</span>}
                    {m && <span>{m}</span>}
                  </div>
                </div>
                <time className="pe-feed__time" dateTime={item.at} title={new Date(item.at).toLocaleString()}>{ago(item.at)}</time>
              </li>
            );
          })}
        </ul>
      )}
      {feed.hasNextPage && <div><Button variant="ghost" busy={feed.isFetchingNextPage} onClick={() => void feed.fetchNextPage()}>{t('common.loadMore')}</Button></div>}
    </div>
  );
}
