/** Step 6: measure 2000 amot out from the shvita corners and build the techum. */

import {
  booleanPointInPolygon,
  difference,
  featureCollection,
  point as turfPoint,
  polygon as turfPolygon,
} from '@turf/turf';
import type { Position } from 'geojson';
import type { LatLon, PipelineContext, Poly, Shvita, Squaring } from '../types';
import type { LString } from '../i18n';
import { SIDE_NAMES } from '../geo/dataEdges';
import {
  DESCENT_LIMIT_AMOT,
  FOUR_AMOT,
  GRADIENT_THRESHOLD,
  ROPE_AMOT,
  TECHUM_AMOT,
  amahMeters,
  type Settings,
} from '../settings';
import { unionAll } from '../geo/unionAll';
import { boundingRect } from '../geo/minRect';
import { minkowskiSumRect } from '../geo/minkowski';
import { allPositions, rotateFeature, rotatePoint } from '../geo/rotate';
import { featureFromLocal, featureToLocal, fromLocal } from '../geo/project';
import { elevationAt } from '../elevation';

export async function measureTechum(
  ctx: PipelineContext,
  settings: Settings,
  shvita: Shvita,
  squarings: Squaring[] = [],
  opts: { startPoint?: LatLon } = {},
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
    ctx.warn({
      en: 'Elevation data unavailable for part of the measurement — those lines were measured flat.',
      he: 'נתוני גובה חסרים לחלק מהמדידה — קווים אלה נמדדו כמישור.',
    });
  }
  const rays: [LString, number, number][] = [
    [{ en: 'N', he: 'צפ' }, dNw, dNe],
    [{ en: 'S', he: 'דר' }, dSw, dSe],
    [{ en: 'W', he: 'מע' }, dWs, dWn],
    [{ en: 'E', he: 'מז' }, dEs, dEn],
  ];
  const fmtRay = (m: number, lang: keyof LString): string => {
    const [amot, meter] = lang === 'en' ? ['amot', 'm'] : ['אמות', "מ'"];
    return `${(m / amah).toFixed(0)} ${amot}/${m.toFixed(0)} ${meter} (−${(techumM - m).toFixed(1)} ${meter})`;
  };
  ctx.log({
    en:
      `Techum rays, of the ${TECHUM_AMOT}-amot (${techumM.toFixed(1)} m) budget ` +
      '(gradient-rule shortfall in parens): ' +
      rays.map(([dir, a, b]) => `${dir.en} ${fmtRay(a, 'en')} / ${fmtRay(b, 'en')}`).join(', '),
    he:
      `קרני התחום, מתוך תקציב של ${TECHUM_AMOT} אמה (${techumM.toFixed(1)} מ') ` +
      '(החֶסר מדין מדידת מדרון בסוגריים): ' +
      rays.map(([dir, a, b]) => `${dir.he} ${fmtRay(a, 'he')} / ${fmtRay(b, 'he')}`).join(', '),
  });

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
        ctx.warn({
          en:
            'Techum indented by the keshet/gam exclusion — the indentation uses the ' +
            'measured side distances; terrain inside it is not measured separately.',
          he:
            'התחום נחתך פנימה בשל הוצאת הקשת/גאם — החיתוך משתמש במרחקי הצדדים ' +
            'שנמדדו; פני הקרקע שבתוכו אינם נמדדים בנפרד.',
        });
      }
    }
  }

  // Havla'ah: a city fully enclosed within the measured 2000 amot is
  // "swallowed" — its length along the ray counts as only 4 amot, so the
  // techum reaches farther out past it.
  const swallowed = havlaahBumps(ctx, settings, shvita, squarings, opts.startPoint, {
    minX,
    minY,
    maxX,
    maxY,
    dW,
    dE,
    dS,
    dN,
  });
  if (swallowed.rects.length) {
    techumRot = unionAll([techumRot, ...swallowed.rects]) ?? techumRot;
    ctx.warn({
      en:
        `Havla'ah: ${swallowed.count} enclosed ${swallowed.count === 1 ? 'city counts' : 'cities count'} ` +
        'as 4 amot; the techum extends past it. The extension uses the city ribua and the ' +
        'measured side distances — it is not measured separately over the terrain.',
      he:
        `הבלעה: ${
          swallowed.count === 1 ? 'עיר מובלעת אחת נחשבת' : `${swallowed.count} ערים מובלעות נחשבות`
        } כ־4 אמות; התחום נמשך אל מעבר לה. ההמשך משתמש בריבוע העיר ובמרחקי הצדדים ` +
        'שנמדדו — הוא אינו נמדד בנפרד על פני הקרקע.',
    });
  }

  return featureFromLocal(ctx.frame, rotateFeature(techumRot, shvita.angle));
}

/** Shvita bounding box and measured reaches in the rotated frame. */
interface ShvitaFrame {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  dW: number;
  dE: number;
  dS: number;
  dN: number;
}

/**
 * Rectangles (rotated frame) added to the techum by havla'ah, plus the number
 * of swallowed cities. A city qualifies for a side when its ribua lies beyond
 * that side's shvita edge, its cross-span overlaps the shvita's own span (so
 * it faces a side of the techum proper, not a squared corner — its width may
 * exceed the techum's), and its whole length along the ray fits inside the
 * measured reach. Each swallowed city adds two rectangles at the sideways
 * band width of the chosen opinion: one level with the city itself, and one
 * extending the techum outward past its measured edge by (length − 4 amot).
 * The city holding the eruv's start point is a special case (see below).
 */
function havlaahBumps(
  ctx: PipelineContext,
  settings: Settings,
  shvita: Shvita,
  squarings: Squaring[],
  startPoint: LatLon | undefined,
  f: ShvitaFrame,
): { rects: Poly[]; count: number } {
  const amah = amahMeters(settings);
  const a2000 = TECHUM_AMOT * amah;
  const four = FOUR_AMOT * amah;
  const { minX, minY, maxX, maxY, dW, dE, dS, dN } = f;

  // Sides in a canonical "outward is + along `axis`" orientation. `edge` is
  // the shvita edge, `reach` the measured distance, `techumSpan` the outer
  // techum extent on the cross axis (for the Chazon Ish cap). `name` is the
  // side's compass direction in the shvita-rotated frame — approximate when
  // the shvita is rotated.
  type Side = {
    name: LString;
    axis: 'x' | 'y';
    sign: 1 | -1;
    edge: number;
    reach: number;
    shvitaSpan: [number, number];
    techumSpan: [number, number];
  };
  const spanX: [number, number] = [minX - dW, maxX + dE];
  const spanY: [number, number] = [minY - dS, maxY + dN];
  const sides: Side[] = [
    { name: SIDE_NAMES.n, axis: 'y', sign: 1, edge: maxY, reach: dN, shvitaSpan: [minX, maxX], techumSpan: spanX },
    { name: SIDE_NAMES.s, axis: 'y', sign: -1, edge: minY, reach: dS, shvitaSpan: [minX, maxX], techumSpan: spanX },
    { name: SIDE_NAMES.e, axis: 'x', sign: 1, edge: maxX, reach: dE, shvitaSpan: [minY, maxY], techumSpan: spanY },
    { name: SIDE_NAMES.w, axis: 'x', sign: -1, edge: minX, reach: dW, shvitaSpan: [minY, maxY], techumSpan: spanY },
  ];

  const overlaps = (a: [number, number], b: [number, number]): boolean =>
    a[0] < b[1] && b[0] < a[1];

  const rects: Poly[] = [];
  let count = 0;
  for (const sq of squarings) {
    // City ribua in the shvita-aligned rotated frame, as an axis-aligned bbox.
    const rotSq = rotateFeature(featureToLocal(ctx.frame, sq.polygon), -shvita.angle);
    const rect = boundingRect(allPositions(rotSq.geometry), 0);
    const [bx0, by0] = rect.corners[0];
    const [bx1, by1] = rect.corners[2];

    // Skip the shvita's own city — its ribua overlaps the shvita bbox.
    if (overlaps([bx0, bx1], [minX, maxX]) && overlaps([by0, by1], [minY, maxY])) continue;

    const startCity =
      startPoint !== undefined &&
      booleanPointInPolygon(turfPoint([startPoint.lon, startPoint.lat]), sq.polygon);

    for (const s of sides) {
      // Project the city bbox onto the along-ray axis (near → far, outward
      // positive) and the cross axis.
      const alongLo = s.axis === 'y' ? by0 : bx0;
      const alongHi = s.axis === 'y' ? by1 : bx1;
      const cross: [number, number] = s.axis === 'y' ? [bx0, bx1] : [by0, by1];
      const near = s.sign === 1 ? alongLo : alongHi;
      const far = s.sign === 1 ? alongHi : alongLo;
      const len = alongHi - alongLo;

      // Beyond this edge, and facing the side (cross-span overlaps the shvita).
      const beyond = s.sign === 1 ? near > s.edge : near < s.edge;
      if (!beyond || !overlaps(cross, s.shvitaSpan)) continue;

      const reachOut = s.edge + s.sign * s.reach; // outer techum edge on this side
      const nearWithin = s.sign === 1 ? near <= reachOut : near >= reachOut;
      const fullyWithin = s.sign === 1 ? far <= reachOut : far >= reachOut;

      // Outward extension past the measured edge, when the whole city is
      // inside the 2000 amot: the freed (length − 4 amot) budget.
      let bumpOut: number | undefined;
      if (fullyWithin) {
        const delta = Math.max(0, len - four);
        if (delta > 0) bumpOut = reachOut + s.sign * delta;
      } else if (!(startCity && settings.havlaahEruvStartCity && nearWithin)) {
        // Rema: the eruv's start city is swallowed even when only partly
        // within the techum — but only far enough to include the whole city
        // (the side band below covers it); anything else is not swallowed.
        continue;
      }

      // Widthwise push on the cross axis, per opinion — applies only level
      // with the city, not to the lengthwise extension past it. The Chazon
      // Ish cap is lifted for the eruv start city (its full width is always
      // included).
      let band: [number, number];
      if (settings.havlaahWidth === 'rema') {
        band = [cross[0] - a2000, cross[1] + a2000];
      } else if (settings.havlaahWidth === 'magenAvraham' || startCity) {
        band = [cross[0], cross[1]];
      } else {
        band = [
          Math.max(cross[0] - a2000, s.techumSpan[0]),
          Math.min(cross[1] + a2000, s.techumSpan[1]),
        ];
      }
      if (band[1] <= band[0]) continue;

      const sideRect = (b: [number, number], lo: number, hi: number): Poly =>
        s.axis === 'y'
          ? rectPoly(b[0], Math.min(lo, hi), b[1], Math.max(lo, hi))
          : rectPoly(Math.min(lo, hi), b[0], Math.max(lo, hi), b[1]);

      // One rectangle level with the city across the band, one outward past
      // the measured techum edge by the freed budget — the latter spanning
      // either the whole original techum width, or only the city's own width
      // (clamped to the techum width; the widthwise push does not carry past
      // the city).
      rects.push(sideRect(band, near, far));
      if (bumpOut !== undefined) {
        const bumpBand: [number, number] =
          settings.havlaahLength === 'fullWidth'
            ? s.techumSpan
            : [Math.max(cross[0], s.techumSpan[0]), Math.min(cross[1], s.techumSpan[1])];
        if (bumpBand[1] > bumpBand[0]) rects.push(sideRect(bumpBand, reachOut, bumpOut));
      }
      count++;

      const cityLabel = sq.city.label ?? '?';
      const lenAmot = Math.round(len / amah);
      if (fullyWithin) {
        const extAmot = Math.round(Math.max(0, len - four) / amah);
        ctx.log({
          en:
            `Havla'ah: city ${cityLabel} (${lenAmot} amot long) is enclosed within the ` +
            `measured 2000 amot to the ${s.name.en} — it counts as 4 amot` +
            (extAmot > 0
              ? ` and the techum extends ${extAmot} amot past it.`
              : ' (no extension — it is no longer than 4 amot).'),
          he:
            `הבלעה: עיר ${cityLabel} (באורך ${lenAmot} אמות) מובלעת בתוך 2000 האמות ` +
            `שנמדדו לצד ${s.name.he} — היא נחשבת כ־4 אמות` +
            (extAmot > 0
              ? ` והתחום נמשך ${extAmot} אמות אל מעבר לה.`
              : ' (ללא המשך — אין היא ארוכה מ־4 אמות).'),
        });
      } else {
        ctx.log({
          en:
            `Havla'ah (Rema): the eruv's start city ${cityLabel} (${lenAmot} amot long, ` +
            `to the ${s.name.en}) is only partly within the techum — it is swallowed far ` +
            'enough to include the whole city, with no outward extension.',
          he:
            `הבלעה (רמ"א): עיר המוצא של העירוב ${cityLabel} (באורך ${lenAmot} אמות, ` +
            `לצד ${s.name.he}) נמצאת רק בחלקה בתוך התחום — היא מובלעת עד כדי ` +
            'הכללת העיר כולה, ללא המשך כלפי חוץ.',
        });
      }
    }
  }
  return { rects, count };
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
