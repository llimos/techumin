/**
 * Which sides of the building-fetch area the data runs out on: a point near
 * an edge of the loaded extent means the buildings there may continue beyond
 * the loaded data. Fetch bboxes are built with the same equirectangular
 * scaling as the local frame, so the loaded extent is an exact rectangle in
 * local coordinates.
 */

import type { Position } from 'geojson';
import type { BBox } from './dilate';
import type { DataEdges } from '../types';
import type { LString } from '../i18n';

/** Within this many meters of the loaded extent counts as reaching the edge. */
const EDGE_MARGIN_M = 150;

export function noDataEdges(): DataEdges {
  return { n: false, e: false, s: false, w: false };
}

export function anyDataEdge(edges: DataEdges): boolean {
  return edges.n || edges.e || edges.s || edges.w;
}

export function mergeDataEdges(a: DataEdges, b: DataEdges): DataEdges {
  return { n: a.n || b.n, e: a.e || b.e, s: a.s || b.s, w: a.w || b.w };
}

/** Loaded-extent sides the given local-frame points come near. */
export function dataEdgesOfPoints(points: Position[], extent: BBox): DataEdges {
  const edges = noDataEdges();
  for (const [x, y] of points) {
    if (y > extent.maxY - EDGE_MARGIN_M) edges.n = true;
    if (x > extent.maxX - EDGE_MARGIN_M) edges.e = true;
    if (y < extent.minY + EDGE_MARGIN_M) edges.s = true;
    if (x < extent.minX + EDGE_MARGIN_M) edges.w = true;
  }
  return edges;
}

/** E.g. "north and east" — for warning messages. */
export function describeDataEdges(edges: DataEdges): LString {
  const pick = (lang: 'en' | 'he'): string => {
    const dir = { n: SIDE_NAMES.n[lang], s: SIDE_NAMES.s[lang], e: SIDE_NAMES.e[lang], w: SIDE_NAMES.w[lang] };
    const names: string[] = [];
    if (edges.n) names.push(dir.n);
    if (edges.s) names.push(dir.s);
    if (edges.e) names.push(dir.e);
    if (edges.w) names.push(dir.w);
    if (names.length <= 1) return names[0] ?? '';
    const last = names[names.length - 1];
    const rest = names.slice(0, -1).join(', ');
    return lang === 'he' ? `${rest} ו${last}` : `${rest} and ${last}`;
  };
  return { en: pick('en'), he: pick('he') };
}

/** Compass side names, for messages that name a direction. */
export const SIDE_NAMES: Record<keyof DataEdges, LString> = {
  n: { en: 'north', he: 'צפון' },
  s: { en: 'south', he: 'דרום' },
  e: { en: 'east', he: 'מזרח' },
  w: { en: 'west', he: 'מערב' },
};
