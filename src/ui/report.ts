/**
 * Printable calculation report, opened in its own tab: a static snapshot of
 * the map with the cities numbered, the selected halachic options, and the
 * per-step calculation log — something to print off and show to a Rabbi.
 */

import type { ReportData, ReportStep } from '../pipeline';
import { AMAH_LABELS, SETTING_META, amahMeters, type Settings } from '../settings';
import { settingValueLabel } from '../settings';
import type { LatLon } from '../types';
import { DISCLAIMERS } from './sidebar';

export interface ReportInput {
  report: ReportData;
  /** PNG data URL of the map snapshot, or null when the capture failed. */
  imageDataUrl: string | null;
  /** Shareable app URL reproducing this calculation. */
  appUrl: string;
}

/**
 * Open the report tab immediately (synchronously, inside the click, so popup
 * blockers allow it) with a placeholder; returns null when blocked.
 */
export function openReportWindow(): Window | null {
  const win = window.open('', '_blank');
  if (win) {
    win.document.write(
      '<title>Techum Shabbos Report</title>' +
        '<p style="font-family: system-ui, sans-serif; margin: 24px">Preparing report…</p>',
    );
    win.document.close();
  }
  return win;
}

/** Replace the placeholder with the full report document. */
export function renderReport(win: Window, input: ReportInput): void {
  win.document.open();
  win.document.write(reportHtml(input));
  win.document.close();
  win.document.getElementById('print-btn')?.addEventListener('click', () => win.print());
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fmtPoint = (p: LatLon): string => `${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}`;

function amahDescription(settings: Settings): string {
  const label = AMAH_LABELS[settings.amahPreset];
  return settings.amahPreset === 'custom'
    ? `${label} (${(amahMeters(settings) * 100).toFixed(1)} cm)`
    : label;
}

function optionRows(settings: Settings): string {
  return SETTING_META.filter(
    (m) => m.key !== 'customAmahCm' || settings.amahPreset === 'custom',
  )
    .map((m) => {
      const label = m.key === 'fetchRadiusM' ? `${m.label} (non-halachic)` : m.label;
      return `<tr><td>${esc(label)}</td><td>${esc(settingValueLabel(m, settings))}</td></tr>`;
    })
    .join('');
}

function legend(hasEruv: boolean): string {
  const line = (color: string, style: string, text: string): string =>
    `<span><span class="swatch" style="border-top: 3px ${style} ${color}"></span>${esc(text)}</span>`;
  const items = [
    line('#d35400', 'solid', 'Merged cities'),
    line('#8e44ad', 'dashed', 'Squaring (ribua)'),
    line('#c0392b', 'dotted', 'Keshet/gam exclusion'),
    line(hasEruv ? '#8e44ad' : '#2980b9', 'solid', 'Shvisa bounds'),
    line(hasEruv ? '#8e44ad' : '#27ae60', 'solid', hasEruv ? 'Techum (from the eruv)' : 'Techum boundary'),
    `<span><span class="dot"></span>Start point</span>`,
  ];
  if (hasEruv) items.push('<span>🍞 Eruv techumin</span>');
  return `<p class="legend">${items.join('')}</p>`;
}

function stepSections(steps: ReportStep[]): string {
  return steps
    .filter((s) => s.logs.length > 0 || s.warnings.length > 0)
    .map(
      (s) => `
      <div class="step">
        <h3>${esc(s.title)}</h3>
        ${s.logs.length ? `<ul class="log">${s.logs.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
        ${s.warnings.length ? `<ul class="warnings">${s.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      </div>`,
    )
    .join('');
}

function reportHtml({ report, imageDataUrl, appUrl }: ReportInput): string {
  const { settings, point, eruvPoint } = report;
  const hasEruv = eruvPoint !== null;
  const mapBlock = imageDataUrl
    ? `<img class="map" src="${imageDataUrl}" alt="Map of the techum, cities numbered" />`
    : `<p class="placeholder">The map snapshot could not be captured — open the
       calculation link above to view the map in the app.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Techum Shabbos Report</title>
<style>
  body {
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    max-width: 800px;
    margin: 24px auto;
    padding: 0 16px;
    color: #222;
    line-height: 1.45;
  }
  h1 { margin: 0 0 4px; }
  h2 { margin: 0 0 8px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  .meta { color: #555; margin: 2px 0; font-size: 14px; }
  section { margin: 24px 0; }
  img.map { max-width: 100%; height: auto; border: 1px solid #ccc; }
  .placeholder { border: 1px dashed #999; padding: 32px; text-align: center; color: #666; }
  .legend { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 13px; margin: 8px 0 4px; }
  .swatch { display: inline-block; width: 22px; vertical-align: middle; margin-right: 6px; }
  .dot {
    display: inline-block; width: 11px; height: 11px; border-radius: 50%;
    background: #e74c3c; border: 2px solid #c0392b; vertical-align: middle; margin-right: 6px;
  }
  .map-notes { color: #555; font-size: 13px; margin: 4px 0; }
  table { border-collapse: collapse; width: 100%; }
  td { border: 1px solid #ddd; padding: 6px 8px; text-align: left; font-size: 14px; vertical-align: top; }
  .step { margin: 14px 0; }
  .step h3 { margin: 0 0 4px; font-size: 15px; }
  ul.log, ul.warnings { margin: 4px 0; padding-left: 22px; font-size: 14px; }
  ul.warnings li { color: #935f00; }
  ul.disclaimers { padding-left: 22px; font-size: 13px; color: #555; }
  #print-btn { float: right; padding: 8px 14px; font-size: 14px; cursor: pointer; }
  a { color: #2980b9; word-break: break-all; }
  @media print {
    .no-print { display: none; }
    body { margin: 0 auto; }
    section, .step { break-inside: avoid; }
  }
  @page { margin: 1.5cm; }
</style>
</head>
<body>
  <button id="print-btn" class="no-print" type="button">Print / Save as PDF</button>
  <h1>Techum Shabbos Report</h1>
  <p class="meta">Generated ${esc(new Date().toLocaleString())}</p>
  ${point ? `<p class="meta">Start point: ${fmtPoint(point)}</p>` : ''}
  ${eruvPoint ? `<p class="meta">Eruv techumin at: ${fmtPoint(eruvPoint)} — the techum is measured from the eruv.</p>` : ''}
  <p class="meta">Amah length: ${esc(amahDescription(settings))}</p>
  <p class="meta">Open this calculation in the app: <a href="${esc(appUrl)}">${esc(appUrl)}</a></p>

  <section>
    ${mapBlock}
    ${legend(hasEruv)}
    <p class="map-notes">Numbered markers are the raw building clusters found in step 2;
      merged-city names like 1+3 combine those numbers. Dotted borders mark sides where
      the building data ran out — the real bounds may extend farther.</p>
  </section>

  <section>
    <h2>Halachic options</h2>
    <table>${optionRows(settings)}</table>
  </section>

  <section>
    <h2>Calculation steps</h2>
    ${stepSections(report.steps)}
  </section>

  <section>
    <h2>Disclaimers</h2>
    <ul class="disclaimers">${DISCLAIMERS.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>
  </section>
</body>
</html>`;
}
