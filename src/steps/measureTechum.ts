/** Step 6: measure 2000 amot out from the shvita corners and build the techum. */

import { buffer, difference, featureCollection, flatten, polygon as turfPolygon } from '@turf/turf';
import type { Position } from 'geojson';
import type { PipelineContext, Poly, Shvita } from '../types';
import {
  DESCENT_LIMIT_AMOT,
  GRADIENT_THRESHOLD,
  TECHUM_AMOT,
  amahMeters,
  type Settings,
} from '../settings';
import { boundingRect } from '../geo/minRect';
import { allPositions, rotateFeature, rotatePoint } from '../geo/rotate';
import { featureFromLocal, featureToLocal, fromLocal } from '../geo/project';
import { elevationAt } from '../elevation';

const SAMPLE_STEP_M = 30;

export async function measureTechum(
  ctx: PipelineContext,
  settings: Settings,
  shvita: Shvita,
): Promise<Poly> {
  const amah = amahMeters(settings);
  const techumM = TECHUM_AMOT * amah;
  const descentLimitM = DESCENT_LIMIT_AMOT * amah;

  const local = featureToLocal(ctx.frame, shvita.polygon);
  const rot = rotateFeature(local, -shvita.angle);
  const bb = boundingRect(allPositions(rot.geometry), 0);
  const [minX, minY] = bb.corners[0];
  const [maxX, maxY] = bb.corners[2];

  // Eight rays: two outward axis directions from each corner of the shvita.
  let missingElevation = false;
  const ray = async (x: number, y: number, dir: Position): Promise<number> => {
    const r = await measureRay(ctx, shvita.angle, [x, y], dir, techumM, descentLimitM);
    if (r.missingData) missingElevation = true;
    return r.distance;
  };
  const [dNw, dNe, dSw, dSe, dWs, dWn, dEs, dEn] = await Promise.all([
    ray(minX, maxY, [0, 1]), // north from NW
    ray(maxX, maxY, [0, 1]), // north from NE
    ray(minX, minY, [0, -1]), // south from SW
    ray(maxX, minY, [0, -1]), // south from SE
    ray(minX, minY, [-1, 0]), // west from SW
    ray(minX, maxY, [-1, 0]), // west from NW
    ray(maxX, minY, [1, 0]), // east from SE
    ray(maxX, maxY, [1, 0]), // east from NE
  ]);
  if (missingElevation) {
    ctx.warn('Elevation data unavailable for part of the measurement — those lines were measured flat.');
  }

  let techumRot: Poly;
  if (settings.unequalLines === 'extend') {
    // Extend the shorter line to the longer: each side sits at the max distance.
    techumRot = rectPoly(
      minX - Math.max(dWs, dWn),
      minY - Math.max(dSw, dSe),
      maxX + Math.max(dEs, dEn),
      maxY + Math.max(dNw, dNe),
    );
  } else {
    // Join unequal lines on the diagonal: each side is the line through its two
    // measured endpoints; corners are the intersections of adjacent side lines.
    const north: [Position, Position] = [[minX, maxY + dNw], [maxX, maxY + dNe]];
    const south: [Position, Position] = [[minX, minY - dSw], [maxX, minY - dSe]];
    const east: [Position, Position] = [[maxX + dEs, minY], [maxX + dEn, maxY]];
    const west: [Position, Position] = [[minX - dWs, minY], [minX - dWn, maxY]];
    const nw = lineIntersection(north, west);
    const ne = lineIntersection(north, east);
    const se = lineIntersection(south, east);
    const sw = lineIntersection(south, west);
    techumRot = turfPolygon([[nw, ne, se, sw, nw]]) as Poly;
  }

  // A keshet-excluded squaring indents the techum where the exclusion runs
  // deeper than the techum distance. Approximate the indentation by eroding
  // the excluded region by the average measured distance.
  if (shvita.source === 'city') {
    const excluded = difference(featureCollection([rectPoly(minX, minY, maxX, maxY), rot]));
    if (excluded) {
      const dAvg = (dNw + dNe + dSw + dSe + dWs + dWn + dEs + dEn) / 8;
      for (const region of flatten(excluded).features as Poly[]) {
        const geo = featureFromLocal(ctx.frame, rotateFeature(region, shvita.angle));
        const eroded = buffer(geo, -dAvg / 1000, { units: 'kilometers' });
        if (!eroded) continue;
        const erodedRot = rotateFeature(featureToLocal(ctx.frame, eroded as Poly), -shvita.angle);
        const cut = difference(featureCollection([techumRot, erodedRot]));
        if (cut) {
          techumRot = cut as Poly;
          ctx.warn('Techum indented by the keshet/gam exclusion (approximated).');
        }
      }
    }
  }

  return featureFromLocal(ctx.frame, rotateFeature(techumRot, shvita.angle));
}

interface RayResult {
  /** Horizontal reach in meters. */
  distance: number;
  missingData: boolean;
}

/**
 * Walk outward sampling the terrain; a segment costs its surface length when
 * the grade is shallow (< 1:3.6), its horizontal length when steep — unless
 * the walk has descended more than 2000 amot below the start, in which case
 * even steep ground is measured along the surface.
 */
async function measureRay(
  ctx: PipelineContext,
  angle: number,
  originRot: Position,
  dirRot: Position,
  budgetM: number,
  descentLimitM: number,
): Promise<RayResult> {
  const toLatLon = (p: Position): Position => {
    const localP = rotatePoint(p, angle);
    return fromLocal(ctx.frame, localP);
  };

  const [lon0, lat0] = toLatLon(originRot);
  const startElev = await elevationAt(lat0, lon0);
  if (startElev === null) {
    return { distance: budgetM, missingData: true };
  }

  let missingData = false;
  let spent = 0;
  let horizontal = 0;
  let prevElev = startElev;
  while (spent < budgetM) {
    const nextH = horizontal + SAMPLE_STEP_M;
    const p: Position = [originRot[0] + dirRot[0] * nextH, originRot[1] + dirRot[1] * nextH];
    const [lon, lat] = toLatLon(p);
    const elev = await elevationAt(lat, lon);
    let cost: number;
    if (elev === null) {
      missingData = true;
      cost = SAMPLE_STEP_M;
    } else {
      const dh = elev - prevElev;
      const grade = Math.abs(dh) / SAMPLE_STEP_M;
      const surface = Math.hypot(SAMPLE_STEP_M, dh);
      const deepDescent = dh < 0 && startElev - elev > descentLimitM;
      cost = grade < GRADIENT_THRESHOLD || deepDescent ? surface : SAMPLE_STEP_M;
      prevElev = elev;
    }
    if (spent + cost >= budgetM) {
      horizontal += ((budgetM - spent) / cost) * SAMPLE_STEP_M;
      spent = budgetM;
    } else {
      spent += cost;
      horizontal = nextH;
    }
  }
  return { distance: horizontal, missingData };
}

function rectPoly(minX: number, minY: number, maxX: number, maxY: number): Poly {
  return turfPolygon([
    [
      [minX, minY],
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY],
      [minX, minY],
    ],
  ]) as Poly;
}

/** Intersection of two infinite lines, each given by two points. */
function lineIntersection([a, b]: [Position, Position], [c, d]: [Position, Position]): Position {
  const denom = (a[0] - b[0]) * (c[1] - d[1]) - (a[1] - b[1]) * (c[0] - d[0]);
  if (Math.abs(denom) < 1e-9) return b; // parallel — degenerate, fall back
  const t = ((a[0] - c[0]) * (c[1] - d[1]) - (a[1] - c[1]) * (c[0] - d[0])) / denom;
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}
