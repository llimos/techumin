/** First-time / on-demand help modal explaining the app basics. */

import { dirOf, getLang, t, type Lang, type LString } from '../i18n';

export interface HelpCallbacks {
  /** Switch the whole app to this language (and re-render the modal). */
  onLanguageChange(lang: Lang): void;
}

/** localStorage flag: the help modal has been shown at least once. */
const SEEN_KEY = 'techumin-help-seen';

const TXT = {
  title: { en: 'Welcome to Techum.app', he: 'ברוכים הבאים ל־Techum.app' },
  intro: {
    en: 'Calculate how far you may walk on Shabbos from any location. Here is how:',
    he: 'חשבו עד היכן מותר ללכת בשבת מכל מיקום. כך עושים זאת:',
  },
  steps: [
    {
      en: 'Find your location by searching in the sidebar, or by panning the map.',
      he: 'מצאו את מיקומכם על ידי חיפוש בסרגל הצד, או על ידי הזזת המפה.',
    },
    {
      en: 'Click on the map to place — or move — your start point. The app then calculates your techum (large cities may take a little longer).',
      he: 'לחצו על המפה כדי להניח — או להזיז — את נקודת המוצא. האפליקציה תחשב את התחום שלכם (ערים גדולות עשויות לקחת מעט יותר זמן).',
    },
    {
      en: 'Once it is calculated, you can add an eruv techumin by clicking “Place eruv techumin”.',
      he: 'לאחר החישוב, ניתן להוסיף עירוב תחומין בלחיצה על „הנחת עירוב תחומין”.',
    },
    {
      en: 'Change the halachic opinions in the sidebar — the techum is recalculated automatically.',
      he: 'שנו את השיטות ההלכתיות בסרגל הצד — התחום מחושב מחדש אוטומטית.',
    },
    {
      en: 'Click “Generate report” to spell out all the calculations, to show to a rabbi.',
      he: 'לחצו על „הפקת דו"ח” כדי לפרט את כל החישובים, להצגה בפני רב.',
    },
  ] as LString[],
  gotIt: { en: 'Got it', he: 'הבנתי' },
  close: { en: 'Close', he: 'סגירה' },
} as const;

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export class Help {
  private overlay: HTMLElement;
  private dialog: HTMLElement;
  private cb: HelpCallbacks;
  private lastFocus: Element | null = null;

  constructor(cb: HelpCallbacks) {
    this.cb = cb;
    this.overlay = document.createElement('div');
    this.overlay.id = 'help-overlay';
    this.overlay.hidden = true;
    this.dialog = document.createElement('div');
    this.dialog.id = 'help-dialog';
    this.dialog.setAttribute('role', 'dialog');
    this.dialog.setAttribute('aria-modal', 'true');
    this.dialog.setAttribute('aria-labelledby', 'help-title');
    this.overlay.appendChild(this.dialog);
    document.body.appendChild(this.overlay);

    // Backdrop click (outside the dialog) closes.
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen) this.close();
    });
  }

  get isOpen(): boolean {
    return !this.overlay.hidden;
  }

  /** Open the modal on the very first visit, then remember it was seen. */
  openIfFirstVisit(): void {
    let seen = false;
    try {
      seen = localStorage.getItem(SEEN_KEY) === '1';
    } catch {
      // Storage unavailable — treat as first visit, but don't loop forever.
    }
    if (seen) return;
    try {
      localStorage.setItem(SEEN_KEY, '1');
    } catch {
      // Ignore — the modal simply reappears next time in private mode.
    }
    this.open();
  }

  open(): void {
    if (this.isOpen) return;
    this.lastFocus = document.activeElement;
    this.render();
    this.overlay.hidden = false;
    // Focus the primary button so keyboard/Escape work immediately.
    this.dialog.querySelector<HTMLButtonElement>('#help-got-it')?.focus();
  }

  close(): void {
    if (!this.isOpen) return;
    this.overlay.hidden = true;
    if (this.lastFocus instanceof HTMLElement) this.lastFocus.focus();
  }

  /** Rebuild the modal's contents in the current language (also on switch). */
  render(): void {
    const lang = getLang();
    this.overlay.dir = dirOf(lang);
    const langBtn = (l: Lang, label: string): string =>
      `<button type="button" data-lang="${l}"${
        lang === l ? ' class="active"' : ''
      }>${label}</button>`;
    this.dialog.innerHTML = `
      <div id="help-lang-toggle" role="group" aria-label="Language / שפה">
        ${langBtn('en', 'En')}${langBtn('he', 'ע')}
      </div>
      <button id="help-close" type="button" aria-label="${esc(t(TXT.close))}">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2.5" stroke-linecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
      <h2 id="help-title">${esc(t(TXT.title))}</h2>
      <p class="help-intro">${esc(t(TXT.intro))}</p>
      <ol class="help-steps">
        ${TXT.steps.map((s) => `<li>${esc(t(s))}</li>`).join('')}
      </ol>
      <button id="help-got-it" type="button">${esc(t(TXT.gotIt))}</button>
    `;

    for (const btn of this.dialog.querySelectorAll<HTMLButtonElement>('#help-lang-toggle button')) {
      btn.addEventListener('click', () => {
        const l = btn.dataset.lang as Lang;
        if (l !== getLang()) this.cb.onLanguageChange(l);
      });
    }
    this.dialog.querySelector('#help-close')!.addEventListener('click', () => this.close());
    this.dialog.querySelector('#help-got-it')!.addEventListener('click', () => this.close());
  }
}
