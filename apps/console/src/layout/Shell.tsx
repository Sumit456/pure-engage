import { NavLink, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LANGUAGES, type Language } from '../i18n/index.ts';
import './shell.css';

export const NAV = ['dashboard', 'contacts', 'segments', 'templates', 'campaigns', 'journeys', 'messages', 'reports', 'settings'] as const;

export function Shell() {
  const { t, i18n } = useTranslation();
  const lang = (i18n.language === 'ar' ? 'ar' : 'en') satisfies Language;

  return (
    <div className="pe-shell">
      <aside className="pe-sidebar">
        <div className="pe-brand">
          <span className="pe-brand__mark" aria-hidden="true">PE</span>
          <span className="pe-brand__name">{t('app.name')}</span>
        </div>
        <nav aria-label="Main">
          {NAV.map((key) => (
            <NavLink key={key} to={key === 'dashboard' ? '/' : `/${key}`} end={key === 'dashboard'} className="pe-nav__link">
              {t(`nav.${key}`)}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="pe-main">
        <header className="pe-topbar">
          <span className="pe-muted">{t('app.tagline')}</span>
          <label className="pe-lang">
            <span className="pe-visually-hidden">{t('common.language')}</span>
            <select value={lang} onChange={(e) => void i18n.changeLanguage(e.target.value)}>
              {Object.entries(LANGUAGES).map(([code, { label }]) => <option key={code} value={code}>{label}</option>)}
            </select>
          </label>
        </header>
        <main className="pe-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
