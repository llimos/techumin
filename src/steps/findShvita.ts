/** Step 5: determine the shvita bounds the techum is measured from. */

import { booleanPointInPolygon, point as turfPoint, polygon as turfPolygon } from '@turf/turf';
import type { PipelineContext, Poly, Shvita, Squaring } from '../types';
import { FOUR_AMOT, amahMeters, type Settings } from '../settings';
import { boundingRect } from '../geo/minRect';
import { allPositions } from '../geo/rotate';
import { featureFromLocal, featureToLocal } from '../geo/project';
import { pointPolygonGap } from '../geo/gaps';
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

  // Inside a city outline (with its ibur strip)? That city's squaring is the
  // shvita — checked before the squaring rectangles, whose corners can sweep
  // over a point that really belongs to another city.
  for (const sq of squarings) {
    if (booleanPointInPolygon(pt, sq.city.polygon)) {
      debugLog(
        `Shvisa: point is inside a city (${sq.city.buildingCount} buildings) - using its squaring`,
      );
      return { polygon: sq.polygon, angle: sq.angle, source: 'city' };
    }
  }

  // Otherwise inside a squaring only (a squared-off corner region). Rectangles
  // of different cities can overlap the point — use the nearest city's, not
  // the first in array order.
  let best: Squaring | null = null;
  let bestDist = Infinity;
  for (const sq of squarings) {
    if (!booleanPointInPolygon(pt, sq.polygon)) continue;
    const dist = pointPolygonGap([0, 0], sq.city.localPolygon); // point = local origin
    if (dist < bestDist) {
      best = sq;
      bestDist = dist;
    }
  }
  if (best) {
    debugLog(
      `Shvisa: point is in a squared-off area; using the nearest city's squaring ` +
        `(${Math.round(bestDist / amah)} amot/${Math.round(bestDist)} metres away, ` +
        `${best.city.buildingCount} buildings)`,
    );
    return { polygon: best.polygon, angle: best.angle, source: 'city' };
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
