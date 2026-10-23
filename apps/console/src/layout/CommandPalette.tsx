// ⌘K / Ctrl+K command palette: jump to any page, run a quick action or open a contact by name, ID, email or phone.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { CornerDownLeft, KeyRound, LayoutTemplate, Megaphone, Plug, Upload, PenSquare, Search, User, Workflow, type LucideIcon } from 'lucide-react';
import { api } from '../api/client.ts';
import type { CampaignSummary, Contact, Journey, Page, Template } from '../api/types.ts';
import { NAV, NAV_ICONS, navPath } from './Shell.tsx';

interface Item { id: string; group: string; label: string; hint?: string; icon: LucideIcon; to: string }

export function CommandPalette() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [active, setActive] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); setOpen((o) => !o); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) { d.showModal?.(); setQ(''); setActive(0); }
    if (!open && d.open) d.close();
  }, [open]);
  useEffect(() => { const id = setTimeout(() => setDebounced(q.trim()), 200); return () => clearTimeout(id); }, [q]);

  const contacts = useQuery({
    queryKey: ['palette-contacts', debounced],
    enabled: open && debounced.length >= 2,
    queryFn: ({ signal }) => api<Page<Contact>>(`/api/contacts?limit=6&q=${encodeURIComponent(debounced)}`, { signal }),
  });

  // Names of campaigns, journeys and templates are searched locally (these lists are small).
  const named = useQuery({
    queryKey: ['palette-named'],
    enabled: open,
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const [c, j, tp] = await Promise.all([
        api<{ data: CampaignSummary[] }>('/api/campaigns', { signal }),
        api<{ data: Journey[] }>('/api/journeys', { signal }),
        api<{ data: Template[] }>('/api/templates', { signal }),
      ]);
      return { campaigns: c.data, journeys: j.data, templates: tp.data };
    },
  });

  const items = useMemo<Item[]>(() => {
    const needle = q.trim().toLowerCase();
    const match = (s: string) => !needle || s.toLowerCase().includes(needle);
    const actions: Item[] = [
      { id: 'a-import', group: t('shell.palette.actions'), label: t('shell.palette.importContacts'), icon: Upload, to: '/contacts/import' },
      { id: 'a-campaign', group: t('shell.palette.actions'), label: t('shell.palette.newCampaign'), icon: Megaphone, to: '/campaigns/new' },
      { id: 'a-journey', group: t('shell.palette.actions'), label: t('shell.palette.newJourney'), icon: Workflow, to: '/journeys/new' },
      { id: 'a-template', group: t('shell.palette.actions'), label: t('shell.palette.newTemplate'), icon: PenSquare, to: '/templates/new' },
      { id: 'a-connect', group: t('shell.palette.actions'), label: t('shell.palette.connectApp'), icon: Plug, to: '/integrations/inbound/new' },
      { id: 'a-key', group: t('shell.palette.actions'), label: t('shell.palette.apiKeys'), icon: KeyRound, to: '/integrations/api' },
    ].filter((i) => match(i.label));
    const pages: Item[] = NAV.map((k) => ({ id: `p-${k}`, group: t('shell.palette.pages'), label: t(`nav.${k}`), icon: NAV_ICONS[k], to: navPath(k) })).filter((i) => match(i.label));
    const people: Item[] = (debounced.length >= 2 ? contacts.data?.data ?? [] : []).map((c) => ({
      id: `c-${c.id}`, group: t('nav.contacts'), icon: User, to: `/contacts/${c.id}`,
      label: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || c.phone || c.external_id || c.id,
      hint: c.external_id ?? c.email ?? undefined,
    }));
    const n = named.data;
    const things: Item[] = needle && n ? [
      ...n.campaigns.map((c) => ({ id: `cp-${c.id}`, group: t('nav.campaigns'), label: c.name, icon: Megaphone, to: `/campaigns/${c.id}` })),
      ...n.journeys.map((j) => ({ id: `j-${j.id}`, group: t('nav.journeys'), label: j.name, icon: Workflow, to: `/journeys/${j.id}` })),
      ...n.templates.map((tp) => ({ id: `t-${tp.id}`, group: t('nav.templates'), label: tp.name, icon: LayoutTemplate, to: `/templates/${tp.id}` })),
    ].filter((i) => match(i.label)).slice(0, 12) : [];
    return [...actions, ...pages, ...things, ...people];
  }, [q, debounced, contacts.data, named.data, t]);

  useEffect(() => { setActive((a) => Math.min(a, Math.max(0, items.length - 1))); }, [items.length]);
  const go = (item: Item | undefined) => { if (!item) return; setOpen(false); navigate(item.to); };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    if (e.key === 'Enter') { e.preventDefault(); go(items[active]); }
  };

  let lastGroup = '';
  return (
    <>
      <button type="button" className="pe-search-trigger" onClick={() => setOpen(true)}>
        <Search aria-hidden="true" />
        <span>{t('shell.search')}</span>
        <kbd>{isMac ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
      <dialog ref={dialog} className="pe-palette" aria-label={t('shell.search')} onClose={() => setOpen(false)} onClick={(e) => { if (e.target === dialog.current) setOpen(false); }}>
        <div className="pe-palette__input">
          <Search aria-hidden="true" />
          <input
            autoFocus value={q} onChange={(e) => { setQ(e.target.value); setActive(0); }} onKeyDown={onKeyDown}
            placeholder={t('shell.searchPlaceholder')} aria-label={t('shell.search')} role="combobox" aria-expanded="true" aria-controls="pe-palette-list"
            aria-activedescendant={items[active] ? `pe-palette-${items[active]!.id}` : undefined}
          />
        </div>
        <ul id="pe-palette-list" role="listbox" className="pe-palette__list">
          {items.length === 0 && <li className="pe-palette__empty">{t('shell.palette.noResults')}</li>}
          {items.map((item, i) => {
            const header = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <li key={item.id} role="presentation">
                {header && <div className="pe-palette__group" role="presentation">{header}</div>}
                <div
                  id={`pe-palette-${item.id}`} role="option" aria-selected={i === active} className="pe-palette__item"
                  onMouseEnter={() => setActive(i)} onClick={() => go(item)}
                >
                  <item.icon aria-hidden="true" />
                  <span>{item.label}</span>
                  {item.hint && <span className="pe-palette__hint pe-ltr">{item.hint}</span>}
                  {i === active && <CornerDownLeft className="pe-palette__enter" aria-hidden="true" />}
                </div>
              </li>
            );
          })}
        </ul>
      </dialog>
    </>
  );
}
