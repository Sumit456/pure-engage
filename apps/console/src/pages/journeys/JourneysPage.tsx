import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import type { Journey, JourneyStatus } from '../../api/types.ts';
import { hasRole, useUser } from '../../auth/auth.tsx';
import { Badge, Button, EmptyState, ErrorBanner, Ltr, Spinner, type Tone } from '../../components/ui.tsx';

const TONE: Record<JourneyStatus, Tone> = { draft: 'neutral', active: 'success', paused: 'warning', archived: 'neutral' };

export function JourneyStatusBadge({ status }: { status: JourneyStatus }) {
  const { t } = useTranslation();
  return <Badge tone={TONE[status]}>{t(`journeys.status.${status}`)}</Badge>;
}

export function JourneysPage() {
  const { t } = useTranslation();
  const user = useUser();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const journeys = useQuery({ queryKey: ['journeys'], queryFn: ({ signal }) => api<{ data: Journey[] }>('/api/journeys', { signal }) });
  const starter = useMutation({
    mutationFn: () => api<Journey>('/api/journeys/starters/appointment-reminder', { method: 'POST' }),
    onSuccess: (j) => { void qc.invalidateQueries({ queryKey: ['journeys'] }); void qc.invalidateQueries({ queryKey: ['templates'] }); navigate(`/journeys/${j.id}`); },
  });

  return (
    <section>
      <div className="pe-page-header">
        <h1>{t('nav.journeys')}</h1>
        <span className="pe-spacer" />
        {hasRole(user, 'marketer') && <>
          <Button busy={starter.isPending} onClick={() => starter.mutate()}>{t('journeys.useStarter')}</Button>
          <Link className="pe-button pe-button--primary" to="/journeys/new">{t('journeys.new')}</Link>
        </>}
      </div>
      <ErrorBanner error={starter.error} />
      <div className="pe-card">
        <ErrorBanner error={journeys.error} />
        {journeys.isPending ? <div className="pe-center"><Spinner /></div> : !journeys.data?.data.length ? <EmptyState title={t('journeys.empty')}>{t('journeys.emptyHint')}</EmptyState> : (
          <div className="pe-table-wrap">
            <table className="pe-table">
              <thead><tr>
                <th>{t('templates.field.name')}</th><th>{t('messages.statusLabel')}</th><th>{t('journeys.trigger')}</th>
                <th>{t('journeys.runs.active')}</th><th>{t('journeys.runs.completed')}</th><th>{t('journeys.runs.exited')}</th><th>{t('campaigns.stat.sent')}</th>
              </tr></thead>
              <tbody>
                {journeys.data.data.map((j) => (
                  <tr key={j.id}>
                    <td><Link to={`/journeys/${j.id}`}>{j.name}</Link></td>
                    <td><JourneyStatusBadge status={j.status} /></td>
                    <td><code><Ltr>{j.trigger_event}</Ltr></code></td>
                    <td>{j.stats.enrollments.active.toLocaleString()}</td>
                    <td>{j.stats.enrollments.completed.toLocaleString()}</td>
                    <td>{j.stats.enrollments.exited.toLocaleString()}</td>
                    <td>{j.stats.messages.sent.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
