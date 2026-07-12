// Drives the app headless with synthetic OSM buildings to exercise the
// triangle-rule corridor check. Usage: node verify-triangle.mjs <in|out>
//   in  — middle city opposite the A–C gap (must merge via triangle rule)
//   out — middle city beyond C, outside the corridor (must NOT merge)
import { chromium } from 'playwright-core';

const scenario = process.argv[2];
if (!['in', 'out', 'edge', 'behindA'].includes(scenario)) {
  console.error('usage: node verify-triangle.mjs <in|out|edge|behindA>');
  process.exit(2);
}

// Local meters around the picked point (31.72, 34.68 — flat coastal plain).
const LAT0 = 31.72;
const LON0 = 34.68;
const M_PER_DEG_LAT = 110882;
const M_PER_DEG_LON = 94787;
const toLL = (x, y) => [LAT0 + y / M_PER_DEG_LAT, LON0 + x / M_PER_DEG_LON];

// Each city: six 10x10 m buildings in a 3x2 grid with 5 m gaps (a city needs
// >= MIN_CITY_BUILDINGS = 6; gaps well under 70 2/3 amot cluster as one) —
// hull extent 40 m wide, 25 m tall, anchored at its lower-left corner.
// Amah = 48 cm. A-C hull gap 150 m = 312.5 amot: > 141 1/3 (no plain merge),
// <= 282 2/3 + B's width 83 1/3 (span OK). Corridor along x: [20, 170].
const A = [-20, -12.5];
const C = [170, -12.5];
const B = {
  in: [55, 280], // x-range [55, 95] inside [20, 170] -> opposite the gap
  out: [240, 280], // x-range [240, 280] beyond C -> outside the corridor
  edge: [165, 280], // x-range [165, 205] grazes the corridor's C end by 5 m
  behindA: [-280, 280], // x-range [-280, -240] beyond A -> outside
}[scenario];
// B is ~270-350 m (~560-720 amot) from both outer cities: within 2000 amot,
// far beyond 141 1/3, so only the triangle rule can merge anything.

let nodeId = 1000;
let wayId = 1;
const elements = [];
for (const [cx, cy] of [A, C, B]) {
  for (const dx of [0, 15, 30]) {
    for (const dy of [0, 15]) {
      const [x1, y1] = [cx + dx, cy + dy];
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
      elements.push({
        type: 'way',
        id: wayId++,
        nodes: [...ids, ids[0]],
        tags: { building: 'yes' },
      });
    }
  }
}
const osm = { version: 0.6, generator: 'synthetic', elements };

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const logs = [];
page.on('console', (m) => logs.push(m.text()));
let intercepts = 0;
await page.route('**/api/interpreter*', (route) => {
  intercepts++;
  return route.fulfill({
    json: osm,
    headers: { 'Access-Control-Allow-Origin': '*' },
  });
});
await page.goto(`http://localhost:5173/?lat=${LAT0}&lon=${LON0}&debug=1`);
await page.waitForSelector('#status');
await page.waitForTimeout(3000); // let the map settle before picking
await page.mouse.click(640, 450); // viewport centre = URL lat/lon = inside A
await page.waitForFunction(
  () => document.querySelector('#status')?.textContent === 'Done.',
  null,
  { timeout: 300_000 },
);
const merged = await page.evaluate(() =>
  window.__techumOutputs.merged.map((c) => ({ label: c.label, buildings: c.buildingCount })),
);
const fetched = await page.evaluate(() => window.__techumOutputs.fetched?.buildings?.length);
console.log(`SCENARIO: ${scenario}`);
console.log(`OVERPASS INTERCEPTS: ${intercepts}, BUILDINGS FETCHED: ${fetched}`);
console.log(`MERGED CITIES: ${JSON.stringify(merged)}`);
for (const l of logs.filter((t) => t.includes('[techum debug]'))) console.log(l);
await browser.close();
