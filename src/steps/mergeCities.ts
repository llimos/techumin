/** Step 3: merge cities ≤ 141⅓ amot apart, plus the triangle (ro'in) rule. */

import type { Position } from 'geojson';
import type { City, PipelineContext } from '../types';
import { CITY_GAP_AMOT, MERGE_GAP_AMOT, amahMeters, type Settings } from '../settings';
import { polygonGap } from '../geo/gaps';
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

  // Rule 2: triangle rule — a third city C between A and B (viewed as if moved
  // onto the A–B corridor) leaves ≤ 141⅓ amot to each. Projection extremes lie
  // on the convex hull, so hulls suffice. Iterate to a fixed point, since a
  // merge can put new cities within range.
  let changed = true;
  while (changed) {
    changed = false;
    for (let a = 0; a < cities.length; a++) {
      for (let b = a + 1; b < cities.length; b++) {
        if (find(a) === find(b)) continue;
        for (let c = 0; c < cities.length; c++) {
          if (c === a || c === b) continue;
          if (triangleJoins(hulls, centroids, a, b, c, gapM)) {
            join(a, b);
            if (settings.triangleAbsorbsThird) join(a, c);
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

/**
 * Project A, B, C onto the A–B centroid axis; C (at its natural station along
 * the axis) must sit inside the A–B gap leaving ≤ gapM on each side.
 */
function triangleJoins(
  hulls: Position[][],
  centroids: [number, number][],
  a: number,
  b: number,
  c: number,
  gapM: number,
): boolean {
  const [ax, ay] = centroids[a];
  const [bx, by] = centroids[b];
  const len = Math.hypot(bx - ax, by - ay);
  if (len === 0) return false;
  const ux = (bx - ax) / len;
  const uy = (by - ay) / len;

  const interval = (i: number): [number, number] => {
    let min = Infinity;
    let max = -Infinity;
    for (const [x, y] of hulls[i]) {
      const t = (x - ax) * ux + (y - ay) * uy;
      if (t < min) min = t;
      if (t > max) max = t;
    }
    return [min, max];
  };

  const [, aMax] = interval(a);
  const [bMin] = interval(b);
  if (bMin <= aMax) return false; // no corridor gap along the axis
  const [cMin, cMax] = interval(c);
  const gapLeft = cMin - aMax;
  const gapRight = bMin - cMax;
  // C must project into the corridor (not beyond either end) and close both gaps.
  return gapLeft >= 0 && gapRight >= 0 && gapLeft <= gapM && gapRight <= gapM;
}
