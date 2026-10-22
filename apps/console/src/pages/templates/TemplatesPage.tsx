import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import type { Template } from '../../api/types.ts';
import { hasRole, useUser } from '../../auth/auth.tsx';
import { Badge, EmptyState, ErrorBanner, Spinner, useFormatDate } from '../../components/ui.tsx';

export function TemplatesPage() {
  const { t } = useTranslation();
  const user = useUser();
  const formatDate = useFormatDate();
  const templates = useQuery({ queryKey: ['templates'], queryFn: ({ signal }) => api<{ data: Template[] }>('/api/templates', { signal }) });

  return (
    <section>
      <div className="pe-page-header">
        <h1>{t('nav.templates')}</h1>
        <span className="pe-spacer" />
        {hasRole(user, 'marketer') && <Link className="pe-button pe-button--primary" to="/templates/new">{t('templates.new')}</Link>}
      </div>
      <div className="pe-card">
        <ErrorBanner error={templates.error} />
        {templates.isPending ? <div className="pe-center"><Spinner /></div> : !templates.data?.data.length ? (
          <EmptyState title={t('templates.empty')}>{t('templates.emptyHint')}</EmptyState>
        ) : (
          <div className="pe-table-wrap">
            <table className="pe-table">
              <thead>
                <tr>
                  <th>{t('templates.field.name')}</th>
                  <th>{t('templates.field.channel')}</th>
                  <th>{t('templates.field.purpose')}</th>
                  <th>{t('templates.version')}</th>
                  <th>{t('contacts.field.updated_at')}</th>
                </tr>
              </thead>
              <tbody>
                {templates.data.data.map((tpl) => (
                  <tr key={tpl.id}>
                    <td><Link to={`/templates/${tpl.id}`}>{tpl.name}</Link></td>
                    <td>{t(`consent.channel_${tpl.channel}`)}</td>
                    <td><Badge tone={tpl.purpose === 'care' ? 'brand' : 'warning'}>{t(`consent.purpose.${tpl.purpose}`)}</Badge></td>
                    <td>v{tpl.current_version}</td>
                    <td>{formatDate(tpl.updated_at)}</td>
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
