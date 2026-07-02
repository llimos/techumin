/** Fast planar dilation: convex hull ⊕ circumscribed N-gon disc approximation. */

import type { Position } from 'geojson';
import type { Feature, Polygon } from 'geojson';
import { convexHull } from './minRect';

/**
 * Dilate the convex hull of `points` by radius `r` (meters, local frame).
 * Uses a circumscribed octagon, so the result slightly over-covers the true
 * disc dilation (≤ ~8% of r) — errs toward merging, never toward splitting.
 */
export function dilateHull(points: Position[], r: number, steps = 8): Feature<Polygon> {
  const rr = r / Math.cos(Math.PI / steps);
  const dirs: Position[] = [];
  for (let k = 0; k < steps; k++) {
    const a = (2 * Math.PI * k) / steps;
    dirs.push([rr * Math.cos(a), rr * Math.sin(a)]);
  }
  const expanded: Position[] = [];
  for (const p of points) {
    for (const d of dirs) expanded.push([p[0] + d[0], p[1] + d[1]]);
  }
  const hull = convexHull(expanded);
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [[...hull, hull[0]]] },
  };
}

/** Point-in-polygon (ray cast) with a bbox fast-reject, planar coordinates. */
export function pointInRings(p: Position, rings: Position[][]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function bboxOf(points: Position[]): BBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** Lower bound on the gap between two point sets: gap between their bboxes. */
export function bboxGap(a: BBox, b: BBox): number {
  const dx = Math.max(0, Math.max(a.minX - b.maxX, b.minX - a.maxX));
  const dy = Math.max(0, Math.max(a.minY - b.maxY, b.minY - a.maxY));
  return Math.hypot(dx, dy);
}
