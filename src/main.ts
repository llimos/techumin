import 'leaflet/dist/leaflet.css';
import './style.css';
import { booleanPointInPolygon, point as turfPoint } from '@turf/turf';
import { TechumMap } from './map';
import { Sidebar } from './ui/sidebar';
import { openReportWindow, renderReport } from './ui/report';
import { TechumPipeline, type PipelineOutputs } from './pipeline';
import { amahMeters, loadSettings, saveSettings } from './settings';
import { DEBUG } from './debug';
import type { LatLon, Poly } from './types';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <aside id="sidebar"></aside>
  <div id="map-wrap">
    <div id="map"></div>
    <div id="calc-overlay" hidden></div>
  </div>
`;
const overlay = app.querySelector<HTMLElement>('#calc-overlay')!;

let lastOutputs: PipelineOutputs = {};
let eruvPoint: LatLon | null = null;
let armingEruv = false;
/** The area the eruv may be placed in, while placement is armed. */
let placementZone: Poly | null = null;
/** Eruv from the URL, applied once the techum is first computed. */
let pendingEruv: LatLon | null = null;

const pipeline = new TechumPipeline(loadSettings());
const map = new TechumMap(document.querySelector('#map')!);
const sidebar = new Sidebar(document.querySelector('#sidebar')!, pipeline.getSettings(), {
  onSettingsChange: (partial) => {
    pipeline.updateSettings(partial);
    const settings = pipeline.getSettings();
    saveSettings(settings);
    map.setAmahMeters(amahMeters(settings));
    // A settings change can reshape the placement zone (or drop the techum
    // entirely, which disarms below).
    if (armingEruv) void refreshZone();
  },
  onLocate: (point) => map.map.setView([point.lat, point.lon]),
  onEruvButton: () => void onEruvButton(),
  onGenerateReport: () => void generateReport(),
});
map.setAmahMeters(amahMeters(pipeline.getSettings()));

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
  sidebar.setStatus('Computing where the eruv can be placed…');
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
    sidebar.setStatus('Eruv not placed — it must be inside the highlighted area.');
    return; // stay armed
  }
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
    sidebar.setStatus('Saved eruv not restored — it is outside the area where an eruv may be placed.');
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
    sidebar.setStatus('Popup blocked — allow popups for this site to generate the report.');
    return;
  }
  sidebar.setStatus('Preparing report…');
  const image = await map.captureReport(lastOutputs.eruvTechum ?? lastOutputs.techum ?? null);
  // Pull the report data after the capture so it reflects the latest run.
  renderReport(win, {
    report: pipeline.getReportData(),
    imageDataUrl: image,
    appUrl: location.href,
  });
  sidebar.setStatus('Done.');
}

pipeline.onUpdate = ({ outputs, warnings, running, stage, error }) => {
  lastOutputs = outputs;
  if (DEBUG) (window as unknown as Record<string, unknown>).__techumOutputs = outputs;
  map.render(outputs);
  sidebar.setWarnings(warnings);
  overlay.hidden = !running;
  if (running) overlay.textContent = `Calculating — ${stage ?? 'starting'}…`;
  sidebar.setStatus(error ? `Error: ${error}` : running ? 'Calculating…' : 'Done.');
  sidebar.setReportEnabled(!!outputs.techum && !running);
  // The zone (and any placement in progress) dies with the techum it was cut from.
  if (armingEruv && !outputs.techum) stopArming();
  if (pendingEruv && !running && !error && outputs.techum && !eruvPoint) {
    const point = pendingEruv;
    pendingEruv = null;
    void restoreEruv(point);
  }
  refreshEruvUi();
};
