/** Step 1: fetch building footprints around the point from Overpass. */

import osmtogeojson from 'osmtogeojson';
import { booleanPointInPolygon, point as turfPoint } from '@turf/turf';
import type { PipelineContext, Poly } from '../types';
import type { Settings } from '../settings';
import { anyDataEdge, dataEdgesOfPoints, describeDataEdges } from '../geo/dataEdges';
import { toLocal } from '../geo/project';

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
  // Square fetch area: radiusM is the distance from the point to each edge.
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
  const bbox = `${lat - dLat},${lon - dLon},${lat + dLat},${lon + dLon}`;
  const query = `
    [out:json][timeout:60];
    (
      way["building"](${bbox});
      relation["building"](${bbox});
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
  const edges = dataEdgesOfPoints(
    buildings.flatMap((b) => {
      const coords =
        b.geometry.type === 'Polygon' ? b.geometry.coordinates[0] : b.geometry.coordinates[0][0];
      return coords.map((p) => toLocal(ctx.frame, p));
    }),
    radiusM,
  );
  if (anyDataEdge(edges)) {
    ctx.warn(
      `Buildings reach the ${describeDataEdges(edges)} edge(s) of the ` +
        `${(radiusM / 1000).toFixed(1)} km data boundary — the city may extend beyond ` +
        'the loaded area (those borders are drawn dotted); increase the data radius to be sure.',
    );
  }

  return { buildings, enclosing, radiusM };
}

/** A hung mirror must not stall the pipeline forever. */
const FETCH_TIMEOUT_MS = 90_000;

/** Public Overpass instances get overloaded; fall through the mirror list. */
async function fetchWithFallback(ctx: PipelineContext, query: string): Promise<any> {
  let lastError: Error | null = null;
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: query,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Overpass request failed: ${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      ctx.warn(`Overpass server ${new URL(url).host} failed (${lastError.message}) — trying next.`);
    }
  }
  throw lastError ?? new Error('All Overpass servers failed');
}
