/**
 * Which sides of the square building-fetch area the data runs out on: a point
 * near an edge of the fetch square means the buildings there may continue
 * beyond the loaded data. The fetch bbox is built with the same
 * equirectangular scaling as the local frame, so in local coordinates it is
 * exactly the square [-radiusM, radiusM]².
 */

import type { Position } from 'geojson';
import type { DataEdges } from '../types';

/** Within this fraction of the fetch radius counts as reaching the edge. */
const EDGE_MARGIN = 0.95;

export function noDataEdges(): DataEdges {
  return { n: false, e: false, s: false, w: false };
}

export function anyDataEdge(edges: DataEdges): boolean {
  return edges.n || edges.e || edges.s || edges.w;
}

export function mergeDataEdges(a: DataEdges, b: DataEdges): DataEdges {
  return { n: a.n || b.n, e: a.e || b.e, s: a.s || b.s, w: a.w || b.w };
}

/** Fetch-square sides the given local-frame points come near. */
export function dataEdgesOfPoints(points: Position[], radiusM: number): DataEdges {
  const thr = radiusM * EDGE_MARGIN;
  const edges = noDataEdges();
  for (const [x, y] of points) {
    if (y > thr) edges.n = true;
    if (x > thr) edges.e = true;
    if (y < -thr) edges.s = true;
    if (x < -thr) edges.w = true;
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
