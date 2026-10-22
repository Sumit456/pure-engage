import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useUser } from '../auth/auth.tsx';

export function Dashboard() {
  const { t } = useTranslation();
  const user = useUser();
  return (
    <section className="pe-stack">
      <h1>{t('dashboard.title')}</h1>
      <div className="pe-card pe-stack">
        <strong>{t('dashboard.hello', { name: user.name || user.email })}</strong>
        <p>{t('dashboard.welcome')}</p>
        <div><Link to="/contacts">{t('dashboard.goContacts')}</Link></div>
      </div>
    </section>
  );
}
