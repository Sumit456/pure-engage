import { useTranslation } from 'react-i18next';

export function ComingSoon({ section }: { section: string }) {
  const { t } = useTranslation();
  return (
    <section>
      <h1>{t(`nav.${section}`)}</h1>
      <p className="pe-muted">{t('common.comingSoon')}</p>
    </section>
  );
}
