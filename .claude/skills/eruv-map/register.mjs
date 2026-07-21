// Georeference a traced eruv by fitting its OUTLINE to the street network.
//
//   node .claude/skills/eruv-map/register.mjs traces.json --centre=31.7,35.1 \
//        [--radius=2500] [--roads=roads.json] [--scale=0.3,6] [--rot=-25,25]
//        [--out=transform.json] [--report=report.json]
//
// Eruv boundaries run along streets. So rather than matching pixels to a
// reference image (which depends on the map's drawing style) or reading
// control points by hand (which depends on the map printing legible street
// names), this matches the traced polygon itself to OpenStreetMap's road
// geometry: a coarse search over scale, rotation and offset, then trimmed
// ICP. Style-independent, automatic, and self-diagnosing — the residual
// distribution says whether it converged.
//
// Trimming matters: parts of a boundary genuinely leave the road network (a
// fence across open ground, a wadi), so each iteration keeps only the best
// --inliers fraction of points and ignores the rest.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { args, openPage } from './lib/page.mjs';
import { toMerc, fit } from './lib/mercator.mjs';

const { opts, rest } = args();
const centreArg = opts.centre || opts.center;
if (!rest[0] || !centreArg) {
  console.error('usage: register.mjs traces.json --centre=lat,lon [--radius=2500] [--roads=cache.json]');
  process.exit(2);
}
const traces = JSON.parse(readFileSync(rest[0], 'utf8'));
const centre = String(centreArg).split(',').map(Number);
const radius = Number(opts.radius || 2500);
const [sLo, sHi] = String(opts.scale || '0.3,6').split(',').map(Number);
const [rLo, rHi] = String(opts.rot || '-25,25').split(',').map(Number);
const inlierFrac = Number(opts.inliers || 0.6);
const sampleStep = Number(opts.step || 6); // px between boundary samples

// ---------------------------------------------------------------- roads ----
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
];

async function fetchRoads() {
  const cache = opts.roads;
  if (cache && existsSync(cache)) {
    const j = JSON.parse(readFileSync(cache, 'utf8'));
    if (j.centre?.[0] === centre[0] && j.centre?.[1] === centre[1] && j.radius >= radius) return j.ways;
  }
  const q = `[out:json][timeout:120];way(around:${radius},${centre[0]},${centre[1]})["highway"]["highway"!~"^(footway|steps|path|corridor|elevator)$"];out geom;`;
  const ctx = await openPage();
  try {
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
        const ways = (res.elements || [])
          .filter((e) => e.type === 'way' && e.geometry?.length > 1)
          .map((w) => w.geometry.map((g) => [g.lat, g.lon]));
        if (ways.length) {
          if (cache) writeFileSync(cache, JSON.stringify({ centre, radius, ways }));
          return ways;
        }
        last = 'empty result';
      } catch (e) {
        last = String(e).split('\n')[0];
      }
    }
    throw new Error(`Overpass failed: ${last}`);
  } finally {
    await ctx.close();
  }
}

// ------------------------------------------------------------ local frame ---
// Metres east/north of the seed centre. Locally flat is accurate to well
// under a metre over a few km, and keeps the maths readable.
const KY = 110574;
const KX = 111320 * Math.cos((centre[0] * Math.PI) / 180);
const toLocal = ([lat, lon]) => [(lon - centre[1]) * KX, (lat - centre[0]) * KY];
const toLatLon = ([x, y]) => [centre[0] + y / KY, centre[1] + x / KX];

const ways = await fetchRoads();

/** Road centrelines as points every ~5 m, in a hash grid for nearest lookup. */
const CELL = 25;
const grid = new Map();
let roadPts = 0;
const key = (x, y) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
for (const w of ways) {
  for (let i = 1; i < w.length; i++) {
    const a = toLocal(w[i - 1]);
    const b = toLocal(w[i]);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!len) continue;
    const dir = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const n = Math.max(1, Math.ceil(len / 5));
    for (let k = 0; k <= n; k++) {
      const p = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n, dir[0], dir[1]];
      const g = key(p[0], p[1]);
      if (!grid.has(g)) grid.set(g, []);
      grid.get(g).push(p);
      roadPts++;
    }
  }
}

// An eruv boundary runs ALONG a street, so a candidate match must also point
// the same way (mod 180°). Without this, any point in a dense network has a
// road within a few metres and the search cannot tell a real fit from a
// plausible-looking one.
const ANG = Math.cos(((Number(opts.angle || 30) * Math.PI) / 180));

/** Nearest road point with a compatible direction. Searches rings of cells. */
function nearest(x, y, maxD, dir) {
  const cx = Math.floor(x / CELL);
  const cy = Math.floor(y / CELL);
  const rings = Math.ceil(maxD / CELL);
  let best = null;
  let bestD = Infinity;
  const dl = dir ? Math.hypot(dir[0], dir[1]) || 1 : 1;
  for (let r = 0; r <= rings; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only
        const cell = grid.get(`${cx + dx},${cy + dy}`);
        if (!cell) continue;
        for (const p of cell) {
          if (dir) {
            const dot = Math.abs((dir[0] * p[2] + dir[1] * p[3]) / dl);
            if (dot < ANG) continue;
          }
          const d = (p[0] - x) ** 2 + (p[1] - y) ** 2;
          if (d < bestD) {
            bestD = d;
            best = p;
          }
        }
      }
    }
    if (best && r * CELL > Math.sqrt(bestD)) break;
  }
  return bestD <= maxD * maxD ? { p: best, d: Math.sqrt(bestD) } : null;
}

// ------------------------------------------------------- boundary samples ---
/** Every traced ring, resampled at a fixed pixel spacing, with directions. */
const samples = [];
for (const f of traces.faces) {
  for (const ring of [f.ringPx, ...(f.holes || []).map((h) => h.ringPx)]) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (!len) continue;
      const dir = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
      const n = Math.max(1, Math.round(len / sampleStep));
      for (let k = 0; k < n; k++)
        samples.push({
          p: [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n],
          dir,
        });
    }
  }
}
if (!samples.length) {
  console.error('traces.json has no rings');
  process.exit(1);
}
const cx = samples.reduce((a, s) => a + s.p[0], 0) / samples.length;
const cy = samples.reduce((a, s) => a + s.p[1], 0) / samples.length;
// A thinned subsample, used for every score evaluation in the search.
const coarse0 = samples.filter((_, i) => i % Math.ceil(samples.length / 160) === 0);

// Transform state: metres = s·R(θ)·F·(x, y) + t, with F flipping image y so
// that down-the-image becomes south. Written out:
//   X = s(cosθ·x + sinθ·y) + tx
//   Y = s(sinθ·x − cosθ·y) + ty
const linear = ({ s, th }) => {
  const co = s * Math.cos(th);
  const si = s * Math.sin(th);
  return [co, si, si, -co]; // [a b; c d]
};
const applyT = (T, [x, y]) => {
  const [a, b, c, d] = linear(T);
  return [a * x + b * y + T.tx, c * x + d * y + T.ty];
};
const applyDir = (T, [x, y]) => {
  const [a, b, c, d] = linear(T);
  return [a * x + b * y, c * x + d * y];
};

/**
 * How much of the boundary actually lies ON a street: the fraction of samples
 * within TOL metres of a road running the same way. Higher is better.
 *
 * Distance-based objectives cannot choose a scale. Mean distance in metres
 * rewards shrinking (the road network does not shrink with the polygon);
 * dividing by the scale rewards inflating (a fixed pixel tolerance then
 * covers more ground). A hit rate at a FIXED GROUND tolerance is the question
 * that actually matters and has no such gradient — measured on Beit Shemesh,
 * the true fit puts 71% of the boundary within 20 m and the inflated one 29%.
 */
const TOL = Number(opts.tol || 15);
const pixDiag = (() => {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of samples) {
    x0 = Math.min(x0, s.p[0]);
    y0 = Math.min(y0, s.p[1]);
    x1 = Math.max(x1, s.p[0]);
    y1 = Math.max(y1, s.p[1]);
  }
  return Math.hypot(x1 - x0, y1 - y0);
})();

function score(T, pts, tol = TOL) {
  // Reject implausible sizes outright, which also kills the collapse-to-a-dot
  // solution that a hit rate would otherwise tolerate.
  const diag = T.s * pixDiag;
  if (diag < 150 || diag > 20000) return -1;
  let hit = 0;
  let sum = 0;
  for (const p of pts) {
    const [x, y] = applyT(T, p.p);
    const n = nearest(x, y, tol, applyDir(T, p.dir));
    if (n) {
      hit++;
      sum += n.d;
    }
  }
  // hit rate, with a small tie-break favouring tighter hits
  return hit / pts.length - 0.15 * ((hit ? sum / hit : tol) / tol);
}

/** Full diagnostics for one transform, over every boundary sample. */
function diagnose(T) {
  const all = samples.map((s) => {
    const q = applyT(T, s.p);
    const n = nearest(q[0], q[1], 60, applyDir(T, s.dir));
    return n ? n.d : 60 * T.s;
  });
  all.sort((a, b) => a - b);
  const pct = (v) => (100 * all.filter((d) => d <= v).length) / all.length;
  const keep = Math.max(3, Math.round(all.length * inlierFrac));
  return {
    scaleMPerPx: T.s,
    rotationDeg: (T.th * 180) / Math.PI,
    inlierRms: Math.sqrt(all.slice(0, keep).reduce((a, d) => a + d * d, 0) / keep),
    medianDist: all[Math.floor(all.length / 2)],
    hitScore: score(T, coarseAll()),
    within10m: pct(10),
    within20m: pct(20),
    within40m: pct(40),
  };
}
const coarseAll = () => coarse0;

// --check=transform.json scores an existing fit instead of searching, so a
// known-good answer can be compared against what the search picks.
if (opts.check) {
  const T = fromTransform(JSON.parse(readFileSync(opts.check, 'utf8')).T);
  console.log('checked transform:', JSON.stringify(diagnose(T), null, 1));
  process.exit(0);
}

/** Read an existing pixel→Mercator transform back into (s, θ, t) local form. */
function fromTransform(A) {
  const R = 6378137;
  const mercToLatLon = ([x, y]) => [
    (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI),
    (x * 180) / (Math.PI * R),
  ];
  const at = (p) =>
    toLocal(mercToLatLon([A[0] * p[0] + A[1] * p[1] + A[2], A[3] * p[0] + A[4] * p[1] + A[5]]));
  const o = at([0, 0]);
  const ex = at([1000, 0]);
  return {
    s: Math.hypot(ex[0] - o[0], ex[1] - o[1]) / 1000,
    th: Math.atan2(ex[1] - o[1], ex[0] - o[0]),
    tx: o[0],
    ty: o[1],
  };
}

// ------------------------------------------------------------ coarse search -
// --seed refines an existing transform (from align.mjs, a couple of control
// points, or a previous run) instead of searching globally. The global search
// is only trustworthy where the road network is distinctive enough.
const seedT = opts.seed ? fromTransform(JSON.parse(readFileSync(opts.seed, 'utf8')).T) : null;
const starts = [];
if (!seedT) for (let s = sLo; s <= sHi * 1.001; s *= 1.25) {
  for (let deg = rLo; deg <= rHi + 1e-9; deg += 5) {
    const th = (deg * Math.PI) / 180;
    // put the polygon centroid at a grid of offsets around the seed centre
    const base = applyT({ s, th, tx: 0, ty: 0 }, [cx, cy]);
    for (let ox = -600; ox <= 600; ox += 200)
      for (let oy = -600; oy <= 600; oy += 200)
        starts.push({ s, th, tx: ox - base[0], ty: oy - base[1] });
  }
}
if (seedT) starts.push({ ...seedT });
for (const st of starts) st.score = score(st, coarse0, 80);
starts.sort((a, b) => b.score - a.score);
const seeds = starts.slice(0, 20);

// --------------------------------------------------------------------- ICP --
/**
 * Trimmed ICP with the scale HELD FIXED — only rotation and translation move.
 * A free scale collapses: shrinking always brings points nearer to some road.
 * Scale is chosen instead by the coarse grid and the refinement pass below,
 * both judged on the pixel-normalised score.
 */
function icp(T0) {
  let T = { ...T0 };
  let last = Infinity;
  for (let iter = 0; iter < 40; iter++) {
    const pairs = [];
    for (const s of samples) {
      const q = applyT(T, s.p);
      const n = nearest(q[0], q[1], Math.max(20, 120 * Math.pow(0.85, iter)), applyDir(T, s.dir));
      if (n) pairs.push({ q, t: n.p, d: n.d });
    }
    if (pairs.length < 10) return { T, rms: Infinity, px: Infinity };
    pairs.sort((a, b) => a.d - b.d);
    const keep = pairs.slice(0, Math.max(10, Math.round(pairs.length * inlierFrac)));

    const n = keep.length;
    const mq = keep.reduce((a, k) => [a[0] + k.q[0] / n, a[1] + k.q[1] / n], [0, 0]);
    const mt = keep.reduce((a, k) => [a[0] + k.t[0] / n, a[1] + k.t[1] / n], [0, 0]);
    let sxx = 0;
    let sxy = 0;
    for (const k of keep) {
      const a = [k.q[0] - mq[0], k.q[1] - mq[1]];
      const b = [k.t[0] - mt[0], k.t[1] - mt[1]];
      sxx += a[0] * b[0] + a[1] * b[1];
      sxy += a[0] * b[1] - a[1] * b[0];
    }
    const dth = Math.atan2(sxy, sxx); // rigid: rotation only, no scale term
    const co = Math.cos(dth);
    const si = Math.sin(dth);
    const dt = [mt[0] - (co * mq[0] - si * mq[1]), mt[1] - (si * mq[0] + co * mq[1])];
    T = {
      s: T.s,
      th: T.th + dth,
      tx: co * T.tx - si * T.ty + dt[0],
      ty: si * T.tx + co * T.ty + dt[1],
    };
    const rms = Math.sqrt(keep.reduce((a, k) => a + k.d * k.d, 0) / keep.length);
    if (Math.abs(last - rms) < 0.01) break;
    last = rms;
  }
  return { T, rms: last, sc: score(T, coarse0) };
}

let best = null;
for (const seed of seeds) {
  const r = icp(seed);
  if (!best || r.sc > best.sc) best = r;
}
// Never return something worse than what we were given: on a regular street
// grid ICP can walk a block and "converge" to a confidently wrong answer.
if (seedT) {
  const seedScore = score(seedT, coarse0);
  if (!best || best.sc <= seedScore) best = { T: seedT, rms: Infinity, sc: seedScore, keptSeed: true };
}
// Refine the scale around the winner, re-running rigid ICP at each step.
for (let pass = 0; pass < 2; pass++) {
  const span = pass ? 0.03 : 0.12;
  for (let k = -4; k <= 4; k++) {
    if (!k) continue;
    const r = icp({ ...best.T, s: best.T.s * (1 + (span * k) / 4) });
    if (r.sc > best.sc) best = r;
  }
}

// ------------------------------------------------------------------ output --
// Diagnostics over ALL samples, not just the inliers that drove the fit.
const all = samples.map((s) => {
  const q = applyT(best.T, s.p);
  const n = nearest(q[0], q[1], 400, applyDir(best.T, s.dir));
  return n ? n.d : 400;
});
all.sort((a, b) => a - b);
const pct = (v) => (100 * all.filter((d) => d <= v).length) / all.length;
const median = all[Math.floor(all.length / 2)];

// Express as the pixel → Mercator affine the rest of the pipeline expects.
const probe = [
  [0, 0],
  [1000, 0],
  [0, 1000],
];
const T = fit(
  probe,
  probe.map((p) => toMerc(toLatLon(applyT(best.T, p)))),
  'affine',
);
const mPerPx = best.T.s;
const rotationDeg = (best.T.th * 180) / Math.PI;
const report = {
  source: rest[0],
  centre,
  roadPoints: roadPts,
  samples: samples.length,
  scaleMPerPx: mPerPx,
  rotationDeg,
  inlierRms: best.rms,
  medianDist: median,
  within10m: pct(10),
  within20m: pct(20),
  within40m: pct(40),
};
writeFileSync(opts.out || 'transform.json', JSON.stringify({
  kind: 'icp',
  T,
  lat0: centre[0],
  rms: best.rms,
  scale: { mPerPxX: mPerPx, mPerPxY: mPerPx, rotationDeg },
  report,
}, null, 1));
if (opts.report) writeFileSync(opts.report, JSON.stringify(report, null, 1));

console.log(`roads ${roadPts} pts, boundary ${samples.length} samples`);
console.log(`scale ${mPerPx.toFixed(3)} m/px, rotation ${rotationDeg.toFixed(2)}°`);
console.log(
  `inlier RMS ${best.rms.toFixed(1)} m, median ${median.toFixed(1)} m, ` +
    `within 10/20/40 m: ${pct(10).toFixed(0)}/${pct(20).toFixed(0)}/${pct(40).toFixed(0)}%`,
);
console.log(`→ ${opts.out || 'transform.json'}`);
