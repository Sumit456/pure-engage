import { useEffect, useState } from 'react';
import { Upload } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import type { Contact, Page } from '../../api/types.ts';
import { hasRole, useUser } from '../../auth/auth.tsx';
import { Button, EmptyState, ErrorBanner, Ltr, Spinner, useFormatDate } from '../../components/ui.tsx';
import { ConsentSummary } from './ConsentMatrix.tsx';
import { ContactFormDialog } from './ContactForm.tsx';

export const displayName = (c: Pick<Contact, 'first_name' | 'last_name' | 'external_id' | 'email'>) =>
  [c.first_name, c.last_name].filter(Boolean).join(' ') || c.external_id || c.email || '—';

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const id = setTimeout(() => setV(value), ms); return () => clearTimeout(id); }, [value, ms]);
  return v;
}

export function ContactsPage() {
  const { t } = useTranslation();
  const user = useUser();
  const navigate = useNavigate();
  const formatDate = useFormatDate();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const q = useDebounced(search.trim());
  const [creating, setCreating] = useState(false);

  useEffect(() => { setParams(q ? { q } : {}, { replace: true }); }, [q, setParams]);

  const contacts = useInfiniteQuery({
    queryKey: ['contacts', q],
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) => {
      const sp = new URLSearchParams({ limit: '50' });
      if (q) sp.set('q', q);
      if (pageParam) sp.set('cursor', pageParam);
      return api<Page<Contact>>(`/api/contacts?${sp}`, { signal });
    },
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const rows = contacts.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <section>
      <div className="pe-page-header">
        <h1>{t('nav.contacts')}</h1>
        <span className="pe-spacer" />
        <input
          className="pe-search"
          type="search"
          placeholder={t('contacts.searchPlaceholder')}
          aria-label={t('contacts.search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {hasRole(user, 'marketer') && <Link className="pe-button" to="/contacts/import"><Upload aria-hidden="true" />{t('contacts.import.title')}</Link>}
        {hasRole(user, 'marketer') && <Button variant="primary" onClick={() => setCreating(true)}>{t('contacts.new')}</Button>}
      </div>

      <div className="pe-card">
        <ErrorBanner error={contacts.error} />
        {contacts.isPending ? (
          <div className="pe-center"><Spinner /></div>
        ) : rows.length === 0 ? (
          <EmptyState title={q ? t('contacts.noMatches') : t('contacts.empty')}>{!q && t('contacts.emptyHint')}</EmptyState>
        ) : (
          <div className="pe-table-wrap">
            <table className="pe-table">
              <thead>
                <tr>
                  <th>{t('contacts.field.name')}</th>
                  <th>{t('contacts.field.external_id')}</th>
                  <th>{t('contacts.field.email')}</th>
                  <th>{t('contacts.field.phone')}</th>
                  <th>{t('consent.careConsent')}</th>
                  <th>{t('contacts.field.updated_at')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td><Link to={`/contacts/${c.id}`}>{displayName(c)}</Link></td>
                    <td><Ltr>{c.external_id ?? '—'}</Ltr></td>
                    <td><Ltr>{c.email ?? '—'}</Ltr></td>
                    <td><Ltr>{c.phone ?? '—'}</Ltr></td>
                    <td><ConsentSummary value={c.consent} /></td>
                    <td>{formatDate(c.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {contacts.hasNextPage && (
          <div className="pe-row" style={{ justifyContent: 'center', marginBlockStart: 16 }}>
            <Button onClick={() => void contacts.fetchNextPage()} busy={contacts.isFetchingNextPage}>{t('common.loadMore')}</Button>
          </div>
        )}
      </div>

      {creating && <ContactFormDialog open onClose={() => setCreating(false)} onSaved={(c) => navigate(`/contacts/${c.id}`)} />}
    </section>
  );
}
