import 'leaflet/dist/leaflet.css';
import './style.css';
import { booleanPointInPolygon, point as turfPoint } from '@turf/turf';
import { TechumMap } from './map';
import { Sidebar, type SidebarCallbacks } from './ui/sidebar';
import { openReportWindow, renderReport } from './ui/report';
import { Help } from './ui/help';
import { TechumPipeline, type PipelineOutputs, type PipelineUpdate } from './pipeline';
import { amahMeters, loadSettings, saveSettings } from './settings';
import { dirOf, getLang, setLang, t } from './i18n';
import { DEBUG } from './debug';
import { track } from './analytics';
import type { LatLon, Poly } from './types';

const TXT = {
  openMenu: { en: 'Open menu', he: 'פתיחת תפריט' },
  closeMenu: { en: 'Close menu', he: 'סגירת תפריט' },
  computingZone: {
    en: 'Computing where the eruv can be placed…',
    he: 'מחשב היכן ניתן להניח את העירוב…',
  },
  eruvNotPlaced: {
    en: 'Eruv not placed — it must be inside the highlighted area.',
    he: 'העירוב לא הונח — עליו להיות בתוך האזור המודגש.',
  },
  eruvNotRestored: {
    en: 'Saved eruv not restored — it is outside the area where an eruv may be placed.',
    he: 'העירוב השמור לא שוחזר — הוא מחוץ לאזור שבו מותר להניח עירוב.',
  },
  popupBlocked: {
    en: 'Popup blocked — allow popups for this site to generate the report.',
    he: 'חלון קופץ נחסם — אפשרו חלונות קופצים לאתר זה כדי להפיק את הדו"ח.',
  },
  preparingReport: { en: 'Preparing report…', he: 'מכין דו"ח…' },
  done: { en: 'Done.', he: 'הסתיים.' },
  calculating: { en: 'Calculating', he: 'מחשב' },
  calculatingShort: { en: 'Calculating…', he: 'מחשב…' },
  starting: { en: 'starting', he: 'מתחיל' },
  error: { en: 'Error:', he: 'שגיאה:' },
  help: { en: 'Help', he: 'עזרה' },
} as const;

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <button id="sidebar-toggle" type="button" aria-label="Open menu" aria-expanded="false">
    <svg class="icon-menu" width="22" height="22" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
    <svg class="icon-close" width="22" height="22" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  </button>
  <aside id="sidebar"></aside>
  <div id="map-wrap">
    <div id="map"></div>
    <button id="help-btn" type="button" aria-label="Help">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <path d="M9.1 9a2.9 2.9 0 0 1 5.6 1c0 2-2.9 2.7-2.9 2.7" />
        <path d="M12 17h.01" />
      </svg>
    </button>
    <div id="calc-overlay" hidden></div>
  </div>
`;
const overlay = app.querySelector<HTMLElement>('#calc-overlay')!;

const sidebarToggle = app.querySelector<HTMLButtonElement>('#sidebar-toggle')!;
function setSidebarOpen(open: boolean): void {
  app.classList.toggle('sidebar-open', open);
  sidebarToggle.setAttribute('aria-expanded', String(open));
  sidebarToggle.setAttribute('aria-label', t(open ? TXT.closeMenu : TXT.openMenu));
}
sidebarToggle.addEventListener('click', () =>
  setSidebarOpen(!app.classList.contains('sidebar-open')),
);

let lastOutputs: PipelineOutputs = {};
let eruvPoint: LatLon | null = null;
let armingEruv = false;
/** The area the eruv may be placed in, while placement is armed. */
let placementZone: Poly | null = null;
/** Eruv from the URL, applied once the techum is first computed. */
let pendingEruv: LatLon | null = null;

/** The last pipeline update, re-applied after a language switch. */
let lastUpdate: PipelineUpdate | null = null;

const initialSettings = loadSettings();
setLang(initialSettings.language);
const pipeline = new TechumPipeline(initialSettings);
const map = new TechumMap(document.querySelector('#map')!);
const sidebarCallbacks: SidebarCallbacks = {
  onSettingsChange: (partial) => {
    pipeline.updateSettings(partial);
    const settings = pipeline.getSettings();
    saveSettings(settings);
    map.setAmahMeters(amahMeters(settings));
    if (partial.language) {
      setLang(partial.language);
      applyLanguage();
    }
    // A settings change can reshape the placement zone (or drop the techum
    // entirely, which disarms below).
    if (armingEruv) void refreshZone();
  },
  onLocate: (point) => {
    // On mobile the sidebar covers the map — reveal the located spot.
    setSidebarOpen(false);
    pick(point);
  },
  onEruvButton: () => void onEruvButton(),
  onGenerateReport: () => void generateReport(),
  osmEditUrl: () => {
    const c = map.map.getCenter();
    const z = Math.round(map.map.getZoom());
    return `https://www.openstreetmap.org/edit#map=${z}/${c.lat.toFixed(5)}/${c.lng.toFixed(5)}`;
  },
};
const buildSidebar = (): Sidebar =>
  new Sidebar(document.querySelector('#sidebar')!, pipeline.getSettings(), sidebarCallbacks);
let sidebar = buildSidebar();
map.setAmahMeters(amahMeters(pipeline.getSettings()));
overlay.dir = dirOf(getLang());

// Help modal: opened by the '?' button, or automatically on the first visit.
// Its language selector switches the whole app (via onSettingsChange).
const help = new Help({
  onLanguageChange: (language) => sidebarCallbacks.onSettingsChange({ language }),
});
const helpBtn = app.querySelector<HTMLButtonElement>('#help-btn')!;
helpBtn.addEventListener('click', () => {
  track('help_opened');
  help.open();
});
function applyHelpLanguage(): void {
  helpBtn.setAttribute('aria-label', t(TXT.help));
  if (help.isOpen) help.render();
}
applyHelpLanguage();
help.openIfFirstVisit();

/** Rebuild the language-dependent UI in place after a language switch. */
function applyLanguage(): void {
  sidebar = buildSidebar();
  map.setLanguage();
  overlay.dir = dirOf(getLang());
  applyHelpLanguage();
  setSidebarOpen(app.classList.contains('sidebar-open')); // refresh the toggle's aria-label
  // Re-apply the dynamic state the rebuilt sidebar lost (warnings, hints,
  // overlay) in the new language; the transient status line is left blank.
  if (lastUpdate) applyUpdate(lastUpdate);
  else refreshEruvUi();
}

map.onPick = (point) => (armingEruv ? placeEruv(point) : pick(point));

// A lat/lon in the query string centers the map there (without selecting it).
const params = new URLSearchParams(location.search);
const urlLat = Number(params.get('lat'));
const urlLon = Number(params.get('lon'));
if (params.has('lat') && params.has('lon') && Number.isFinite(urlLat) && Number.isFinite(urlLon)) {
  map.map.setView([urlLat, urlLon]);
}
const urlEruvLat = Number(params.get('eruvLat'));
const urlEruvLon = Number(params.get('eruvLon'));
if (
  params.has('eruvLat') &&
  params.has('eruvLon') &&
  Number.isFinite(urlEruvLat) &&
  Number.isFinite(urlEruvLon)
) {
  pendingEruv = { lat: urlEruvLat, lon: urlEruvLon };
}

function pick(point: LatLon): void {
  track('point_selected', { lat: point.lat, lon: point.lon });
  // A new start point starts a new scenario — any eruv belongs to the old one.
  if (eruvPoint || armingEruv) clearEruvState();
  map.setPoint(point);
  map.map.setView([point.lat, point.lon]);
  pipeline.setPoint(point); // also resets the pipeline's eruv
  // Record the point in the URL so the location can be shared/reloaded.
  const params = new URLSearchParams(location.search);
  params.set('lat', point.lat.toFixed(6));
  params.set('lon', point.lon.toFixed(6));
  history.replaceState(null, '', `${location.pathname}?${params}${location.hash}`);
}

function setUrlEruv(point: LatLon | null): void {
  const params = new URLSearchParams(location.search);
  if (point) {
    params.set('eruvLat', point.lat.toFixed(6));
    params.set('eruvLon', point.lon.toFixed(6));
  } else {
    params.delete('eruvLat');
    params.delete('eruvLon');
  }
  history.replaceState(null, '', `${location.pathname}?${params}${location.hash}`);
}

async function onEruvButton(): Promise<void> {
  if (eruvPoint) {
    removeEruv();
    return;
  }
  if (armingEruv) {
    stopArming();
    return;
  }
  if (!lastOutputs.techum) return;
  sidebar.setStatus(t(TXT.computingZone));
  const zone = await pipeline.getPlacementZone();
  if (!zone) {
    sidebar.setStatus('');
    return; // techum vanished meanwhile (new run started)
  }
  armingEruv = true;
  placementZone = zone;
  map.setEruvZone(zone);
  map.setEruvCursor(true);
  sidebar.setStatus('');
  refreshEruvUi();
}

/** Re-fetch the placement zone while armed; disarm if it no longer exists. */
async function refreshZone(): Promise<void> {
  const zone = await pipeline.getPlacementZone();
  if (!armingEruv) return;
  if (!zone) {
    stopArming();
    return;
  }
  placementZone = zone;
  map.setEruvZone(zone);
}

function placeEruv(point: LatLon): void {
  if (
    !placementZone ||
    !booleanPointInPolygon(turfPoint([point.lon, point.lat]), placementZone)
  ) {
    sidebar.setStatus(t(TXT.eruvNotPlaced));
    return; // stay armed
  }
  track('eruv_selected', { lat: point.lat, lon: point.lon });
  stopArming();
  eruvPoint = point;
  map.setEruvPoint(point);
  pipeline.setEruv(point);
  setUrlEruv(point);
  refreshEruvUi();
}

/** Restore an eruv shared in the URL, validated like a manual placement. */
async function restoreEruv(point: LatLon): Promise<void> {
  const zone = await pipeline.getPlacementZone();
  if (eruvPoint || !zone) return;
  if (!booleanPointInPolygon(turfPoint([point.lon, point.lat]), zone)) {
    sidebar.setStatus(t(TXT.eruvNotRestored));
    setUrlEruv(null);
    return;
  }
  eruvPoint = point;
  map.setEruvPoint(point);
  pipeline.setEruv(point);
  setUrlEruv(point);
  refreshEruvUi();
}

function stopArming(): void {
  armingEruv = false;
  placementZone = null;
  map.setEruvZone(null);
  map.setEruvCursor(false);
  refreshEruvUi();
}

function clearEruvState(): void {
  eruvPoint = null;
  setUrlEruv(null);
  map.setEruvPoint(null);
  stopArming();
}

function removeEruv(): void {
  clearEruvState();
  pipeline.clearEruv(); // home techum re-renders from cache, no recompute
}

function refreshEruvUi(): void {
  sidebar.setEruvState(
    eruvPoint ? 'placed' : armingEruv ? 'arming' : lastOutputs.techum ? 'ready' : 'disabled',
  );
}

/** Snapshot the map and open the printable report in a new tab. */
async function generateReport(): Promise<void> {
  if (!lastOutputs.techum) return;
  // Open the tab synchronously, inside the click, so popup blockers allow it.
  const win = openReportWindow();
  if (!win) {
    sidebar.setStatus(t(TXT.popupBlocked));
    return;
  }
  sidebar.setStatus(t(TXT.preparingReport));
  const image = await map.captureReport(lastOutputs.eruvTechum ?? lastOutputs.techum ?? null);
  // Pull the report data after the capture so it reflects the latest run.
  renderReport(win, {
    report: pipeline.getReportData(),
    imageDataUrl: image,
    appUrl: location.href,
  });
  sidebar.setStatus(t(TXT.done));
}

function applyUpdate({ outputs, warnings, running, stage, error }: PipelineUpdate): void {
  lastOutputs = outputs;
  if (DEBUG) (window as unknown as Record<string, unknown>).__techumOutputs = outputs;
  map.render(outputs);
  sidebar.setWarnings(warnings);
  overlay.hidden = !running;
  if (running) {
    overlay.textContent = `${t(TXT.calculating)} — ${stage ? t(stage) : t(TXT.starting)}…`;
  }
  sidebar.setStatus(
    error ? `${t(TXT.error)} ${error}` : running ? t(TXT.calculatingShort) : t(TXT.done),
  );
  sidebar.setReportEnabled(!!outputs.techum && !running);
  // The zone (and any placement in progress) dies with the techum it was cut from.
  if (armingEruv && !outputs.techum) stopArming();
  if (pendingEruv && !running && !error && outputs.techum && !eruvPoint) {
    const point = pendingEruv;
    pendingEruv = null;
    void restoreEruv(point);
  }
  refreshEruvUi();
}

pipeline.onUpdate = (update) => {
  lastUpdate = update;
  applyUpdate(update);
};
