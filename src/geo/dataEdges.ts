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
export function describeDataEdges(edges: DataEdges): string {
  const names: string[] = [];
  if (edges.n) names.push('north');
  if (edges.s) names.push('south');
  if (edges.e) names.push('east');
  if (edges.w) names.push('west');
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
