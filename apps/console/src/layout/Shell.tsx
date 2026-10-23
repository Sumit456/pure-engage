import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart3, ChevronsLeft, ChevronsRight, Filter, HeartPulse, Languages, LayoutDashboard, LayoutTemplate, LogOut, Megaphone, Menu,
  MessagesSquare, Moon, Plug, Settings, ShieldCheck, Sun, Users, Workflow, type LucideIcon,
} from 'lucide-react';
import { LANGUAGES, type Language } from '../i18n/index.ts';
import { useLogout, useUser } from '../auth/auth.tsx';
import { api } from '../api/client.ts';
import type { DeliveryStatus } from '../api/types.ts';
import { applyTheme, effectiveTheme } from '../theme/theme.ts';
import { CommandPalette } from './CommandPalette.tsx';
import { Initials, Pill } from '../components/bits.tsx';
import './shell.css';

export const NAV = ['dashboard', 'contacts', 'segments', 'templates', 'campaigns', 'journeys', 'messages', 'integrations', 'reports', 'settings'] as const;
export type NavKey = (typeof NAV)[number];

export const NAV_ICONS: Record<NavKey, LucideIcon> = {
  dashboard: LayoutDashboard, contacts: Users, segments: Filter, templates: LayoutTemplate, campaigns: Megaphone,
  journeys: Workflow, messages: MessagesSquare, integrations: Plug, reports: BarChart3, settings: Settings,
};
const GROUPS: { label: string | null; items: NavKey[] }[] = [
  { label: null, items: ['dashboard'] },
  { label: 'audience', items: ['contacts', 'segments'] },
  { label: 'engage', items: ['templates', 'campaigns', 'journeys', 'messages'] },
  { label: 'connect', items: ['integrations'] },
  { label: 'insights', items: ['reports', 'settings'] },
];
export const navPath = (key: NavKey) => (key === 'dashboard' ? '/' : `/${key}`);

function readCollapsed() {
  try { return localStorage.getItem('pe.sidebar') === 'collapsed'; } catch { return false; }
}

export function Shell() {
  const { t, i18n } = useTranslation();
  const user = useUser();
  const logout = useLogout();
  const navigate = useNavigate();
  const location = useLocation();
  const lang = (i18n.language === 'ar' ? 'ar' : 'en') satisfies Language;
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useState(effectiveTheme);
  const delivery = useQuery({ queryKey: ['delivery-status'], queryFn: () => api<DeliveryStatus>('/api/delivery/status'), staleTime: 5 * 60_000 });

  useEffect(() => { setMobileOpen(false); setMenuOpen(false); }, [location.pathname]);
  const toggleCollapsed = () => setCollapsed((c) => {
    try { localStorage.setItem('pe.sidebar', c ? 'expanded' : 'collapsed'); } catch { /* per-browser convenience only */ }
    return !c;
  });
  const toggleTheme = () => { const next = theme === 'dark' ? 'light' : 'dark'; applyTheme(next); setTheme(next); };
  const name = user.name || user.email;
  const mode = delivery.data?.mode;

  return (
    <div className="pe-shell" data-collapsed={collapsed || undefined} data-mobile-open={mobileOpen || undefined}>
      <aside className="pe-sidebar" aria-label={t('nav.main')}>
        <div className="pe-brand">
          <span className="pe-brand__mark" aria-hidden="true"><HeartPulse /></span>
          <span className="pe-brand__text">
            <span className="pe-brand__name">{t('app.name')}</span>
            <span className="pe-brand__tag">{t('shell.org')}</span>
          </span>
        </div>
        <nav aria-label={t('nav.main')} className="pe-nav">
          {GROUPS.map((g, i) => (
            <div key={i} className="pe-nav__group">
              {g.label && <div className="pe-nav__label">{t(`shell.groups.${g.label}`)}</div>}
              {g.items.map((key) => {
                const Icon = NAV_ICONS[key];
                return (
                  <NavLink key={key} to={navPath(key)} end={key === 'dashboard'} className="pe-nav__link" title={collapsed ? t(`nav.${key}`) : undefined}>
                    <Icon aria-hidden="true" />
                    <span>{t(`nav.${key}`)}</span>
                  </NavLink>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="pe-sidebar__foot">
          <div className="pe-sidebar__note">
            <ShieldCheck aria-hidden="true" />
            <span>{mode === 'live' ? t('shell.noteLive') : t('shell.noteSandbox')}</span>
          </div>
          <button type="button" className="pe-icon-button pe-collapse" onClick={toggleCollapsed} aria-label={collapsed ? t('shell.expand') : t('shell.collapse')} aria-pressed={collapsed}>
            {(collapsed !== (lang === 'ar')) ? <ChevronsRight aria-hidden="true" /> : <ChevronsLeft aria-hidden="true" />}
          </button>
        </div>
      </aside>
      <button type="button" className="pe-scrim" aria-label={t('shell.closeMenu')} onClick={() => setMobileOpen(false)} tabIndex={-1} />

      <div className="pe-main">
        <header className="pe-topbar">
          <button type="button" className="pe-icon-button pe-only-mobile" onClick={() => setMobileOpen(true)} aria-label={t('shell.openMenu')}><Menu aria-hidden="true" /></button>
          <CommandPalette />
          <span className="pe-spacer" />
          {mode && (
            <span className="pe-only-wide">
              {mode === 'sandbox'
                ? <Pill tone="warning" dot>{t('shell.badge.sandbox')}</Pill>
                : <Pill tone="success" live>{delivery.data?.allowlist ? t('shell.badge.liveAllowlist') : t('shell.badge.live')}</Pill>}
            </span>
          )}
          <label className="pe-lang">
            <Languages aria-hidden="true" />
            <span className="pe-visually-hidden">{t('common.language')}</span>
            <select value={lang} onChange={(e) => void i18n.changeLanguage(e.target.value)}>
              {Object.entries(LANGUAGES).map(([code, { label }]) => <option key={code} value={code}>{label}</option>)}
            </select>
          </label>
          <button type="button" className="pe-icon-button" onClick={toggleTheme} aria-label={theme === 'dark' ? t('shell.lightMode') : t('shell.darkMode')}>
            {theme === 'dark' ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
          </button>
          <div className="pe-usermenu">
            <button type="button" className="pe-usermenu__trigger" aria-haspopup="menu" aria-expanded={menuOpen} aria-label={t('shell.userMenu')} onClick={() => setMenuOpen((o) => !o)}>
              <Initials name={name} />
            </button>
            {menuOpen && (
              <div className="pe-usermenu__panel" role="menu" onKeyDown={(e) => e.key === 'Escape' && setMenuOpen(false)}>
                <div className="pe-usermenu__who">
                  <strong>{name}</strong>
                  <span className="pe-muted">{user.email}</span>
                  <Pill tone="primary">{t(`roles.${user.role}`)}</Pill>
                </div>
                <NavLink role="menuitem" to="/settings" className="pe-usermenu__item"><Settings aria-hidden="true" />{t('nav.settings')}</NavLink>
                <button type="button" role="menuitem" className="pe-usermenu__item" disabled={logout.isPending} onClick={() => logout.mutate(undefined, { onSettled: () => navigate('/login', { replace: true }) })}>
                  <LogOut aria-hidden="true" />{t('auth.signOut')}
                </button>
              </div>
            )}
          </div>
        </header>
        {mode === 'sandbox' && <div className="pe-banner" role="status">{t('delivery.sandboxBanner')}</div>}
        <main className="pe-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
