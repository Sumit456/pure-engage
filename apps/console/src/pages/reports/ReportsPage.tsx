import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import type { CampaignReportRow, JourneyReportRow, MessagesReport } from '../../api/types.ts';
import { BarList, LineChart } from '../../components/LineChart.tsx';
import { ErrorBanner, Spinner, TextField } from '../../components/ui.tsx';
import { CampaignStatusBadge } from '../campaigns/CampaignsPage.tsx';
import { JourneyStatusBadge } from '../journeys/JourneysPage.tsx';

const daysBefore = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

export function ReportsPage() {
  const { t, i18n } = useTranslation();
  // No range until the user picks one: the API defaults to the last 30 days ending today in the platform's time
  // zone (the browser's clock and zone can't be trusted to agree with it).
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const qs = range ? `from=${range.from}&to=${range.to}` : '';
  const messages = useQuery({ queryKey: ['report', 'messages', qs], queryFn: ({ signal }) => api<MessagesReport>(`/api/reports/messages?${qs}`, { signal }) });
  const campaigns = useQuery({ queryKey: ['report', 'campaigns', qs], queryFn: ({ signal }) => api<{ data: CampaignReportRow[] }>(`/api/reports/campaigns?${qs}`, { signal }) });
  const journeys = useQuery({ queryKey: ['report', 'journeys'], queryFn: ({ signal }) => api<{ data: JourneyReportRow[] }>('/api/reports/journeys', { signal }) });

  const chart = useMemo(() => {
    const days = [...new Set(messages.data?.days.map((d) => d.day) ?? [])];
    const of = (ch: 'email' | 'sms') => days.map((day) => messages.data!.days.find((d) => d.day === day && d.channel === ch)?.sent ?? 0);
    return { days, email: messages.data ? of('email') : [], sms: messages.data ? of('sms') : [] };
  }, [messages.data]);
  const totals = useMemo(() => {
    const sum = (k: 'sent' | 'delivered' | 'opened' | 'clicked' | 'failed' | 'not_sent', ch?: string) => (messages.data?.days ?? []).filter((d) => !ch || d.channel === ch).reduce((n, d) => n + d[k], 0);
    return { sent: sum('sent'), emailSent: sum('sent', 'email'), opened: sum('opened', 'email'), clicked: sum('clicked', 'email'), failed: sum('failed'), notSent: sum('not_sent') };
  }, [messages.data]);
  const dayFmt = new Intl.DateTimeFormat(i18n.language === 'ar' ? 'ar-AE' : 'en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const num = (n: number) => n.toLocaleString(i18n.language);
  const pct = (a: number, b: number) => (b ? new Intl.NumberFormat(i18n.language, { style: 'percent', maximumFractionDigits: 1 }).format(a / b) : '—');
  const shown = range ?? (messages.data ? { from: messages.data.from, to: messages.data.to } : null);
  const today = messages.data?.today;
  const preset = (n: number) => today && setRange({ from: daysBefore(today, n - 1), to: today });

  return (
    <section className="pe-stack">
      <div className="pe-page-header">
        <h1>{t('nav.reports')}</h1>
        <span className="pe-spacer" />
        <div className="pe-row" role="group" aria-label={t('reports.range')}>
          {[7, 30, 90].map((n) => <button key={n} type="button" className="pe-button pe-button--ghost" disabled={!today} onClick={() => preset(n)}>{t('reports.lastDays', { n })}</button>)}
          <TextField label={t('reports.from')} type="date" value={shown?.from ?? ''} max={shown?.to} disabled={!shown} onChange={(e) => shown && e.target.value && setRange({ ...shown, from: e.target.value })} />
          <TextField label={t('reports.to')} type="date" value={shown?.to ?? ''} min={shown?.from} disabled={!shown} onChange={(e) => shown && e.target.value && setRange({ ...shown, to: e.target.value })} />
        </div>
      </div>
      <ErrorBanner error={messages.error} />

      {!messages.data ? <Spinner /> : (
        <>
          <div className="pe-kpis">
            <div className="pe-card pe-kpi"><span className="pe-muted">{t('reports.sent')}</span><strong data-testid="report-sent">{num(totals.sent)}</strong></div>
            <div className="pe-card pe-kpi"><span className="pe-muted">{t('reports.emailOpenRate')}</span><strong>{pct(totals.opened, totals.emailSent)}</strong></div>
            <div className="pe-card pe-kpi"><span className="pe-muted">{t('reports.emailClickRate')}</span><strong>{pct(totals.clicked, totals.emailSent)}</strong></div>
            <div className="pe-card pe-kpi"><span className="pe-muted">{t('reports.notSent')}</span><strong>{num(totals.notSent)}</strong></div>
            <div className="pe-card pe-kpi"><span className="pe-muted">{t('reports.failed')}</span><strong>{num(totals.failed)}</strong></div>
          </div>
          <div className="pe-card">
            <LineChart
              title={t('reports.sentPerDay')}
              labels={chart.days}
              formatLabel={(d) => dayFmt.format(new Date(`${d}T00:00:00Z`))}
              series={[
                { key: 'email', label: t('consent.channel_email'), color: 'var(--pe-series-1)', values: chart.email },
                { key: 'sms', label: t('consent.channel_sms'), color: 'var(--pe-series-2)', values: chart.sms },
              ]}
            />
            <div className="pe-row"><span className="pe-spacer" /><a href={`/api/reports/messages.csv?${qs}`} download>{t('reports.exportCsv')}</a></div>
          </div>
          <div className="pe-card">
            <BarList title={t('reports.whyNotSent')} empty={t('reports.allSent')} items={messages.data.not_sent.map((r) => ({ label: t(`messages.reason.${r.reason}`, { defaultValue: r.reason }), value: r.count }))} />
          </div>
        </>
      )}

      <div className="pe-card pe-stack">
        <div className="pe-row"><h2 style={{ margin: 0 }}>{t('nav.campaigns')}</h2><span className="pe-spacer" /><a href={`/api/reports/campaigns.csv?${qs}`} download>{t('reports.exportCsv')}</a></div>
        <ErrorBanner error={campaigns.error} />
        {!campaigns.data ? <Spinner /> : !campaigns.data.data.length ? <p className="pe-muted">{t('reports.noCampaigns')}</p> : (
          <div className="pe-table-wrap">
            <table className="pe-table">
              <thead><tr><th>{t('templates.field.name')}</th><th>{t('messages.statusLabel')}</th><th>{t('templates.field.channel')}</th><th>{t('campaigns.stat.targeted')}</th><th>{t('campaigns.stat.sent')}</th><th>{t('reports.openRate')}</th><th>{t('reports.clickRate')}</th></tr></thead>
              <tbody>
                {campaigns.data.data.map((c) => (
                  <tr key={c.id}>
                    <td><Link to={`/campaigns/${c.id}`}>{c.name}</Link></td><td><CampaignStatusBadge status={c.status} /></td><td>{t(`consent.channel_${c.channel}`)}</td>
                    <td>{num(c.targeted)}</td><td>{num(c.sent)}</td><td>{c.channel === 'email' ? pct(c.opened, c.sent) : '—'}</td><td>{c.channel === 'email' ? pct(c.clicked, c.sent) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="pe-card pe-stack">
        <h2>{t('nav.journeys')}</h2>
        {!journeys.data ? <Spinner /> : !journeys.data.data.length ? <p className="pe-muted">{t('journeys.empty')}</p> : (
          <div className="pe-table-wrap">
            <table className="pe-table">
              <thead><tr><th>{t('templates.field.name')}</th><th>{t('messages.statusLabel')}</th><th>{t('reports.runs')}</th><th>{t('journeys.runs.active')}</th><th>{t('journeys.runs.completed')}</th><th>{t('journeys.runs.exited')}</th></tr></thead>
              <tbody>
                {journeys.data.data.map((j) => (
                  <tr key={j.id}><td><Link to={`/journeys/${j.id}`}>{j.name}</Link></td><td><JourneyStatusBadge status={j.status} /></td><td>{num(j.runs)}</td><td>{num(j.active)}</td><td>{num(j.completed)}</td><td>{num(j.exited)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
