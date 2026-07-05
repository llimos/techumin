import 'leaflet/dist/leaflet.css';
import './style.css';
import { TechumMap } from './map';
import { Sidebar } from './ui/sidebar';
import { TechumPipeline } from './pipeline';
import { amahMeters, loadSettings, saveSettings } from './settings';
import type { LatLon } from './types';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <aside id="sidebar"></aside>
  <div id="map-wrap">
    <div id="map"></div>
    <div id="calc-overlay" hidden></div>
  </div>
`;
const overlay = app.querySelector<HTMLElement>('#calc-overlay')!;

const pipeline = new TechumPipeline(loadSettings());
const map = new TechumMap(document.querySelector('#map')!);
const sidebar = new Sidebar(document.querySelector('#sidebar')!, pipeline.getSettings(), {
  onSettingsChange: (partial) => {
    pipeline.updateSettings(partial);
    const settings = pipeline.getSettings();
    saveSettings(settings);
    map.setAmahMeters(amahMeters(settings));
  },
  onLocate: (point) => pick(point),
});
map.setAmahMeters(amahMeters(pipeline.getSettings()));

map.onPick = (point) => pick(point);

// A lat/lon in the query string centers the map there (without selecting it).
const params = new URLSearchParams(location.search);
const urlLat = Number(params.get('lat'));
const urlLon = Number(params.get('lon'));
if (params.has('lat') && params.has('lon') && Number.isFinite(urlLat) && Number.isFinite(urlLon)) {
  map.map.setView([urlLat, urlLon]);
}

function pick(point: LatLon): void {
  map.setPoint(point);
  map.map.setView([point.lat, point.lon]);
  pipeline.setPoint(point);
  // Record the point in the URL so the location can be shared/reloaded.
  const params = new URLSearchParams(location.search);
  params.set('lat', point.lat.toFixed(6));
  params.set('lon', point.lon.toFixed(6));
  history.replaceState(null, '', `${location.pathname}?${params}${location.hash}`);
}

pipeline.onUpdate = ({ outputs, warnings, running, stage, error }) => {
  map.render(outputs);
  sidebar.setWarnings(warnings);
  overlay.hidden = !running;
  if (running) overlay.textContent = `Calculating — ${stage ?? 'starting'}…`;
  sidebar.setStatus(error ? `Error: ${error}` : running ? 'Calculating…' : 'Done.');
};
