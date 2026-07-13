/**
 * Step 1: fetch building footprints around the point from Overpass — and,
 * when the city turns out to reach the loaded boundary, extend the data with
 * strip fetches on just the affected sides (the pipeline drives that loop).
 */

import osmtogeojson from 'osmtogeojson';
import { booleanPointInPolygon, point as turfPoint } from '@turf/turf';
import type { DataEdges, PipelineContext, Poly } from '../types';
import type { Settings } from '../settings';
import type { BBox } from '../geo/dilate';
import { fromLocal } from '../geo/project';

const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
];

/** Depth of each boundary-extension strip. */
export const EXPAND_STEP_M = 1500;
/** Hard cap on the loaded extent per direction — beyond it, borders stay dotted. */
export const MAX_EXTENT_M = 10_000;

export interface FetchResult {
  buildings: Poly[];
  /** Building footprint containing the query point, if any. */
  enclosing: Poly | null;
  /** Rectangle (local frame, meters) the building data covers. */
  extent: BBox;
}

export async function fetchBuildings(
  ctx: PipelineContext,
  settings: Settings,
): Promise<FetchResult> {
  const r = settings.fetchRadiusM;
  const extent: BBox = { minX: -r, minY: -r, maxX: r, maxY: r };
  const buildings = await fetchArea(ctx, extent);
  if (buildings.length === 0) {
    ctx.warn({
      en: 'No buildings found in the loaded area — the point is treated as open country.',
      he: 'לא נמצאו בניינים באזור שנטען — הנקודה נידונת כשדה פתוח.',
    });
  }

  const pt = turfPoint([ctx.point.lon, ctx.point.lat]);
  const enclosing = buildings.find((b) => booleanPointInPolygon(pt, b)) ?? null;

  return { buildings, enclosing, extent };
}

/**
 * Extend the loaded data with one strip per requested side (each side capped
 * at MAX_EXTENT_M by the caller). North/south strips span the current width;
 * east/west strips then span the already-extended height, so a corner between
 * two extended sides is covered too. Returns a new combined result.
 */
export async function extendBuildings(
  ctx: PipelineContext,
  fetched: FetchResult,
  sides: DataEdges,
): Promise<FetchResult> {
  const extent = { ...fetched.extent };
  const buildings = [...fetched.buildings];
  // Buildings straddling a strip boundary come back from both queries.
  const seen = new Set(buildings.map((b) => b.id).filter((id) => id != null));
  const add = async (strip: BBox) => {
    for (const b of await fetchArea(ctx, strip)) {
      if (b.id != null) {
        if (seen.has(b.id)) continue;
        seen.add(b.id);
      }
      buildings.push(b);
    }
  };
  const stepTo = (edge: number) => Math.min(EXPAND_STEP_M, MAX_EXTENT_M - Math.abs(edge));

  if (sides.n) {
    const maxY = extent.maxY + stepTo(extent.maxY);
    await add({ ...extent, minY: extent.maxY, maxY });
    extent.maxY = maxY;
  }
  if (sides.s) {
    const minY = extent.minY - stepTo(extent.minY);
    await add({ ...extent, maxY: extent.minY, minY });
    extent.minY = minY;
  }
  if (sides.e) {
    const maxX = extent.maxX + stepTo(extent.maxX);
    await add({ ...extent, minX: extent.maxX, maxX });
    extent.maxX = maxX;
  }
  if (sides.w) {
    const minX = extent.minX - stepTo(extent.minX);
    await add({ ...extent, maxX: extent.minX, minX });
    extent.minX = minX;
  }

  return { buildings, enclosing: fetched.enclosing, extent };
}

/** Fetch the building polygons in a local-frame rectangle. */
async function fetchArea(ctx: PipelineContext, area: BBox): Promise<Poly[]> {
  const [west, south] = fromLocal(ctx.frame, [area.minX, area.minY]);
  const [east, north] = fromLocal(ctx.frame, [area.maxX, area.maxY]);
  const bbox = `${south},${west},${north},${east}`;
  // maxsize below the server default keeps a worst-case query cheaper to host.
  const query = `
    [out:json][timeout:60][maxsize:268435456];
    (
      way["building"](${bbox});
      relation["building"](${bbox});
    );
    out body;
    >;
    out skel qt;
  `;
  const data = await fetchWithFallback(ctx, query);
  if (data.remark) {
    ctx.warn({ en: `Overpass remark: ${data.remark}`, he: `הערת Overpass: ${data.remark}` });
  }

  const fc = osmtogeojson(data);
  return fc.features.filter(
    (f): f is Poly => f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon',
  );
}

/** A hung mirror must not stall the pipeline forever. */
const FETCH_TIMEOUT_MS = 90_000;
/** Minimum spacing between Overpass requests (fair use). */
const REQUEST_GAP_MS = 1500;
/** Wait before retrying a mirror that answered 429/504 (overload, not failure). */
const OVERLOAD_BACKOFF_MS = 5000;

let lastRequestAt = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Space consecutive Overpass requests at least REQUEST_GAP_MS apart. */
async function politePause(): Promise<void> {
  const wait = lastRequestAt + REQUEST_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
}

/**
 * Public Overpass instances get overloaded; fall through the mirror list.
 * An overload response (429/504) gets one backed-off retry on the same
 * mirror before moving on.
 */
async function fetchWithFallback(ctx: PipelineContext, query: string): Promise<any> {
  let lastError: Error | null = null;
  for (const url of OVERPASS_URLS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      await politePause();
      try {
        const res = await fetch(url, {
          method: 'POST',
          body: query,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (res.status === 429 || res.status === 504) {
          lastError = new Error(`Overpass request failed: ${res.status} ${res.statusText}`);
          if (attempt === 0) await sleep(OVERLOAD_BACKOFF_MS);
          continue;
        }
        if (!res.ok) throw new Error(`Overpass request failed: ${res.status} ${res.statusText}`);
        return await res.json();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        break; // hard failure — no same-mirror retry
      } finally {
        lastRequestAt = Date.now();
      }
    }
    ctx.warn({
      en: `Overpass server ${new URL(url).host} failed (${lastError?.message}) — trying next.`,
      he: `שרת Overpass ‏${new URL(url).host} נכשל (${lastError?.message}) — מנסה את הבא.`,
    });
  }
  throw lastError ?? new Error('All Overpass servers failed');
}
