/** Step 5: determine the shvita bounds the techum is measured from. */

import { booleanPointInPolygon, point as turfPoint, polygon as turfPolygon } from '@turf/turf';
import type { PipelineContext, Poly, Shvita, Squaring } from '../types';
import { FOUR_AMOT, amahMeters, type Settings } from '../settings';
import { boundingRect } from '../geo/minRect';
import { allPositions } from '../geo/rotate';
import { featureFromLocal, featureToLocal } from '../geo/project';
import type { FetchResult } from './fetchBuildings';

export function findShvita(
  ctx: PipelineContext,
  settings: Settings,
  fetched: FetchResult,
  squarings: Squaring[],
): Shvita {
  const pt = turfPoint([ctx.point.lon, ctx.point.lat]);

  // Inside a city's squaring (which contains the city itself)?
  for (const sq of squarings) {
    if (booleanPointInPolygon(pt, sq.polygon)) {
      return { polygon: sq.polygon, angle: sq.angle, source: 'city' };
    }
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
  const amah = amahMeters(settings);
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
