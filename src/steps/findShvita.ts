/** Step 5: determine the shvita bounds the techum is measured from. */

import { booleanPointInPolygon, point as turfPoint, polygon as turfPolygon } from '@turf/turf';
import type { Position } from 'geojson';
import type { PipelineContext, Poly, Shvita, Squaring } from '../types';
import { CITY_GAP_AMOT, FOUR_AMOT, amahMeters, type Settings } from '../settings';
import { boundingRect } from '../geo/minRect';
import { allPositions } from '../geo/rotate';
import { featureFromLocal, featureToLocal } from '../geo/project';
import { pointPolygonGap } from '../geo/gaps';
import { pointInRings } from '../geo/dilate';
import { debugLog } from '../debug';
import type { FetchResult } from './fetchBuildings';

export function findShvita(
  ctx: PipelineContext,
  settings: Settings,
  fetched: FetchResult,
  squarings: Squaring[],
): Shvita {
  const pt = turfPoint([ctx.point.lon, ctx.point.lat]);
  const amah = amahMeters(settings);
  const halfGapM = (CITY_GAP_AMOT * amah) / 2;

  // Inside a city's bounds? That city's squaring is the shvita. The bounds are
  // the built-up cluster (gaps between its buildings included), extended by
  // the 70⅔ strip only when the Rema karpef option is on.
  for (const sq of squarings) {
    if (inCityBounds(sq.city.localPolygon, halfGapM, settings.remaExtra)) {
      debugLog(
        `Shvisa: point is inside a city (${sq.city.buildingCount} buildings) - using its squaring`,
      );
      return { polygon: sq.polygon, angle: sq.angle, source: 'city' };
    }
  }

  // The ribua is a measurement construct, not the city itself — a point in a
  // squared-off corner does not acquire city status (Mishna Eruvin 5:7: an
  // eruv outside the ibur, even one amah, measures from where it lies).
  if (squarings.some((sq) => booleanPointInPolygon(pt, sq.polygon))) {
    ctx.warn(
      "Point is within a city's squared bounds (ribua) but outside the city " +
        'itself — the ribua does not confer city status; measuring from the point.',
    );
  }

  // Inside a building? Its North-South bounding rectangle is the shvita.
  if (fetched.enclosing) {
    const local = featureToLocal(ctx.frame, fetched.enclosing);
    const rect = boundingRect(allPositions(local.geometry), 0);
    const [minX, minY] = rect.corners[0];
    const [maxX, maxY] = rect.corners[2];
    const polygon = featureFromLocal(
      ctx.frame,
      turfPolygon([
        [
          [minX, minY],
          [maxX, minY],
          [maxX, maxY],
          [minX, maxY],
          [minX, minY],
        ],
      ]) as Poly,
    );
    ctx.warn('Point is outside any city; measuring from the enclosing building.');
    return { polygon, angle: 0, source: 'building' };
  }

  // Open country: a 4-amot square around the point (frame origin).
  const half = settings.fourAmotMode === 'each' ? FOUR_AMOT * amah : (FOUR_AMOT / 2) * amah;
  const polygon = featureFromLocal(
    ctx.frame,
    turfPolygon([
      [
        [-half, -half],
        [half, -half],
        [half, half],
        [-half, half],
        [-half, -half],
      ],
    ]) as Poly,
  );
  ctx.warn(
    `Point is in open country; measuring from ${
      settings.fourAmotMode === 'each' ? '4 amot in each direction' : '4 amot total'
    } around the point.`,
  );
  return { polygon, angle: 0, source: 'point' };
}

/**
 * Is the picked point (the local-frame origin) within the city's bounds?
 * The cluster outline is the buildings dilated by half the 70⅔ gap, so the
 * built-up city itself is the outline eroded by that half gap — the point is
 * in it iff it is inside the outline and no closer than the half gap to the
 * outline's boundary — and the Rema's 70⅔ karpef strip around the city is
 * the outline dilated by the half gap. Hole rings are ignored: open space
 * enclosed by the city counts as the city.
 */
function inCityBounds(outline: Poly, halfGapM: number, remaExtra: boolean): boolean {
  const origin: Position = [0, 0]; // the query point is the local-frame origin
  const g = outline.geometry;
  const exteriorRings =
    g.type === 'Polygon' ? [g.coordinates[0]] : g.coordinates.map((rings) => rings[0]);
  const inside = pointInRings(origin, exteriorRings);
  const boundaryGap = pointPolygonGap(origin, outline);
  return remaExtra ? inside || boundaryGap <= halfGapM : inside && boundaryGap >= halfGapM;
}
