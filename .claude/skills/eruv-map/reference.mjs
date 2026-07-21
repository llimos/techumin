// Render a real basemap around a known coordinate, as the georeferencing
// reference: the sidecar JSON says exactly which lat/lon each pixel is.
//   node .claude/skills/eruv-map/reference.mjs --centre=31.70445,34.98682 \
//        [--zoom=15.5] [--size=1600x1100] [--basemap=esri|osm]
//        [--out=ref.png] [--json=ref.json]
import { writeFileSync } from 'node:fs';
import { args } from './lib/page.mjs';
import { openMap } from './lib/leaflet.mjs';

const { opts } = args();
const centreArg = opts.centre || opts.center;
if (!centreArg) {
  console.error('usage: reference.mjs --centre=lat,lon [--zoom=15.5] [--size=WxH] [--basemap=esri|osm]');
  process.exit(2);
}
const centre = String(centreArg).split(',').map(Number);
const [width, height] = String(opts.size || '1600x1100').split('x').map(Number);
const zoom = Number(opts.zoom ?? 15.5);
const out = opts.out || 'ref.png';
const json = opts.json || out.replace(/\.png$/, '') + '.json';

const map = await openMap({ width, height, centre, zoom, basemap: opts.basemap || 'esri' });
try {
  await map.settle();
  const info = await map.mapInfo();
  await map.shot(out);
  writeFileSync(json, JSON.stringify({ ...info, basemap: opts.basemap || 'esri' }, null, 1));
  const spanM = ((info.se[1] - info.nw[1]) * 111320 * Math.cos((centre[0] * Math.PI) / 180));
  console.log(`${out} ${info.size.join('x')} @ z${info.zoom}`);
  console.log(`NW ${info.nw.map((v) => v.toFixed(6)).join(', ')}  SE ${info.se.map((v) => v.toFixed(6)).join(', ')}`);
  console.log(`≈ ${(spanM / info.size[0]).toFixed(2)} m/px, ${(spanM / 1000).toFixed(2)} km wide`);
  console.log(`→ ${json}`);
} finally {
  await map.close();
}
