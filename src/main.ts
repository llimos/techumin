import 'leaflet/dist/leaflet.css';
import './style.css';
import { TechumMap } from './map';
import { Sidebar } from './ui/sidebar';
import { TechumPipeline } from './pipeline';
import { DEFAULT_SETTINGS } from './settings';
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

const pipeline = new TechumPipeline(DEFAULT_SETTINGS);
const map = new TechumMap(document.querySelector('#map')!);
const sidebar = new Sidebar(document.querySelector('#sidebar')!, pipeline.getSettings(), {
  onSettingsChange: (partial) => pipeline.updateSettings(partial),
  onLocate: (point) => pick(point),
});

map.onPick = (point) => pick(point);

function pick(point: LatLon): void {
  map.setPoint(point);
  map.map.setView([point.lat, point.lon]);
  pipeline.setPoint(point);
}

pipeline.onUpdate = ({ outputs, warnings, running, stage, error }) => {
  map.render(outputs);
  sidebar.setWarnings(warnings);
  overlay.hidden = !running;
  if (running) overlay.textContent = `Calculating — ${stage ?? 'starting'}…`;
  sidebar.setStatus(error ? `Error: ${error}` : running ? 'Calculating…' : 'Done.');
};
