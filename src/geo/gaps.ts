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

function exteriorRings(poly: Poly): Position[][] {
  const g = poly.geometry;
  return g.type === 'Polygon' ? [g.coordinates[0]] : g.coordinates.map((rings) => rings[0]);
}

/**
 * True when the boundary gap is ≤ limit. Early-exits on the first close
 * segment pair; exterior rings only (for disjoint polygons the closest points
 * always lie on exterior rings), with a per-segment bbox reject — much faster
 * than an exact polygonGap on large outlines.
 */
export function polygonGapUnder(a: Poly, b: Poly, limit: number): boolean {
  // Precompute b's segment bboxes once.
  const bSegs: { ring: Position[]; boxes: Float64Array }[] = exteriorRings(b).map((ring) => {
    const boxes = new Float64Array((ring.length - 1) * 4);
    for (let j = 0; j < ring.length - 1; j++) {
      boxes[j * 4] = Math.min(ring[j][0], ring[j + 1][0]);
      boxes[j * 4 + 1] = Math.max(ring[j][0], ring[j + 1][0]);
      boxes[j * 4 + 2] = Math.min(ring[j][1], ring[j + 1][1]);
      boxes[j * 4 + 3] = Math.max(ring[j][1], ring[j + 1][1]);
    }
    return { ring, boxes };
  });
  for (const ra of exteriorRings(a)) {
    for (let i = 0; i < ra.length - 1; i++) {
      const p = ra[i];
      const q = ra[i + 1];
      const minX = Math.min(p[0], q[0]) - limit;
      const maxX = Math.max(p[0], q[0]) + limit;
      const minY = Math.min(p[1], q[1]) - limit;
      const maxY = Math.max(p[1], q[1]) + limit;
      for (const { ring, boxes } of bSegs) {
        for (let j = 0; j < ring.length - 1; j++) {
          if (
            boxes[j * 4] > maxX ||
            boxes[j * 4 + 1] < minX ||
            boxes[j * 4 + 2] > maxY ||
            boxes[j * 4 + 3] < minY
          )
            continue;
          if (segSegDist(p, q, ring[j], ring[j + 1]) <= limit) return true;
        }
      }
    }
  }
  return false;
}

/** Closest point to p on the segment q1–q2. */
function closestOnSeg(p: Position, q1: Position, q2: Position): Position {
  const dx = q2[0] - q1[0];
  const dy = q2[1] - q1[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p[0] - q1[0]) * dx + (p[1] - q1[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return [q1[0] + t * dx, q1[1] + t * dy];
}

export interface GapLine {
  dist: number;
  from: Position;
  to: Position;
}

/**
 * The shortest line between two disjoint polygon boundaries: its length and
 * its endpoints (`from` on a, `to` on b). Exterior rings only — for disjoint
 * polygons the closest points always lie on exterior rings.
 */
export function polygonGapLine(a: Poly, b: Poly): GapLine {
  let best: GapLine = { dist: Infinity, from: [0, 0], to: [0, 0] };
  const consider = (p: Position, q: Position) => {
    const dist = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (dist < best.dist) best = { dist, from: p, to: q };
  };
  for (const ra of exteriorRings(a)) {
    for (const rb of exteriorRings(b)) {
      for (let i = 0; i < ra.length - 1; i++) {
        for (let j = 0; j < rb.length - 1; j++) {
          consider(ra[i], closestOnSeg(ra[i], rb[j], rb[j + 1]));
          consider(ra[i + 1], closestOnSeg(ra[i + 1], rb[j], rb[j + 1]));
          consider(closestOnSeg(rb[j], ra[i], ra[i + 1]), rb[j]);
          consider(closestOnSeg(rb[j + 1], ra[i], ra[i + 1]), rb[j + 1]);
        }
      }
    }
  }
  return best;
}

/**
 * True when the segment p–q touches or crosses the closed ring given as an
 * open vertex loop (e.g. a convex hull). A segment with both endpoints
 * outside the ring passes through it iff it crosses the boundary, so this
 * doubles as a pass-through test in that case.
 */
export function segmentCrossesRing(p: Position, q: Position, ring: Position[]): boolean {
  for (let j = 0; j < ring.length; j++) {
    if (segSegDist(p, q, ring[j], ring[(j + 1) % ring.length]) < 1e-9) return true;
  }
  return false;
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
