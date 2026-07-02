/** Rotation helpers for working in a city-angle-aligned frame. */

import type { Position, Geometry, Feature } from 'geojson';

/** Rotate a point counterclockwise by `theta` radians around the origin. */
export function rotatePoint([x, y]: Position, theta: number): Position {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return [x * c - y * s, x * s + y * c];
}

function mapPositions(geom: Geometry, fn: (p: Position) => Position): Geometry {
  const mapDeep = (coords: unknown): unknown =>
    typeof (coords as Position)[0] === 'number'
      ? fn(coords as Position)
      : (coords as unknown[]).map(mapDeep);
  if (geom.type === 'GeometryCollection') {
    return { ...geom, geometries: geom.geometries.map((g) => mapPositions(g, fn)) };
  }
  return { ...geom, coordinates: mapDeep(geom.coordinates) } as Geometry;
}

export function rotateFeature<G extends Geometry>(feat: Feature<G>, theta: number): Feature<G> {
  return { ...feat, geometry: mapPositions(feat.geometry, (p) => rotatePoint(p, theta)) as G };
}

/** All positions of a geometry, flattened. */
export function allPositions(geom: Geometry): Position[] {
  const out: Position[] = [];
  const walk = (coords: unknown): void => {
    if (typeof (coords as Position)[0] === 'number') out.push(coords as Position);
    else (coords as unknown[]).forEach(walk);
  };
  if (geom.type === 'GeometryCollection') geom.geometries.forEach((g) => walk((g as any).coordinates));
  else walk((geom as any).coordinates);
  return out;
}
