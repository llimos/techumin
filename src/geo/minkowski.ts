/** Minkowski sum of a polygon with an axis-aligned rectangle (local frame). */

import { polygon as turfPolygon } from '@turf/turf';
import type { Position } from 'geojson';
import type { Poly } from '../types';
import { convexHull } from './minRect';
import { unionAll } from './unionAll';

/**
 * poly ⊕ [−dW, dE] × [−dS, dN]: every point within the per-direction offsets
 * of the polygon, with square corners. Built as the union of the polygon with
 * each boundary edge dilated by the offset rectangle.
 */
export function minkowskiSumRect(
  poly: Poly,
  dW: number,
  dE: number,
  dS: number,
  dN: number,
): Poly {
  const offsets: Position[] = [
    [-dW, -dS],
    [dE, -dS],
    [dE, dN],
    [-dW, dN],
  ];
  const parts: Poly[] = [poly];
  const polys =
    poly.geometry.type === 'Polygon' ? [poly.geometry.coordinates] : poly.geometry.coordinates;
  for (const rings of polys) {
    for (const ring of rings) {
      for (let i = 0; i < ring.length - 1; i++) {
        const pts: Position[] = [];
        for (const p of [ring[i], ring[i + 1]]) {
          for (const [ox, oy] of offsets) pts.push([p[0] + ox, p[1] + oy]);
        }
        const hull = convexHull(pts);
        parts.push(turfPolygon([[...hull, hull[0]]]) as Poly);
      }
    }
  }
  return unionAll(parts) ?? poly;
}
