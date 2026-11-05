export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'taskwatch.ui.theme';

export function getThemePref(): ThemePref {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '"system"');
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** The theme actually showing right now. */
export function resolvedTheme(pref = getThemePref()): 'light' | 'dark' {
  if (pref !== 'system') return pref;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(pref = getThemePref()): void {
  if (pref === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', pref);
}

export function setThemePref(pref: ThemePref): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(pref));
  } catch {
    /* ignore */
  }
  applyTheme(pref);
  window.dispatchEvent(new Event('tw-theme'));
}
