/**
 * Step 2: cluster buildings into halachic cities (gaps ≤ 70⅔ amot, ≥ 6
 * buildings). All geometry runs in the local planar frame: each building's
 * convex hull is dilated by half the gap and the dilations are unioned, so
 * buildings within the gap merge into one outline (ibur ir).
 */

import { flatten } from '@turf/turf';
import type { Feature, Polygon, Position } from 'geojson';
import type { City, PipelineContext, Poly } from '../types';
import { CITY_GAP_AMOT, MIN_CITY_BUILDINGS, amahMeters, type Settings } from '../settings';
import { featureFromLocal, fromLocal, toLocal } from '../geo/project';
import { DEBUG, debugLog } from '../debug';
import { allPositions } from '../geo/rotate';
import { bboxOf, dilateHull, pointInRings, type BBox } from '../geo/dilate';
import { convexHull } from '../geo/minRect';
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

  const halfGapM = (CITY_GAP_AMOT * amahMeters(settings)) / 2;

  // Local-frame vertices per building, and each building dilated by half the gap.
  const buildingPoints: Position[][] = buildings.map((b) =>
    allPositions(b.geometry).map((p) => toLocal(ctx.frame, p)),
  );
  const dilated = buildingPoints.map((pts) => dilateHull(pts, halfGapM));

  const merged = unionAll(dilated as Poly[], (n) =>
    ctx.warn(`${n} building outline(s) could not be merged and were skipped.`),
  );
  if (!merged) return { cities: [], structures: [] };
  const clusters = flatten(merged).features as Feature<Polygon>[];

  // Assign each building to its cluster via a representative vertex.
  const clusterBBoxes: BBox[] = clusters.map((c) => bboxOf(allPositions(c.geometry)));
  const counts = new Array(clusters.length).fill(0);
  const rawPoints: Position[][] = clusters.map(() => []);
  const buildingHulls: Position[][][] = clusters.map(() => []);
  for (let bi = 0; bi < buildings.length; bi++) {
    const rep = buildingPoints[bi][0];
    for (let ci = 0; ci < clusters.length; ci++) {
      const bb = clusterBBoxes[ci];
      if (rep[0] < bb.minX || rep[0] > bb.maxX || rep[1] < bb.minY || rep[1] > bb.maxY) continue;
      if (pointInRings(rep, clusters[ci].geometry.coordinates)) {
        counts[ci]++;
        rawPoints[ci].push(...buildingPoints[bi]);
        buildingHulls[ci].push(convexHull(buildingPoints[bi]));
        break;
      }
    }
  }

  const cities: City[] = [];
  const structures: City[] = [];
  clusters.forEach((localPolygon, i) => {
    const cluster: City = {
      polygon: featureFromLocal(ctx.frame, localPolygon as Poly),
      localPolygon: localPolygon as Poly,
      rawPointsLocal: rawPoints[i],
      buildingHullsLocal: buildingHulls[i],
      buildingCount: counts[i],
    };
    (counts[i] >= MIN_CITY_BUILDINGS ? cities : structures).push(cluster);
  });

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
