// Fit poster pixels → ground coordinates from matched control points.
//   node .claude/skills/eruv-map/georef.mjs points.json --ref=ref.json \
//        [--kind=affine|similarity] [--out=transform.json]
//
// points.json: [{ "name": "roundabout N", "poster": [x,y], "ref": [x,y] }, ...]
//   poster — pixel in the poster image (full-image coordinates)
//   ref    — pixel in the reference render produced by reference.mjs
// Residuals are printed in ground metres; drop or re-read the worst point and
// refit until they are small and evenly spread.
import { readFileSync, writeFileSync } from 'node:fs';
import { args } from './lib/page.mjs';
import { refPixToLatLon } from './lib/leaflet.mjs';
import { toMerc, toLatLon, fit, apply, describe, mercStretch } from './lib/mercator.mjs';

const { opts, rest } = args();
if (!rest[0] && !opts.align) {
  console.error(
    'usage: georef.mjs [points.json] [--ref=ref.json] [--align=align.json] [--kind=affine|similarity]',
  );
  process.exit(2);
}
// --ref is only needed to turn reference PIXELS into coordinates; control
// points that already carry a latlon (junction.mjs) need no reference at all.
const info = opts.ref ? JSON.parse(readFileSync(opts.ref, 'utf8')) : null;

// align.mjs already matched poster pixels to reference pixels; three points
// pushed through that similarity pin down the poster → ground transform
// exactly. Control points, when supplied, then either check it or replace it.
let points = rest[0] ? JSON.parse(readFileSync(rest[0], 'utf8')) : [];
// A similarity needs 2 points, an affine 3 — below that, fall back to align.
const need = opts.kind === 'similarity' ? 2 : 3;
let source = points.length >= need && opts.use !== 'align' ? 'points' : 'align';
if (source === 'align' && !opts.align) {
  console.error('need --align=align.json (or 3+ control points)');
  process.exit(2);
}
let alignRef = null;
if (opts.align) {
  const a = JSON.parse(readFileSync(opts.align, 'utf8'));
  const th = (a.rotationDeg * Math.PI) / 180;
  const co = a.scale * Math.cos(th);
  const si = a.scale * Math.sin(th);
  alignRef = ([x, y]) => {
    const dx = x - a.posterCentre[0];
    const dy = y - a.posterCentre[1];
    return [a.refCentre[0] + co * dx - si * dy, a.refCentre[1] + si * dx + co * dy];
  };
  if (source === 'align')
    points = [
      [a.posterCentre[0] - 500, a.posterCentre[1] - 500],
      [a.posterCentre[0] + 500, a.posterCentre[1] - 500],
      [a.posterCentre[0], a.posterCentre[1] + 500],
    ].map((p, i) => ({ name: `align#${i}`, poster: p, ref: alignRef(p) }));
}
const kind = opts.kind || (points.length >= 3 ? 'affine' : 'similarity');

const latlons = points.map((p) => {
  if (p.latlon) return p.latlon;
  if (!info) throw new Error(`point "${p.name}" has no latlon — pass --ref to use its ref pixel`);
  return refPixToLatLon(info, p.ref);
});
const mercs = latlons.map(toMerc);
const pixels = points.map((p) => p.poster);
const T = fit(pixels, mercs, kind);

const lat0 = latlons.reduce((a, l) => a + l[0], 0) / latlons.length;
const k = mercStretch(lat0);
const rows = points.map((p, i) => {
  const [X, Y] = apply(T, p.poster);
  const dx = (X - mercs[i][0]) / k;
  const dy = (Y - mercs[i][1]) / k;
  return { name: p.name || `#${i}`, latlon: latlons[i], residM: Math.hypot(dx, dy), dx, dy };
});
const rms = Math.sqrt(rows.reduce((a, r) => a + r.residM ** 2, 0) / rows.length);
const d = describe(T, lat0);

console.log(`${kind} fit from ${source} (${points.length} points)`);
console.log('point                      lat        lon         dx(m)   dy(m)  resid(m)');
for (const r of rows)
  console.log(
    `${r.name.slice(0, 24).padEnd(24)}  ${r.latlon[0].toFixed(6)}  ${r.latlon[1].toFixed(6)}  ${r.dx.toFixed(1).padStart(6)}  ${r.dy.toFixed(1).padStart(6)}  ${r.residM.toFixed(1).padStart(7)}`,
  );
console.log(`RMS ${rms.toFixed(2)} m, worst ${Math.max(...rows.map((r) => r.residM)).toFixed(2)} m`);
console.log(
  `scale ${d.mPerPxX.toFixed(3)} × ${d.mPerPxY.toFixed(3)} m/px, rotation ${d.rotationDeg.toFixed(2)}°`,
);
const corner = (p) => toLatLon(apply(T, p)).map((v) => v.toFixed(6)).join(', ');
console.log(`poster (0,0) → ${corner([0, 0])}`);

// When both are available, say how far the control points sit from where the
// automatic alignment puts them — a big gap means one of the two is wrong.
if (alignRef && source === 'points') {
  const d = points.map((p, i) => {
    const [X, Y] = toMerc(refPixToLatLon(info, alignRef(p.poster)));
    return Math.hypot(X - mercs[i][0], Y - mercs[i][1]) / k;
  });
  console.log(`vs align.mjs: mean ${(d.reduce((a, v) => a + v, 0) / d.length).toFixed(1)} m, max ${Math.max(...d).toFixed(1)} m`);
}

const out = opts.out || 'transform.json';
writeFileSync(
  out,
  JSON.stringify(
    { kind, T, lat0, rms, worst: Math.max(...rows.map((r) => r.residM)), scale: d, points: rows },
    null,
    1,
  ),
);
console.log(`→ ${out}`);
