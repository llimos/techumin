import type { Feature, Polygon, MultiPolygon, Position } from 'geojson';
import type { LocalFrame } from './geo/project';

export type Poly = Feature<Polygon | MultiPolygon>;

export interface LatLon {
  lat: number;
  lon: number;
}

export interface City {
  /**
   * City outline with ibur gaps filled (buildings dilated by half the 70⅔
   * gap and unioned), geographic coordinates — for display and keshet checks.
   */
  polygon: Poly;
  /** Same outline in the local planar frame (meters). */
  localPolygon: Poly;
  /** Raw building vertices (local frame) — exact city bounds for squaring. */
  rawPointsLocal: Position[];
  buildingCount: number;
}

export interface Squaring {
  city: City;
  /** Squaring polygon (rectangle, possibly minus keshet exclusions), geographic. */
  polygon: Poly;
  /** CCW radians from North-South alignment. */
  angle: number;
  /** True when the polygon is exactly its bounding rectangle (no keshet cut). */
  isRectangle: boolean;
}

export type ShvitaSource = 'city' | 'building' | 'point';

export interface Shvita {
  polygon: Poly;
  angle: number;
  source: ShvitaSource;
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
