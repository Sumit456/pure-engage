import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.ts';
import type { Contact, Page } from '../api/types.ts';
import { displayName } from '../pages/contacts/ContactsPage.tsx';
import { Badge, Button } from './ui.tsx';

/** Search-as-you-type contact chooser. */
export function ContactPicker({ label, placeholder, value, onChange }: { label: string; placeholder: string; value: Contact | null; onChange: (c: Contact | null) => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const id = setTimeout(() => setDebounced(q.trim()), 300); return () => clearTimeout(id); }, [q]);
  const results = useQuery({
    queryKey: ['contacts', 'picker', debounced],
    enabled: debounced.length > 1,
    queryFn: ({ signal }) => api<Page<Contact>>(`/api/contacts?limit=5&q=${encodeURIComponent(debounced)}`, { signal }),
  });
  if (value) {
    return <span className="pe-row"><span className="pe-muted">{label}</span> <Badge tone="brand">{displayName(value)}</Badge><Button variant="ghost" aria-label={t('common.clear')} onClick={() => onChange(null)}>×</Button></span>;
  }
  return (
    <div className="pe-picker">
      <input className="pe-search" type="search" placeholder={placeholder} aria-label={label} value={q} onChange={(e) => setQ(e.target.value)} />
      {results.data && debounced.length > 1 && (
        <ul className="pe-picker__list" role="listbox" aria-label={label}>
          {results.data.data.map((c) => <li key={c.id}><button type="button" role="option" aria-selected={false} onClick={() => { onChange(c); setQ(''); }}>{displayName(c)}</button></li>)}
          {!results.data.data.length && <li className="pe-muted">{t('contacts.noMatches')}</li>}
        </ul>
      )}
    </div>
  );
}
