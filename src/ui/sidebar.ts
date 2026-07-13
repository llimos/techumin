/** Sidebar: location search, halachic opinion controls, warnings, disclaimers. */

import { SETTING_META, type SettingMeta, type Settings } from '../settings';
import { dirOf, t, type Lang, type LString } from '../i18n';
import { geocode } from '../geocode';
import type { LatLon } from '../types';

export interface SidebarCallbacks {
  onSettingsChange(partial: Partial<Settings>): void;
  onLocate(point: LatLon, label?: string): void;
  /** The eruv button: arms placement, cancels it, or removes the eruv. */
  onEruvButton(): void;
  /** Open the printable calculation report in a new tab. */
  onGenerateReport(): void;
  /** URL of the OpenStreetMap editor, centred on the current map view. */
  osmEditUrl(): string;
}

/** UI phase of the eruv techumin button, driven by the orchestrator. */
export type EruvPhase = 'disabled' | 'ready' | 'arming' | 'placed';

export interface Disclaimer {
  /** Plain-text form, shown in the printable report. */
  text: LString;
  /** Optional richer markup for the sidebar (trusted HTML). */
  html?: LString;
}

export const DISCLAIMERS: Disclaimer[] = [
  {
    text: {
      en: 'This tool estimates techum boundaries for reference only — consult a rabbi for practical psak; you can generate a report to help with that.',
      he: 'כלי זה מעריך את גבולות התחום לעיון בלבד — לפסק הלכה למעשה יש להתייעץ עם רב; אפשר להפיק דו"ח שיסייע בכך.',
    },
  },
  {
    text: {
      en: 'City shapes come from OpenStreetMap building data; results are only as good as OSM coverage in the area.',
      he: 'צורות הערים מבוססות על נתוני הבניינים של OpenStreetMap; טיב התוצאות תלוי בכיסוי של OSM באזור.',
    },
    html: {
      en:
        'City shapes come from OpenStreetMap building data; results are only as good as OSM coverage in the area — if something looks wrong, ' +
        '<a id="osm-edit-link" href="#" target="_blank" rel="noopener">fix it on OpenStreetMap</a>.',
      he:
        'צורות הערים מבוססות על נתוני הבניינים של OpenStreetMap; טיב התוצאות תלוי בכיסוי של OSM באזור — אם משהו נראה שגוי, ' +
        '<a id="osm-edit-link" href="#" target="_blank" rel="noopener">תקנו זאת ב־OpenStreetMap</a>.',
    },
  },
  {
    text: {
      en: 'City eruvim are not considered — according to some opinions an eruv can change the city boundary.',
      he: 'עירובים עירוניים אינם נלקחים בחשבון — לפי חלק מהשיטות עירוב יכול לשנות את גבול העיר.',
    },
  },
];

const TXT = {
  subtitle: {
    en: 'Calculate techum Shabbos from any point on Earth, taking into account buildings, cities, and elevation, using your own combination of halachic psakim.',
    he: 'חישוב תחום שבת מכל נקודה בעולם, בהתחשב בבניינים, ערים וטופוגרפיה, לפי צירוף פסקי ההלכה שתבחרו.',
  },
  location: { en: 'Location', he: 'מיקום' },
  searchPlaceholder: { en: 'Search address…', he: 'חיפוש כתובת…' },
  search: { en: 'Search', he: 'חיפוש' },
  useMyLocation: { en: 'Use my location', he: 'השתמשו במיקום שלי' },
  orClickMap: { en: '…or click anywhere on the map.', he: '…או לחצו בכל מקום על המפה.' },
  disclaimers: { en: 'Disclaimers', he: 'הבהרות' },
  eruvTechumin: { en: 'Eruv techumin', he: 'עירוב תחומין' },
  placeEruv: { en: 'Place eruv techumin', he: 'הנחת עירוב תחומין' },
  cancelEruv: { en: 'Cancel placing eruv', he: 'ביטול הנחת העירוב' },
  removeEruv: { en: 'Remove eruv', he: 'הסרת העירוב' },
  calcFirst: { en: 'Calculate a techum first.', he: 'חשבו תחילה תחום.' },
  eruvArmingHint: {
    en: 'Click inside the highlighted area to place the eruv.',
    he: 'לחצו בתוך האזור המודגש כדי להניח את העירוב.',
  },
  eruvPlacedHint: { en: 'The techum is measured from the eruv.', he: 'התחום נמדד מן העירוב.' },
  eruvReadyHint: {
    en: 'Place an eruv to measure the techum from it instead.',
    he: 'הניחו עירוב כדי למדוד את התחום ממנו במקום מנקודת המוצא.',
  },
  report: { en: 'Report', he: 'דו"ח' },
  generateReport: { en: 'Generate report', he: 'הפקת דו"ח' },
  reportHint: {
    en: 'Opens a printable report in a new tab.',
    he: 'פותח דו"ח להדפסה בלשונית חדשה.',
  },
  opinions: { en: 'Halachic opinions', he: 'שיטות הלכתיות' },
  eruvCityNotice: {
    en: 'Even according to this opinion, most poskim do not allow returning to the start point when the eruv is more than 2000 amot from it.',
    he: 'גם לפי שיטה זו, רוב הפוסקים אינם מתירים לחזור לנקודת המוצא כאשר העירוב רחוק ממנה יותר מ־2000 אמה.',
  },
  data: { en: 'Data', he: 'נתונים' },
  radiusLabel: { en: 'Initial building data radius:', he: 'רדיוס נתוני בניינים התחלתי:' },
  km: { en: 'km', he: 'ק"מ' },
  radiusHint: {
    en: 'Extends automatically while the city reaches the data boundary.',
    he: 'מתרחב אוטומטית כאשר העיר מגיעה לגבול הנתונים.',
  },
  warnings: { en: 'Warnings', he: 'אזהרות' },
  none: { en: 'None.', he: 'אין.' },
  about: { en: 'About', he: 'אודות' },
  feedback: { en: 'Comments or suggestions?', he: 'הערות או הצעות?' },
  sourceOnGitHub: { en: 'Source on GitHub', he: 'קוד המקור ב־GitHub' },
  credit: {
    en: "Created l'zikui harabim by Shimon Lyons.",
    he: 'נוצר לזיכוי הרבים ע"י שמעון ליונס.',
  },
  searching: { en: 'Searching…', he: 'מחפש…' },
  noResults: { en: 'No results.', he: 'אין תוצאות.' },
  searchFailed: { en: 'Search failed.', he: 'החיפוש נכשל.' },
  geolocationFailed: { en: 'Geolocation failed:', he: 'איתור המיקום נכשל:' },
} as const;

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Markup for one halachic-opinion control, from its display metadata. A
 *  labelOverride shortens the label when a section header supplies context. */
function settingControl(meta: SettingMeta, labelOverride?: LString): string {
  if (meta.key === 'customAmahCm') {
    return `<label id="custom-amah-row" hidden>${esc(t(meta.label))}
      <input type="number" data-setting="customAmahCm" min="30" max="80" step="0.1" />
    </label>`;
  }
  const label = esc(t(labelOverride ?? meta.label));
  switch (meta.kind) {
    case 'select':
      return `<label>${label}
        <select data-setting="${meta.key}">
          ${Object.entries(meta.values ?? {})
            .map(([v, l]) => `<option value="${v}">${esc(t(l))}</option>`)
            .join('')}
        </select>
      </label>`;
    case 'checkbox':
      return `<label><input type="checkbox" data-setting="${meta.key}" />
        ${label}</label>`;
    default:
      return '';
  }
}

interface OpinionItem {
  key: keyof Settings;
  /** Shorter label used under a section header (see settingControl). */
  label?: LString;
  /** Small Hebrew source note shown in gray under the control. */
  note?: string;
}

/** The opinion controls grouped into labelled subsections; a null title leaves
 *  the controls ungrouped at the top. Keys reference SETTING_META. */
const OPINION_GROUPS: { title: LString | null; items: OpinionItem[] }[] = [
  {
    title: null,
    items: [
      { key: 'amahPreset' },
      { key: 'fourAmotMode', note: 'שצו:א ברמ"א; מ"ב מיקל' },
      {
        key: 'eruvCityTechum',
        note: 'תח:א (שו"ע מחמיר, רמ"א מג"א ומ"ב מקילין). יל"ע אם מותר לחזור לביתו',
      },
    ],
  },
  {
    title: { en: 'City definition', he: 'הגדרת עיר' },
    items: [{ key: 'remaExtra', note: 'שצח:ה' }],
  },
  {
    title: { en: 'City merging', he: 'איחוד ערים' },
    items: [
      { key: 'triangleAbsorbsThird', note: 'שצח:ח (שו"ע מיקל; רמ"א מחמיר; מ"ב מכריע להקל)' },
      { key: 'triangleWideMiddle' },
    ],
  },
  {
    title: { en: 'Squaring (ribua)', he: 'ריבוע העיר' },
    items: [
      { key: 'chazonIshStraightSide', note: 'או"ח קי:כג' },
      { key: 'keshetCondition', note: 'שצח:ד (שו"ע מחמיר; רמ"א מיקל)' },
      { key: 'keshetExclusion', note: 'שצח:ד (שו"ע מחמיר; רמ"א מיקל)' },
    ],
  },
  {
    title: { en: 'Techum', he: 'תחום' },
    items: [{ key: 'unequalLines', note: 'שצט:ח ברמ"א; מ"ב מיקל' }],
  },
  {
    title: { en: "Havla'ah", he: 'הבלעה' },
    items: [
      { key: 'havlaahWidth', note: 'תח:א ברמ"א; מ"ב ס"ק כ נוטה להחמיר כמג"א' },
      {
        key: 'havlaahLength',
        note: 'נודע ביהודה מחמיר (מהדו"ת או"ח סי\' נ); חזו"א מיקל (או"ח סי; ק"י ס"ק י"ד)',
      },
      { key: 'havlaahEruvStartCity', note: 'תח:א ברמ"א; מ"ב מיקל' },
    ],
  },
];

/** The eruv-in-city notice, rendered next to its checkbox so its toggle can
 *  find it. */
const eruvCityNotice = (): string =>
  `<p class="hint eruv-notice" id="eruv-city-notice" hidden>${esc(t(TXT.eruvCityNotice))}</p>`;

/** Render the grouped opinion controls, with the custom-amah field and the
 *  eruv-in-city notice tucked in beside the controls they belong to. */
function opinionControls(): string {
  const metaByKey = new Map(SETTING_META.map((m) => [m.key, m]));
  return OPINION_GROUPS.map((group) => {
    const header = group.title ? `<h3>${esc(t(group.title))}</h3>` : '';
    const controls = group.items
      .map(({ key, label, note }) => {
        let html = settingControl(metaByKey.get(key)!, label);
        if (note) html += `<p class="opinion-note" dir="rtl">${esc(note)}</p>`;
        if (key === 'amahPreset') html += settingControl(metaByKey.get('customAmahCm')!);
        if (key === 'eruvCityTechum') html += eruvCityNotice();
        return html;
      })
      .join('');
    return header + controls;
  }).join('');
}

export class Sidebar {
  private warningsEl: HTMLElement;
  private statusEl: HTMLElement;
  private resultsEl: HTMLElement;
  private eruvBtnEl: HTMLButtonElement;
  private eruvHintEl: HTMLElement;
  private reportBtnEl: HTMLButtonElement;
  private reportHintEl: HTMLElement;
  private cb: SidebarCallbacks;

  constructor(root: HTMLElement, settings: Settings, cb: SidebarCallbacks) {
    this.cb = cb;
    root.dir = dirOf(settings.language);
    const langBtn = (lang: Lang, label: string): string =>
      `<button type="button" data-lang="${lang}"${
        settings.language === lang ? ' class="active"' : ''
      }>${label}</button>`;
    root.innerHTML = `
      <div id="lang-toggle" role="group" aria-label="Language / שפה">
        ${langBtn('en', 'En')}${langBtn('he', 'ע')}
      </div>
      <h1>Techum.app</h1>
      <p class="subtitle">${esc(t(TXT.subtitle))}</p>

      <section>
        <h2>${esc(t(TXT.location))}</h2>
        <form id="search-form">
          <input id="search-input" type="text" placeholder="${esc(t(TXT.searchPlaceholder))}" autocomplete="off" />
          <button type="submit">${esc(t(TXT.search))}</button>
        </form>
        <div id="search-results"></div>
        <button id="geolocate" type="button">${esc(t(TXT.useMyLocation))}</button>
        <p class="hint">${esc(t(TXT.orClickMap))}</p>
        <div id="status"></div>
      </section>

      <section class="disclaimers">
        <h2>${esc(t(TXT.disclaimers))}</h2>
        <ul>${DISCLAIMERS.map((d) => `<li>${d.html ? t(d.html) : esc(t(d.text))}</li>`).join('')}</ul>
      </section>

      <section>
        <h2>${esc(t(TXT.eruvTechumin))}</h2>
        <button id="eruv-btn" type="button" disabled>${esc(t(TXT.placeEruv))}</button>
        <p class="hint" id="eruv-hint">${esc(t(TXT.calcFirst))}</p>
      </section>

      <section>
        <h2>${esc(t(TXT.report))}</h2>
        <button id="report-btn" type="button" disabled>${esc(t(TXT.generateReport))}</button>
        <p class="hint" id="report-hint">${esc(t(TXT.calcFirst))}</p>
      </section>

      <section>
        <h2>${esc(t(TXT.opinions))}</h2>
        ${opinionControls()}
      </section>

      <section>
        <h2>${esc(t(TXT.data))}</h2>
        <label>${esc(t(TXT.radiusLabel))} <span id="radius-label"></span> ${esc(t(TXT.km))}
          <input type="range" data-setting="fetchRadiusM" min="1000" max="6000" step="500" />
        </label>
        <p class="hint">${esc(t(TXT.radiusHint))}</p>
      </section>

      <section>
        <h2>${esc(t(TXT.warnings))}</h2>
        <ul id="warnings" class="warnings" data-empty="${esc(t(TXT.none))}"></ul>
      </section>

      <section class="about">
        <h2>${esc(t(TXT.about))}</h2>
        <p>${esc(t(TXT.feedback))} <a href="mailto:info@techum.app">info@techum.app</a></p>
        <p><a href="https://github.com/llimos/techumin" target="_blank" rel="noopener">
          <svg class="gh-icon" viewBox="0 0 16 16" width="15" height="15" fill="currentColor"
            aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38
              0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01
              1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95
              0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68
              0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0
              3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013
              8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path></svg>${esc(t(TXT.sourceOnGitHub))}</a></p>
        <p class="credit">${esc(t(TXT.credit))}</p>
      </section>
    `;

    this.warningsEl = root.querySelector('#warnings')!;
    this.statusEl = root.querySelector('#status')!;
    this.resultsEl = root.querySelector('#search-results')!;
    this.eruvBtnEl = root.querySelector<HTMLButtonElement>('#eruv-btn')!;
    this.eruvHintEl = root.querySelector('#eruv-hint')!;
    this.reportBtnEl = root.querySelector<HTMLButtonElement>('#report-btn')!;
    this.reportHintEl = root.querySelector('#report-hint')!;

    for (const btn of root.querySelectorAll<HTMLButtonElement>('#lang-toggle button')) {
      btn.addEventListener('click', () => {
        const lang = btn.dataset.lang as Lang;
        if (lang !== settings.language) this.cb.onSettingsChange({ language: lang });
      });
    }

    // Initialize control values from settings and wire change events.
    for (const el of root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-setting]')) {
      const key = el.dataset.setting as keyof Settings;
      const value = settings[key];
      if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = value as boolean;
      else el.value = String(value);
      el.addEventListener('change', () => {
        const raw =
          el instanceof HTMLInputElement && el.type === 'checkbox'
            ? el.checked
            : el instanceof HTMLInputElement && (el.type === 'number' || el.type === 'range')
              ? Number(el.value)
              : el.value;
        if (key === 'amahPreset') this.toggleCustomAmah(raw === 'custom');
        if (key === 'fetchRadiusM') this.updateRadiusLabel(raw as number);
        if (key === 'eruvCityTechum') this.toggleEruvNotice(raw as boolean);
        this.cb.onSettingsChange({ [key]: raw } as Partial<Settings>);
      });
    }
    this.toggleCustomAmah(settings.amahPreset === 'custom');
    this.updateRadiusLabel(settings.fetchRadiusM);
    this.toggleEruvNotice(settings.eruvCityTechum);

    root.querySelector<HTMLFormElement>('#search-form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.search(root.querySelector<HTMLInputElement>('#search-input')!.value);
    });

    this.eruvBtnEl.addEventListener('click', () => this.cb.onEruvButton());
    this.reportBtnEl.addEventListener('click', () => this.cb.onGenerateReport());

    // Point the OSM edit link at the current map view just before it opens.
    const osmLink = root.querySelector<HTMLAnchorElement>('#osm-edit-link');
    osmLink?.addEventListener('click', () => {
      osmLink.href = this.cb.osmEditUrl();
    });

    root.querySelector('#geolocate')!.addEventListener('click', () => {
      navigator.geolocation.getCurrentPosition(
        (pos) => this.cb.onLocate({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
        (err) => this.setStatus(`${t(TXT.geolocationFailed)} ${err.message}`),
      );
    });
  }

  private toggleCustomAmah(show: boolean): void {
    document.querySelector<HTMLElement>('#custom-amah-row')!.hidden = !show;
  }

  private updateRadiusLabel(radiusM: number): void {
    document.querySelector('#radius-label')!.textContent = (radiusM / 1000).toFixed(1);
  }

  private toggleEruvNotice(show: boolean): void {
    document.querySelector<HTMLElement>('#eruv-city-notice')!.hidden = !show;
  }

  setEruvState(phase: EruvPhase): void {
    this.eruvBtnEl.disabled = phase === 'disabled';
    this.eruvBtnEl.textContent = t(
      phase === 'arming' ? TXT.cancelEruv : phase === 'placed' ? TXT.removeEruv : TXT.placeEruv,
    );
    this.eruvHintEl.textContent = t(
      phase === 'arming'
        ? TXT.eruvArmingHint
        : phase === 'placed'
          ? TXT.eruvPlacedHint
          : phase === 'ready'
            ? TXT.eruvReadyHint
            : TXT.calcFirst,
    );
  }

  setReportEnabled(enabled: boolean): void {
    this.reportBtnEl.disabled = !enabled;
    this.reportHintEl.textContent = t(enabled ? TXT.reportHint : TXT.calcFirst);
  }

  private async search(query: string): Promise<void> {
    if (!query.trim()) return;
    this.resultsEl.textContent = t(TXT.searching);
    try {
      const results = await geocode(query);
      this.resultsEl.innerHTML = '';
      if (results.length === 0) {
        this.resultsEl.textContent = t(TXT.noResults);
        return;
      }
      for (const r of results) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'search-result';
        btn.textContent = r.displayName;
        btn.addEventListener('click', () => {
          this.resultsEl.innerHTML = '';
          this.cb.onLocate({ lat: r.lat, lon: r.lon }, r.displayName);
        });
        this.resultsEl.appendChild(btn);
      }
    } catch (err) {
      this.resultsEl.textContent = err instanceof Error ? err.message : t(TXT.searchFailed);
    }
  }

  setStatus(text: string): void {
    this.statusEl.textContent = text;
  }

  setWarnings(warnings: LString[]): void {
    this.warningsEl.innerHTML = '';
    for (const w of warnings) {
      const li = document.createElement('li');
      li.textContent = t(w);
      this.warningsEl.appendChild(li);
    }
  }
}
