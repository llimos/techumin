/** Sidebar: location search, halachic opinion controls, warnings, disclaimers. */

import { SETTING_META, type SettingMeta, type Settings } from '../settings';
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
  text: string;
  /** Optional richer markup for the sidebar (trusted HTML). */
  html?: string;
}

export const DISCLAIMERS: Disclaimer[] = [
  {
    text: 'This tool estimates techum boundaries for reference only — consult a rabbi for practical psak; you can generate a report to help with that.',
  },
  {
    text: 'City shapes come from OpenStreetMap building data; results are only as good as OSM coverage in the area.',
    html:
      'City shapes come from OpenStreetMap building data; results are only as good as OSM coverage in the area — if something looks wrong, ' +
      '<a id="osm-edit-link" href="#" target="_blank" rel="noopener">fix it on OpenStreetMap</a>.',
  },
  {
    text: 'City eruvim are not considered — according to some opinions an eruv can change the city boundary.',
  },
];

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Markup for one halachic-opinion control, from its display metadata. A
 *  labelOverride shortens the label when a section header supplies context. */
function settingControl(meta: SettingMeta, labelOverride?: string): string {
  if (meta.key === 'customAmahCm') {
    return `<label id="custom-amah-row" hidden>${esc(meta.label)}
      <input type="number" data-setting="customAmahCm" min="30" max="80" step="0.1" />
    </label>`;
  }
  const label = esc(labelOverride ?? meta.label);
  switch (meta.kind) {
    case 'select':
      return `<label>${label}
        <select data-setting="${meta.key}">
          ${Object.entries(meta.values ?? {})
            .map(([v, l]) => `<option value="${v}">${esc(l)}</option>`)
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

/** The eruv-in-city notice, rendered next to its checkbox so its toggle can
 *  find it. */
const ERUV_CITY_NOTICE = `<p class="hint eruv-notice" id="eruv-city-notice" hidden>Even according to this
  opinion, most poskim do not allow returning to the start point when the eruv
  is more than 2000 amot from it.</p>`;

interface OpinionItem {
  key: keyof Settings;
  /** Shorter label used under a section header (see settingControl). */
  label?: string;
}

/** The opinion controls grouped into labelled subsections; a null title leaves
 *  the controls ungrouped at the top. Keys reference SETTING_META. */
const OPINION_GROUPS: { title: string | null; items: OpinionItem[] }[] = [
  { title: null, items: [{ key: 'amahPreset' }, { key: 'fourAmotMode' }, { key: 'eruvCityTechum' }] },
  { title: 'City definition', items: [{ key: 'remaExtra' }] },
  {
    title: 'City merging',
    items: [{ key: 'triangleAbsorbsThird' }, { key: 'triangleWideMiddle' }],
  },
  {
    title: 'Squaring (ribua)',
    items: [{ key: 'chazonIshStraightSide' }, { key: 'unequalLines' }],
  },
  {
    title: 'Keshet/gam',
    items: [
      { key: 'keshetCondition', label: 'Condition' },
      { key: 'keshetExclusion', label: 'Exclusion' },
    ],
  },
  {
    title: "Havla'ah",
    items: [{ key: 'havlaahWidth' }, { key: 'havlaahLength' }, { key: 'havlaahEruvStartCity' }],
  },
];

/** Render the grouped opinion controls, with the custom-amah field and the
 *  eruv-in-city notice tucked in beside the controls they belong to. */
function opinionControls(): string {
  const metaByKey = new Map(SETTING_META.map((m) => [m.key, m]));
  return OPINION_GROUPS.map((group) => {
    const header = group.title ? `<h3>${esc(group.title)}</h3>` : '';
    const controls = group.items
      .map(({ key, label }) => {
        let html = settingControl(metaByKey.get(key)!, label);
        if (key === 'amahPreset') html += settingControl(metaByKey.get('customAmahCm')!);
        if (key === 'eruvCityTechum') html += ERUV_CITY_NOTICE;
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
    root.innerHTML = `
      <h1>Techum.app</h1>
      <p class="subtitle">Calculate techum Shabbos from any point on Earth, taking into
        account buildings, cities, and elevation, using your own combination of halachic psakim.</p>

      <section>
        <h2>Location</h2>
        <form id="search-form">
          <input id="search-input" type="text" placeholder="Search address…" autocomplete="off" />
          <button type="submit">Search</button>
        </form>
        <div id="search-results"></div>
        <button id="geolocate" type="button">Use my location</button>
        <p class="hint">…or click anywhere on the map.</p>
        <div id="status"></div>
      </section>

      <section class="disclaimers">
        <h2>Disclaimers</h2>
        <ul>${DISCLAIMERS.map((d) => `<li>${d.html ?? esc(d.text)}</li>`).join('')}</ul>
      </section>

      <section>
        <h2>Eruv techumin</h2>
        <button id="eruv-btn" type="button" disabled>Place eruv techumin</button>
        <p class="hint" id="eruv-hint">Calculate a techum first.</p>
      </section>

      <section>
        <h2>Report</h2>
        <button id="report-btn" type="button" disabled>Generate report</button>
        <p class="hint" id="report-hint">Calculate a techum first.</p>
      </section>

      <section>
        <h2>Halachic opinions</h2>
        ${opinionControls()}
      </section>

      <section>
        <h2>Data</h2>
        <label>Initial building data radius: <span id="radius-label"></span> km
          <input type="range" data-setting="fetchRadiusM" min="1000" max="6000" step="500" />
        </label>
        <p class="hint">Extends automatically while the city reaches the data boundary.</p>
      </section>

      <section>
        <h2>Warnings</h2>
        <ul id="warnings" class="warnings"></ul>
      </section>
    `;

    this.warningsEl = root.querySelector('#warnings')!;
    this.statusEl = root.querySelector('#status')!;
    this.resultsEl = root.querySelector('#search-results')!;
    this.eruvBtnEl = root.querySelector<HTMLButtonElement>('#eruv-btn')!;
    this.eruvHintEl = root.querySelector('#eruv-hint')!;
    this.reportBtnEl = root.querySelector<HTMLButtonElement>('#report-btn')!;
    this.reportHintEl = root.querySelector('#report-hint')!;

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
        (err) => this.setStatus(`Geolocation failed: ${err.message}`),
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
    this.eruvBtnEl.textContent =
      phase === 'arming'
        ? 'Cancel placing eruv'
        : phase === 'placed'
          ? 'Remove eruv'
          : 'Place eruv techumin';
    this.eruvHintEl.textContent =
      phase === 'arming'
        ? 'Click inside the highlighted area to place the eruv.'
        : phase === 'placed'
          ? 'The techum is measured from the eruv.'
          : phase === 'ready'
            ? 'Place an eruv to measure the techum from it instead.'
            : 'Calculate a techum first.';
  }

  setReportEnabled(enabled: boolean): void {
    this.reportBtnEl.disabled = !enabled;
    this.reportHintEl.textContent = enabled
      ? 'Opens a printable report in a new tab.'
      : 'Calculate a techum first.';
  }

  private async search(query: string): Promise<void> {
    if (!query.trim()) return;
    this.resultsEl.textContent = 'Searching…';
    try {
      const results = await geocode(query);
      this.resultsEl.innerHTML = '';
      if (results.length === 0) {
        this.resultsEl.textContent = 'No results.';
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
      this.resultsEl.textContent = err instanceof Error ? err.message : 'Search failed.';
    }
  }

  setStatus(text: string): void {
    this.statusEl.textContent = text;
  }

  setWarnings(warnings: string[]): void {
    this.warningsEl.innerHTML = '';
    for (const w of warnings) {
      const li = document.createElement('li');
      li.textContent = w;
      this.warningsEl.appendChild(li);
    }
  }
}
