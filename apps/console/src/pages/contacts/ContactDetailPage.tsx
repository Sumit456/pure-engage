import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client.ts';
import type { ContactDetail } from '../../api/types.ts';
import { hasRole, useUser } from '../../auth/auth.tsx';
import { Badge, Button, Dialog, EmptyState, ErrorBanner, Ltr, Spinner, useFormatDate } from '../../components/ui.tsx';
import { ConsentMatrix } from './ConsentMatrix.tsx';
import { ContactFormDialog } from './ContactForm.tsx';
import { displayName } from './ContactsPage.tsx';
import { MessageList } from '../messages/MessagesPage.tsx';

export function ContactDetailPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const user = useUser();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const formatDate = useFormatDate();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const contact = useQuery({
    queryKey: ['contact', id],
    queryFn: ({ signal }) => api<ContactDetail>(`/api/contacts/${id}`, { signal }),
    retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 1,
  });
  const remove = useMutation({
    mutationFn: () => api<void>(`/api/contacts/${id}`, { method: 'DELETE' }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['contacts'] }); navigate('/contacts', { replace: true }); },
  });

  if (contact.isPending) return <div className="pe-center"><Spinner /></div>;
  if (contact.error instanceof ApiError && contact.error.status === 404) {
    return <EmptyState title={t('contacts.notFound')}><Link to="/contacts">{t('contacts.backToList')}</Link></EmptyState>;
  }
  if (contact.error || !contact.data) return <ErrorBanner error={contact.error} />;
  const c = contact.data;
  const attributes = Object.entries(c.attributes);

  return (
    <section>
      <div className="pe-page-header">
        <Link to="/contacts" className="pe-muted">{t('contacts.backToList')}</Link>
      </div>
      <div className="pe-page-header">
        <h1>{displayName(c)}</h1>
        {c.external_id && <Badge tone="brand"><Ltr>{c.external_id}</Ltr></Badge>}
        <span className="pe-spacer" />
        {hasRole(user, 'marketer') && <Button onClick={() => setEditing(true)}>{t('common.edit')}</Button>}
        {hasRole(user, 'admin') && <Button variant="danger" onClick={() => setConfirmDelete(true)}>{t('common.delete')}</Button>}
      </div>

      <div className="pe-grid-2">
        <div className="pe-card pe-stack">
          <h2>{t('contacts.profile')}</h2>
          <dl className="pe-dl">
            <dt>{t('contacts.field.email')}</dt><dd><Ltr>{c.email ?? '—'}</Ltr></dd>
            <dt>{t('contacts.field.phone')}</dt><dd><Ltr>{c.phone ?? '—'}</Ltr></dd>
            <dt>{t('contacts.field.preferred_language')}</dt><dd>{c.preferred_language ?? '—'}</dd>
            <dt>{t('contacts.field.timezone')}</dt><dd><Ltr>{c.timezone ?? '—'}</Ltr></dd>
            <dt>{t('contacts.field.created_at')}</dt><dd>{formatDate(c.created_at)}</dd>
            <dt>{t('contacts.field.updated_at')}</dt><dd>{formatDate(c.updated_at)}</dd>
          </dl>
          <h3>{t('contacts.attributes')}</h3>
          {attributes.length ? (
            <dl className="pe-dl">
              {attributes.map(([k, v]) => [<dt key={`${k}-k`}><Ltr>{k}</Ltr></dt>, <dd key={`${k}-v`}>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>])}
            </dl>
          ) : <p className="pe-muted">{t('contacts.noAttributes')}</p>}
        </div>

        <div className="pe-card pe-stack">
          <h2>{t('consent.title')}</h2>
          <ConsentMatrix value={c.consent} />
          <p className="pe-muted">{t('consent.explainer')}</p>
          <h3>{t('consent.history')}</h3>
          {c.consent_history.length ? (
            <ul className="pe-timeline">
              {c.consent_history.map((h) => (
                <li key={h.id}>
                  <div>{t(`consent.channel_${h.channel}`)} · {t(`consent.purpose.${h.purpose}`)}: {t(`consent.status.${h.previous_status ?? 'unknown'}`)} → <strong>{t(`consent.status.${h.status}`)}</strong></div>
                  <small className="pe-muted">{formatDate(h.changed_at)} · {t('common.source')}: {h.source}</small>
                </li>
              ))}
            </ul>
          ) : <p className="pe-muted">{t('consent.noHistory')}</p>}
        </div>
      </div>

      <div className="pe-card pe-stack" style={{ marginBlockStart: 16 }}>
        <h2>{t('contacts.recentActivity')}</h2>
        {c.recent_events.length ? (
          <ul className="pe-timeline">
            {c.recent_events.map((e) => (
              <li key={e.id}>
                <div><strong><Ltr>{e.name}</Ltr></strong> <Badge>{e.source}</Badge></div>
                <small className="pe-muted">{formatDate(e.occurred_at)}</small>
                {Object.keys(e.properties).length > 0 && <div><code><Ltr>{JSON.stringify(e.properties)}</Ltr></code></div>}
              </li>
            ))}
          </ul>
        ) : <p className="pe-muted">{t('contacts.noActivity')}</p>}
      </div>

      <div className="pe-card pe-stack" style={{ marginBlockStart: 16 }}>
        <h2>{t('nav.messages')}</h2>
        <MessageList contactId={c.id} compact />
      </div>

      {editing && <ContactFormDialog open contact={c} onClose={() => setEditing(false)} />}
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t('contacts.deleteTitle')}
        footer={<>
          <Button onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</Button>
          <Button variant="danger" busy={remove.isPending} onClick={() => remove.mutate()}>{t('common.delete')}</Button>
        </>}
      >
        <p>{t('contacts.deleteWarning', { name: displayName(c) })}</p>
        <ErrorBanner error={remove.error} />
      </Dialog>
    </section>
  );
}
