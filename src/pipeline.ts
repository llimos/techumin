/**
 * Runs the six calculation steps, caching each output. A settings change
 * re-runs only from the first affected step; a new point re-runs everything.
 */

import type { City, LatLon, PipelineContext, Poly, Shvita, Squaring } from './types';
import { SETTING_FIRST_STEP, type Settings } from './settings';
import { makeFrame } from './geo/project';
import { fetchBuildings, type FetchResult } from './steps/fetchBuildings';
import { findCities, type CitiesResult } from './steps/findCities';
import { mergeCities } from './steps/mergeCities';
import { squareCities } from './steps/squareCity';
import { findShvita } from './steps/findShvita';
import { measureTechum } from './steps/measureTechum';

export interface PipelineOutputs {
  fetched?: FetchResult;
  citiesResult?: CitiesResult;
  merged?: City[];
  squarings?: Squaring[];
  shvita?: Shvita;
  techum?: Poly;
}

export interface PipelineUpdate {
  outputs: PipelineOutputs;
  warnings: string[];
  running: boolean;
  error?: string;
}

const STEP_NAMES = [
  '1 fetchBuildings',
  '2 findCities',
  '3 mergeCities',
  '4 squareCities',
  '5 findShvita',
  '6 measureTechum',
];

export class TechumPipeline {
  private point: LatLon | null = null;
  private settings: Settings;
  private outputs: PipelineOutputs = {};
  /** Warnings collected per step, so partial re-runs keep earlier warnings. */
  private stepWarnings: string[][] = [[], [], [], [], [], []];
  private runToken = 0;

  onUpdate: (update: PipelineUpdate) => void = () => {};

  constructor(settings: Settings) {
    this.settings = { ...settings };
  }

  getSettings(): Settings {
    return { ...this.settings };
  }

  setPoint(point: LatLon): void {
    this.point = point;
    void this.run(1);
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
    return 6;
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

    // Drop stale outputs and warnings from the re-run steps onward.
    const o = this.outputs;
    if (fromStep <= 1) o.fetched = undefined;
    if (fromStep <= 2) o.citiesResult = undefined;
    if (fromStep <= 3) o.merged = undefined;
    if (fromStep <= 4) o.squarings = undefined;
    if (fromStep <= 5) o.shvita = undefined;
    o.techum = undefined;
    for (let i = fromStep - 1; i < 6; i++) this.stepWarnings[i] = [];

    this.emit(true);
    try {
      for (let step = fromStep; step <= 6; step++) {
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
        this.emit(step < 6);
      }
    } catch (err) {
      if (token !== this.runToken) return;
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
        o.techum = await measureTechum(ctx, this.settings, o.shvita!);
        break;
    }
  }

  private stepOutput(step: number): unknown {
    const o = this.outputs;
    return [o.fetched, o.citiesResult, o.merged, o.squarings, o.shvita, o.techum][step - 1];
  }

  private emit(running: boolean, error?: string): void {
    this.onUpdate({
      outputs: { ...this.outputs },
      warnings: this.stepWarnings.flat(),
      running,
      error,
    });
  }
}
