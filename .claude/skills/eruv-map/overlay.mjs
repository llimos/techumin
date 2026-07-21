// Draw the resulting eruvin over a real basemap, as the reality check.
//   node .claude/skills/eruv-map/overlay.mjs eruvin.geojson [--basemap=esri|osm]
//        [--size=1600x1100] [--out=overlay.png] [--pad=0.05]
import { readFileSync } from 'node:fs';
import { args } from './lib/page.mjs';
import { openMap } from './lib/leaflet.mjs';

const { opts, rest } = args();
if (!rest[0]) {
  console.error('usage: overlay.mjs eruvin.geojson [--basemap=esri|osm] [--size=WxH] [--out=png]');
  process.exit(2);
}
const gj = JSON.parse(readFileSync(rest[0], 'utf8'));
const [width, height] = String(opts.size || '1600x1100').split('x').map(Number);
const out = opts.out || 'overlay.png';

const map = await openMap({ width, height, basemap: opts.basemap || 'esri' });
try {
  const info = await map.page.evaluate(
    ({ gj }) => {
      const palette = ['#ffeb3b', '#ff5252', '#00e5ff', '#69f0ae', '#e040fb', '#ffa726', '#b388ff'];
      const layer = L.geoJSON(gj, {
        style: (f) => ({
          color: palette[(f.properties.id ?? 0) % palette.length],
          weight: 3,
          fillOpacity: 0.25,
        }),
      }).addTo(window.__map);
      layer.eachLayer((l) => {
        const p = l.feature.properties;
        l.bindTooltip(`${p.name || 'eruv ' + p.id} — ${(p.areaSqM / 10000).toFixed(1)} ha`, {
          permanent: true,
          direction: 'center',
          className: 'lbl',
        });
      });
      const css = document.createElement('style');
      css.textContent =
        '.lbl{background:#000c;color:#fff;border:0;font:bold 13px sans-serif;box-shadow:none}.lbl::before{display:none}';
      document.head.appendChild(css);
      window.__map.fitBounds(layer.getBounds(), { padding: [20, 20] });
      const b = layer.getBounds();
      return {
        bounds: [
          [b.getSouth(), b.getWest()],
          [b.getNorth(), b.getEast()],
        ],
        zoom: window.__map.getZoom(),
      };
    },
    { gj },
  );
  await map.settle();
  await map.shot(out);
  console.log(`${out} — ${gj.features.length} eruvin, z${info.zoom.toFixed(1)}`);
  console.log(`bounds S,W ${info.bounds[0].map((v) => v.toFixed(5))} → N,E ${info.bounds[1].map((v) => v.toFixed(5))}`);
} finally {
  await map.close();
}
