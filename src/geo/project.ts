/**
 * Local planar frame in meters centered on the query point, +x east, +y north.
 * Equirectangular approximation — accurate to well under 0.1% within the
 * ~10 km scales this app works at.
 */

import type { Position, Geometry, Feature } from 'geojson';

const M_PER_DEG_LAT = 111320;

export interface LocalFrame {
  lat0: number;
  lon0: number;
  kx: number;
  ky: number;
}

export function makeFrame(lat0: number, lon0: number): LocalFrame {
  return {
    lat0,
    lon0,
    kx: M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180),
    ky: M_PER_DEG_LAT,
  };
}

export function toLocal(f: LocalFrame, [lon, lat]: Position): Position {
  return [(lon - f.lon0) * f.kx, (lat - f.lat0) * f.ky];
}

export function fromLocal(f: LocalFrame, [x, y]: Position): Position {
  return [f.lon0 + x / f.kx, f.lat0 + y / f.ky];
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

export function featureToLocal<G extends Geometry>(f: LocalFrame, feat: Feature<G>): Feature<G> {
  return { ...feat, geometry: mapPositions(feat.geometry, (p) => toLocal(f, p)) as G };
}

export function featureFromLocal<G extends Geometry>(f: LocalFrame, feat: Feature<G>): Feature<G> {
  return { ...feat, geometry: mapPositions(feat.geometry, (p) => fromLocal(f, p)) as G };
}
