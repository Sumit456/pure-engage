import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';
import ar from './ar.json';

export const LANGUAGES = { en: { dir: 'ltr', label: 'English' }, ar: { dir: 'rtl', label: 'العربية' } } as const;
export type Language = keyof typeof LANGUAGES;

const STORAGE_KEY = 'pe.lang';

function initialLanguage(): Language {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'ar') return saved;
  } catch { /* storage unavailable */ }
  return 'en';
}

// Keeps <html lang dir> in step so CSS logical properties flip the layout for Arabic.
export function applyLanguage(lang: Language): void {
  document.documentElement.lang = lang;
  document.documentElement.dir = LANGUAGES[lang].dir;
  try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* storage unavailable */ }
}

const lng = initialLanguage();
void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, ar: { translation: ar } },
  lng,
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});
applyLanguage(lng);
i18n.on('languageChanged', (l) => applyLanguage(l === 'ar' ? 'ar' : 'en'));

export default i18n;
