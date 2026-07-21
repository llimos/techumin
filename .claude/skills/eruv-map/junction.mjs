// Ground coordinates for named street intersections, from OpenStreetMap.
//
// A drawn eruv map prints its street names, which makes intersections the
// most reliable control points available — no pixel matching against a
// reference image at all. Feed the result into points.json, filling in the
// "poster" pixel of each junction as you read it off the map.
//
//   node .claude/skills/eruv-map/junction.mjs --centre=32.08486,34.84449 --list
//   node .claude/skills/eruv-map/junction.mjs --centre=... "זומא" "אונקלוס"
//   node .claude/skills/eruv-map/junction.mjs --centre=... --batch=pairs.json > junctions.json
//
// Street names are matched as regular expressions against OSM's `name`, so a
// single distinctive word is safest ("כהנמן", not "הרב כהנמן"). Prefer
// --batch: it avoids passing Hebrew through the shell, where quoting and
// bidirectional text make it easy to send something other than you meant.
// pairs.json is [["street A", "street B"], ...].
//
//   --radius=900    search radius in metres
//   --list[=regex]  list the street names found (with how many ways each has)
import { readFileSync } from 'node:fs';
import { args, openPage } from './lib/page.mjs';

const { opts, rest } = args();
const centre = String(opts.centre || opts.center || '').split(',').map(Number);
if (centre.length !== 2 || centre.some(Number.isNaN)) {
  console.error('usage: junction.mjs --centre=lat,lon (--list | "street A" "street B" | --batch=pairs.json)');
  process.exit(2);
}
const radius = Number(opts.radius || 900);
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
];

const ctx = await openPage();
/**
 * One Overpass request for the whole street network, then every junction is
 * computed locally — public mirrors rate-limit and time out, and a query per
 * pair turns a few seconds of work into ten minutes of retries.
 *
 * The request is issued from a document on the mirror's own origin: that is
 * both same-origin (no CORS) and inside Chromium's TLS stack, which node's
 * does not always agree with here.
 */
async function fetchStreets() {
  const q = `[out:json][timeout:90];way(around:${radius},${centre[0]},${centre[1]})["highway"]["name"];out geom;`;
  let last = 'no mirrors';
  for (const url of [...MIRRORS, ...MIRRORS]) {
    try {
      await ctx.page.goto(new URL(url).origin, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const res = await ctx.page.evaluate(
        async ([path, body]) => {
          const r = await fetch(path, { method: 'POST', body: 'data=' + encodeURIComponent(body) });
          if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
          return await r.json();
        },
        [new URL(url).pathname, q],
      );
      const ways = (res.elements || []).filter((e) => e.type === 'way' && e.geometry && e.tags?.name);
      if (ways.length) return ways;
      last = 'empty result';
    } catch (e) {
      last = String(e).split('\n')[0];
    }
  }
  await ctx.close();
  throw new Error(`Overpass failed: ${last}`);
}

const ways = await fetchStreets();
await ctx.close();

if (opts.list !== undefined) {
  const re = opts.list === true ? null : new RegExp(opts.list);
  const names = new Map();
  for (const w of ways)
    if (!re || re.test(w.tags.name)) names.set(w.tags.name, (names.get(w.tags.name) || 0) + 1);
  console.log(`${ways.length} named ways within ${radius} m; ${names.size} distinct names`);
  for (const [n, c] of [...names].sort((a, b) => b[1] - a[1]))
    console.log(`${String(c).padStart(3)}  ${n}`);
  process.exit(0);
}

const KX = 111320 * Math.cos((centre[0] * Math.PI) / 180);

if (opts.junctions !== undefined) {
  // Every place two differently-named ways share a node. Guessing which
  // streets cross wastes time when OSM's coverage is patchy — this lists the
  // junctions that actually exist, to pick the ones the map shows.
  const at = new Map();
  for (const w of ways)
    for (const g of w.geometry) {
      const k = `${g.lat.toFixed(7)},${g.lon.toFixed(7)}`;
      if (!at.has(k)) at.set(k, new Set());
      at.get(k).add(w.tags.name);
    }
  const found = [];
  for (const [k, names] of at) {
    if (names.size < 2) continue;
    const [lat, lon] = k.split(',').map(Number);
    found.push({
      names: [...names],
      latlon: [lat, lon],
      d: Math.hypot((lat - centre[0]) * 110574, (lon - centre[1]) * KX),
    });
  }
  found.sort((a, b) => a.d - b.d);
  const limit = Number(opts.junctions === true ? 40 : opts.junctions);
  console.log(`${found.length} junctions between differently-named ways`);
  for (const j of found.slice(0, limit))
    console.log(`${j.latlon.map((v) => v.toFixed(7)).join(', ')}  ${Math.round(j.d)}m  ${j.names.join(' X ')}`);
  process.exit(0);
}
const metres = (p, q) => Math.hypot((p.lat - q.lat) * 110574, (p.lon - q.lon) * KX);
const match = (pattern) => {
  const re = new RegExp(pattern);
  return ways.filter((w) => re.test(w.tags.name));
};

/** Where two named streets meet: a shared node, else their closest approach. */
function junction(a, b) {
  const wa = match(a);
  const wb = match(b);
  if (!wa.length) return { error: `no street matching /${a}/ within ${radius} m` };
  if (!wb.length) return { error: `no street matching /${b}/ within ${radius} m` };
  const names =
    [...new Set(wa.map((w) => w.tags.name))].join('/') +
    ' X ' +
    [...new Set(wb.map((w) => w.tags.name))].join('/');
  let best = null;
  for (const p of wa.flatMap((w) => w.geometry))
    for (const q of wb.flatMap((w) => w.geometry)) {
      const d = metres(p, q);
      if (!best || d < best.d) best = { d, lat: (p.lat + q.lat) / 2, lon: (p.lon + q.lon) / 2 };
    }
  if (best.d > 60) return { error: `never closer than ${best.d.toFixed(0)} m — they do not meet here`, names };
  return {
    latlon: [best.lat, best.lon],
    names,
    note: best.d > 1 ? `[no shared node; ${best.d.toFixed(1)} m apart]` : '',
  };
}

if (opts.batch) {
  const pairs = JSON.parse(readFileSync(opts.batch, 'utf8'));
  const out = [];
  for (const [a, b] of pairs) {
    const r = junction(a, b);
    if (r.latlon) out.push({ name: r.names, latlon: r.latlon, poster: null });
    console.error(r.latlon ? `ok   ${r.names} ${r.note}` : `FAIL ${a} X ${b} — ${r.error}`);
  }
  console.log(JSON.stringify(out, null, 1));
  process.exit(0);
}

const [a, b] = rest;
if (!a || !b) {
  console.error('give two street names, --batch=pairs.json, or --list');
  process.exit(2);
}
const r = junction(a, b);
if (r.error) {
  console.error(`${a} X ${b}: ${r.error}`);
  console.error('names are matched as regexes — check them with --list');
  process.exit(1);
}
if (opts.json) console.log(JSON.stringify(r.latlon));
else console.log(`${r.names} — ${r.latlon.map((v) => v.toFixed(7)).join(', ')} ${r.note}`);
