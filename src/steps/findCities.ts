/**
 * Step 2: cluster buildings into halachic cities (gaps ≤ 70⅔ amot, ≥ 6
 * buildings). All geometry runs in the local planar frame. Each building's
 * convex hull is dilated by half the gap; buildings whose dilations overlap
 * belong to one city (ibur ir). Clustering runs first — union-find over a
 * spatial hash grid, with pairwise overlap tests — which fixes membership
 * and counts cheaply; only then is each cluster's outline built by unioning
 * its members' dilations. The expensive polygon union never crosses cluster
 * boundaries, and members are unioned in Morton order so each intermediate
 * union merges adjacent geometry.
 */

import type { Position } from 'geojson';
import type { City, PipelineContext, Poly } from '../types';
import { CITY_GAP_AMOT, MIN_CITY_BUILDINGS, amahMeters, type Settings } from '../settings';
import { featureFromLocal, fromLocal, toLocal } from '../geo/project';
import { DEBUG, debugLog } from '../debug';
import { allPositions } from '../geo/rotate';
import { bboxOf, dilateHullPoints, pointInRings } from '../geo/dilate';
import { convexHull } from '../geo/minRect';
import { convexOverlap, hullsWithinGap } from '../geo/gaps';
import { unionFind } from '../geo/unionFind';
import { unionAll } from '../geo/unionAll';
import type { FetchResult } from './fetchBuildings';

export interface CitiesResult {
  cities: City[];
  /** Building clusters too small to be cities. */
  structures: City[];
}

export function findCities(
  ctx: PipelineContext,
  settings: Settings,
  fetched: FetchResult,
): CitiesResult {
  const { buildings } = fetched;
  if (buildings.length === 0) return { cities: [], structures: [] };

  const gapM = CITY_GAP_AMOT * amahMeters(settings);
  const halfGapM = gapM / 2;

  // Local-frame vertices, convex hull, and half-gap dilation per building.
  const buildingPoints: Position[][] = buildings.map((b) =>
    allPositions(b.geometry).map((p) => toLocal(ctx.frame, p)),
  );
  const hulls = buildingPoints.map(convexHull);
  const dilated = buildingPoints.map((pts) => dilateHullPoints(pts, halfGapM));

  const tCluster = performance.now();
  const clusters = clusterBuildings(hulls, dilated, gapM);
  debugLog(`findCities: clustering took ${Math.round(performance.now() - tCluster)} ms`);
  const tUnion = performance.now();

  // Each cluster's outline: the union of its members' dilations. Members are
  // transitively overlapping, so the outline comes out connected.
  let dropped = 0;
  const cities: City[] = [];
  const structures: City[] = [];
  for (const members of clusters) {
    const parts = members.map((i) => hullFeature(dilated[i]));
    const localPolygon = unionAll(parts, (n) => (dropped += n)) ?? parts[0];
    const cluster: City = {
      polygon: featureFromLocal(ctx.frame, localPolygon),
      localPolygon,
      hullPointsLocal: convexHull(members.flatMap((i) => hulls[i])),
      buildingHullsLocal: members.map((i) => hulls[i]),
      buildingCount: members.length,
    };
    (members.length >= MIN_CITY_BUILDINGS ? cities : structures).push(cluster);
  }
  debugLog(`findCities: outlines took ${Math.round(performance.now() - tUnion)} ms`);
  if (dropped > 0) {
    ctx.warn(`${dropped} building outline(s) could not be merged and were skipped.`);
  }

  if (DEBUG) {
    // Anchor each city number to coordinates, so numbers from different runs
    // (or after OSM data changes) can be matched by location.
    cities.forEach((c, i) => {
      const bb = bboxOf(allPositions(c.localPolygon.geometry));
      const [lon, lat] = fromLocal(ctx.frame, [(bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2]);
      debugLog(`City ${i + 1}: ${lat.toFixed(5)}, ${lon.toFixed(5)} — ${c.buildingCount} buildings`);
    });
  }

  const origin: Position = [0, 0]; // the query point is the local-frame origin
  const inSmallCluster = structures.some(
    (s) =>
      s.localPolygon.geometry.type === 'Polygon' &&
      pointInRings(origin, s.localPolygon.geometry.coordinates),
  );
  if (cities.length === 0) {
    ctx.warn('No cluster of 6+ buildings found — no halachic city in the loaded area.');
  } else if (inSmallCluster) {
    ctx.warn('The point is in a cluster of fewer than 6 buildings, which is not a city.');
  }

  return { cities, structures };
}

/** Wrap an open convex loop as a Polygon feature. */
function hullFeature(hull: Position[]): Poly {
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [[...hull, hull[0]]] },
  };
}

/**
 * Union-find clustering: two buildings belong to one cluster when their
 * dilated hulls overlap — exactly the pairs the union would merge. The exact
 * hull distance ≤ gapM implies overlap and is cheaper, so it screens first;
 * the octagon dilation over-covers the true disc by ≤ ~8%, and pairs in that
 * margin fall through to the separating-axis test on the dilations. A
 * spatial hash grid (cell = gapM) limits the tests to nearby pairs, so this
 * is near-linear in the number of buildings. Returns each cluster's building
 * indices in Morton order.
 */
function clusterBuildings(hulls: Position[][], dilated: Position[][], gapM: number): number[][] {
  const n = hulls.length;
  const { find, join } = unionFind(n);
  const cellOf = (v: number) => Math.floor(v / gapM);
  const bboxes = dilated.map(bboxOf);

  // Overlapping dilations always share a grid cell of either building's bbox.
  const grid = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const bb = bboxes[i];
    for (let cx = cellOf(bb.minX); cx <= cellOf(bb.maxX); cx++) {
      for (let cy = cellOf(bb.minY); cy <= cellOf(bb.maxY); cy++) {
        const key = `${cx},${cy}`;
        const list = grid.get(key);
        if (list) list.push(i);
        else grid.set(key, [i]);
      }
    }
  }

  for (const list of grid.values()) {
    for (let a = 0; a < list.length; a++) {
      const i = list[a];
      const bi = bboxes[i];
      for (let b = a + 1; b < list.length; b++) {
        const j = list[b];
        // A pair can share several cells; the root check also dedupes it.
        if (find(i) === find(j)) continue;
        const bj = bboxes[j];
        if (bi.minX > bj.maxX || bj.minX > bi.maxX || bi.minY > bj.maxY || bj.minY > bi.maxY) {
          continue;
        }
        if (hullsWithinGap(hulls[i], hulls[j], gapM) || convexOverlap(dilated[i], dilated[j])) {
          join(i, j);
        }
      }
    }
  }

  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const group = byRoot.get(root);
    if (group) group.push(i);
    else byRoot.set(root, [i]);
  }

  // Morton (Z-order) code of each building's bbox center, so a sorted
  // cluster unions spatially adjacent geometry at every tree level.
  let minX = Infinity;
  let minY = Infinity;
  for (const bb of bboxes) {
    if (bb.minX < minX) minX = bb.minX;
    if (bb.minY < minY) minY = bb.minY;
  }
  const codes = bboxes.map((bb) =>
    morton(cellOf((bb.minX + bb.maxX) / 2 - minX), cellOf((bb.minY + bb.maxY) / 2 - minY)),
  );
  const clusters = [...byRoot.values()];
  for (const members of clusters) members.sort((a, b) => codes[a] - codes[b]);
  return clusters;
}

/** Z-order curve index: interleave the low 16 bits of x and y. */
function morton(x: number, y: number): number {
  return part1by1(x) * 2 + part1by1(y);
}

function part1by1(v: number): number {
  v &= 0xffff;
  v = (v | (v << 8)) & 0x00ff00ff;
  v = (v | (v << 4)) & 0x0f0f0f0f;
  v = (v | (v << 2)) & 0x33333333;
  v = (v | (v << 1)) & 0x55555555;
  return v;
}
