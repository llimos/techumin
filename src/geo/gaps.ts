/** Minimum planar gap between two polygon boundaries (meters, local frame). */

import type { Feature, Polygon, MultiPolygon, Position } from 'geojson';

type Poly = Feature<Polygon | MultiPolygon>;

function rings(poly: Poly): Position[][] {
  const g = poly.geometry;
  return g.type === 'Polygon' ? g.coordinates : g.coordinates.flat();
}

function segSegDist(a1: Position, a2: Position, b1: Position, b2: Position): number {
  // Distance between two segments = min over point-to-segment distances,
  // unless they intersect (then 0).
  const d = (p: Position, q1: Position, q2: Position) => {
    const dx = q2[0] - q1[0];
    const dy = q2[1] - q1[1];
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((p[0] - q1[0]) * dx + (p[1] - q1[1]) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = q1[0] + t * dx - p[0];
    const py = q1[1] + t * dy - p[1];
    return Math.hypot(px, py);
  };
  const cross = (o: Position, a: Position, b: Position) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const s1 = cross(a1, a2, b1);
  const s2 = cross(a1, a2, b2);
  const s3 = cross(b1, b2, a1);
  const s4 = cross(b1, b2, a2);
  if (s1 * s2 < 0 && s3 * s4 < 0) return 0;
  return Math.min(d(a1, b1, b2), d(a2, b1, b2), d(b1, a1, a2), d(b2, a1, a2));
}

export function polygonGap(a: Poly, b: Poly): number {
  let min = Infinity;
  for (const ra of rings(a)) {
    for (const rb of rings(b)) {
      for (let i = 0; i < ra.length - 1; i++) {
        for (let j = 0; j < rb.length - 1; j++) {
          const dist = segSegDist(ra[i], ra[i + 1], rb[j], rb[j + 1]);
          if (dist < min) min = dist;
          if (min === 0) return 0;
        }
      }
    }
  }
  return min;
}
