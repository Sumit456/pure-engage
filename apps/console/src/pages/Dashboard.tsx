import { useTranslation } from 'react-i18next';

export function Dashboard() {
  const { t } = useTranslation();
  return (
    <section>
      <h1>{t('dashboard.title')}</h1>
      <div className="pe-card">
        <p>{t('dashboard.welcome')}</p>
      </div>
    </section>
  );
}
