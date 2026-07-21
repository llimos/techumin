// Project traced pixel rings to lat/lon and merge the contiguous eruvin.
//   node .claude/skills/eruv-map/project.mjs traces.json --transform=transform.json \
//        [--names=names.json] [--merge=15] [--out=eruvin.geojson]
//
// names.json: { "3": "רמה ג' 1", "1": "רמה ג' 1 אזור חבקוק", ... } (face id → label)
// --merge is the ground gap in metres below which two areas count as one eruv;
// eruvin sharing a street wall sit a stroke-width apart, unconnected ones are
// far apart. Writes <out> (merged) and <out minus .geojson>-raw.geojson (per face).
import { readFileSync, writeFileSync } from 'node:fs';
import { area, buffer, union, featureCollection, polygon } from '@turf/turf';
import { args } from './lib/page.mjs';
import { toLatLon, apply } from './lib/mercator.mjs';

const { opts, rest } = args();
if (!rest[0] || !opts.transform) {
  console.error('usage: project.mjs traces.json --transform=transform.json [--names=n.json] [--merge=15]');
  process.exit(2);
}
const traces = JSON.parse(readFileSync(rest[0], 'utf8'));
// --drop=7,12 removes areas that turned out not to be eruvin (a map's own
// shading, a legend swatch) without having to retrace.
if (opts.drop) {
  const drop = new Set(String(opts.drop).split(',').map(Number));
  traces.faces = traces.faces.filter((f) => !drop.has(f.id));
  traces.pairs = (traces.pairs || []).filter((p) => !drop.has(p.a) && !drop.has(p.b));
}
const tf = JSON.parse(readFileSync(opts.transform, 'utf8'));
const names = opts.names ? JSON.parse(readFileSync(opts.names, 'utf8')) : {};
const mergeM = Number(opts.merge ?? 15);
const out = opts.out || 'eruvin.geojson';

const mPerPx = (tf.scale.mPerPxX + tf.scale.mPerPxY) / 2;
const ring = (px) => {
  const r = px.map((p) => {
    const [lat, lon] = toLatLon(apply(tf.T, p));
    return [lon, lat];
  });
  const [a, b] = [r[0], r[r.length - 1]];
  if (a[0] !== b[0] || a[1] !== b[1]) r.push([...a]);
  return r;
};

const feats = traces.faces.map((f) => {
  const poly = polygon([ring(f.ringPx), ...(f.holes || []).map((hole) => ring(hole.ringPx))], {
    id: f.id,
    name: names[f.id] || names[String(f.id)] || null,
    colours: f.colours.slice(0, 2).map((c) => c.name),
  });
  poly.properties.areaSqM = Math.round(area(poly));
  return poly;
});
writeFileSync(out.replace(/\.geojson$/, '') + '-raw.geojson', JSON.stringify(featureCollection(feats)));

// Union-find over the adjacency the tracer measured, in ground metres.
const parent = new Map(traces.faces.map((f) => [f.id, f.id]));
const find = (a) => (parent.get(a) === a ? a : (parent.set(a, find(parent.get(a))), parent.get(a)));
const link = (a, b) => parent.set(find(a), find(b));
const joins = [];
for (const p of traces.pairs || []) {
  if (!parent.has(p.a) || !parent.has(p.b)) continue;
  const m = p.px * mPerPx;
  if (m <= mergeM) {
    link(p.a, p.b);
    joins.push(`${p.a}+${p.b} (${m.toFixed(1)} m)`);
  }
}

const groups = new Map();
for (const f of feats) {
  const g = find(f.properties.id);
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push(f);
}

const merged = [];
for (const [g, members] of groups) {
  let feat;
  if (members.length === 1) feat = members[0];
  else {
    // Grow each part by half the merge gap so touching parts fuse, union, shrink back.
    const grown = members.map((m) => buffer(m, mergeM / 2, { units: 'meters' }));
    let u = grown[0];
    for (let i = 1; i < grown.length; i++) u = union(featureCollection([u, grown[i]]));
    feat = buffer(u, -mergeM / 2, { units: 'meters' }) || u;
  }
  const ids = members.map((m) => m.properties.id);
  // Name a merged eruv after its biggest named part — the whole join reads as
  // a paragraph and is no use as a label.
  const named = [...new Set(members.map((m) => m.properties.name).filter(Boolean))];
  const lead = members
    .slice()
    .sort((a, b) => b.properties.areaSqM - a.properties.areaSqM)
    .find((m) => m.properties.name)?.properties.name;
  feat.properties = {
    id: g,
    parts: ids,
    name: lead ? (named.length > 1 ? `${lead} +${named.length - 1}` : lead) : null,
    partNames: named,
    colours: [...new Set(members.flatMap((m) => m.properties.colours))],
    areaSqM: Math.round(area(feat)),
  };
  merged.push(feat);
}
merged.sort((a, b) => b.properties.areaSqM - a.properties.areaSqM);
writeFileSync(out, JSON.stringify(featureCollection(merged), null, 1));

console.log(`scale ${mPerPx.toFixed(3)} m/px; merge gap ${mergeM} m`);
const gaps = (traces.pairs || [])
  .slice()
  .sort((a, b) => a.px - b.px)
  .map((p) => `${p.a}-${p.b}:${(p.px * mPerPx).toFixed(1)}${p.px * mPerPx <= mergeM ? '*' : ''}`);
if (gaps.length) console.log(`gaps in m (* = merged): ${gaps.join(' ')}`);
console.log('eruv                       parts        area (ha)  vertices');
for (const f of merged) {
  const n = f.geometry.coordinates.flat(2).length / 2;
  console.log(
    `${String(f.properties.name || 'eruv ' + f.properties.id).slice(0, 24).padEnd(24)}  ${JSON.stringify(f.properties.parts || [f.properties.id]).padEnd(12)} ${(f.properties.areaSqM / 10000).toFixed(1).padStart(8)}  ${String(n).padStart(6)}`,
  );
}
console.log(`→ ${out} (${merged.length} eruvin) and ${out.replace(/\.geojson$/, '')}-raw.geojson (${feats.length} areas)`);
