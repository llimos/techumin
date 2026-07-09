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

/**
 * True when two convex hulls (open vertex loops) are within `limit` of each
 * other. Containment is checked first — a building drawn inside another has
 * no crossing boundary segments, so segment distances alone could miss it.
 */
export function hullsWithinGap(a: Position[], b: Position[], limit: number): boolean {
  if (pointInConvex(a[0], b) || pointInConvex(b[0], a)) return true;
  for (let i = 0; i < a.length; i++) {
    const a2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      if (segSegDist(a[i], a2, b[j], b[(j + 1) % b.length]) <= limit) return true;
    }
  }
  return false;
}

/** Point inside or on a convex hull given as a CCW open vertex loop. */
function pointInConvex(p: Position, hull: Position[]): boolean {
  if (hull.length < 3) return false;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    if ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) < 0) return false;
  }
  return true;
}

/**
 * Do two non-degenerate convex polygons (open vertex loops) intersect?
 * Separating-axis test over both polygons' edge normals.
 */
export function convexOverlap(a: Position[], b: Position[]): boolean {
  return !hasSeparatingAxis(a, b) && !hasSeparatingAxis(b, a);
}

function hasSeparatingAxis(a: Position[], b: Position[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const p = a[i];
    const q = a[(i + 1) % a.length];
    const nx = q[1] - p[1];
    const ny = p[0] - q[0];
    let minA = Infinity, maxA = -Infinity;
    for (const [x, y] of a) {
      const t = x * nx + y * ny;
      if (t < minA) minA = t;
      if (t > maxA) maxA = t;
    }
    let minB = Infinity, maxB = -Infinity;
    for (const [x, y] of b) {
      const t = x * nx + y * ny;
      if (t < minB) minB = t;
      if (t > maxB) maxB = t;
    }
    if (maxA < minB || maxB < minA) return true;
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
  // Per-segment bboxes of b, so segment pairs that cannot beat the current
  // best (bbox distance is a lower bound) are pruned cheaply.
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
      const minX = Math.min(p[0], q[0]);
      const maxX = Math.max(p[0], q[0]);
      const minY = Math.min(p[1], q[1]);
      const maxY = Math.max(p[1], q[1]);
      for (const { ring, boxes } of bSegs) {
        for (let j = 0; j < ring.length - 1; j++) {
          const dx = Math.max(0, boxes[j * 4] - maxX, minX - boxes[j * 4 + 1]);
          const dy = Math.max(0, boxes[j * 4 + 2] - maxY, minY - boxes[j * 4 + 3]);
          if (dx * dx + dy * dy >= best.dist * best.dist) continue;
          consider(p, closestOnSeg(p, ring[j], ring[j + 1]));
          consider(q, closestOnSeg(q, ring[j], ring[j + 1]));
          consider(closestOnSeg(ring[j], p, q), ring[j]);
          consider(closestOnSeg(ring[j + 1], p, q), ring[j + 1]);
        }
      }
    }
  }
  return best;
}

/** Distance from a point to a polygon's boundary (exterior rings). */
export function pointPolygonGap(p: Position, poly: Poly): number {
  let min = Infinity;
  for (const ring of exteriorRings(poly)) {
    for (let i = 0; i < ring.length - 1; i++) {
      const q = closestOnSeg(p, ring[i], ring[i + 1]);
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < min) min = d;
    }
  }
  return min;
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
