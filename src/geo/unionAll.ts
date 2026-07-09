/**
 * Robust union of many polygons, divide-and-conquer. Each pair is unioned
 * with polygon-clipping (~8× faster than turf's polyclip-ts on this
 * workload); when it throws, turf's union and then a jitter retry serve as
 * the robust fallback ("Unable to complete output ring" on degenerate sets).
 *
 * Every pairwise union is reduced to its outer contour: holes are dropped
 * (open ground fully enclosed by a city is halachically part of the city)
 * and near-collinear vertices removed, so intermediate polygons stay
 * proportional to their outer perimeter instead of accumulating interior
 * detail — the difference between minutes and seconds on a large city.
 */

import { union, featureCollection } from '@turf/turf';
import polygonClipping from 'polygon-clipping';
import type { MultiPolygon, Polygon, Position } from 'geojson';
import type { Poly } from '../types';

/** Snap coordinates to a grid (meters) — fewer degenerate intersections. */
export function snapCoords(poly: Poly, grid = 0.001): Poly {
  const snap = (p: Position): Position => [
    Math.round(p[0] / grid) * grid,
    Math.round(p[1] / grid) * grid,
  ];
  const mapDeep = (coords: unknown): unknown =>
    typeof (coords as Position)[0] === 'number'
      ? snap(coords as Position)
      : (coords as unknown[]).map(mapDeep);
  return {
    ...poly,
    geometry: { ...poly.geometry, coordinates: mapDeep(poly.geometry.coordinates) },
  } as Poly;
}

export function unionAll(features: Poly[], onDropped?: (count: number) => void): Poly | null {
  if (features.length === 0) return null;
  let dropped = 0;
  const result = unionRec(
    features.map((f) => snapCoords(f)),
    () => dropped++,
  );
  if (dropped > 0) onDropped?.(dropped);
  return result;
}

function unionRec(features: Poly[], onDrop: () => void): Poly | null {
  if (features.length === 0) return null;
  if (features.length === 1) return features[0];
  if (features.length === 2) return unionPair(features[0], features[1], onDrop);
  const mid = features.length >> 1;
  const a = unionRec(features.slice(0, mid), onDrop);
  const b = unionRec(features.slice(mid), onDrop);
  if (!a) return b;
  if (!b) return a;
  return unionPair(a, b, onDrop);
}

function unionPair(a: Poly, b: Poly, onDrop: () => void): Poly {
  // Fast path: polygon-clipping directly.
  try {
    const u = polygonClipping.union(pcGeom(a), pcGeom(b));
    if (u.length > 0) return outerContour(fromPcResult(u));
  } catch {
    // Fall through to the slower but more robust polyclip-ts path.
  }
  try {
    const u = union(featureCollection([a, b])) as Poly | null;
    return u ? outerContour(u) : a;
  } catch {
    // Retry with b nudged by a millimeter to break the degenerate geometry.
    try {
      const nudged = translate(b, 0.001, 0.0007);
      const u = union(featureCollection([a, nudged])) as Poly | null;
      return u ? outerContour(u) : a;
    } catch {
      onDrop();
      return a;
    }
  }
}

type PcGeom = Parameters<typeof polygonClipping.union>[0];

function pcGeom(poly: Poly): PcGeom {
  const g = poly.geometry;
  return (g.type === 'Polygon' ? [g.coordinates] : g.coordinates) as unknown as PcGeom;
}

function fromPcResult(multi: ReturnType<typeof polygonClipping.union>): Poly {
  const coordinates = multi as unknown as MultiPolygon['coordinates'];
  const geometry: Polygon | MultiPolygon =
    coordinates.length === 1
      ? { type: 'Polygon', coordinates: coordinates[0] }
      : { type: 'MultiPolygon', coordinates };
  return { type: 'Feature', properties: {}, geometry };
}

/** Keep only each part's exterior ring, simplified. */
function outerContour(poly: Poly): Poly {
  const g = poly.geometry;
  const coordinates =
    g.type === 'Polygon'
      ? [simplifyRing(g.coordinates[0])]
      : g.coordinates.map((rings) => [simplifyRing(rings[0])]);
  return { ...poly, geometry: { ...g, coordinates } } as Poly;
}

/**
 * Boundary simplification tolerance (meters). Worst-case drift accumulates
 * across the ~log₂N union levels, still well under a meter — negligible next
 * to the 34 m half-gap dilation and OSM footprint accuracy.
 */
const SIMPLIFY_TOL_M = 0.02;

/** Drop vertices lying within the tolerance of the line through their neighbours. */
function simplifyRing(ring: Position[]): Position[] {
  let pts = ring.slice(0, -1);
  while (pts.length > 3) {
    const out: Position[] = [];
    for (let i = 0; i < pts.length; i++) {
      const prev = out.length > 0 ? out[out.length - 1] : pts[pts.length - 1];
      const next = pts[(i + 1) % pts.length];
      if (pointSegDist(pts[i], prev, next) >= SIMPLIFY_TOL_M) out.push(pts[i]);
    }
    if (out.length < 3 || out.length === pts.length) break;
    pts = out;
  }
  return [...pts, pts[0]];
}

/** Distance from p to the segment a–b. */
function pointSegDist(p: Position, a: Position, b: Position): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
}

function translate(poly: Poly, dx: number, dy: number): Poly {
  const mapDeep = (coords: unknown): unknown =>
    typeof (coords as Position)[0] === 'number'
      ? [(coords as Position)[0] + dx, (coords as Position)[1] + dy]
      : (coords as unknown[]).map(mapDeep);
  return {
    ...poly,
    geometry: { ...poly.geometry, coordinates: mapDeep(poly.geometry.coordinates) },
  } as Poly;
}
