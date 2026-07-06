/** Step 6: measure 2000 amot out from the shvita corners and build the techum. */

import { difference, featureCollection, polygon as turfPolygon } from '@turf/turf';
import type { Position } from 'geojson';
import type { PipelineContext, Poly, Shvita } from '../types';
import {
  DESCENT_LIMIT_AMOT,
  GRADIENT_THRESHOLD,
  ROPE_AMOT,
  TECHUM_AMOT,
  amahMeters,
  type Settings,
} from '../settings';
import { boundingRect } from '../geo/minRect';
import { minkowskiSumRect } from '../geo/minkowski';
import { allPositions, rotateFeature, rotatePoint } from '../geo/rotate';
import { featureFromLocal, featureToLocal, fromLocal } from '../geo/project';
import { elevationAt } from '../elevation';
import { debugLog } from '../debug';

export async function measureTechum(
  ctx: PipelineContext,
  settings: Settings,
  shvita: Shvita,
): Promise<Poly> {
  const amah = amahMeters(settings);
  const techumM = TECHUM_AMOT * amah;
  const descentLimitM = DESCENT_LIMIT_AMOT * amah;
  const stepM = ROPE_AMOT * amah;

  const local = featureToLocal(ctx.frame, shvita.polygon);
  const rot = rotateFeature(local, -shvita.angle);
  const bb = boundingRect(allPositions(rot.geometry), 0);
  const [minX, minY] = bb.corners[0];
  const [maxX, maxY] = bb.corners[2];

  // Eight rays: two outward axis directions from each corner of the shvita.
  let missingElevation = false;
  const ray = async (x: number, y: number, dir: Position): Promise<number> => {
    const r = await measureRay(ctx, shvita.angle, [x, y], dir, techumM, descentLimitM, stepM);
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
  const rays: [string, number, number][] = [
    ['N', dNw, dNe],
    ['S', dSw, dSe],
    ['W', dWs, dWn],
    ['E', dEs, dEn],
  ];
  debugLog(
    `Techum rays, m of ${techumM.toFixed(1)} budget (gradient-rule shortfall in parens): ` +
      rays
        .map(
          ([dir, a, b]) =>
            `${dir} ${a.toFixed(1)} (−${(techumM - a).toFixed(1)}) / ${b.toFixed(1)} (−${(techumM - b).toFixed(1)})`,
        )
        .join(', '),
  );

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
    // Join on the diagonal: each side runs between its own two measured ray
    // endpoints — a diagonal edge when terrain leaves them unequal — instead
    // of extending the shorter line to the longer. Corners are still squared
    // out by extending the side lines to their intersections.
    const north: Line = [
      [minX, maxY + dNw],
      [maxX, maxY + dNe],
    ];
    const east: Line = [
      [maxX + dEn, maxY],
      [maxX + dEs, minY],
    ];
    const south: Line = [
      [maxX, minY - dSe],
      [minX, minY - dSw],
    ];
    const west: Line = [
      [minX - dWs, minY],
      [minX - dWn, maxY],
    ];
    const nw = lineIntersection(west, north);
    const ne = lineIntersection(north, east);
    const se = lineIntersection(east, south);
    const sw = lineIntersection(south, west);
    techumRot = turfPolygon([[nw, ne, se, sw, nw]]) as Poly;
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

type Line = [Position, Position];

/** Intersection of the infinite lines through segments a and b. */
function lineIntersection(a: Line, b: Line): Position {
  const [[x1, y1], [x2, y2]] = a;
  const [[x3, y3], [x4, y4]] = b;
  const denom = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
  const t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / denom;
  return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
}

interface RayResult {
  /** Horizontal reach in meters. */
  distance: number;
  missingData: boolean;
}

/**
 * Walk outward in rope-length (50 amot) steps sampling the terrain; a segment
 * costs its surface length when the grade is shallow (< 1:3.6), its
 * horizontal length when steep — unless the walk has descended more than
 * 2000 amot below the start, in which case even steep ground is measured
 * along the surface.
 */
async function measureRay(
  ctx: PipelineContext,
  angle: number,
  originRot: Position,
  dirRot: Position,
  budgetM: number,
  descentLimitM: number,
  stepM: number,
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
    const nextH = horizontal + stepM;
    const p: Position = [originRot[0] + dirRot[0] * nextH, originRot[1] + dirRot[1] * nextH];
    const [lon, lat] = toLatLon(p);
    const elev = await elevationAt(lat, lon);
    let cost: number;
    if (elev === null) {
      missingData = true;
      cost = stepM;
    } else {
      const dh = elev - prevElev;
      const grade = Math.abs(dh) / stepM;
      const surface = Math.hypot(stepM, dh);
      const deepDescent = dh < 0 && startElev - elev > descentLimitM;
      cost = grade < GRADIENT_THRESHOLD || deepDescent ? surface : stepM;
      prevElev = elev;
    }
    if (spent + cost >= budgetM) {
      horizontal += ((budgetM - spent) / cost) * stepM;
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
