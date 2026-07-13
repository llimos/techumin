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
}

/** UI phase of the eruv techumin button, driven by the orchestrator. */
export type EruvPhase = 'disabled' | 'ready' | 'arming' | 'placed';

export const DISCLAIMERS = [
  'This tool estimates techum boundaries for reference only — consult a rabbi for practical psak.',
  'City shapes come from OpenStreetMap building data; results are only as good as OSM coverage in the area.',
  'City eruvim are not considered — according to some opinions an eruv can change the city boundary.',
  'Measurement lines are straight; obstacles, water and karpef are not considered.',
  'Terrain data has ~10–30 m resolution; micro-terrain is ignored.',
];

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Markup for one halachic-opinion control, from its display metadata. */
function settingControl(meta: SettingMeta): string {
  if (meta.key === 'customAmahCm') {
    return `<label id="custom-amah-row" hidden>${esc(meta.label)}
      <input type="number" data-setting="customAmahCm" min="30" max="80" step="0.1" />
    </label>`;
  }
  switch (meta.kind) {
    case 'select':
      return `<label>${esc(meta.label)}
        <select data-setting="${meta.key}">
          ${Object.entries(meta.values ?? {})
            .map(([v, l]) => `<option value="${v}">${esc(l)}</option>`)
            .join('')}
        </select>
      </label>`;
    case 'checkbox':
      return `<label><input type="checkbox" data-setting="${meta.key}" />
        ${esc(meta.label)}</label>`;
    default:
      return '';
  }
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
      <p class="subtitle">Techum Shabbos calculator</p>

      <section class="disclaimers">
        <h2>Disclaimers</h2>
        <ul>${DISCLAIMERS.map((d) => `<li>${d}</li>`).join('')}</ul>
      </section>

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
        ${SETTING_META.filter((m) => m.key !== 'fetchRadiusM')
          .map(settingControl)
          .join('')}
        <p class="hint eruv-notice" id="eruv-city-notice" hidden>Even according to this
          opinion, most poskim do not allow returning to the start point when the eruv
          is more than 2000 amot from it.</p>
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
