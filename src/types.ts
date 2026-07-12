import type { Feature, Polygon, MultiPolygon, Position } from 'geojson';
import type { LocalFrame } from './geo/project';

export type Poly = Feature<Polygon | MultiPolygon>;

export interface LatLon {
  lat: number;
  lon: number;
}

/**
 * Compass sides of the building-fetch area where the loaded data runs out:
 * a side is true when buildings come close to that edge of the fetch square,
 * so the real city may continue beyond it and derived bounds (ribua, shvita,
 * techum) may be understated in that direction.
 */
export interface DataEdges {
  n: boolean;
  e: boolean;
  s: boolean;
  w: boolean;
}

export interface City {
  /**
   * City outline with ibur gaps filled (buildings dilated by half the 70⅔
   * gap and unioned), geographic coordinates — for display and keshet checks.
   */
  polygon: Poly;
  /** Same outline in the local planar frame (meters). */
  localPolygon: Poly;
  /**
   * Building hull vertices (local frame) — their convex hull is the city's
   * exact (undilated) extent, for squaring and width measurements. For a
   * merged city this is the concatenation of the parts' hulls.
   */
  hullPointsLocal: Position[];
  /** Convex hull of each individual building (local frame) — undilated extents. */
  buildingHullsLocal: Position[][];
  buildingCount: number;
  /** Fetch-area sides this city's buildings come near — it may extend past them. */
  dataEdges: DataEdges;
}

export interface Squaring {
  city: City;
  /** Squaring polygon (rectangle, possibly minus keshet exclusions), geographic. */
  polygon: Poly;
  /** Keshet/gam regions excluded from the squaring, geographic — for display. */
  keshetCuts: Poly[];
  /** CCW radians from North-South alignment. */
  angle: number;
  /** True when the polygon is exactly its bounding rectangle (no keshet cut). */
  isRectangle: boolean;
  /** Inherited from the city: sides where the data (and so the ribua) may fall short. */
  dataEdges: DataEdges;
}

export type ShvitaSource = 'city' | 'building' | 'point';

export interface Shvita {
  polygon: Poly;
  angle: number;
  source: ShvitaSource;
  /** Sides where the shvita (and the techum measured from it) may be understated. */
  dataEdges: DataEdges;
}

export interface StepWarnings {
  push(message: string): void;
}

export interface PipelineContext {
  point: LatLon;
  frame: LocalFrame;
  warnings: string[];
  warn(message: string): void;
}
