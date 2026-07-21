// A Leaflet map in the headless page, from the copy of Leaflet already in the
// repo's node_modules. Used both for the georeferencing reference image and
// for the verification overlay.
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { openPage } from './page.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '../../../..');

export const BASEMAPS = {
  esri: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 19,
  },
  osm: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19 },
};

/**
 * Open a page holding a Leaflet map of the given pixel size. Returns the page
 * context plus `mapInfo()` — centre, zoom and the corner lat/lons Leaflet
 * itself reports, which is what makes reference pixels convertible to ground
 * coordinates without reimplementing the projection.
 */
export async function openMap({ width, height, centre, zoom, basemap = 'esri' }) {
  const ctx = await openPage({ width: width + 40, height: height + 40 });
  const { page } = ctx;
  await page.addStyleTag({ path: resolve(REPO, 'node_modules/leaflet/dist/leaflet.css') });
  await page.addScriptTag({ path: resolve(REPO, 'node_modules/leaflet/dist/leaflet.js') });
  await page.evaluate(
    ({ width, height, centre, zoom, tiles }) => {
      document.body.style.margin = '0';
      const d = document.createElement('div');
      d.id = 'map';
      d.style.width = width + 'px';
      d.style.height = height + 'px';
      document.body.appendChild(d);
      const map = L.map('map', {
        zoomControl: false,
        attributionControl: false,
        zoomSnap: 0,
        fadeAnimation: false,
      });
      if (centre) map.setView(centre, zoom);
      else map.setView([0, 0], 2);
      window.__map = map;
      window.__tilesPending = 0;
      const layer = L.tileLayer(tiles.url, { maxZoom: tiles.maxZoom, keepBuffer: 4 });
      layer.on('tileloadstart', () => window.__tilesPending++);
      layer.on('tileload tileerror', () => window.__tilesPending--);
      layer.addTo(map);
    },
    { width, height, centre, zoom, tiles: BASEMAPS[basemap] || BASEMAPS.esri },
  );
  return {
    ...ctx,
    async settle(ms = 30000) {
      await page.waitForFunction(() => window.__tilesPending <= 0, null, { timeout: ms }).catch(() => {});
      await page.waitForTimeout(1500);
    },
    mapInfo: () =>
      page.evaluate(() => {
        const m = window.__map;
        const s = m.getSize();
        const ll = (x, y) => {
          const p = m.containerPointToLatLng([x, y]);
          return [p.lat, p.lng];
        };
        return {
          size: [s.x, s.y],
          centre: [m.getCenter().lat, m.getCenter().lng],
          zoom: m.getZoom(),
          // pixel (0,0) is the top-left CORNER of the image
          nw: ll(0, 0),
          se: ll(s.x, s.y),
        };
      }),
    shot: (file) => page.locator('#map').screenshot({ path: file }),
  };
}

/**
 * Reference pixel → lat/lon. Web Mercator is linear in pixels at a fixed
 * zoom, so the two corners Leaflet reported pin down the whole image.
 */
export function refPixToLatLon(info, [x, y]) {
  const [w, h] = info.size;
  const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const y0 = mercY(info.nw[0]);
  const y1 = mercY(info.se[0]);
  const my = y0 + (y1 - y0) * (y / h);
  const lat = (2 * Math.atan(Math.exp(my)) - Math.PI / 2) * (180 / Math.PI);
  return [lat, info.nw[1] + (info.se[1] - info.nw[1]) * (x / w)];
}
