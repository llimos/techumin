/**
 * Two-language (English/Hebrew) UI support. Every user-facing string is an
 * LString holding both languages; `t` picks the current one at render time,
 * so text generated before a language switch (pipeline logs, warnings) still
 * displays in the newly selected language.
 */

export type Lang = 'en' | 'he';

/** A user-facing string in both languages. */
export interface LString {
  en: string;
  he: string;
}

let current: Lang = 'en';

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  current = lang;
}

/** The current language's text. */
export function t(s: LString): string {
  return s[current];
}

/** Text direction of a language. */
export function dirOf(lang: Lang): 'ltr' | 'rtl' {
  return lang === 'he' ? 'rtl' : 'ltr';
}

/**
 * Default language: the first entry in the browser's language list that is
 * English or Hebrew ('iw' is the legacy Hebrew code); English otherwise.
 */
export function detectLang(): Lang {
  const langs =
    typeof navigator !== 'undefined' ? (navigator.languages ?? [navigator.language]) : [];
  for (const l of langs) {
    const code = l.toLowerCase();
    if (code === 'he' || code.startsWith('he-') || code === 'iw' || code.startsWith('iw-')) {
      return 'he';
    }
    if (code === 'en' || code.startsWith('en-')) return 'en';
  }
  return 'en';
}
