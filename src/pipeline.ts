/**
 * Runs the calculation steps, caching each output. A settings change re-runs
 * only from the first affected step; a new point re-runs everything. Steps
 * 7-8 repeat the shvita/techum steps measured from an eruv techumin, when one
 * is set; the home outputs stay cached so removing the eruv is instant.
 */

import { booleanPointInPolygon, point as turfPoint } from '@turf/turf';
import type { City, LatLon, PipelineContext, Poly, Shvita, Squaring } from './types';
import { SETTING_FIRST_STEP, type Settings } from './settings';
import { makeFrame } from './geo/project';
import { fetchBuildings, type FetchResult } from './steps/fetchBuildings';
import { findCities, type CitiesResult } from './steps/findCities';
import { mergeCities } from './steps/mergeCities';
import { squareCities } from './steps/squareCity';
import { findShvita, pointShvita } from './steps/findShvita';
import { measureTechum } from './steps/measureTechum';

export interface PipelineOutputs {
  fetched?: FetchResult;
  citiesResult?: CitiesResult;
  merged?: City[];
  squarings?: Squaring[];
  shvita?: Shvita;
  techum?: Poly;
  eruvShvita?: Shvita;
  eruvTechum?: Poly;
}

export interface PipelineUpdate {
  outputs: PipelineOutputs;
  warnings: string[];
  running: boolean;
  /** Label of the step currently being calculated, while running. */
  stage?: string;
  error?: string;
}

const STEP_NAMES = [
  '1 fetchBuildings',
  '2 findCities',
  '3 mergeCities',
  '4 squareCities',
  '5 findShvita',
  '6 measureTechum',
  '7 findShvita (eruv)',
  '8 measureTechum (eruv)',
];

const STAGE_LABELS = [
  'Fetching buildings',
  'Finding cities',
  'Merging cities',
  'Squaring the cities',
  'Finding the shvisa bounds',
  'Measuring the techum',
  'Finding the eruv shvisa bounds',
  'Measuring the eruv techum',
];

/**
 * Resolve after the browser has painted, so a status update shows before a
 * CPU-heavy step — with a timeout fallback, since rAF does not fire in hidden
 * tabs and the pipeline must keep running there.
 */
const nextPaint = (): Promise<void> =>
  new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    requestAnimationFrame(() => setTimeout(finish, 0));
    setTimeout(finish, 100);
  });

export class TechumPipeline {
  private point: LatLon | null = null;
  private eruvPoint: LatLon | null = null;
  private settings: Settings;
  private outputs: PipelineOutputs = {};
  /** Warnings collected per step, so partial re-runs keep earlier warnings. */
  private stepWarnings: string[][] = [[], [], [], [], [], [], [], []];
  /** Techum from a 4-amot shvita at the start point; cached per home run. */
  private personalZoneCache: Promise<Poly> | null = null;
  private runToken = 0;
  private stage?: string;

  onUpdate: (update: PipelineUpdate) => void = () => {};

  constructor(settings: Settings) {
    this.settings = { ...settings };
  }

  getSettings(): Settings {
    return { ...this.settings };
  }

  setPoint(point: LatLon): void {
    this.point = point;
    this.eruvPoint = null;
    this.personalZoneCache = null;
    void this.run(1);
  }

  /** Set the eruv techumin point; steps 7-8 measure the techum from it. */
  setEruv(point: LatLon): void {
    this.eruvPoint = point;
    void this.run(7);
  }

  /** Remove the eruv; the cached home techum shows again with no recompute. */
  clearEruv(): void {
    this.eruvPoint = null;
    this.outputs.eruvShvita = undefined;
    this.outputs.eruvTechum = undefined;
    this.stepWarnings[6] = [];
    this.stepWarnings[7] = [];
    this.emit(this.stage !== undefined);
  }

  /**
   * The area where an eruv techumin may be placed, per the current setting:
   * the whole city's techum, or only the techum measured from the start point
   * itself. Undefined until a techum has been computed.
   */
  async getPlacementZone(): Promise<Poly | undefined> {
    if (!this.point || !this.outputs.techum) return undefined;
    return this.settings.eruvCityTechum ? this.outputs.techum : this.personalZone();
  }

  /** Requires outputs.techum; see getPlacementZone. */
  private personalZone(): Promise<Poly> {
    const o = this.outputs;
    if (o.shvita?.source === 'point') return Promise.resolve(o.techum!);
    if (!this.personalZoneCache) {
      const point = this.point!;
      const ctx: PipelineContext = {
        point,
        frame: makeFrame(point.lat, point.lon),
        warnings: [],
        warn: () => {},
      };
      this.personalZoneCache = measureTechum(
        ctx,
        this.settings,
        pointShvita(ctx, this.settings, [0, 0]),
        this.outputs.squarings ?? [],
      );
    }
    return this.personalZoneCache;
  }

  updateSettings(partial: Partial<Settings>): void {
    let firstStep = Infinity;
    for (const [key, value] of Object.entries(partial) as [keyof Settings, never][]) {
      if (this.settings[key] === value) continue;
      (this.settings as unknown as Record<string, unknown>)[key] = value;
      firstStep = Math.min(firstStep, SETTING_FIRST_STEP[key]);
    }
    if (firstStep === Infinity || !this.point) return;
    void this.run(firstStep);
  }

  /** Earliest step whose output is missing (e.g. after a failed run). */
  private firstMissingStep(): number {
    const o = this.outputs;
    if (!o.fetched) return 1;
    if (!o.citiesResult) return 2;
    if (!o.merged) return 3;
    if (!o.squarings) return 4;
    if (!o.shvita) return 5;
    if (!o.techum) return 6;
    return 7;
  }

  private async run(fromStep: number): Promise<void> {
    if (!this.point) return;
    fromStep = Math.min(fromStep, this.firstMissingStep());
    const token = ++this.runToken;
    const point = this.point;
    const ctx: PipelineContext = {
      point,
      frame: makeFrame(point.lat, point.lon),
      warnings: [],
      warn: (m) => ctx.warnings.push(m),
    };

    // Drop stale outputs and warnings from the re-run steps onward. The eruv
    // outputs are always recomputed when the run reaches them (same policy as
    // the techum before the eruv steps existed).
    const o = this.outputs;
    if (fromStep <= 1) o.fetched = undefined;
    if (fromStep <= 2) o.citiesResult = undefined;
    if (fromStep <= 3) o.merged = undefined;
    if (fromStep <= 4) o.squarings = undefined;
    if (fromStep <= 5) o.shvita = undefined;
    if (fromStep <= 6) {
      o.techum = undefined;
      this.personalZoneCache = null;
    }
    o.eruvShvita = undefined;
    o.eruvTechum = undefined;
    for (let i = fromStep - 1; i < 8; i++) this.stepWarnings[i] = [];

    // Re-evaluated per iteration: clearing the eruv mid-run ends the run at 6.
    const lastStep = () => (this.eruvPoint ? 8 : 6);
    try {
      for (let step = fromStep; step <= lastStep(); step++) {
        this.stage = STAGE_LABELS[step - 1];
        this.emit(true);
        await nextPaint(); // let the stage popup show before a blocking step
        if (token !== this.runToken) return;
        ctx.warnings = [];
        const t0 = performance.now();
        await this.runStep(step, ctx);
        if (token !== this.runToken) return; // superseded by a newer run
        this.stepWarnings[step - 1] = ctx.warnings;
        console.debug(
          `[techum] ${STEP_NAMES[step - 1]} (${Math.round(performance.now() - t0)} ms)`,
          this.stepOutput(step),
          ctx.warnings.length ? { warnings: ctx.warnings } : '',
        );
        if (step === lastStep()) this.stage = undefined;
        this.emit(step < lastStep());
      }
    } catch (err) {
      if (token !== this.runToken) return;
      this.stage = undefined;
      console.error('[techum] pipeline failed', err);
      this.emit(false, err instanceof Error ? err.message : String(err));
    }
  }

  private async runStep(step: number, ctx: PipelineContext): Promise<void> {
    const o = this.outputs;
    switch (step) {
      case 1:
        o.fetched = await fetchBuildings(ctx, this.settings);
        break;
      case 2:
        o.citiesResult = findCities(ctx, this.settings, o.fetched!);
        break;
      case 3:
        o.merged = mergeCities(ctx, this.settings, o.citiesResult!);
        break;
      case 4:
        o.squarings = squareCities(ctx, this.settings, o.merged!);
        break;
      case 5:
        o.shvita = findShvita(ctx, this.settings, o.fetched!, o.squarings!);
        break;
      case 6:
        o.techum = await measureTechum(ctx, this.settings, o.shvita!, o.squarings!);
        break;
      case 7: {
        const eruv = this.eruvPoint!;
        const eruvPt = turfPoint([eruv.lon, eruv.lat]);
        const zone = await this.getPlacementZone();
        if (zone && !booleanPointInPolygon(eruvPt, zone)) {
          ctx.warn('The eruv is outside the area where an eruv may be placed — the eruv is invalid.');
        } else if (
          this.settings.eruvCityTechum &&
          !booleanPointInPolygon(eruvPt, await this.personalZone())
        ) {
          ctx.warn(
            'The eruv is more than 2000 amot from the start point — ' +
              'most poskim do not allow returning to the start point.',
          );
        }
        const eruvCtx: PipelineContext = { ...ctx, warn: (m) => ctx.warn(`Eruv: ${m}`) };
        o.eruvShvita = findShvita(eruvCtx, this.settings, o.fetched!, o.squarings!, eruv);
        break;
      }
      case 8:
        o.eruvTechum = await measureTechum(ctx, this.settings, o.eruvShvita!, o.squarings!, {
          startPoint: this.point ?? undefined,
        });
        break;
    }
  }

  private stepOutput(step: number): unknown {
    const o = this.outputs;
    return [o.fetched, o.citiesResult, o.merged, o.squarings, o.shvita, o.techum, o.eruvShvita, o.eruvTechum][step - 1];
  }

  private emit(running: boolean, error?: string): void {
    this.onUpdate({
      outputs: { ...this.outputs },
      warnings: this.stepWarnings.flat(),
      running,
      stage: running ? this.stage : undefined,
      error,
    });
  }
}
