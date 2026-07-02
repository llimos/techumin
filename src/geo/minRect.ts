/** Minimum-area bounding rectangle via rotating calipers over the convex hull. */

import type { Position } from 'geojson';
import { rotatePoint } from './rotate';

export interface Rect {
  /** CCW rotation (radians) of the rectangle's axes from the x/y axes. */
  angle: number;
  /** Corner positions in the input frame, in ring order. */
  corners: [Position, Position, Position, Position];
  width: number;
  height: number;
  area: number;
}

/** Andrew's monotone chain. Returns hull in CCW order without repeated last point. */
export function convexHull(points: Position[]): Position[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length <= 2) return pts;
  const cross = (o: Position, a: Position, b: Position) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Position[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper: Position[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Axis-aligned bounding rectangle (angle 0). */
export function boundingRect(points: Position[], angle = 0): Rect {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    const [x, y] = angle === 0 ? p : rotatePoint(p, -angle);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const cornersRot: Position[] = [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ];
  const corners = cornersRot.map((p) => (angle === 0 ? p : rotatePoint(p, angle))) as Rect['corners'];
  const width = maxX - minX;
  const height = maxY - minY;
  return { angle, corners, width, height, area: width * height };
}

/** Minimum-area bounding rectangle at any angle. */
export function minAreaRect(points: Position[]): Rect {
  const hull = convexHull(points);
  if (hull.length < 3) return boundingRect(points, 0);
  let best: Rect | null = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const rect = boundingRect(hull, angle);
    if (!best || rect.area < best.area) best = rect;
  }
  return best!;
}
