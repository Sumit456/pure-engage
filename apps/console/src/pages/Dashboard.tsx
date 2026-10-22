import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.ts';
import type { Overview } from '../api/types.ts';
import { useUser } from '../auth/auth.tsx';
import { ErrorBanner, Spinner } from '../components/ui.tsx';

export function Dashboard() {
  const { t, i18n } = useTranslation();
  const user = useUser();
  const overview = useQuery({ queryKey: ['overview'], queryFn: ({ signal }) => api<Overview>('/api/reports/overview', { signal }) });
  const num = (n: number) => n.toLocaleString(i18n.language);
  const pct = (r: number | null) => (r === null ? '—' : new Intl.NumberFormat(i18n.language, { style: 'percent', maximumFractionDigits: 1 }).format(r));
  const o = overview.data;

  return (
    <section className="pe-stack">
      <h1>{t('dashboard.title')}</h1>
      <p className="pe-muted">{t('dashboard.hello', { name: user.name || user.email })}</p>
      <ErrorBanner error={overview.error} />
      {!o ? <Spinner /> : (
        <>
          <div className="pe-kpis">
            <div className="pe-card pe-kpi"><span className="pe-muted">{t('dashboard.kpi.contacts')}</span><strong data-testid="kpi-contacts">{num(o.contacts)}</strong><Link to="/contacts">{t('dashboard.view')}</Link></div>
            <div className="pe-card pe-kpi"><span className="pe-muted">{t('dashboard.kpi.careConsent')}</span><strong>{num(o.consent.email_care)} / {num(o.consent.sms_care)}</strong><small className="pe-muted">{t('dashboard.kpi.emailSms')}</small></div>
            <div className="pe-card pe-kpi"><span className="pe-muted">{t('dashboard.kpi.sent', { days: o.window_days })}</span><strong data-testid="kpi-sent">{num(o.messages.sent)}</strong><small className="pe-muted">{t('dashboard.kpi.notSent', { n: num(o.messages.not_sent) })}</small></div>
            <div className="pe-card pe-kpi"><span className="pe-muted">{t('dashboard.kpi.openRate')}</span><strong>{pct(o.email.open_rate)}</strong><small className="pe-muted">{t('dashboard.kpi.clickRate', { rate: pct(o.email.click_rate) })}</small></div>
            <div className="pe-card pe-kpi"><span className="pe-muted">{t('dashboard.kpi.activeRuns')}</span><strong>{num(o.journeys.active_runs)}</strong><Link to="/journeys">{t('dashboard.view')}</Link></div>
            <div className="pe-card pe-kpi"><span className="pe-muted">{t('dashboard.kpi.campaigns', { days: o.window_days })}</span><strong>{num(o.campaigns_sent)}</strong><Link to="/campaigns">{t('dashboard.view')}</Link></div>
          </div>
          <div className="pe-card pe-row"><span>{t('dashboard.reportsHint')}</span><span className="pe-spacer" /><Link to="/reports">{t('dashboard.goReports')}</Link></div>
        </>
      )}
    </section>
  );
}
