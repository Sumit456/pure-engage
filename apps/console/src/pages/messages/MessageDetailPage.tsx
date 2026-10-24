import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import type { MessageDetail } from '../../api/types.ts';
import { Badge, ErrorBanner, Ltr, Spinner, useFormatDate } from '../../components/ui.tsx';
import { MessageStatusBadge } from './MessageStatusBadge.tsx';

export function MessageDetailPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const formatDate = useFormatDate();
  const msg = useQuery({ queryKey: ['message', id], queryFn: ({ signal }) => api<MessageDetail>(`/api/messages/${id}`, { signal }) });

  if (msg.isPending) return <div className="pe-center"><Spinner /></div>;
  if (msg.error || !msg.data) return <ErrorBanner error={msg.error} />;
  const m = msg.data;

  return (
    <section>
      <div className="pe-page-header"><Link to="/messages" className="pe-muted">{t('messages.backToList')}</Link></div>
      <div className="pe-page-header">
        <h1>{m.subject ?? m.template_name ?? t('messages.message')}</h1>
        <MessageStatusBadge status={m.status} reason={m.status_reason} />
      </div>
      <div className="pe-grid-2">
        <div className="pe-card pe-stack">
          <dl className="pe-dl">
            <dt>{t('messages.to')}</dt><dd><Link to={`/contacts/${m.contact_id}`}><Ltr>{m.to_address ?? '—'}</Ltr></Link></dd>
            <dt>{t('messages.template')}</dt><dd>{m.template_id ? <Link to={`/templates/${m.template_id}`}>{m.template_name}</Link> : '—'}</dd>
            <dt>{t('templates.field.channel')}</dt><dd>{t(`consent.channel_${m.channel}`)} · {t(`consent.purpose.${m.purpose}`)} · {m.locale === 'ar' ? 'العربية' : 'English'}</dd>
            <dt>{t('messages.provider')}</dt><dd>{m.provider ? <Badge>{m.provider}</Badge> : '—'}</dd>
            <dt>{t('messages.created')}</dt><dd>{formatDate(m.created_at)}</dd>
            {m.next_attempt_at && <><dt>{t('messages.nextAttempt')}</dt><dd>{formatDate(m.next_attempt_at)}</dd></>}
            <dt>{t('messages.sentAt')}</dt><dd>{formatDate(m.sent_at)}</dd>
            <dt>{t('messages.attempts')}</dt><dd>{m.attempts}</dd>
          </dl>
          <h3>{t('messages.timeline')}</h3>
          {m.events.length ? (
            <ul className="pe-timeline">
              {m.events.map((e) => <li key={e.id}><strong>{t(`messages.event.${e.type}`, { defaultValue: e.type })}</strong> <small className="pe-muted">{formatDate(e.at)}</small>{e.detail && <div><code><Ltr>{e.detail}</Ltr></code></div>}</li>)}
            </ul>
          ) : <p className="pe-muted">{t('messages.noEvents')}</p>}
        </div>
        <div className="pe-card pe-stack">
          <h2>{t('messages.content')}</h2>
          {m.status === 'suppressed' ? <p className="pe-muted">{t('messages.suppressedNoContent')}</p>
            : m.channel === 'email' && m.body_html_preview ? <iframe title={t('messages.content')} className="pe-preview" sandbox="" srcDoc={m.body_html_preview} />
            : <div className="pe-sms-bubble" dir={m.locale === 'ar' ? 'rtl' : 'ltr'}>{m.body_text}</div>}
        </div>
      </div>
    </section>
  );
}
