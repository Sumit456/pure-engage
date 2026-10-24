import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Activity, MailOpen, Megaphone, MousePointerClick, Plus, Send, ShieldCheck, Users, Workflow } from 'lucide-react';
import { api } from '../api/client.ts';
import type { CampaignReportRow, JourneyReportRow, MessagesReport, Overview } from '../api/types.ts';
import { hasRole, useUser } from '../auth/auth.tsx';
import { ErrorBanner } from '../components/ui.tsx';
import { KpiTile, Pill, type Tone } from '../components/bits.tsx';
import { ActivityFeed } from '../components/ActivityFeed.tsx';
import { LineChart } from '../components/LineChart.tsx';

const statusTone: Record<string, Tone> = { active: 'success', sent: 'success', sending: 'info', scheduled: 'warning', paused: 'warning', draft: 'muted', cancelled: 'danger', archived: 'muted' };

export function Dashboard() {
  const { t, i18n } = useTranslation();
  const user = useUser();
  const overview = useQuery({ queryKey: ['overview'], queryFn: ({ signal }) => api<Overview>('/api/reports/overview', { signal }), refetchInterval: 30_000 });
  const daily = useQuery({ queryKey: ['report', 'messages', 'dashboard'], queryFn: ({ signal }) => api<MessagesReport>('/api/reports/messages', { signal }) });
  const campaigns = useQuery({ queryKey: ['report', 'campaigns', 'dashboard'], queryFn: ({ signal }) => api<{ data: CampaignReportRow[] }>('/api/reports/campaigns', { signal }) });
  const journeys = useQuery({ queryKey: ['report', 'journeys'], queryFn: ({ signal }) => api<{ data: JourneyReportRow[] }>('/api/reports/journeys', { signal }) });
  const num = (n: number) => n.toLocaleString(i18n.language);
  const pct = (r: number | null) => (r === null ? '—' : new Intl.NumberFormat(i18n.language, { style: 'percent', maximumFractionDigits: 1 }).format(r));
  const o = overview.data;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? t('dashboard.morning') : hour < 18 ? t('dashboard.afternoon') : t('dashboard.evening');

  const series = useMemo(() => {
    const days = [...new Set(daily.data?.days.map((d) => d.day) ?? [])];
    const sum = (day: string, key: 'sent' | 'opened' | 'clicked', ch?: string) => daily.data!.days.filter((d) => d.day === day && (!ch || d.channel === ch)).reduce((n, d) => n + d[key], 0);
    return {
      days,
      sent: days.map((d) => sum(d, 'sent')),
      opened: days.map((d) => sum(d, 'opened', 'email')),
      clicked: days.map((d) => sum(d, 'clicked', 'email')),
      email: days.map((d) => sum(d, 'sent', 'email')),
      sms: days.map((d) => sum(d, 'sent', 'sms')),
    };
  }, [daily.data]);
  const dayFmt = new Intl.DateTimeFormat(i18n.language === 'ar' ? 'ar-AE' : 'en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

  return (
    <section className="pe-stack" style={{ gap: 20 }}>
      <div className="pe-hero">
        <div>
          <h1 className="pe-eyebrow">{t('dashboard.title')}</h1>
          <p className="pe-hero__title">{greeting}, {user.name?.split(' ')[0] || user.email}</p>
          <p className="pe-muted">{t('dashboard.subtitle')}</p>
        </div>
        {hasRole(user, 'marketer') && (
          <div className="pe-row">
            <Link className="pe-button" to="/journeys/new"><Workflow aria-hidden="true" />{t('journeys.new')}</Link>
            <Link className="pe-button pe-button--primary" to="/campaigns/new"><Plus aria-hidden="true" />{t('campaigns.new')}</Link>
          </div>
        )}
      </div>

      <ErrorBanner error={overview.error} />
      <div className="pe-kpis">
        <KpiTile icon={Users} label={t('dashboard.kpi.contacts')} value={o ? num(o.contacts) : '…'} testId={o ? "kpi-contacts" : undefined} footer={<Link to="/contacts">{t('dashboard.view')}</Link>} />
        <KpiTile icon={ShieldCheck} label={t('dashboard.kpi.careConsent')} value={o ? `${num(o.consent.email_care)} / ${num(o.consent.sms_care)}` : '…'} hint={t('dashboard.kpi.emailSms')} />
        <KpiTile icon={Send} label={t('dashboard.kpi.sent', { days: o?.window_days ?? 30 })} value={o ? num(o.messages.sent) : '…'} testId={o ? "kpi-sent" : undefined} trend={series.sent} hint={o ? t('dashboard.kpi.notSent', { n: num(o.messages.not_sent) }) : undefined} />
        <KpiTile icon={MailOpen} label={t('dashboard.kpi.openRate')} value={o ? pct(o.email.open_rate) : '…'} trend={series.opened} hint={o ? t('dashboard.kpi.clickRate', { rate: pct(o.email.click_rate) }) : undefined} />
        <KpiTile icon={Activity} label={t('dashboard.kpi.activeRuns')} value={o ? num(o.journeys.active_runs) : '…'} footer={<Link to="/journeys">{t('dashboard.view')}</Link>} />
        <KpiTile icon={Megaphone} label={t('dashboard.kpi.campaigns', { days: o?.window_days ?? 30 })} value={o ? num(o.campaigns_sent) : '…'} footer={<Link to="/campaigns">{t('dashboard.view')}</Link>} />
      </div>

      <div className="pe-dash">
        <div className="pe-stack" style={{ gap: 16 }}>
          <div className="pe-card">
            {series.days.length > 0 ? (
              <LineChart
                title={t('reports.sentPerDay')}
                labels={series.days}
                formatLabel={(d) => dayFmt.format(new Date(`${d}T00:00:00Z`))}
                series={[
                  { key: 'email', label: t('consent.channel_email'), color: 'var(--pe-series-1)', values: series.email },
                  { key: 'sms', label: t('consent.channel_sms'), color: 'var(--pe-series-2)', values: series.sms },
                ]}
              />
            ) : <span className="pe-skeleton" style={{ blockSize: 260 }} />}
          </div>
          <div className="pe-grid-2">
            <div className="pe-card">
              <div className="pe-card__head"><Megaphone aria-hidden="true" className="pe-muted" width={18} /><h2>{t('dashboard.recentCampaigns')}</h2><span className="pe-spacer" /><Link to="/campaigns">{t('dashboard.viewAll')}</Link></div>
              {campaigns.data?.data.length ? (
                <ul className="pe-list">
                  {campaigns.data.data.slice(0, 5).map((c) => (
                    <li key={c.id}>
                      <div className="pe-list__main"><Link to={`/campaigns/${c.id}`}>{c.name}</Link><small>{t('dashboard.campaignLine', { sent: num(c.sent), opened: num(c.opened) })}</small></div>
                      <Pill tone={statusTone[c.status] ?? 'muted'}>{t(`campaigns.status.${c.status}`)}</Pill>
                    </li>
                  ))}
                </ul>
              ) : <p className="pe-muted">{t('campaigns.empty')}</p>}
            </div>
            <div className="pe-card">
              <div className="pe-card__head"><Workflow aria-hidden="true" className="pe-muted" width={18} /><h2>{t('nav.journeys')}</h2><span className="pe-spacer" /><Link to="/journeys">{t('dashboard.viewAll')}</Link></div>
              {journeys.data?.data.length ? (
                <ul className="pe-list">
                  {journeys.data.data.slice(0, 5).map((j) => (
                    <li key={j.id}>
                      <div className="pe-list__main"><Link to={`/journeys/${j.id}`}>{j.name}</Link><small>{t('dashboard.journeyLine', { active: num(j.active), completed: num(j.completed) })}</small></div>
                      <Pill tone={statusTone[j.status] ?? 'muted'} dot={j.status === 'active'}>{t(`journeys.status.${j.status}`)}</Pill>
                    </li>
                  ))}
                </ul>
              ) : <p className="pe-muted">{t('journeys.empty')}</p>}
            </div>
          </div>
        </div>
        <div className="pe-card">
          <div className="pe-card__head">
            <MousePointerClick aria-hidden="true" className="pe-muted" width={18} />
            <h2>{t('activity.title')}</h2>
            <span className="pe-spacer" />
            <Pill tone="success" live>{t('activity.live')}</Pill>
          </div>
          <ActivityFeed live limit={12} />
        </div>
      </div>
    </section>
  );
}
