import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LANGUAGES, type Language } from '../i18n/index.ts';
import { useLogout, useUser } from '../auth/auth.tsx';
import { Badge, Button } from '../components/ui.tsx';
import './shell.css';

export const NAV = ['dashboard', 'contacts', 'segments', 'templates', 'campaigns', 'journeys', 'messages', 'reports', 'settings'] as const;

export function Shell() {
  const { t, i18n } = useTranslation();
  const user = useUser();
  const logout = useLogout();
  const navigate = useNavigate();
  const lang = (i18n.language === 'ar' ? 'ar' : 'en') satisfies Language;

  return (
    <div className="pe-shell">
      <aside className="pe-sidebar">
        <div className="pe-brand">
          <span className="pe-brand__mark" aria-hidden="true">PE</span>
          <span className="pe-brand__name">{t('app.name')}</span>
        </div>
        <nav aria-label={t('nav.main')}>
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
          <div className="pe-row">
            <label className="pe-lang">
              <span className="pe-visually-hidden">{t('common.language')}</span>
              <select value={lang} onChange={(e) => void i18n.changeLanguage(e.target.value)}>
                {Object.entries(LANGUAGES).map(([code, { label }]) => <option key={code} value={code}>{label}</option>)}
              </select>
            </label>
            <span>{user.name || user.email}</span>
            <Badge tone="brand">{t(`roles.${user.role}`)}</Badge>
            <Button variant="ghost" busy={logout.isPending} onClick={() => logout.mutate(undefined, { onSettled: () => navigate('/login', { replace: true }) })}>
              {t('auth.signOut')}
            </Button>
          </div>
        </header>
        <main className="pe-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
