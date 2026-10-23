// Light/dark preference. "system" follows the OS (tokens.css media query); the choice is a per-browser convenience.
export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = 'pe.theme';

export function getTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch { /* storage unavailable: the choice lasts for this page only */ }
}

/** The theme actually showing, resolving "system" against the OS setting. */
export function effectiveTheme(): 'light' | 'dark' {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'light' || attr === 'dark') return attr;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

if (typeof document !== 'undefined') applyTheme(getTheme());
