/** Halachic opinion settings and fixed constants. All lengths in amot unless noted. */

export type AmahPreset = 'naeh' | 'moshe' | 'chazonIsh' | 'custom';
export type KeshetExclusion = 'entire' | 'past4000';
export type KeshetCondition = 'mouthAndDepth' | 'mouthOnly';
export type FourAmotMode = 'each' | 'total';
export type UnequalLines = 'extend' | 'diagonal';
export type TriangleWideMiddle = 'merge' | 'noMerge';

export interface Settings {
  amahPreset: AmahPreset;
  /** Used when amahPreset === 'custom'. */
  customAmahCm: number;
  /** Triangle rule: is the third city itself absorbed into the merged city? */
  triangleAbsorbsThird: boolean;
  /** Middle city wider than the gap between the outer cities: Gr"a — they
   *  still merge; Tur/Chazon Ish — they do not. */
  triangleWideMiddle: TriangleWideMiddle;
  /** Chazon Ish: a full-length straight side determines the squaring angle. */
  chazonIshStraightSide: boolean;
  /** Keshet/gam test: mouth ≥ 4000 amot and depth > 2000, or mouth alone. */
  keshetCondition: KeshetCondition;
  /** Exclude the entire keshet/gam, or only where it is wider than 4000 amot. */
  keshetExclusion: KeshetExclusion;
  /** Rema: every city gets an extra 70⅔ amot added to its squaring. */
  remaExtra: boolean;
  /** No-structure fallback: 4 amot in each direction, or 4 amot total. */
  fourAmotMode: FourAmotMode;
  /** Unequal measurement lines: extend the shorter, or join on the diagonal. */
  unequalLines: UnequalLines;
  /** Eruv techumin may be placed anywhere in the city's techum, not only
   *  within 2000 amot of the start point. */
  eruvCityTechum: boolean;
  /** Non-halachic: half-side of the square building-fetch area, meters. */
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
/** Partial exclusion keeps the keshet where its arms close within this. */
export const KESHET_WIDTH_AMOT = 4000;
export const REMA_EXTRA_AMOT = CITY_GAP_AMOT;
export const FOUR_AMOT = 4;
/** Descent limit for the downhill exception in the gradient rule. */
export const DESCENT_LIMIT_AMOT = 2000;

export const MIN_CITY_BUILDINGS = 6;
/** Ground steeper than this rise/run is measured as the crow flies. */
export const GRADIENT_THRESHOLD = 1 / 3.6;
/** Measuring-rope length: the gradient is sampled at this interval. */
export const ROPE_AMOT = 50;

export const DEFAULT_SETTINGS: Settings = {
  amahPreset: 'naeh',
  customAmahCm: 48,
  triangleAbsorbsThird: true,
  triangleWideMiddle: 'noMerge',
  chazonIshStraightSide: false,
  keshetCondition: 'mouthAndDepth',
  keshetExclusion: 'past4000',
  remaExtra: false,
  fourAmotMode: 'each',
  unequalLines: 'extend',
  eruvCityTechum: false,
  fetchRadiusM: 3000,
};

const STORAGE_KEY = 'techumin-settings';

/** Per-key validation of stored values; bounds match the sidebar controls. */
const SETTING_VALID: Record<keyof Settings, (v: unknown) => boolean> = {
  amahPreset: (v) => typeof v === 'string' && v in AMAH_LABELS,
  customAmahCm: (v) => typeof v === 'number' && v >= 30 && v <= 80,
  triangleAbsorbsThird: (v) => typeof v === 'boolean',
  triangleWideMiddle: (v) => v === 'merge' || v === 'noMerge',
  chazonIshStraightSide: (v) => typeof v === 'boolean',
  keshetCondition: (v) => v === 'mouthAndDepth' || v === 'mouthOnly',
  keshetExclusion: (v) => v === 'entire' || v === 'past4000',
  remaExtra: (v) => typeof v === 'boolean',
  fourAmotMode: (v) => v === 'each' || v === 'total',
  unequalLines: (v) => v === 'extend' || v === 'diagonal',
  eruvCityTechum: (v) => typeof v === 'boolean',
  fetchRadiusM: (v) => typeof v === 'number' && v >= 1000 && v <= 6000,
};

/** Defaults overlaid with saved preferences; invalid entries are ignored. */
export function loadSettings(): Settings {
  const settings = { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return settings;
    const stored = JSON.parse(raw) as Record<string, unknown>;
    for (const key of Object.keys(settings) as (keyof Settings)[]) {
      if (SETTING_VALID[key](stored[key])) {
        (settings as Record<string, unknown>)[key] = stored[key];
      }
    }
  } catch {
    // Corrupt storage — fall back to defaults.
  }
  return settings;
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable (e.g. private mode) — preferences just don't persist.
  }
}

/**
 * First pipeline step (1-based) affected by each setting; a change re-runs the
 * pipeline from that step. Steps: 1 fetch, 2 cities, 3 merge, 4 square,
 * 5 shvita, 6 techum, 7-8 the same two steps measured from the eruv.
 */
export const SETTING_FIRST_STEP: Record<keyof Settings, number> = {
  fetchRadiusM: 1,
  amahPreset: 2,
  customAmahCm: 2,
  triangleAbsorbsThird: 3,
  triangleWideMiddle: 3,
  chazonIshStraightSide: 4,
  keshetCondition: 4,
  keshetExclusion: 4,
  remaExtra: 4,
  fourAmotMode: 5,
  unequalLines: 6,
  eruvCityTechum: 7,
};
