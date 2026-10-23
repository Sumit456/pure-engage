// Integrations hub: a catalog of every way to connect Pure Engage to other apps, with live request stats.
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import {
  Activity, AlertTriangle, ArrowDownToLine, ArrowUpFromLine, BookOpen, Bot, FileSpreadsheet, HeartPulse, KeyRound, Plug, Zap, type LucideIcon,
} from 'lucide-react';
import { api } from '../../api/client.ts';
import type { IntegrationsOverview } from '../../api/types.ts';
import { hasRole, useUser } from '../../auth/auth.tsx';
import { IconChip, KpiTile, PageHeader, Pill, type Tone } from '../../components/bits.tsx';
import { RequestLog } from './common.tsx';

interface Card { id: string; icon: LucideIcon; to: string | null; tone: Tone; status: (o: IntegrationsOverview | undefined) => { tone: Tone; label: string } | null; adminOnly?: boolean }

export function IntegrationsPage() {
  const { t } = useTranslation();
  const admin = hasRole(useUser(), 'admin');
  const overview = useQuery({ queryKey: ['integrations-overview'], enabled: admin, queryFn: () => api<IntegrationsOverview>('/api/integrations/overview'), refetchInterval: 30_000 });
  const o = overview.data;
  const count = (n: number, key: string) => (n ? { tone: 'success' as const, label: t(key, { count: n }) } : { tone: 'muted' as const, label: t('integrations.status.notSetUp') });

  const cards: Card[] = [
    { id: 'api', icon: KeyRound, to: '/integrations/api', tone: 'primary', adminOnly: true, status: (x) => (x ? count(x.api_keys, 'integrations.status.keys') : null) },
    { id: 'inbound', icon: ArrowDownToLine, to: '/integrations/inbound', tone: 'info', adminOnly: true, status: (x) => (x ? count(x.inbound_webhooks.enabled, 'integrations.status.sources') : null) },
    { id: 'outbound', icon: ArrowUpFromLine, to: '/integrations/outbound', tone: 'sms', adminOnly: true, status: (x) => (x ? count(x.outbound_webhooks.enabled, 'integrations.status.endpoints') : null) },
    { id: 'ai', icon: Bot, to: '/integrations/ai', tone: 'primary', adminOnly: true, status: (x) => (x?.ai_connections ? { tone: 'success', label: t('integrations.status.connected', { count: x.ai_connections }) } : { tone: 'info', label: t('integrations.status.new') }) },
    { id: 'nocode', icon: Zap, to: '/integrations/no-code', tone: 'warning', status: () => null },
    { id: 'import', icon: FileSpreadsheet, to: '/contacts/import', tone: 'success', status: () => null },
    { id: 'reference', icon: BookOpen, to: '/integrations/reference', tone: 'muted', status: () => null },
    { id: 'purenet', icon: HeartPulse, to: null, tone: 'danger', status: () => ({ tone: 'warning', label: t('integrations.status.awaiting') }) },
  ];

  return (
    <section className="pe-stack">
      <PageHeader title={t('nav.integrations')} subtitle={t('integrations.subtitle')} />

      {admin && (
        <div className="pe-kpis">
          <KpiTile label={t('integrations.kpi.requests')} icon={Activity} value={o ? o.requests_24h.toLocaleString() : '…'} trend={o?.hourly} hint={t('integrations.kpi.last24h')} testId={o ? 'kpi-requests' : undefined} />
          <KpiTile label={t('integrations.kpi.errors')} icon={AlertTriangle} value={o ? o.errors_24h.toLocaleString() : '…'} hint={o && o.requests_24h ? t('integrations.kpi.errorRate', { pct: Math.round((o.errors_24h / o.requests_24h) * 100) }) : t('integrations.kpi.last24h')} />
          <KpiTile label={t('integrations.kpi.keys')} icon={KeyRound} value={o ? o.api_keys : '…'} hint={t('integrations.kpi.keysHint')} />
          <KpiTile label={t('integrations.kpi.sources')} icon={Plug} value={o ? o.inbound_webhooks.enabled + o.outbound_webhooks.enabled : '…'} hint={t('integrations.kpi.sourcesHint')} />
        </div>
      )}
      {!admin && <div className="pe-alert pe-alert--info">{t('integrations.adminOnly')}</div>}

      <div className="pe-catalog">
        {cards.map((c) => {
          const status = c.status(o);
          const usable = c.to && (!c.adminOnly || admin);
          const body = (
            <>
              <div className="pe-catalog__head">
                <IconChip icon={c.icon} tone={c.tone} />
                {status && <Pill tone={status.tone} dot>{status.label}</Pill>}
              </div>
              <strong className="pe-catalog__title">{t(`integrations.cards.${c.id}.title`)}</strong>
              <p className="pe-muted">{t(`integrations.cards.${c.id}.body`)}</p>
              <span className="pe-catalog__cta">{c.to && !usable ? t('integrations.adminOnlyShort') : t(`integrations.cards.${c.id}.cta`)}</span>
            </>
          );
          return usable
            ? <Link key={c.id} to={c.to!} className="pe-card pe-catalog__card" data-testid={`card-${c.id}`}>{body}</Link>
            : <div key={c.id} className="pe-card pe-catalog__card pe-catalog__card--static" data-testid={`card-${c.id}`}>{body}</div>;
        })}
      </div>

      {admin && (
        <div className="pe-card pe-stack">
          <h2>{t('integrations.log.title')}</h2>
          <RequestLog limit={15} />
        </div>
      )}
    </section>
  );
}
