/** Step 1: fetch building footprints around the point from Overpass. */

import osmtogeojson from 'osmtogeojson';
import { booleanPointInPolygon, point as turfPoint } from '@turf/turf';
import type { LatLon, PipelineContext, Poly } from '../types';
import type { Settings } from '../settings';

const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
];

export interface FetchResult {
  buildings: Poly[];
  /** Building footprint containing the query point, if any. */
  enclosing: Poly | null;
  radiusM: number;
}

export async function fetchBuildings(
  ctx: PipelineContext,
  settings: Settings,
): Promise<FetchResult> {
  const { lat, lon } = ctx.point;
  const radiusM = settings.fetchRadiusM;
  const query = `
    [out:json][timeout:60];
    (
      way["building"](around:${radiusM},${lat},${lon});
      relation["building"](around:${radiusM},${lat},${lon});
    );
    out body;
    >;
    out skel qt;
  `;
  const data = await fetchWithFallback(ctx, query);
  if (data.remark) ctx.warn(`Overpass remark: ${data.remark}`);

  const fc = osmtogeojson(data);
  const buildings = fc.features.filter(
    (f): f is Poly => f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon',
  );
  if (buildings.length === 0) {
    ctx.warn('No buildings found in the loaded area — the point is treated as open country.');
  }

  const pt = turfPoint([lon, lat]);
  const enclosing = buildings.find((b) => booleanPointInPolygon(pt, b)) ?? null;

  // If any building comes near the fetch boundary, the real city may extend
  // beyond the loaded data and the techum could be understated.
  const edge = nearFetchEdge(buildings, ctx.point, radiusM);
  if (edge) {
    ctx.warn(
      `Buildings reach the ${(radiusM / 1000).toFixed(1)} km data boundary — ` +
        'the city may extend beyond the loaded area; increase the data radius to be sure.',
    );
  }

  return { buildings, enclosing, radiusM };
}

/** Public Overpass instances get overloaded; fall through the mirror list. */
async function fetchWithFallback(ctx: PipelineContext, query: string): Promise<any> {
  let lastError: Error | null = null;
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, { method: 'POST', body: query });
      if (!res.ok) throw new Error(`Overpass request failed: ${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      ctx.warn(`Overpass server ${new URL(url).host} failed (${lastError.message}) — trying next.`);
    }
  }
  throw lastError ?? new Error('All Overpass servers failed');
}

function nearFetchEdge(buildings: Poly[], center: LatLon, radiusM: number): boolean {
  const margin = 0.95;
  const kx = 111320 * Math.cos((center.lat * Math.PI) / 180);
  const ky = 111320;
  for (const b of buildings) {
    const coords =
      b.geometry.type === 'Polygon' ? b.geometry.coordinates[0] : b.geometry.coordinates[0][0];
    for (const [lon, lat] of coords) {
      const dx = (lon - center.lon) * kx;
      const dy = (lat - center.lat) * ky;
      if (Math.hypot(dx, dy) > radiusM * margin) return true;
    }
  }
  return false;
}
