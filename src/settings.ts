/** Halachic opinion settings and fixed constants. All lengths in amot unless noted. */

export type AmahPreset = 'naeh' | 'moshe' | 'chazonIsh' | 'custom';
export type KeshetExclusion = 'entire' | 'past2000';
export type FourAmotMode = 'each' | 'total';
export type UnequalLines = 'extend' | 'diagonal';

export interface Settings {
  amahPreset: AmahPreset;
  /** Used when amahPreset === 'custom'. */
  customAmahCm: number;
  /** Triangle rule: is the third city itself absorbed into the merged city? */
  triangleAbsorbsThird: boolean;
  /** Chazon Ish: a full-length straight side determines the squaring angle. */
  chazonIshStraightSide: boolean;
  /** Exclude the entire keshet/gam, or only where it widens past 2000 amot. */
  keshetExclusion: KeshetExclusion;
  /** Rema: every city gets an extra 70⅔ amot added to its squaring. */
  remaExtra: boolean;
  /** No-structure fallback: 4 amot in each direction, or 4 amot total. */
  fourAmotMode: FourAmotMode;
  /** Unequal measurement lines: extend the shorter, or join on the diagonal. */
  unequalLines: UnequalLines;
  /** Non-halachic: building-fetch radius around the point, meters. */
  fetchRadiusM: number;
}

export const AMAH_CM: Record<Exclude<AmahPreset, 'custom'>, number> = {
  naeh: 48,
  moshe: 54,
  chazonIsh: 57.6,
};

export const AMAH_LABELS: Record<AmahPreset, string> = {
  naeh: "R' Chaim Naeh (48 cm)",
  moshe: "R' Moshe Feinstein (54 cm)",
  chazonIsh: 'Chazon Ish (57.6 cm)',
  custom: 'Custom',
};

export function amahMeters(s: Settings): number {
  const cm = s.amahPreset === 'custom' ? s.customAmahCm : AMAH_CM[s.amahPreset];
  return cm / 100;
}

export const MAX_AMAH_M = Math.max(...Object.values(AMAH_CM)) / 100;

// Fixed halachic constants (amot)
export const CITY_GAP_AMOT = 70 + 2 / 3;
export const MERGE_GAP_AMOT = 141 + 1 / 3;
/** Triangle rule: max distance from the middle city to each outer city. */
export const TRIANGLE_SIDE_AMOT = 2000;
/** Triangle rule: max gap between the outer cities, beyond the middle city's width (2 × 141⅓). */
export const TRIANGLE_SPAN_AMOT = 2 * MERGE_GAP_AMOT;
export const TECHUM_AMOT = 2000;
export const KESHET_MOUTH_AMOT = 4000;
export const KESHET_DEPTH_AMOT = 2000;
export const KESHET_WIDTH_AMOT = 2000;
export const REMA_EXTRA_AMOT = CITY_GAP_AMOT;
export const FOUR_AMOT = 4;
/** Descent limit for the downhill exception in the gradient rule. */
export const DESCENT_LIMIT_AMOT = 2000;

export const MIN_CITY_BUILDINGS = 6;
/** Ground steeper than this rise/run is measured as the crow flies. */
export const GRADIENT_THRESHOLD = 1 / 3.6;

export const DEFAULT_SETTINGS: Settings = {
  amahPreset: 'naeh',
  customAmahCm: 48,
  triangleAbsorbsThird: true,
  chazonIshStraightSide: false,
  keshetExclusion: 'past2000',
  remaExtra: false,
  fourAmotMode: 'each',
  unequalLines: 'extend',
  fetchRadiusM: 3000,
};

/**
 * First pipeline step (1-based) affected by each setting; a change re-runs the
 * pipeline from that step. Steps: 1 fetch, 2 cities, 3 merge, 4 square,
 * 5 shvita, 6 techum.
 */
export const SETTING_FIRST_STEP: Record<keyof Settings, number> = {
  fetchRadiusM: 1,
  amahPreset: 2,
  customAmahCm: 2,
  triangleAbsorbsThird: 3,
  chazonIshStraightSide: 4,
  keshetExclusion: 4,
  remaExtra: 4,
  fourAmotMode: 5,
  unequalLines: 6,
};
