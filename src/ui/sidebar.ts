/** Sidebar: location search, halachic opinion controls, warnings, disclaimers. */

import { AMAH_LABELS, type AmahPreset, type Settings } from '../settings';
import { geocode } from '../geocode';
import type { LatLon } from '../types';

export interface SidebarCallbacks {
  onSettingsChange(partial: Partial<Settings>): void;
  onLocate(point: LatLon, label?: string): void;
}

const DISCLAIMERS = [
  'This tool estimates techum boundaries for reference only — consult a rabbi for practical psak.',
  'City shapes come from OpenStreetMap building data; results are only as good as OSM coverage in the area.',
  'City eruvim are not considered — according to some opinions an eruv can change the city boundary.',
  'Measurement lines are straight; obstacles, water and karpef are not considered.',
  'Terrain data has ~10–30 m resolution; micro-terrain is ignored.',
];

export class Sidebar {
  private warningsEl: HTMLElement;
  private statusEl: HTMLElement;
  private resultsEl: HTMLElement;
  private cb: SidebarCallbacks;

  constructor(root: HTMLElement, settings: Settings, cb: SidebarCallbacks) {
    this.cb = cb;
    root.innerHTML = `
      <h1>Techumin</h1>
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
        <h2>Halachic opinions</h2>
        <label>Amah length
          <select data-setting="amahPreset">
            ${(Object.keys(AMAH_LABELS) as AmahPreset[])
              .map((k) => `<option value="${k}">${AMAH_LABELS[k]}</option>`)
              .join('')}
          </select>
        </label>
        <label id="custom-amah-row" hidden>Custom amah (cm)
          <input type="number" data-setting="customAmahCm" min="30" max="80" step="0.1" />
        </label>
        <label><input type="checkbox" data-setting="triangleAbsorbsThird" />
          Triangle rule: third city joins the merged city</label>
        <label>Triangle rule: middle city wider than the gap
          <select data-setting="triangleWideMiddle">
            <option value="noMerge">Does not merge (Tur, Chazon Ish)</option>
            <option value="merge">Still merges (Gr&quot;a)</option>
          </select>
        </label>
        <label><input type="checkbox" data-setting="chazonIshStraightSide" />
          Chazon Ish: square along a full straight side</label>
        <label>Keshet/gam condition
          <select data-setting="keshetCondition">
            <option value="mouthAndDepth">Mouth ≥ 4000 and depth &gt; 2000 amot</option>
            <option value="mouthOnly">Mouth ≥ 4000 amot alone</option>
          </select>
        </label>
        <label>Keshet/gam exclusion
          <select data-setting="keshetExclusion">
            <option value="past4000">Exclude only wider than 4000 amot</option>
            <option value="entire">Exclude entire keshet</option>
          </select>
        </label>
        <label><input type="checkbox" data-setting="remaExtra" />
          Rema: extra 70⅔ amot for every city</label>
        <label>No-structure fallback
          <select data-setting="fourAmotMode">
            <option value="each">4 amot in each direction</option>
            <option value="total">4 amot total</option>
          </select>
        </label>
        <label>Unequal measurement lines
          <select data-setting="unequalLines">
            <option value="extend">Extend the shorter line</option>
            <option value="diagonal">Join on the diagonal</option>
          </select>
        </label>
      </section>

      <section>
        <h2>Data</h2>
        <label>Building data radius: <span id="radius-label"></span> km
          <input type="range" data-setting="fetchRadiusM" min="1000" max="6000" step="500" />
        </label>
      </section>

      <section>
        <h2>Warnings</h2>
        <ul id="warnings" class="warnings"></ul>
      </section>
    `;

    this.warningsEl = root.querySelector('#warnings')!;
    this.statusEl = root.querySelector('#status')!;
    this.resultsEl = root.querySelector('#search-results')!;

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
        this.cb.onSettingsChange({ [key]: raw } as Partial<Settings>);
      });
    }
    this.toggleCustomAmah(settings.amahPreset === 'custom');
    this.updateRadiusLabel(settings.fetchRadiusM);

    root.querySelector<HTMLFormElement>('#search-form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.search(root.querySelector<HTMLInputElement>('#search-input')!.value);
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
