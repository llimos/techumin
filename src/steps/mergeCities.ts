/**
 * Step 3: merge cities in two phases — first plain proximity (≤ 141⅓ amot) to
 * completion, then a single triangle (ro'in) pass between the already-merged
 * cities, so the triangle rule works with whole cities, not raw fragments.
 */

import type { Position } from 'geojson';
import type { City, PipelineContext } from '../types';
import {
  CITY_GAP_AMOT,
  MERGE_GAP_AMOT,
  TRIANGLE_SIDE_AMOT,
  TRIANGLE_SPAN_AMOT,
  amahMeters,
  type Settings,
} from '../settings';
import {
  polygonGap,
  polygonGapLine,
  polygonGapUnder,
  segmentCrossesRing,
  type GapLine,
} from '../geo/gaps';
import { allPositions } from '../geo/rotate';
import { featureFromLocal } from '../geo/project';
import { bboxGap, bboxOf, type BBox } from '../geo/dilate';
import { convexHull } from '../geo/minRect';
import { unionAll } from '../geo/unionAll';
import { unionFind } from '../geo/unionFind';
import { DEBUG, debugLog } from '../debug';
import type { CitiesResult } from './findCities';

export function mergeCities(
  ctx: PipelineContext,
  settings: Settings,
  found: CitiesResult,
): City[] {
  const { cities } = found;
  if (cities.length <= 1) return cities;
  const { merged: plainMerged, groups } = mergePlain(ctx, settings, cities);
  if (plainMerged.length <= 2) return plainMerged;
  // Debug labels: each plain-merged city named by its original city numbers.
  const labels = groups.map((g) => g.map((i) => i + 1).join('+'));
  return mergeTriangles(ctx, settings, plainMerged, labels);
}

/** Formats a distance as e.g. "63 amot/30 metres" for debug messages. */
function fmtDist(meters: number, amah: number): string {
  return `${Math.round(meters / amah)} amot/${Math.round(meters)} metres`;
}

/** Phase 1: merge cities whose gap is ≤ 141⅓ amot (transitively). */
function mergePlain(
  ctx: PipelineContext,
  settings: Settings,
  cities: City[],
): { merged: City[]; groups: number[][] } {
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
        if (DEBUG) {
          const gap = polygonGap(local[i], local[j]);
          debugLog(
            `Merging cities ${i + 1} and ${j + 1} using proximity - ${fmtDist(gap + comp, amah)}`,
          );
        }
      }
    }
  }
  return buildMerged(ctx, cities, find);
}

/**
 * Phase 2: triangle rule — a middle city B close to both A and C lets them
 * merge even though they are too far apart on their own. Real-distance
 * conditions (outline gaps are compensated for the 70⅔ dilation):
 *   gap(A,B) ≤ 2000 amot, gap(B,C) ≤ 2000 amot, and
 *   gap(A,C) ≤ 282⅔ amot + B's width along the A–C gap line
 * (B is viewed as if moved into the gap between A and C, where its width
 * fills part of the distance). The rule only applies when the line between
 * A and C (along their shortest gap) does not pass through a building of any
 * other city besides B. Configurable: whether a B wider than the A–C gap
 * still merges them (Gr"a) or not (Tur/Chazon Ish).
 * A single pass over the plain-merged cities:
 * every triple is judged by the phase-1 city shapes, so one triangle merge
 * does not feed larger composite shapes into further triangle checks.
 */
function mergeTriangles(
  ctx: PipelineContext,
  settings: Settings,
  cities: City[],
  labels: string[],
): City[] {
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
          debugLog(
            `Not merging cities ${labels[a]} and ${labels[c]} via triangle rule around ` +
              `${labels[b]} - its width (${fmtDist(width, amah)}) exceeds the gap ` +
              `(${fmtDist(line.dist + comp, amah)}) (Tur/Chazon Ish)`,
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
        // Skip when the join would change nothing (also prevents repeat warns).
        const pairMerged = find(a) === find(c);
        if (pairMerged && (!settings.triangleAbsorbsThird || find(b) === find(a))) continue;
        if (!sideOk(a, b) || !sideOk(b, c) || !spanOk(a, c, b)) continue;
        const blocking = blockers(a, c).filter((d) => d !== b);
        if (blocking.length > 0) {
          debugLog(
            `Not merging cities ${labels[a]} and ${labels[c]} via triangle rule around ` +
              `${labels[b]} - the ${labels[a]}-${labels[c]} line passes through ` +
              `${blocking.map((d) => labels[d]).join(', ')}`,
          );
          continue;
        }
        join(a, c);
        if (settings.triangleAbsorbsThird) join(a, b);
        if (DEBUG) {
          // Real distances between buildings: outline gap + the 70⅔ dilation.
          const gapAB = polygonGap(local[a], local[b]) + comp;
          const gapBC = polygonGap(local[b], local[c]) + comp;
          const line = gapLine(a, c);
          const gapAC = line.dist + comp;
          const width = widthAlong(rawHulls[b], line.from, line.to);
          debugLog(
            `Merging cities ${labels[a]} and ${labels[c]} using triangle rule around ${labels[b]}. ` +
              `Distances: ${labels[a]}-${labels[b]} ${fmtDist(gapAB, amah)}, ` +
              `${labels[b]}-${labels[c]} ${fmtDist(gapBC, amah)}, ` +
              `${labels[a]}-${labels[c]} ${fmtDist(gapAC, amah)}; ` +
              `width of ${labels[b]} along the ${labels[a]}-${labels[c]} line: ${fmtDist(width, amah)}`,
          );
        }
        ctx.warn(
          'Triangle rule applied: two cities merged via a third between them' +
            (settings.triangleAbsorbsThird
              ? ' (third city included).'
              : ' (third city not included).'),
        );
      }
    }
  }
  return buildMerged(ctx, cities, find).merged;
}

/**
 * Combine each union-find group into a single city. Also returns, per merged
 * city, the input-city indices it came from (for debug labelling).
 */
function buildMerged(
  ctx: PipelineContext,
  cities: City[],
  find: (i: number) => number,
): { merged: City[]; groups: number[][] } {
  const byRoot = new Map<number, number[]>();
  cities.forEach((_, i) => {
    const root = find(i);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root)!.push(i);
  });

  const merged: City[] = [];
  const groups: number[][] = [];
  for (const idxs of byRoot.values()) {
    groups.push(idxs);
    if (idxs.length === 1) {
      merged.push(cities[idxs[0]]);
      continue;
    }
    const localPolys = idxs.map((i) => cities[i].localPolygon);
    const localPolygon = unionAll(localPolys) ?? localPolys[0];
    merged.push({
      polygon: featureFromLocal(ctx.frame, localPolygon),
      localPolygon,
      hullPointsLocal: idxs.flatMap((i) => cities[i].hullPointsLocal),
      buildingHullsLocal: idxs.flatMap((i) => cities[i].buildingHullsLocal),
      buildingCount: idxs.reduce((s, i) => s + cities[i].buildingCount, 0),
    });
  }
  return { merged, groups };
}

/** Extent of a point set projected onto the from→to direction (meters). */
function widthAlong(hull: Position[], from: Position, to: Position): number {
  const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
  if (len === 0 || hull.length === 0) return 0;
  const ux = (to[0] - from[0]) / len;
  const uy = (to[1] - from[1]) / len;
  let min = Infinity;
  let max = -Infinity;
  for (const [x, y] of hull) {
    const t = x * ux + y * uy;
    if (t < min) min = t;
    if (t > max) max = t;
  }
  return max - min;
}
