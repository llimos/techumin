/**
 * Robust union of many polygons. polyclip occasionally throws "Unable to
 * complete output ring" on large overlapping sets; divide-and-conquer with a
 * jitter retry works around it.
 */

import { union, featureCollection } from '@turf/turf';
import type { Position } from 'geojson';
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
  try {
    return (union(featureCollection([a, b])) as Poly) ?? a;
  } catch {
    // Retry with b nudged by a millimeter to break the degenerate geometry.
    try {
      const nudged = translate(b, 0.001, 0.0007);
      return (union(featureCollection([a, nudged])) as Poly) ?? a;
    } catch {
      onDrop();
      return a;
    }
  }
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
