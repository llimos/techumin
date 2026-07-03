/** Step 6: measure 2000 amot out from the shvita corners and build the techum. */

import { difference, featureCollection, polygon as turfPolygon } from '@turf/turf';
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
import { minkowskiSumRect } from '../geo/minkowski';
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

  const dW = Math.max(dWs, dWn);
  const dE = Math.max(dEs, dEn);
  const dS = Math.max(dSw, dSe);
  const dN = Math.max(dNw, dNe);

  let techumRot: Poly;
  if (settings.unequalLines === 'extend') {
    // Extend the shorter line to the longer: every point within the measured
    // per-direction distances of the shvita, with square corners. For a
    // rectangular shvita this is the rectangle expanded by the max distance
    // per side; a keshet-excluded squaring indents the techum wherever the
    // exclusion runs deeper than the measured distance.
    techumRot = minkowskiSumRect(rot, dW, dE, dS, dN);
  } else {
    // Join on the diagonal: each side is the segment between its own two
    // measured endpoints (a trapezoid edge when they differ), and adjacent
    // sides are joined endpoint-to-endpoint across each corner, so the
    // corners are cut diagonally rather than squared out.
    techumRot = turfPolygon([
      [
        [minX, maxY + dNw], // north ray from NW
        [maxX, maxY + dNe], // north ray from NE
        [maxX + dEn, maxY], // east ray from NE
        [maxX + dEs, minY], // east ray from SE
        [maxX, minY - dSe], // south ray from SE
        [minX, minY - dSw], // south ray from SW
        [minX - dWs, minY], // west ray from SW
        [minX - dWn, maxY], // west ray from NW
        [minX, maxY + dNw],
      ],
    ]) as Poly;
  }

  // A keshet-excluded squaring indents the techum where the exclusion runs
  // deeper than the measured distance. The 'extend' Minkowski sum handles this
  // by construction; for 'diagonal' the notch beyond the shvita's reach is cut
  // out of the diagonal outline. Either way, warn that the indentation uses
  // the four globally measured side distances.
  if (shvita.source === 'city') {
    const notch = difference(featureCollection([rectPoly(minX, minY, maxX, maxY), rot]));
    if (notch) {
      const reach =
        settings.unequalLines === 'extend' ? techumRot : minkowskiSumRect(rot, dW, dE, dS, dN);
      const outside = difference(featureCollection([notch as Poly, reach]));
      if (outside) {
        if (settings.unequalLines !== 'extend') {
          const cut = difference(featureCollection([techumRot, outside as Poly]));
          if (cut) techumRot = cut as Poly;
        }
        ctx.warn(
          'Techum indented by the keshet/gam exclusion — the indentation uses the ' +
            'measured side distances; terrain inside it is not measured separately.',
        );
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
