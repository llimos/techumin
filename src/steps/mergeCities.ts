/**
 * Step 3: merge cities in two phases — first plain proximity (≤ 141⅓ amot) to
 * completion, then a single triangle (ro'in) pass between the already-merged
 * cities, so the triangle rule works with whole cities, not raw fragments.
 */

import { buffer, difference, intersect, featureCollection } from '@turf/turf';
import type { Feature, Polygon, Position } from 'geojson';
import type { City, PipelineContext, Poly } from '../types';
import type { LString } from '../i18n';
import {
  CITY_GAP_AMOT,
  MERGE_GAP_AMOT,
  TRIANGLE_SIDE_AMOT,
  TRIANGLE_SPAN_AMOT,
  amahMeters,
  type Settings,
} from '../settings';
import {
  convexOverlap,
  polygonGap,
  polygonGapLine,
  polygonGapUnder,
  segmentCrossesRing,
  type GapLine,
} from '../geo/gaps';
import { allPositions } from '../geo/rotate';
import { featureFromLocal, featureToLocal } from '../geo/project';
import { bboxGap, bboxOf, type BBox } from '../geo/dilate';
import { mergeDataEdges } from '../geo/dataEdges';
import { convexHull } from '../geo/minRect';
import { unionAll } from '../geo/unionAll';
import { unionFind } from '../geo/unionFind';
import { builtUpOutline, type CitiesResult } from './findCities';

export function mergeCities(
  ctx: PipelineContext,
  settings: Settings,
  found: CitiesResult,
): City[] {
  const { cities } = found;
  if (cities.length <= 1) return cities.map((c, i) => ({ ...c, label: String(i + 1) }));
  const plainMerged = mergePlain(ctx, settings, cities);
  if (plainMerged.length <= 2) return plainMerged;
  return mergeTriangles(ctx, settings, plainMerged);
}

/** Formats a distance as e.g. "63 amot/30 metres", in both languages. */
function fmtDist(meters: number, amah: number): LString {
  return {
    en: `${Math.round(meters / amah)} amot/${Math.round(meters)} metres`,
    he: `${Math.round(meters / amah)} אמות/${Math.round(meters)} מטר`,
  };
}

/** Phase 1: merge cities whose gap is ≤ 141⅓ amot (transitively). */
function mergePlain(ctx: PipelineContext, settings: Settings, cities: City[]): City[] {
  // City outlines are already dilated by half the 70⅔ gap on each side, so a
  // real gap of 141⅓ amot appears as 141⅓ − 70⅔ = 70⅔ between the outlines.
  const amah = amahMeters(settings);
  const gapM = (MERGE_GAP_AMOT - CITY_GAP_AMOT) * amah;
  const comp = CITY_GAP_AMOT * amah; // outline gap → real gap between buildings

  const local = cities.map((c) => c.localPolygon);
  const bboxes: BBox[] = local.map((p) => bboxOf(allPositions(p.geometry)));
  const { find, join } = unionFind(cities.length);

  // The bbox gap is a lower bound on the true gap, so it cheaply rejects
  // far-apart pairs before the exact test.
  for (let i = 0; i < cities.length; i++) {
    for (let j = i + 1; j < cities.length; j++) {
      if (bboxGap(bboxes[i], bboxes[j]) > gapM) continue;
      if (polygonGapUnder(local[i], local[j], gapM)) {
        join(i, j);
        const gap = polygonGap(local[i], local[j]);
        const dist = fmtDist(gap + comp, amah);
        ctx.log({
          en: `Merging cities ${i + 1} and ${j + 1} using proximity - ${dist.en}`,
          he: `הערים ${i + 1} ו־${j + 1} מתאחדות מחמת סמיכות — ${dist.he}`,
        });
      }
    }
  }
  return buildMerged(ctx, cities, find, amah);
}

/**
 * Phase 2: triangle rule — a middle city B close to both A and C lets them
 * merge even though they are too far apart on their own. Real-distance
 * conditions (outline gaps are compensated for the 70⅔ dilation):
 *   gap(A,B) ≤ 2000 amot, gap(B,C) ≤ 2000 amot, and
 *   gap(A,C) ≤ 282⅔ amot + B's width along the A–C gap line
 * (B is viewed as if moved into the gap between A and C, where its width
 * fills part of the distance). B must also actually sit opposite that gap:
 * its hull must reach the band swept sideways from the gap between A and C's
 * facing extents (judged by the real undilated hulls — a middle city beyond
 * either outer city in the gap direction does not trigger the rule).
 * The rule only applies when the line between
 * A and C (along their shortest gap) does not pass through a building of any
 * other city besides B. Configurable: whether a B wider than the A–C gap
 * still merges them (Gr"a) or not (Tur/Chazon Ish).
 * A single pass over the plain-merged cities:
 * every triple is judged by the phase-1 city shapes, so one triangle merge
 * does not feed larger composite shapes into further triangle checks.
 */
function mergeTriangles(ctx: PipelineContext, settings: Settings, cities: City[]): City[] {
  // Each plain-merged city is named by its original city numbers, e.g. "1+3".
  const labels = cities.map((c, i) => c.label ?? String(i + 1));
  const local = cities.map((c) => c.localPolygon);
  const bboxes: BBox[] = local.map((p) => bboxOf(allPositions(p.geometry)));
  // Hulls of the building hull vertices — real (undilated) city extents, for
  // measuring the middle city's width.
  const rawHulls = cities.map((c) => convexHull(c.hullPointsLocal));
  // Bbox diagonal of each hull — an upper bound on its width in any direction.
  const rawDiags = rawHulls.map((h) => {
    const bb = bboxOf(h);
    return Math.hypot(bb.maxX - bb.minX, bb.maxY - bb.minY);
  });

  const amah = amahMeters(settings);
  const comp = CITY_GAP_AMOT * amah;
  const sideLimitM = TRIANGLE_SIDE_AMOT * amah - comp;
  const spanBaseM = TRIANGLE_SPAN_AMOT * amah - comp;
  const n = cities.length;
  const { find, join } = unionFind(n);

  const sideCache = new Map<number, boolean>();
  const sideOk = (i: number, j: number): boolean => {
    const key = i < j ? i * n + j : j * n + i;
    let ok = sideCache.get(key);
    if (ok === undefined) {
      ok =
        bboxGap(bboxes[i], bboxes[j]) <= sideLimitM &&
        polygonGapUnder(local[i], local[j], sideLimitM);
      sideCache.set(key, ok);
    }
    return ok;
  };
  // Shortest line between each outer pair's outlines — the A–C gap is
  // measured along it, so B's width and the blocking check use it too.
  const gapLineCache = new Map<number, GapLine>();
  const gapLine = (a: number, c: number): GapLine => {
    const key = a * n + c;
    let line = gapLineCache.get(key);
    if (line === undefined) {
      line = polygonGapLine(local[a], local[c]);
      gapLineCache.set(key, line);
    }
    return line;
  };

  // The area extending from the gap between an outer pair: B qualifies as a
  // middle city only if it reaches the band swept sideways from the gap
  // between A and C's facing extents. Judged on the real (undilated) hulls:
  // the axis u is the shortest line between the two hulls, the facing extent
  // is where the hulls overlap laterally (perpendicular to u), and the
  // corridor spans, along u, the full gap between the facing boundaries over
  // that lateral range. B must overlap [uStart, uEnd] when projected onto u.
  // null: no meaningful gap direction (hulls touch/overlap) — check passes.
  const corridorCache = new Map<number, Corridor | null>();
  const corridor = (a: number, c: number): Corridor | null => {
    const key = a * n + c;
    let cor = corridorCache.get(key);
    if (cor === undefined) {
      cor = gapCorridor(rawHulls[a], rawHulls[c]);
      corridorCache.set(key, cor);
    }
    return cor;
  };
  const inCorridor = (b: number, cor: Corridor | null): boolean => {
    if (cor === null) return true;
    const [lo, hi] = projectRange(rawHulls[b], cor.ux, cor.uy);
    return hi >= cor.uStart && lo <= cor.uEnd;
  };

  // Cities with a building crossed by the shortest line between a pair —
  // such a city blocks the triangle rule for that pair (unless it is the
  // middle city itself). Tested against undilated building extents.
  const blockerCache = new Map<number, number[]>();
  const blockers = (a: number, c: number): number[] => {
    const key = a * n + c;
    let list = blockerCache.get(key);
    if (list === undefined) {
      const { from, to } = gapLine(a, c);
      const minX = Math.min(from[0], to[0]);
      const maxX = Math.max(from[0], to[0]);
      const minY = Math.min(from[1], to[1]);
      const maxY = Math.max(from[1], to[1]);
      list = [];
      for (let d = 0; d < n; d++) {
        if (d === a || d === c) continue;
        const bb = bboxes[d];
        if (bb.minX > maxX || bb.maxX < minX || bb.minY > maxY || bb.maxY < minY) continue;
        if (cities[d].buildingHullsLocal.some((h) => segmentCrossesRing(from, to, h))) {
          list.push(d);
        }
      }
      blockerCache.set(key, list);
    }
    return list;
  };

  const spanCache = new Map<number, boolean>();
  const spanOk = (a: number, c: number, b: number): boolean => {
    const key = (a * n + c) * n + b;
    let ok = spanCache.get(key);
    if (ok === undefined) {
      // The bbox gap is a lower bound on the true gap and the diagonal an
      // upper bound on the width, so this cheaply rejects far-apart pairs
      // before the exact gap line is computed.
      if (bboxGap(bboxes[a], bboxes[c]) > spanBaseM + rawDiags[b]) {
        ok = false;
      } else {
        const line = gapLine(a, c);
        const width = widthAlong(rawHulls[b], line.from, line.to);
        ok = line.dist <= spanBaseM + width;
        // Tur/Chazon Ish: a middle city wider than the gap cannot be viewed
        // as if placed between the outer cities, so they do not merge.
        if (ok && settings.triangleWideMiddle === 'noMerge' && width > line.dist + comp) {
          ok = false;
          ctx.debug(
            `Not merging cities ${labels[a]} and ${labels[c]} via triangle rule around ` +
              `${labels[b]} - its width (${fmtDist(width, amah).en}) exceeds the gap ` +
              `(${fmtDist(line.dist + comp, amah).en}) (Tur/Chazon Ish)`,
          );
        }
      }
      spanCache.set(key, ok);
    }
    return ok;
  };

  for (let a = 0; a < n; a++) {
    for (let c = a + 1; c < n; c++) {
      for (let b = 0; b < n; b++) {
        if (b === a || b === c) continue;
        // Skip when the join would change nothing (also prevents repeat logs).
        const pairMerged = find(a) === find(c);
        if (pairMerged && (!settings.triangleAbsorbsThird || find(b) === find(a))) continue;
        if (!sideOk(a, b) || !sideOk(b, c)) continue;
        if (!inCorridor(b, corridor(a, c))) {
          ctx.debug(
            `Not merging cities ${labels[a]} and ${labels[c]} via triangle rule around ` +
              `${labels[b]} - it lies outside the area extending from the gap between them`,
          );
          continue;
        }
        if (!spanOk(a, c, b)) continue;
        const blocking = blockers(a, c).filter((d) => d !== b);
        if (blocking.length > 0) {
          ctx.debug(
            `Not merging cities ${labels[a]} and ${labels[c]} via triangle rule around ` +
              `${labels[b]} - the ${labels[a]}-${labels[c]} line passes through ` +
              `${blocking.map((d) => labels[d]).join(', ')}`,
          );
          continue;
        }
        join(a, c);
        if (settings.triangleAbsorbsThird) join(a, b);
        {
          // Real distances between buildings: outline gap + the 70⅔ dilation.
          const gapAB = fmtDist(polygonGap(local[a], local[b]) + comp, amah);
          const gapBC = fmtDist(polygonGap(local[b], local[c]) + comp, amah);
          const line = gapLine(a, c);
          const gapAC = fmtDist(line.dist + comp, amah);
          const width = fmtDist(widthAlong(rawHulls[b], line.from, line.to), amah);
          ctx.log({
            en:
              `Merging cities ${labels[a]} and ${labels[c]} using triangle rule around ${labels[b]}. ` +
              `Distances: ${labels[a]}-${labels[b]} ${gapAB.en}, ` +
              `${labels[b]}-${labels[c]} ${gapBC.en}, ` +
              `${labels[a]}-${labels[c]} ${gapAC.en}; ` +
              `width of ${labels[b]} along the ${labels[a]}-${labels[c]} line: ${width.en}`,
            he:
              `הערים ${labels[a]} ו־${labels[c]} מתאחדות בדין רואין סביב ${labels[b]}. ` +
              `מרחקים: ${labels[a]}–${labels[b]} ${gapAB.he}, ` +
              `${labels[b]}–${labels[c]} ${gapBC.he}, ` +
              `${labels[a]}–${labels[c]} ${gapAC.he}; ` +
              `רוחב ${labels[b]} לאורך קו ${labels[a]}–${labels[c]}: ${width.he}`,
          });
        }
      }
    }
  }
  return buildMerged(ctx, cities, find, amah);
}

/**
 * Combine each union-find group into a single city, labelled by the input
 * cities' labels (falling back to their 1-based numbers) joined with '+'.
 * Input cities are never mutated — singletons are shallow-copied — so the raw
 * cities shared with citiesResult stay label-free.
 */
function buildMerged(
  ctx: PipelineContext,
  cities: City[],
  find: (i: number) => number,
  amah: number,
): City[] {
  const halfGapM = (CITY_GAP_AMOT * amah) / 2;
  const byRoot = new Map<number, number[]>();
  cities.forEach((_, i) => {
    const root = find(i);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root)!.push(i);
  });

  const merged: City[] = [];
  for (const idxs of byRoot.values()) {
    const label = idxs.map((i) => cities[i].label ?? String(i + 1)).join('+');
    if (idxs.length === 1) {
      merged.push({ ...cities[idxs[0]], label });
      continue;
    }
    const localPolys = idxs.map((i) => cities[i].localPolygon);
    const closeM = closeRadiusM(amah);
    const rawUnion = unionAll(localPolys) ?? localPolys[0];
    const localPolygon = closeSeams(ctx, rawUnion, closeM);
    const polygon = featureFromLocal(ctx.frame, localPolygon);
    merged.push({
      polygon,
      localPolygon,
      builtUpPolygon: connectedBuiltUp(ctx, polygon, localPolygon, rawUnion, halfGapM),
      hullPointsLocal: idxs.flatMap((i) => cities[i].hullPointsLocal),
      buildingHullsLocal: idxs.flatMap((i) => cities[i].buildingHullsLocal),
      buildingCount: idxs.reduce((s, i) => s + cities[i].buildingCount, 0),
      dataEdges: idxs.map((i) => cities[i].dataEdges).reduce(mergeDataEdges),
      label,
    });
  }
  return merged;
}

/**
 * Radius of the morphological closing that seals a merged city's seams: half
 * the outline merge gap (70⅔ amot between the dilated outlines at the 141⅓-amot
 * building distance), plus 0.5 m so parts at exactly the merge distance still
 * seal.
 */
function closeRadiusM(amah: number): number {
  return ((MERGE_GAP_AMOT - CITY_GAP_AMOT) * amah) / 2 + 0.5;
}

/**
 * Seal the gaps between a merged city's parts, so the merged outline is one
 * shape and a point standing between the parts is inside the city. A
 * morphological closing — dilate by `closeM`, erode back — fills the space
 * between the parts wherever their outlines face each other within the merge
 * distance. Every point in such a gap lies within one part's 70⅔-amot ibur,
 * and the meeting iburim are what make the parts one city — so the gap itself
 * is city ground, unlike the ribua corners or the open strip around the
 * outside. Wider gap regions (including triangle-rule/ro'in gaps, a measuring
 * fiction) stay open. The final union keeps the exact original outline against
 * buffer drift and drops any holes the seal encloses. Local frame in and out
 * (the union runs in the local metric frame, where unionAll's snap grid is
 * millimetres — in geographic degrees it would be ~111 m).
 */
function closeSeams(ctx: PipelineContext, localPolygon: Poly, closeM: number): Poly {
  try {
    const dilated = buffer(featureFromLocal(ctx.frame, localPolygon), closeM / 1000, {
      units: 'kilometers',
    });
    const closed = dilated && buffer(dilated, -closeM / 1000, { units: 'kilometers' });
    if (!closed) return localPolygon;
    return unionAll([localPolygon, featureToLocal(ctx.frame, closed as Poly)]) ?? localPolygon;
  } catch {
    // Degenerate geometry — keep the unsealed union.
    return localPolygon;
  }
}

/**
 * Built-up outline of a merged city that stays connected wherever `polygon`
 * is. Eroding polygon by halfGap to hug the buildings (builtUpOutline) would
 * dissolve the thin seal bridges between merged parts — near the 141⅓-amot
 * merge limit a bridge is only metres wide — leaving parts drawn as separate
 * islands. A closing can't reliably re-bridge them: once eroded the parts sit
 * the full building gap apart, too far to span across a short facing edge.
 *
 * Instead we rebuild each bridge explicitly. `localPolygon − rawUnion` is
 * exactly the fill closeSeams added between the parts (a clean cut: the rest of
 * the outline is shared verbatim, so there are none of the perimeter slivers a
 * buffered opening would leave). That fill sits between the *dilated* parts, so
 * it stops halfGap short of the eroded bodies; dilating it by halfGap and
 * clipping to `polygon` grows a connector that overlaps both eroded parts and
 * stays inside the city. Unioning the connectors onto the eroded body restores
 * every join the merge made. Triangle-rule gaps aren't in `localPolygon`, so no
 * bridge is built there and they stay open.
 */
function connectedBuiltUp(
  ctx: PipelineContext,
  polygon: Poly,
  localPolygon: Poly,
  rawUnion: Poly,
  halfGapM: number,
): Poly {
  const eroded = builtUpOutline(polygon, halfGapM);
  if (eroded === polygon) return polygon; // erosion vanished — nothing to hug
  try {
    const bridges = difference(featureCollection([localPolygon, rawUnion]));
    if (!bridges) return eroded; // parts already touched — no fill was added
    const reach = buffer(featureFromLocal(ctx.frame, bridges), halfGapM / 1000, {
      units: 'kilometers',
    });
    const connector = reach && intersect(featureCollection([reach as Poly, polygon]));
    if (!connector) return eroded;
    const merged = unionAll([
      featureToLocal(ctx.frame, eroded),
      featureToLocal(ctx.frame, connector as Poly),
    ]);
    if (!merged) return eroded;
    const sealed = featureFromLocal(ctx.frame, merged);
    // Connectors only ever join eroded parts; if buffer/clip noise instead
    // added a stray sliver, the plain built-up outline was already better.
    return pieceCount(sealed) <= pieceCount(eroded) ? sealed : eroded;
  } catch {
    // Degenerate geometry — keep the plain built-up outline.
    return eroded;
  }
}

/** Number of disjoint polygons in a feature. */
function pieceCount(poly: Poly): number {
  return poly.geometry.type === 'MultiPolygon' ? poly.geometry.coordinates.length : 1;
}

/** Extent of a point set projected onto the from→to direction (meters). */
function widthAlong(hull: Position[], from: Position, to: Position): number {
  const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
  if (len === 0 || hull.length === 0) return 0;
  const [min, max] = projectRange(hull, (to[0] - from[0]) / len, (to[1] - from[1]) / len);
  return max - min;
}

/** Min/max of a point set projected onto the unit direction (ux, uy). */
function projectRange(points: Position[], ux: number, uy: number): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const [x, y] of points) {
    const t = x * ux + y * uy;
    if (t < min) min = t;
    if (t > max) max = t;
  }
  return [min, max];
}

/**
 * The band extending sideways from the gap between two city hulls: (ux, uy)
 * is the unit direction of the shortest hull-to-hull line, and [uStart, uEnd]
 * the gap's extent along it between the hulls' facing boundaries, over the
 * full lateral range where the hulls face each other.
 */
interface Corridor {
  ux: number;
  uy: number;
  uStart: number;
  uEnd: number;
}

function gapCorridor(hullA: Position[], hullC: Position[]): Corridor | null {
  // Overlapping hulls (deeply concave cities interleaving) have no gap
  // direction; polygonGapLine assumes disjoint boundaries, so bail out first.
  if (convexOverlap(hullA, hullC)) return null;
  const { from, to } = polygonGapLine(hullFeature(hullA), hullFeature(hullC));
  const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
  if (len < 1e-9) return null;
  const ux = (to[0] - from[0]) / len;
  const uy = (to[1] - from[1]) / len;
  const vx = -uy;
  const vy = ux;
  // Lateral (perpendicular to u) range where the hulls face each other.
  // Never empty: the gap line is parallel to u, so its endpoints share one
  // lateral value that lies on both hulls.
  const [aLoV, aHiV] = projectRange(hullA, vx, vy);
  const [cLoV, cHiV] = projectRange(hullC, vx, vy);
  const vLo = Math.max(aLoV, cLoV);
  const vHi = Math.min(aHiV, cHiV);
  // A's facing boundary (max u at a given lateral value) is concave in the
  // lateral value and C's (min u) convex, so their extremes over the facing
  // range are attained at its ends — two slices per hull suffice.
  const uStart = Math.min(
    sliceURange(hullA, ux, uy, vx, vy, vLo)[1],
    sliceURange(hullA, ux, uy, vx, vy, vHi)[1],
  );
  const uEnd = Math.max(
    sliceURange(hullC, ux, uy, vx, vy, vLo)[0],
    sliceURange(hullC, ux, uy, vx, vy, vHi)[0],
  );
  return { ux, uy, uStart, uEnd };
}

/** A convex hull (open vertex loop) as a polygon feature. */
function hullFeature(hull: Position[]): Feature<Polygon> {
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [[...hull, hull[0]]] },
  };
}

/**
 * u-extent of a convex hull's cross-section at lateral position v, where
 * u/v coordinates are dot products with the (ux, uy) / (vx, vy) unit
 * directions. v is expected to lie within the hull's lateral projection.
 */
function sliceURange(
  hull: Position[],
  ux: number,
  uy: number,
  vx: number,
  vy: number,
  v: number,
): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  const add = (u: number) => {
    if (u < min) min = u;
    if (u > max) max = u;
  };
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i];
    const q = hull[(i + 1) % hull.length];
    const sp = p[0] * vx + p[1] * vy - v;
    const sq = q[0] * vx + q[1] * vy - v;
    if (sp === 0) add(p[0] * ux + p[1] * uy);
    else if (sq !== 0 && sp < 0 !== sq < 0) {
      const t = sp / (sp - sq);
      add((p[0] + t * (q[0] - p[0])) * ux + (p[1] + t * (q[1] - p[1])) * uy);
    }
  }
  if (min === Infinity) {
    // v grazed past every edge numerically — use the nearest vertex.
    let best = Infinity;
    for (const p of hull) {
      const s = Math.abs(p[0] * vx + p[1] * vy - v);
      if (s < best) {
        best = s;
        min = max = p[0] * ux + p[1] * uy;
      }
    }
  }
  return [min, max];
}
