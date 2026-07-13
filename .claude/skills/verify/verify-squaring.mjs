// Drives the app headless with synthetic OSM buildings to exercise the
// perceptual squaring tolerance. Usage: node verify-squaring.mjs <square|straight>
//   square   — jagged near-square city rotated 20°: must be squared at ~20°
//              (tolerant already-square branch, or fast path if ratio ≥ 0.95)
//   straight — city with one wobbly straight side at 20°, irregular top, and
//              chazonIshStraightSide enabled: squaring must align to ~20°
import { chromium } from 'playwright-core';

const scenario = process.argv[2];
if (!['square', 'straight'].includes(scenario)) {
  console.error('usage: node verify-squaring.mjs <square|straight>');
  process.exit(2);
}
const PORT = process.env.PORT ?? '5173';

// Local meters around the picked point (31.72, 34.68 — flat coastal plain).
const LAT0 = 31.72;
const LON0 = 34.68;
const M_PER_DEG_LAT = 110882;
const M_PER_DEG_LON = 94787;
const ROT = (20 * Math.PI) / 180; // whole city rotated 20° CCW
const rot = ([x, y]) => [x * Math.cos(ROT) - y * Math.sin(ROT), x * Math.sin(ROT) + y * Math.cos(ROT)];
const toLL = (x, y) => [LAT0 + y / M_PER_DEG_LAT, LON0 + x / M_PER_DEG_LON];

// 10×10 m buildings on a 24 m pitch (14 m gaps < 70⅔ amot ≈ 33.9 m @ 48 cm).
const boxes = []; // [x, y] of building lower-left corners, local unrotated frame
if (scenario === 'square') {
  // 21×21 grid spanning 490×490 m, centred on the origin. Only the four
  // corner buildings pin the full rectangle (so the min-area rect is the
  // exact square, no tilt); every other boundary building is inset 8 m —
  // ~76% of the ~10.5 m perceptual tolerance of a ~526 m rect. That recesses
  // ~5.6% of the rect area, dropping the fill ratio below OBLONG_RATIO, while
  // no dent comes near the tolerance: only the tolerant branch can square it.
  for (let i = 0; i < 21; i++) {
    for (let j = 0; j < 21; j++) {
      const onEdge = i === 0 || i === 20 || j === 0 || j === 20;
      const corner = (i === 0 || i === 20) && (j === 0 || j === 20);
      let [x, y] = [i * 24 - 240, j * 24 - 240];
      if (onEdge && !corner) {
        if (i === 0) x += 8;
        if (i === 20) x -= 8;
        if (j === 0) y += 8;
        if (j === 20) y -= 8;
      }
      boxes.push([x, y]);
    }
  }
} else {
  // Bottom row flush along y=-50 with ±3 m wobble (straight to the eye);
  // irregular bumpy top so neither square check passes. Spans ~950 m.
  for (let i = 0; i < 40; i++) {
    const x = i * 24 - 480;
    const wobble = 3 * Math.sin(i * 12.9898);
    boxes.push([x, -50 + wobble]);
    const h = 100 + 80 * Math.sin(x / 150) + 40 * Math.sin(x / 47);
    for (let y = -50 + 24; y < -50 + h; y += 24) boxes.push([x, y]);
  }
}

let nodeId = 1000;
let wayId = 1;
const elements = [];
for (const [bx, by] of boxes) {
  const ids = [
    [bx, by],
    [bx + 10, by],
    [bx + 10, by + 10],
    [bx, by + 10],
  ].map((p) => {
    const [lat, lon] = toLL(...rot(p));
    const id = nodeId++;
    elements.push({ type: 'node', id, lat, lon });
    return id;
  });
  elements.push({ type: 'way', id: wayId++, nodes: [...ids, ids[0]], tags: { building: 'yes' } });
}
const osm = { version: 0.6, generator: 'synthetic', elements };

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
if (scenario === 'straight') {
  await page.addInitScript(() =>
    localStorage.setItem('techumin-settings', JSON.stringify({ chazonIshStraightSide: true })),
  );
}
const logs = [];
page.on('console', (m) => logs.push(m.text()));
await page.route('**/api/interpreter*', (route) =>
  route.fulfill({ json: osm, headers: { 'Access-Control-Allow-Origin': '*' } }),
);
await page.goto(`http://localhost:${PORT}/?lat=${LAT0}&lon=${LON0}&debug=1`);
await page.waitForSelector('#status');
await page.waitForTimeout(3000); // let the map settle before picking
const box = await page.locator('#map').boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForFunction(
  () => document.querySelector('#status')?.textContent === 'Done.',
  null,
  { timeout: 300_000 },
);
const result = await page.evaluate(() => ({
  cities: window.__techumOutputs.merged.map((c) => ({ label: c.label, buildings: c.buildingCount })),
  squarings: window.__techumOutputs.squarings.map((s) => ({
    angleDeg: (s.angle * 180) / Math.PI,
    isRectangle: s.isRectangle,
  })),
}));
await browser.close();

console.log(`SCENARIO: ${scenario}`);
console.log(`CITIES: ${JSON.stringify(result.cities)}`);
console.log(`SQUARINGS: ${JSON.stringify(result.squarings)}`);
const debugLogs = logs.filter((t) => t.includes('[techum debug]'));
for (const l of debugLogs) console.log(l);

// The squaring of the (single) city must align to the 20° rotation.
const angErr = Math.min(
  ...result.squarings.map((s) => Math.abs((((s.angleDeg - 20) % 90) + 135) % 90 - 45)),
);
if (result.squarings.length !== 1 || angErr > 1.5) {
  console.error(`FAIL: expected one squaring at ~20°, got ${JSON.stringify(result.squarings)}`);
  process.exit(1);
}
console.log(`PASS: squaring angle within ${angErr.toFixed(2)}° of the city's 20° orientation`);
