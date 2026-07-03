/** Step 3: merge cities ≤ 141⅓ amot apart, plus the triangle (ro'in) rule. */

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
import { polygonGap, polygonGapUnder } from '../geo/gaps';
import { allPositions } from '../geo/rotate';
import { featureFromLocal } from '../geo/project';
import { bboxGap, bboxOf, type BBox } from '../geo/dilate';
import { convexHull } from '../geo/minRect';
import { unionAll } from '../geo/unionAll';
import type { CitiesResult } from './findCities';

export function mergeCities(
  ctx: PipelineContext,
  settings: Settings,
  found: CitiesResult,
): City[] {
  const { cities } = found;
  if (cities.length <= 1) return cities;

  // City outlines are already dilated by half the 70⅔ gap on each side, so a
  // real gap of 141⅓ amot appears as 141⅓ − 70⅔ = 70⅔ between the outlines.
  const gapM = (MERGE_GAP_AMOT - CITY_GAP_AMOT) * amahMeters(settings);

  const local = cities.map((c) => c.localPolygon);
  const hulls = local.map((p) => convexHull(allPositions(p.geometry)));
  const bboxes: BBox[] = local.map((p) => bboxOf(allPositions(p.geometry)));
  const centroids = hulls.map((h) => {
    const sx = h.reduce((s, q) => s + q[0], 0);
    const sy = h.reduce((s, q) => s + q[1], 0);
    return [sx / h.length, sy / h.length] as [number, number];
  });
  // Hulls of the raw building vertices — real (undilated) city extents, for
  // measuring the middle city's width in the triangle rule.
  const rawHulls = cities.map((c) => convexHull(c.rawPointsLocal));

  // Union-find over city indices.
  const parent = cities.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (i: number, j: number) => {
    parent[find(i)] = find(j);
  };

  // Rule 1: plain proximity. The bbox gap is a lower bound on the true gap,
  // so it cheaply rejects far-apart pairs before the exact test.
  for (let i = 0; i < cities.length; i++) {
    for (let j = i + 1; j < cities.length; j++) {
      if (bboxGap(bboxes[i], bboxes[j]) > gapM) continue;
      if (polygonGap(local[i], local[j]) <= gapM) join(i, j);
    }
  }

  // Rule 2: triangle rule — a middle city B close to both A and C lets them
  // merge even though they are too far apart on their own. Real-distance
  // conditions (outline gaps are compensated for the 70⅔ dilation):
  //   gap(A,B) ≤ 2000 amot, gap(B,C) ≤ 2000 amot, and
  //   gap(A,C) ≤ 282⅔ amot + B's width along the A–C direction
  // (B is viewed as if moved into the gap between A and C, where its width
  // fills part of the distance). Iterate to a fixed point, since a merge can
  // put new cities within range.
  const amah = amahMeters(settings);
  const comp = CITY_GAP_AMOT * amah;
  const sideLimitM = TRIANGLE_SIDE_AMOT * amah - comp;
  const spanBaseM = TRIANGLE_SPAN_AMOT * amah - comp;
  const n = cities.length;

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

  const spanCache = new Map<number, boolean>();
  const spanOk = (a: number, c: number, b: number): boolean => {
    const key = (a * n + c) * n + b;
    let ok = spanCache.get(key);
    if (ok === undefined) {
      const limit = spanBaseM + widthAlong(rawHulls[b], centroids[a], centroids[c]);
      ok =
        bboxGap(bboxes[a], bboxes[c]) <= limit && polygonGapUnder(local[a], local[c], limit);
      spanCache.set(key, ok);
    }
    return ok;
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (let a = 0; a < n; a++) {
      for (let c = a + 1; c < n; c++) {
        if (find(a) === find(c)) continue;
        for (let b = 0; b < n; b++) {
          if (b === a || b === c) continue;
          // After the pair merges mid-scan, keep going only to absorb further
          // qualifying middle cities not yet in the group.
          const pairMerged = find(a) === find(c);
          if (pairMerged && (!settings.triangleAbsorbsThird || find(b) === find(a))) continue;
          if (!sideOk(a, b) || !sideOk(b, c) || !spanOk(a, c, b)) continue;
          join(a, c);
          if (settings.triangleAbsorbsThird) join(a, b);
          changed = true;
          ctx.warn(
            'Triangle rule applied: two cities merged via a third between them' +
              (settings.triangleAbsorbsThird
                ? ' (third city included).'
                : ' (third city not included).'),
          );
        }
      }
    }
  }

  // Build merged cities.
  const groups = new Map<number, number[]>();
  cities.forEach((_, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  });

  const merged: City[] = [];
  for (const idxs of groups.values()) {
    if (idxs.length === 1) {
      merged.push(cities[idxs[0]]);
      continue;
    }
    const localPolys = idxs.map((i) => cities[i].localPolygon);
    const localPolygon = unionAll(localPolys) ?? localPolys[0];
    merged.push({
      polygon: featureFromLocal(ctx.frame, localPolygon),
      localPolygon,
      rawPointsLocal: idxs.flatMap((i) => cities[i].rawPointsLocal),
      buildingCount: idxs.reduce((s, i) => s + cities[i].buildingCount, 0),
    });
  }
  return merged;
}

/** Extent of a point set projected onto the from→to direction (meters). */
function widthAlong(
  hull: Position[],
  from: [number, number],
  to: [number, number],
): number {
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
