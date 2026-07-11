/** Step 4: ribua ha'ir — square off each merged city. */

import {
  buffer,
  difference,
  featureCollection,
  flatten,
  intersect,
  polygon as turfPolygon,
} from '@turf/turf';
import type { Position } from 'geojson';
import type { City, PipelineContext, Poly, Squaring } from '../types';
import {
  CITY_GAP_AMOT,
  KESHET_DEPTH_AMOT,
  KESHET_MOUTH_AMOT,
  KESHET_WIDTH_AMOT,
  REMA_EXTRA_AMOT,
  amahMeters,
  type Settings,
} from '../settings';
import { anyDataEdge } from '../geo/dataEdges';
import { pointInRings } from '../geo/dilate';
import { boundingRect, minAreaRect } from '../geo/minRect';
import { allPositions, rotateFeature, rotatePoint } from '../geo/rotate';
import { featureFromLocal } from '../geo/project';

/** City fills ≥ this fraction of its min-area rectangle → already squared. */
const OBLONG_RATIO = 0.95;
/** A straight side must span ≥ this fraction of the city extent (Chazon Ish). */
const STRAIGHT_SIDE_SPAN = 0.95;
const COLLINEAR_TOL_RAD = (2 * Math.PI) / 180;
const COLLINEAR_OFFSET_M = 3;

export function squareCities(
  ctx: PipelineContext,
  settings: Settings,
  merged: City[],
): Squaring[] {
  const squarings = merged.map((city) => squareOne(ctx, settings, city));
  const truncated = squarings.filter((s) => anyDataEdge(s.dataEdges)).length;
  if (truncated > 0) {
    ctx.warn(
      `Building data ran out at the edge of the loaded area for ${truncated} ` +
        `${truncated === 1 ? 'city' : 'cities'} — the dotted borders may understate the real bounds.`,
    );
  }
  return squarings;
}

function squareOne(ctx: PipelineContext, settings: Settings, city: City): Squaring {
  const amah = amahMeters(settings);
  const local = city.localPolygon;
  const pts = allPositions(local.geometry);

  // 1. Already-oblong check: city fills its min-area rectangle at some angle.
  const minRect = minAreaRect(pts);
  const cityArea = planarArea(local);
  let angle: number;
  if (cityArea / minRect.area >= OBLONG_RATIO) {
    angle = normalizeAngle(minRect.angle);
  } else {
    // 2. Chazon Ish: one straight side along the city's full length fixes the angle.
    const straight = settings.chazonIshStraightSide ? findStraightSideAngle(local, pts) : null;
    angle = straight !== null ? normalizeAngle(straight) : 0;
  }

  // Work in the frame where the squaring rectangle is axis-aligned. The rect
  // comes from the building hull vertices — the exact city bounds, without
  // the half-gap dilation of the outline.
  const rawRot = city.hullPointsLocal.map((p) => rotatePoint(p, -angle));
  const rectRot = boundingRect(rawRot.length ? rawRot : allPositions(local.geometry), 0);
  const [minX, minY] = rectRot.corners[0];
  const [maxX, maxY] = rectRot.corners[2];
  let squaringRot: Poly = rectPoly(minX, minY, maxX, maxY);
  let isRectangle = true;
  const keshetCutsRot: Poly[] = [];

  // 3. Keshet/gam exclusion — only worth analyzing for the city the query
  // point belongs to (the local-frame origin), and against the gap-filled
  // outline so streets don't read as concavities.
  const originRot = rotatePoint([0, 0], -angle);
  const containsPoint =
    originRot[0] >= minX && originRot[0] <= maxX && originRot[1] >= minY && originRot[1] <= maxY;
  const cityRot = rotateFeature(local, -angle);
  const gaps = containsPoint ? difference(featureCollection([squaringRot, cityRot])) : null;
  if (gaps) {
    for (const region of flatten(gaps).features as Poly[]) {
      const cut = keshetCut(region, cityRot, minX, minY, maxX, maxY, amah, settings);
      if (!cut) continue;
      const next = difference(featureCollection([squaringRot, cut]));
      if (next) {
        squaringRot = next as Poly;
        isRectangle = false;
        keshetCutsRot.push(cut);
        ctx.warn(
          'Keshet/gam detected: part of the squaring is excluded ' +
            (settings.keshetExclusion === 'entire'
              ? '(entire keshet excluded).'
              : '(excluded only where wider than 4000 amot).'),
        );
      }
    }
  }

  // 4. Rema: every city gets an extra 70⅔ amot around its squaring.
  const remaM = settings.remaExtra ? REMA_EXTRA_AMOT * amah : 0;
  if (remaM > 0 && isRectangle) {
    squaringRot = rectPoly(minX - remaM, minY - remaM, maxX + remaM, maxY + remaM);
  }

  let squaringLocal = rotateFeature(squaringRot, angle);
  let polygon = featureFromLocal(ctx.frame, squaringLocal);
  if (remaM > 0 && !isRectangle) {
    // Non-rectangular squaring: approximate the Minkowski expansion with a
    // geodesic buffer (round corners instead of square — slightly lenient there).
    polygon = (buffer(polygon, remaM / 1000, { units: 'kilometers' }) as Poly) ?? polygon;
  }

  const keshetCuts = keshetCutsRot.map((cut) =>
    featureFromLocal(ctx.frame, rotateFeature(cut, angle)),
  );
  return { city, polygon, keshetCuts, angle, isRectangle, dataEdges: city.dataEdges };
}

/** Keep angles in [-45°, 45°): a rectangle's orientation is symmetric mod 90°. */
function normalizeAngle(theta: number): number {
  const quarter = Math.PI / 2;
  let a = theta % quarter;
  if (a >= quarter / 2) a -= quarter;
  if (a < -quarter / 2) a += quarter;
  return a;
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

/** Signed shoelace area of one ring. */
function ringArea(ring: Position[]): number {
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return s / 2;
}

/** Planar polygon area in the local frame (holes subtracted). */
function planarArea(poly: Poly): number {
  const polys =
    poly.geometry.type === 'Polygon' ? [poly.geometry.coordinates] : poly.geometry.coordinates;
  let total = 0;
  for (const rings of polys) {
    for (const ring of rings) total += Math.abs(ringArea(ring)) * (ring === rings[0] ? 1 : -1);
  }
  return total;
}

/**
 * Chazon Ish straight side: find a maximal collinear run of boundary edges
 * spanning (nearly) the whole city in its direction; returns its angle or null.
 */
function findStraightSideAngle(local: Poly, allPts: Position[]): number | null {
  const rings =
    local.geometry.type === 'Polygon'
      ? [local.geometry.coordinates[0]]
      : local.geometry.coordinates.map((p) => p[0]);
  // Use the outer ring of the largest part.
  const ring = rings.reduce((best, r) => (Math.abs(ringArea(r)) > Math.abs(ringArea(best)) ? r : best));

  const n = ring.length - 1;
  for (let start = 0; start < n; start++) {
    const a = ring[start];
    let end = start + 1;
    let b = ring[end % n];
    const theta = Math.atan2(b[1] - a[1], b[0] - a[0]);
    // Extend the run while points stay collinear with the initial direction.
    while (end - start < n) {
      const next = ring[(end + 1) % n];
      if (pointLineOffset(next, a, theta) > COLLINEAR_OFFSET_M) break;
      const dir = Math.atan2(next[1] - b[1], next[0] - b[0]);
      if (Math.abs(angleDiff(dir, theta)) > COLLINEAR_TOL_RAD) break;
      end++;
      b = ring[end % n];
    }
    const runLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (runLen === 0) continue;
    // Does the run span the city's full extent along its own direction?
    const u: Position = [Math.cos(theta), Math.sin(theta)];
    let min = Infinity;
    let max = -Infinity;
    for (const p of allPts) {
      const t = p[0] * u[0] + p[1] * u[1];
      if (t < min) min = t;
      if (t > max) max = t;
    }
    if (runLen >= STRAIGHT_SIDE_SPAN * (max - min)) return theta;
  }
  return null;
}

function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function pointLineOffset(p: Position, origin: Position, theta: number): number {
  const dx = p[0] - origin[0];
  const dy = p[1] - origin[1];
  return Math.abs(-Math.sin(theta) * dx + Math.cos(theta) * dy);
}

/**
 * Decide whether a rect-minus-city region is a halachic keshet/gam and return
 * the polygon to exclude from the squaring (or null to keep it).
 * Frame: squaring rectangle is axis-aligned [minX..maxX]×[minY..maxY].
 *
 * The mouth (chord) runs between the two horns of the bow — the farthest-apart
 * pair of region boundary points lying on the rectangle boundary — and depth
 * is measured perpendicular to that chord, so a keshet opening diagonally or
 * wrapping a rectangle corner is measured along its true chord.
 */
function keshetCut(
  region: Poly,
  cityRot: Poly,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  amah: number,
  settings: Settings,
): Poly | null {
  const eps = 0.5;
  const pts = allPositions(region.geometry);

  // A bow opens onto the rectangle boundary in exactly one contiguous arc,
  // and its interior is empty. A region with several disconnected mouths (or
  // with city parts inside it as holes) is the space *between* parts of a
  // halachically-merged city — it separates the city rather than indenting
  // it, and must stay inside the squaring.
  if (region.geometry.type !== 'Polygon' || region.geometry.coordinates.length > 1) return null;
  const ring = region.geometry.coordinates[0];
  const m = ring.length - 1;
  const sideMask = (p: Position): number =>
    (maxY - p[1] < eps ? 1 : 0) |
    (p[1] - minY < eps ? 2 : 0) |
    (maxX - p[0] < eps ? 4 : 0) |
    (p[0] - minX < eps ? 8 : 0);
  // An edge is part of the mouth when it runs along a rectangle side.
  const isMouth: boolean[] = [];
  for (let i = 0; i < m; i++) {
    isMouth.push((sideMask(ring[i]) & sideMask(ring[i + 1])) !== 0);
  }
  let runs = 0;
  for (let i = 0; i < m; i++) {
    if (isMouth[i] && !isMouth[(i - 1 + m) % m]) runs++;
  }
  if (runs !== 1) return null; // interior hole, or several mouths (split city)

  // Horns = the endpoints of the single mouth arc (it may wrap a corner).
  let start = 0;
  while (!(isMouth[start] && !isMouth[(start - 1 + m) % m])) start++;
  let end = start;
  while (isMouth[end % m]) end++;
  const h1 = ring[start];
  const h2 = ring[end % m];
  const mouthM = Math.hypot(h2[0] - h1[0], h2[1] - h1[1]);
  if (mouthM === 0) return null;

  // The chord must also span open ground: buildings interrupting the straight
  // line between the horns mean this is not a bow's mouth.
  const samples = Math.min(500, Math.max(20, Math.round(mouthM / 30)));
  for (let i = 1; i < samples; i++) {
    const t = i / samples;
    const p: Position = [h1[0] + (h2[0] - h1[0]) * t, h1[1] + (h2[1] - h1[1]) * t];
    if (pointInCity(p, cityRot)) return null;
  }

  // Chord frame: u along the chord, v perpendicular pointing into the region
  // (the side where the region extends deeper).
  const ux = (h2[0] - h1[0]) / mouthM;
  const uy = (h2[1] - h1[1]) / mouthM;
  let vx = -uy;
  let vy = ux;
  let maxPos = 0;
  let maxNeg = 0;
  for (const p of pts) {
    const v = (p[0] - h1[0]) * vx + (p[1] - h1[1]) * vy;
    if (v > maxPos) maxPos = v;
    if (-v > maxNeg) maxNeg = -v;
  }
  if (maxNeg > maxPos) {
    vx = -vx;
    vy = -vy;
  }
  const uOf = (p: Position) => (p[0] - h1[0]) * ux + (p[1] - h1[1]) * uy;
  const vOf = (p: Position) => (p[0] - h1[0]) * vx + (p[1] - h1[1]) * vy;

  // The outline is dilated by half the 70⅔ gap, which narrows a concavity by
  // half a gap per arm — compensate the thresholds accordingly.
  const gapM = CITY_GAP_AMOT * amah;
  const depthM = Math.max(maxPos, maxNeg);
  if (mouthM < KESHET_MOUTH_AMOT * amah - gapM) return null;
  if (
    settings.keshetCondition === 'mouthAndDepth' &&
    depthM <= KESHET_DEPTH_AMOT * amah - gapM / 2
  ) {
    return null;
  }

  if (settings.keshetExclusion === 'entire') return region;

  // Exclude only where the keshet's cross-section (parallel to the chord) is
  // wider than 4000 amot — where the arms close within 4000 amot, the gap
  // between them is under the mouth threshold and the hollow beyond is
  // treated as filled again. Sample the width at increasing depth and cut at
  // the last depth still wider.
  const widthLimit = KESHET_WIDTH_AMOT * amah - gapM;
  const steps = 100;
  let cutDepth = 0;
  for (let i = 0; i <= steps; i++) {
    const d = (depthM * i) / steps;
    if (crossSection(region, vOf, uOf, d) > widthLimit) cutDepth = d;
  }
  if (cutDepth <= 0) return null;
  // Band in the chord frame from below the chord (v < 0 pockets beyond it lie
  // even farther from the city) up to the cut depth.
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = 0;
  for (const p of pts) {
    const u = uOf(p);
    const v = vOf(p);
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
    if (v < vMin) vMin = v;
  }
  const margin = 1; // so the band strictly covers the region's edges
  const bandCorners = (
    [
      [uMin - margin, vMin - margin],
      [uMax + margin, vMin - margin],
      [uMax + margin, cutDepth],
      [uMin - margin, cutDepth],
    ] as Position[]
  ).map(([u, v]): Position => [h1[0] + u * ux + v * vx, h1[1] + u * uy + v * vy]);
  const band = turfPolygon([[...bandCorners, bandCorners[0]]]) as Poly;
  const clipped = intersectSafe(region, band);
  return clipped ?? region;
}

/**
 * Total cross-section length of the region at the given depth: sum of the
 * intervals where the depth-contour line passes through the region.
 */
function crossSection(
  region: Poly,
  depthOf: (p: Position) => number,
  alongOf: (p: Position) => number,
  d: number,
): number {
  const polys =
    region.geometry.type === 'Polygon'
      ? [region.geometry.coordinates]
      : region.geometry.coordinates;
  // Where region edges cross the constant-depth contour, record the coordinate
  // along the mouth side; sorted pairs of crossings bound the inside intervals.
  const crossings: number[] = [];
  for (const rings of polys) {
    for (const ring of rings) {
      for (let i = 0; i < ring.length - 1; i++) {
        const p = ring[i];
        const q = ring[i + 1];
        const dp = depthOf(p) - d;
        const dq = depthOf(q) - d;
        if ((dp <= 0 && dq > 0) || (dp > 0 && dq <= 0)) {
          const t = dp / (dp - dq);
          crossings.push(alongOf(p) + t * (alongOf(q) - alongOf(p)));
        }
      }
    }
  }
  if (crossings.length < 2) return 0;
  crossings.sort((a, b) => a - b);
  let total = 0;
  for (let i = 0; i + 1 < crossings.length; i += 2) total += crossings[i + 1] - crossings[i];
  return total;
}

function pointInCity(p: Position, city: Poly): boolean {
  const g = city.geometry;
  if (g.type === 'Polygon') return pointInRings(p, g.coordinates);
  return g.coordinates.some((rings) => pointInRings(p, rings));
}

function intersectSafe(a: Poly, b: Poly): Poly | null {
  try {
    return intersect(featureCollection([a, b])) as Poly | null;
  } catch {
    return null;
  }
}
