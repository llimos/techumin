// Drives the app headless with two synthetic cities to exercise the havla'ah
// (swallowed city) width rules. Usage: node verify-havlaah.mjs <scenario>
//   maParallel   — defaults (Magen Avraham width, parallel extension)
//   remaParallel — Rema widthwise push, extension parallel to the city
//   remaFull     — Rema widthwise push, extension across the full techum width
import { chromium } from 'playwright-core';

const SETTINGS = {
  maParallel: {},
  remaParallel: { havlaahWidth: 'rema' },
  remaFull: { havlaahWidth: 'rema', havlaahLength: 'fullWidth' },
};
const scenario = process.argv[2];
if (!(scenario in SETTINGS)) {
  console.error(`usage: node verify-havlaah.mjs <${Object.keys(SETTINGS).join('|')}>`);
  process.exit(2);
}

// Local meters around the picked point (31.72, 34.68 — flat coastal plain).
const LAT0 = 31.72;
const LON0 = 34.68;
const M_PER_DEG_LAT = 110882;
const M_PER_DEG_LON = 94787;
const toLL = (x, y) => [LAT0 + y / M_PER_DEG_LAT, LON0 + x / M_PER_DEG_LON];
const toXY = ([lon, lat]) => [(lon - LON0) * M_PER_DEG_LON, (lat - LAT0) * M_PER_DEG_LAT];

// Cities are grids of 10x10 m buildings on a 15 m pitch (gaps < 70 2/3 amot
// cluster as one city; >= 6 buildings so it isn't dismissed as a structure).
let nodeId = 1000;
let wayId = 1;
const elements = [];
function city(x0, y0, cols, rows) {
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const [x1, y1] = [x0 + c * 15, y0 + r * 15];
      const ids = [
        [x1, y1],
        [x1 + 10, y1],
        [x1 + 10, y1 + 10],
        [x1, y1 + 10],
      ].map(([x, y]) => {
        const [lat, lon] = toLL(x, y);
        const id = nodeId++;
        elements.push({ type: 'node', id, lat, lon });
        return id;
      });
      elements.push({ type: 'way', id: wayId++, nodes: [...ids, ids[0]], tags: { building: 'yes' } });
    }
  }
}
// Start city A: 40x25 m around the pick point (viewport centre = 0,0).
city(-20, -12.5, 3, 2);
// City B: 205 m wide x 55 m tall, 600 m due north — fully inside the ~959 m
// measured distance (so it is swallowed), and much wider than city A. With
// amah 48 cm: 2000 amot = 960 m, 4 amot = 1.92 m, so the freed lengthwise
// budget past B is ~53 m; the Rema widthwise band is B +- 960 m.
const B_X = [-102.5, 102.5];
const B_Y = [600, 655];
city(B_X[0], B_Y[0], 14, 4);
const osm = { version: 0.6, generator: 'synthetic', elements };

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const logs = [];
page.on('console', (m) => logs.push(m.text()));
await page.addInitScript((s) => {
  localStorage.setItem('techumin-settings', JSON.stringify(s));
}, SETTINGS[scenario]);
await page.route('**/api/interpreter*', (route) =>
  route.fulfill({ json: osm, headers: { 'Access-Control-Allow-Origin': '*' } }),
);
const port = process.env.PORT ?? '5173';
await page.goto(`http://localhost:${port}/?lat=${LAT0}&lon=${LON0}&debug=1`);
await page.waitForSelector('#status');
await page.waitForTimeout(3000); // let the map settle before picking
// The sidebar offsets the map, so the URL lat/lon sits at the centre of the
// #map container, not of the viewport.
const box = await page.locator('#map').boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForFunction(
  () => document.querySelector('#status')?.textContent === 'Done.',
  null,
  { timeout: 300_000 },
);
const techum = await page.evaluate(() => window.__techumOutputs.techum);
await browser.close();

// The x-span of the techum along the horizontal line y=Y (local meters):
// intersect the line with every ring edge (long edges have no vertices, so
// never scan vertices in a band).
const rings =
  techum.geometry.type === 'Polygon'
    ? techum.geometry.coordinates
    : techum.geometry.coordinates.flat();
function spanAtY(Y) {
  const xs = [];
  for (const ring of rings) {
    const pts = ring.map(toXY);
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[i + 1];
      if (y1 === y2 ? y1 !== Y : (y1 - Y) * (y2 - Y) > 0) continue;
      xs.push(y1 === y2 ? x1 : x1 + ((Y - y1) / (y2 - y1)) * (x2 - x1));
      if (y1 === y2) xs.push(x2);
    }
  }
  if (!xs.length) return undefined;
  return [Math.min(...xs), Math.max(...xs)];
}
const maxY = Math.max(...rings.flat().map((c) => toXY(c)[1]));

const levelSpan = spanAtY(625); // level with city B
const betweenSpan = spanAtY(940); // past B, still within the measured techum
const bumpSpan = spanAtY(maxY - 20); // inside the lengthwise extension past B
const w = (s) => (s ? Math.round(s[1] - s[0]) : NaN);
console.log(`SCENARIO: ${scenario}`);
console.log(`techum top: ${Math.round(maxY)} m (expect ~1025: 12.5 + ~959 + ~53 freed)`);
console.log(`width level with B (y=625):  ${w(levelSpan)} m`);
console.log(`width past B (y=940):        ${w(betweenSpan)} m`);
console.log(`width of extension (y=${Math.round(maxY - 20)}): ${w(bumpSpan)} m`);
for (const l of logs.filter((t) => t.includes("Havla'ah"))) console.log(l);

// Expected widths: base techum ~1958 (40 m shvita + ~959 each side), Rema
// band level with B ~2125 (205 + 960 each side), parallel extension ~205.
const EXPECT = {
  maParallel: { level: [1900, 2020], between: [1900, 2020], bump: [160, 300] },
  remaParallel: { level: [2080, 2180], between: [1900, 2020], bump: [160, 300] },
  remaFull: { level: [2080, 2180], between: [1900, 2020], bump: [1900, 2020] },
}[scenario];
let ok = true;
for (const [name, span] of [
  ['level', levelSpan],
  ['between', betweenSpan],
  ['bump', bumpSpan],
]) {
  const [lo, hi] = EXPECT[name];
  const width = w(span);
  if (!(width >= lo && width <= hi)) {
    console.error(`FAIL: ${name} width ${width} m outside [${lo}, ${hi}]`);
    ok = false;
  }
}
if (maxY < 990 || maxY > 1060) {
  console.error(`FAIL: techum top ${Math.round(maxY)} m outside [990, 1060]`);
  ok = false;
}
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
