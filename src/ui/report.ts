/**
 * Printable calculation report, opened in its own tab: a static snapshot of
 * the map with the cities numbered, the selected halachic options, and the
 * per-step calculation log — something to print off and show to a Rabbi.
 */

import type { ReportData, ReportStep } from '../pipeline';
import { AMAH_LABELS, SETTING_META, amahMeters, type Settings } from '../settings';
import { settingValueLabel } from '../settings';
import { dirOf, getLang, t } from '../i18n';
import type { LatLon } from '../types';
import { DISCLAIMERS } from './sidebar';

export interface ReportInput {
  report: ReportData;
  /** PNG data URL of the map snapshot, or null when the capture failed. */
  imageDataUrl: string | null;
  /** Shareable app URL reproducing this calculation. */
  appUrl: string;
}

const TXT = {
  title: { en: 'Techum Shabbos Report', he: 'דו"ח תחום שבת' },
  preparing: { en: 'Preparing report…', he: 'מכין דו"ח…' },
  print: { en: 'Print / Save as PDF', he: 'הדפסה / שמירה כ־PDF' },
  generated: { en: 'Generated', he: 'הופק' },
  startPoint: { en: 'Start point:', he: 'נקודת מוצא:' },
  eruvAt: { en: 'Eruv techumin at:', he: 'עירוב תחומין ב:' },
  measuredFromEruv: {
    en: 'the techum is measured from the eruv.',
    he: 'התחום נמדד מן העירוב.',
  },
  amahLength: { en: 'Amah length:', he: 'אורך האמה:' },
  openInApp: { en: 'Open this calculation in the app:', he: 'פתיחת חישוב זה באפליקציה:' },
  mapAlt: { en: 'Map of the techum, cities numbered', he: 'מפת התחום, הערים ממוספרות' },
  captureFailed: {
    en: 'The map snapshot could not be captured — open the calculation link above to view the map in the app.',
    he: 'לא ניתן היה לצלם את המפה — פתחו את קישור החישוב שלמעלה כדי לצפות במפה באפליקציה.',
  },
  mapNotes: {
    en:
      'Numbered markers are the raw building clusters found in step 2; ' +
      'merged-city names like 1+3 combine those numbers. Dotted borders mark sides where ' +
      'the building data ran out — the real bounds may extend farther.',
    he:
      'הסמנים הממוספרים הם צברי הבניינים הגולמיים שנמצאו בשלב 2; ' +
      'שמות ערים מאוחדות כגון 1+3 מצרפים את המספרים הללו. גבולות מקווקווים מסמנים צדדים ' +
      'שבהם נגמרו נתוני הבניינים — הגבולות האמיתיים עשויים להימשך הלאה.',
  },
  legendMerged: { en: 'Merged cities', he: 'ערים מאוחדות' },
  legendSquaring: { en: 'Squaring (ribua)', he: 'ריבוע' },
  legendKeshet: { en: 'Keshet/gam exclusion', he: 'הוצאת קשת/גאם' },
  legendShvisa: { en: 'Shvisa bounds', he: 'גבולות השביתה' },
  legendTechumEruv: { en: 'Techum (from the eruv)', he: 'תחום (מן העירוב)' },
  legendTechum: { en: 'Techum boundary', he: 'גבול התחום' },
  legendStart: { en: 'Start point', he: 'נקודת מוצא' },
  legendEruv: { en: 'Eruv techumin', he: 'עירוב תחומין' },
  options: { en: 'Halachic options', he: 'שיטות הלכתיות' },
  nonHalachic: { en: '(non-halachic)', he: '(לא הלכתי)' },
  steps: { en: 'Calculation steps', he: 'שלבי החישוב' },
  disclaimers: { en: 'Disclaimers', he: 'הבהרות' },
} as const;

/**
 * Open the report tab immediately (synchronously, inside the click, so popup
 * blockers allow it) with a placeholder; returns null when blocked.
 */
export function openReportWindow(): Window | null {
  const win = window.open('', '_blank');
  if (win) {
    win.document.write(
      `<title>${esc(t(TXT.title))}</title>` +
        `<p dir="${dirOf(getLang())}" style="font-family: system-ui, sans-serif; margin: 24px">${esc(t(TXT.preparing))}</p>`,
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
  const label = t(AMAH_LABELS[settings.amahPreset]);
  return settings.amahPreset === 'custom'
    ? `${label} (${(amahMeters(settings) * 100).toFixed(1)} ${t({ en: 'cm', he: 'ס"מ' })})`
    : label;
}

function optionRows(settings: Settings): string {
  return SETTING_META.filter(
    (m) => m.key !== 'customAmahCm' || settings.amahPreset === 'custom',
  )
    .map((m) => {
      const label =
        m.key === 'fetchRadiusM' ? `${t(m.label)} ${t(TXT.nonHalachic)}` : t(m.label);
      return `<tr><td>${esc(label)}</td><td>${esc(settingValueLabel(m, settings))}</td></tr>`;
    })
    .join('');
}

function legend(hasEruv: boolean): string {
  const line = (color: string, style: string, text: string): string =>
    `<span><span class="swatch" style="border-top: 3px ${style} ${color}"></span>${esc(text)}</span>`;
  const items = [
    line('#d35400', 'solid', t(TXT.legendMerged)),
    line('#8e44ad', 'dashed', t(TXT.legendSquaring)),
    line('#c0392b', 'dotted', t(TXT.legendKeshet)),
    line(hasEruv ? '#8e44ad' : '#2980b9', 'solid', t(TXT.legendShvisa)),
    line(
      hasEruv ? '#8e44ad' : '#27ae60',
      'solid',
      t(hasEruv ? TXT.legendTechumEruv : TXT.legendTechum),
    ),
    `<span><span class="dot"></span>${esc(t(TXT.legendStart))}</span>`,
  ];
  if (hasEruv) items.push(`<span>🍞 ${esc(t(TXT.legendEruv))}</span>`);
  return `<p class="legend">${items.join('')}</p>`;
}

function stepSections(steps: ReportStep[]): string {
  return steps
    .filter((s) => s.logs.length > 0 || s.warnings.length > 0)
    .map(
      (s) => `
      <div class="step">
        <h3>${esc(t(s.title))}</h3>
        ${s.logs.length ? `<ul class="log">${s.logs.map((l) => `<li>${esc(t(l))}</li>`).join('')}</ul>` : ''}
        ${s.warnings.length ? `<ul class="warnings">${s.warnings.map((w) => `<li>${esc(t(w))}</li>`).join('')}</ul>` : ''}
      </div>`,
    )
    .join('');
}

function reportHtml({ report, imageDataUrl, appUrl }: ReportInput): string {
  const { settings, point, eruvPoint } = report;
  const hasEruv = eruvPoint !== null;
  const lang = getLang();
  const mapBlock = imageDataUrl
    ? `<img class="map" src="${imageDataUrl}" alt="${esc(t(TXT.mapAlt))}" />`
    : `<p class="placeholder">${esc(t(TXT.captureFailed))}</p>`;
  const generatedAt = new Date().toLocaleString(lang === 'he' ? 'he-IL' : undefined);

  return `<!doctype html>
<html lang="${lang}" dir="${dirOf(lang)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(t(TXT.title))}</title>
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
  .swatch { display: inline-block; width: 22px; vertical-align: middle; margin-inline-end: 6px; }
  .dot {
    display: inline-block; width: 11px; height: 11px; border-radius: 50%;
    background: #e74c3c; border: 2px solid #c0392b; vertical-align: middle; margin-inline-end: 6px;
  }
  .map-notes { color: #555; font-size: 13px; margin: 4px 0; }
  table { border-collapse: collapse; width: 100%; }
  td { border: 1px solid #ddd; padding: 6px 8px; text-align: start; font-size: 14px; vertical-align: top; }
  .step { margin: 14px 0; }
  .step h3 { margin: 0 0 4px; font-size: 15px; }
  ul.log, ul.warnings { margin: 4px 0; padding-inline-start: 22px; font-size: 14px; }
  ul.warnings li { color: #935f00; }
  ul.disclaimers { padding-inline-start: 22px; font-size: 13px; color: #555; }
  #print-btn { float: inline-end; padding: 8px 14px; font-size: 14px; cursor: pointer; }
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
  <button id="print-btn" class="no-print" type="button">${esc(t(TXT.print))}</button>
  <h1>${esc(t(TXT.title))}</h1>
  <p class="meta">${esc(t(TXT.generated))} ${esc(generatedAt)}</p>
  ${point ? `<p class="meta">${esc(t(TXT.startPoint))} ${fmtPoint(point)}</p>` : ''}
  ${eruvPoint ? `<p class="meta">${esc(t(TXT.eruvAt))} ${fmtPoint(eruvPoint)} — ${esc(t(TXT.measuredFromEruv))}</p>` : ''}
  <p class="meta">${esc(t(TXT.amahLength))} ${esc(amahDescription(settings))}</p>
  <p class="meta">${esc(t(TXT.openInApp))} <a href="${esc(appUrl)}">${esc(appUrl)}</a></p>

  <section>
    ${mapBlock}
    ${legend(hasEruv)}
    <p class="map-notes">${esc(t(TXT.mapNotes))}</p>
  </section>

  <section>
    <h2>${esc(t(TXT.options))}</h2>
    <table>${optionRows(settings)}</table>
  </section>

  <section>
    <h2>${esc(t(TXT.steps))}</h2>
    ${stepSections(report.steps)}
  </section>

  <section>
    <h2>${esc(t(TXT.disclaimers))}</h2>
    <ul class="disclaimers">${DISCLAIMERS.map((d) => `<li>${esc(t(d.text))}</li>`).join('')}</ul>
  </section>
</body>
</html>`;
}
