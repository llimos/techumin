// Ground error of a transform at known control points — the only honest
// accuracy number, since a fit can look tidy against roads and still be
// displaced. Reports metres at each point.
//
//   node .claude/skills/eruv-map/evaluate.mjs points.json --transform=t.json
//        [--vs=other.json]
import { readFileSync } from 'node:fs';
import { args } from './lib/page.mjs';
import { toMerc, apply, mercStretch } from './lib/mercator.mjs';

const { opts, rest } = args();
if (!rest[0] || !opts.transform) {
  console.error('usage: evaluate.mjs points.json --transform=t.json [--vs=other.json]');
  process.exit(2);
}
const points = JSON.parse(readFileSync(rest[0], 'utf8')).filter((p) => p.latlon && p.poster);
if (!points.length) {
  console.error('points.json needs entries with both "poster" and "latlon"');
  process.exit(1);
}
const load = (f) => JSON.parse(readFileSync(f, 'utf8'));

function errors(T, lat0) {
  const k = mercStretch(lat0);
  return points.map((p) => {
    const [X, Y] = apply(T, p.poster);
    const [tx, ty] = toMerc(p.latlon);
    return Math.hypot(X - tx, Y - ty) / k;
  });
}
const stat = (e) => ({
  rms: Math.sqrt(e.reduce((a, v) => a + v * v, 0) / e.length),
  max: Math.max(...e),
  mean: e.reduce((a, v) => a + v, 0) / e.length,
});

const lat0 = points.reduce((a, p) => a + p.latlon[0], 0) / points.length;
const a = load(opts.transform);
const ea = errors(a.T, lat0);
const sa = stat(ea);
const b = opts.vs ? load(opts.vs) : null;
const eb = b ? errors(b.T, lat0) : null;

console.log(`point                          ${opts.transform.split(/[\\/]/).pop().padEnd(22)}${b ? opts.vs.split(/[\\/]/).pop() : ''}`);
points.forEach((p, i) => {
  console.log(
    `${(p.name || '#' + i).slice(0, 28).padEnd(30)} ${ea[i].toFixed(1).padStart(8)} m` +
      (eb ? `   ${eb[i].toFixed(1).padStart(8)} m` : ''),
  );
});
console.log(
  `RMS ${sa.rms.toFixed(2)} m, max ${sa.max.toFixed(2)} m` +
    (eb ? `   |   RMS ${stat(eb).rms.toFixed(2)} m, max ${stat(eb).max.toFixed(2)} m` : ''),
);
