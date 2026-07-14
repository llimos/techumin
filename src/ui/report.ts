/**
 * Printable calculation report, opened in its own tab: a static snapshot of
 * the map with the cities numbered, the selected halachic options, and the
 * per-step calculation log — something to print off and show to a Rabbi.
 */

import type { ReportData } from '../pipeline';
import { AMAH_LABELS, SETTING_META, amahMeters, type Settings } from '../settings';
import { settingValueLabel } from '../settings';
import { dirOf, getLang, t, type LString } from '../i18n';
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
  thisRun: { en: 'For this calculation:', he: 'בחישוב זה:' },
  disclaimers: { en: 'Disclaimers', he: 'הבהרות' },
} as const;

/**
 * A plain-language account of what each pipeline step does, shown in the
 * report before that step's run-specific log. Paraphrased from the README,
 * with the geometric tolerances the code actually uses; purely technical
 * details (data services, caching) are left out. Indexed to match
 * report.steps (0-5 the core steps, 6-7 the eruv re-measure).
 */
interface StepDescription {
  intro: LString;
  points?: LString[];
}

const STEP_DESCRIPTIONS: StepDescription[] = [
  // 1. Fetch buildings
  {
    intro: {
      en:
        'All buildings inside a square around the chosen point are collected, and the ' +
        'building the point falls inside — if any — is identified. The square’s half-width is ' +
        'the data radius shown above. If buildings reach the edge of the loaded area, the city ' +
        'may continue beyond it, and a warning is shown.',
      he:
        'נאספים כל הבניינים שבתוך ריבוע סביב הנקודה שנבחרה, ומזוהה הבניין שבתוכו נמצאת הנקודה, ' +
        'אם ישנו. חצי רוחב הריבוע הוא רדיוס הנתונים המוצג למעלה. אם הבניינים מגיעים לקצה האזור ' +
        'שנטען, ייתכן שהעיר נמשכת מעברו, ומוצגת אזהרה.',
    },
  },
  // 2. Find cities
  {
    intro: { en: 'The buildings are grouped into halachic cities.', he: 'הבניינים מקובצים לערים הלכתיות.' },
    points: [
      {
        en:
          'Buildings separated by a gap of at most 70⅔ amot belong to the same city; the gaps ' +
          'between them are filled in so the cluster reads as one built-up area.',
        he:
          'בניינים שהמרווח ביניהם אינו עולה על 70⅔ אמה שייכים לאותה עיר; הרווחים שביניהם מתמלאים ' +
          'כך שהצבר נחשב לשטח בנוי אחד.',
      },
      {
        en: 'A cluster of fewer than 6 buildings does not count as a city and stays a standalone structure.',
        he: 'צבר של פחות מ־6 בניינים אינו נחשב לעיר ונשאר מבנה בודד.',
      },
    ],
  },
  // 3. Merge cities
  {
    intro: { en: 'Neighbouring cities are combined, in two passes:', he: 'ערים סמוכות מתאחדות, בשני שלבים:' },
    points: [
      {
        en:
          'Proximity: any two cities at most 141⅓ amot apart merge into one, repeated until ' +
          'nothing further merges.',
        he:
          'קרבה: כל שתי ערים המרוחקות זו מזו 141⅓ אמה לכל היותר מתאחדות לאחת, וחוזר חלילה עד שלא ' +
          'נותר מה לאחד.',
      },
      {
        en:
          'Triangle (ro’in) rule: given three cities A, B and C, if B is within 2000 amot of both ' +
          'A and C and the gap between A and C is at most 282⅔ amot plus B’s width, then A and C ' +
          'merge — B is regarded as if moved into the gap between them, so it need not actually ' +
          'stand between them. B must lie opposite the gap, and the rule does not apply if the ' +
          'straight line between A and C passes through a building of a third city.',
        he:
          'דין רואין: בשלוש ערים א, ב ו־ג — אם ב נמצאת בתוך 2000 אמה מכל אחת מ־א ו־ג, והרווח שבין ' +
          'א ל־ג אינו עולה על 282⅔ אמה בתוספת רוחבה של ב, מתאחדות א ו־ג. ב נחשבת כאילו הוזזה אל ' +
          'תוך הרווח שביניהן, ולכן אינה צריכה לעמוד ביניהן ממש. על ב לעמוד כנגד הרווח, והדין אינו ' +
          'חל אם הקו הישר שבין א ל־ג עובר דרך בניין של עיר שלישית.',
      },
    ],
  },
  // 4. Square the city
  {
    intro: {
      en:
        'Each city is enclosed in a rectangle (ribua ha’ir), whose angle sets the direction of ' +
        'the techum measurement. The angle is chosen by the first rule below that applies:',
      he:
        'כל עיר נסגרת במלבן (ריבוע העיר), וזווית המלבן קובעת את כיוון מדידת התחום. הזווית נקבעת ' +
        'לפי הכלל הראשון החל מבין הבאים:',
    },
    points: [
      {
        en:
          'Already oblong: if the city already fills a bounding rectangle at some angle, it is ' +
          'taken as squared at that angle. It counts as filling the rectangle when it covers at ' +
          'least 95% of the rectangle’s area, or when its outline nowhere reaches more than a ' +
          'small perceptual tolerance — about 2% of the shorter side, and at least 4 metres — ' +
          'inside the rectangle’s edges.',
        he:
          'כבר מלבני: אם העיר כבר ממלאת מלבן חוסם בזווית כלשהי, היא נחשבת מרובעת באותה זווית. היא ' +
          'נחשבת כממלאה את המלבן כאשר היא מכסה 95% לפחות משטח המלבן, או כאשר קו המתאר שלה אינו ' +
          'נכנס בשום מקום יותר מסטייה מזערית שאין העין מבחינה בה — כ־2% מהצלע הקצרה, ולפחות ' +
          '4 מטרים — מקצות המלבן.',
      },
      {
        en:
          'Straight side (Chazon Ish, configurable): when enabled, if one side of the city runs ' +
          'as a straight line for its whole length, the squaring is aligned to that side. The ' +
          'side must stay straight to within that same tolerance (about 2% of its length, at ' +
          'least 4 metres) and span at least 95% of the city’s length.',
        he:
          'צלע ישרה (חזון איש, ניתן לבחירה): כאשר האפשרות פעילה, אם צלע אחת של העיר ישרה לכל ' +
          'אורכה, הריבוע מיושר לפי אותה צלע. על הצלע להישאר ישרה בגבול אותה סטייה (כ־2% מאורכה, ' +
          'ולפחות 4 מטרים) ולהשתרע על 95% לפחות מאורך העיר.',
      },
      {
        en: 'Otherwise the city is squared true north–south.',
        he: 'אם לא — העיר מרובעת לפי צפון–דרום אמיתי.',
      },
      {
        en:
          'Keshet/gam exclusion: a deep concave bay in the outline is measured along its chord — ' +
          'the line between the two horns of the bow. A bay whose chord spans at least 4000 amot ' +
          'is cut out of the squaring. Configurable: whether it must also run more than 2000 amot ' +
          'deep, and whether to cut the whole bay or only the part still wider than 4000 amot.',
        he:
          'הוצאת קשת/גאם: מפרץ קעור עמוק בקו המתאר נמדד לאורך המיתר שלו — הקו שבין שתי קרני הקשת. ' +
          'מפרץ שמיתרו משתרע על 4000 אמה לפחות מוצא מן הריבוע. ניתן לבחירה: אם נדרש גם שיהיה עמוק ' +
          'יותר מ־2000 אמה, ואם להוציא את כל המפרץ או רק את החלק שעודנו רחב מ־4000 אמה.',
      },
      {
        en: 'Rema (configurable): add an extra 70⅔ amot around the squaring.',
        he: 'רמ"א (ניתן לבחירה): מוסיפים 70⅔ אמה סביב הריבוע.',
      },
    ],
  },
  // 5. Shvita bounds
  {
    intro: {
      en: 'The area the techum is measured from (the shvita) is fixed by where the point sits:',
      he: 'השטח שממנו נמדד התחום (השביתה) נקבע לפי מקום הנקודה:',
    },
    points: [
      {
        en:
          'Inside a city → that city’s squaring, at its angle. The squared-off corners of the ' +
          'ribua are only a measurement construct and do not themselves count as part of the city.',
        he:
          'בתוך עיר → ריבוע אותה עיר, בזוויתו. פינות הריבוע המרובעות הן רק אמצעי מדידה ואינן ' +
          'נחשבות כשלעצמן לחלק מן העיר.',
      },
      {
        en: 'Otherwise inside a building → the building’s north–south bounding rectangle.',
        he: 'אחרת, בתוך בניין → המלבן החוסם של הבניין לפי צפון–דרום.',
      },
      {
        en:
          'Otherwise, on open ground → a square of 4 amot around the point (configurable: 4 amot ' +
          'in each direction, or 4 amot in total).',
        he:
          'אחרת, בשטח פתוח → ריבוע של 4 אמות סביב הנקודה (ניתן לבחירה: 4 אמות לכל רוח, או 4 אמות ' +
          'בסך הכל).',
      },
    ],
  },
  // 6. Measure the techum
  {
    intro: {
      en:
        'From each corner of the shvita bounds, 2000 amot are measured outward along the two ' +
        'axes of the recorded angle.',
      he:
        'מכל פינה של גבולות השביתה נמדדות 2000 אמה כלפי חוץ, לאורך שני הצירים של הזווית שנקבעה.',
    },
    points: [
      {
        en:
          'Gradient rule: each line follows the ground, with the elevation sampled every 50 amot ' +
          '(a rope’s length). Ground gentler than a 1:3.6 slope is measured along the surface; ' +
          'steeper ground is measured as the crow flies — unless it descends to more than 2000 ' +
          'amot below the start, in which case it too is measured along the surface.',
        he:
          'דין המדרון: כל קו הולך לפי פני הקרקע, כאשר הגובה נדגם כל 50 אמה (אורך חבל). קרקע ' +
          'ששיפועה מתון מ־1:3.6 נמדדת לאורך פני השטח; קרקע תלולה יותר נמדדת באוויר — אלא אם היא ' +
          'יורדת ליותר מ־2000 אמה מתחת לנקודת ההתחלה, ואז גם היא נמדדת לאורך פני השטח.',
      },
      {
        en:
          'Joining the sides: the four sides are joined and extended until they meet, so the ' +
          'techum has full squared corners. Where two lines in the same direction come out ' +
          'unequal, configurable: extend the shorter to match the longer, or join their ends on ' +
          'a diagonal.',
        he:
          'חיבור הצלעות: ארבע הצלעות מחוברות ומוארכות עד שהן נפגשות, כך שלתחום פינות מרובעות ' +
          'שלמות. היכן ששני קווים באותו כיוון יוצאים לא שווים, ניתן לבחירה: מאריכים את הקצר עד ' +
          'לארוך, או מחברים את קצותיהם באלכסון.',
      },
      {
        en:
          'Havla’ah (swallowed cities): a whole city that lies inside the measured techum is ' +
          '“swallowed” — its length counts as only 4 amot, so the techum reaches past it by its ' +
          'length less 4 amot. A swallowed city wider than the techum can also push it out ' +
          'sideways, level with the city. How far, in each case, is configurable (see the ' +
          'options above).',
        he:
          'הבלעה (ערים מובלעות): עיר שלמה הנמצאת בתוך התחום הנמדד "מובלעת" — אורכה נחשב כ־4 אמות ' +
          'בלבד, וכך התחום נמשך מעברה כאורכה פחות 4 אמות. עיר מובלעת הרחבה מן התחום עשויה גם לדחוף ' +
          'אותו לצדדים, כנגד העיר. עד כמה, בכל מקרה, ניתן לבחירה (ראו האפשרויות למעלה).',
      },
    ],
  },
  // 7. Shvita bounds (from the eruv)
  {
    intro: {
      en:
        'An eruv techumin has been placed, so the shvita is taken from the eruv’s location ' +
        'instead of the start point. Its bounds are found exactly as in step 5 — the city’s ' +
        'squaring if the eruv is in a city, the building if in a building, otherwise 4 amot.',
      he:
        'הונח עירוב תחומין, ולכן השביתה נלקחת ממקום העירוב במקום מנקודת המוצא. גבולותיה נקבעים ' +
        'בדיוק כמו בשלב 5 — ריבוע העיר אם העירוב בעיר, הבניין אם בבניין, ואם לאו 4 אמות.',
    },
  },
  // 8. Measure the techum (from the eruv)
  {
    intro: {
      en: 'The techum is measured afresh from the eruv’s shvita bounds, by the same rule as step 6.',
      he: 'התחום נמדד מחדש מגבולות השביתה של העירוב, לפי אותו כלל של שלב 6.',
    },
  },
];

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

function describe(desc: StepDescription | undefined): string {
  if (!desc) return '';
  const intro = `<p class="desc">${esc(t(desc.intro))}</p>`;
  const points = desc.points?.length
    ? `<ul class="desc">${desc.points.map((p) => `<li>${esc(t(p))}</li>`).join('')}</ul>`
    : '';
  return intro + points;
}

function stepSections(report: ReportData): string {
  const hasEruv = report.eruvPoint !== null;
  return report.steps
    .map((s, i) => {
      // The core steps (0-5) always ran when there is a calculation, so their
      // description is shown even without a step-specific log; the eruv steps
      // (6-7) only apply — and only appear — when an eruv has been placed.
      const isEruvStep = i >= 6;
      if (isEruvStep ? !hasEruv : !report.point) return '';
      const desc = describe(STEP_DESCRIPTIONS[i]);
      const hasData = s.logs.length > 0 || s.warnings.length > 0;
      if (!desc && !hasData) return '';
      return `
      <div class="step">
        <h3>${esc(t(s.title))}</h3>
        ${desc}
        ${s.logs.length ? `<p class="run-label">${esc(t(TXT.thisRun))}</p><ul class="log">${s.logs.map((l) => `<li>${esc(t(l))}</li>`).join('')}</ul>` : ''}
        ${s.warnings.length ? `<ul class="warnings">${s.warnings.map((w) => `<li>${esc(t(w))}</li>`).join('')}</ul>` : ''}
      </div>`;
    })
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
  /* Palette mirrors the app's design tokens in src/style.css — keep in sync. */
  :root {
    --ink: #2c3e50;
    --accent: #16a085;
    --accent-hover: #12886f;
    --link: #2563a8;
    --warning: #935f00;
    --surface: #ffffff;
    --border: #e4e7ea;
    --border-strong: #c7ccd2;
    --text: #263238;
    --text-muted: #5a6570;
    --text-subtle: #8a929b;
    --radius-sm: 6px;
  }
  body {
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    max-width: 800px;
    margin: 24px auto;
    padding: 0 16px;
    color: var(--text);
    line-height: 1.45;
  }
  h1 { margin: 0 0 4px; color: var(--ink); }
  h2 { margin: 0 0 8px; border-bottom: 1px solid var(--border); padding-bottom: 4px; }
  .meta { color: var(--text-muted); margin: 2px 0; font-size: 14px; }
  section { margin: 24px 0; }
  img.map { max-width: 100%; height: auto; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); }
  .placeholder { border: 1px dashed var(--border-strong); border-radius: var(--radius-sm); padding: 32px; text-align: center; color: var(--text-muted); }
  .legend { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 13px; margin: 8px 0 4px; }
  .swatch { display: inline-block; width: 22px; vertical-align: middle; margin-inline-end: 6px; }
  .dot {
    display: inline-block; width: 11px; height: 11px; border-radius: 50%;
    background: #e74c3c; border: 2px solid #c0392b; vertical-align: middle; margin-inline-end: 6px;
  }
  .map-notes { color: var(--text-muted); font-size: 13px; margin: 4px 0; }
  table { border-collapse: collapse; width: 100%; }
  td { border: 1px solid var(--border); padding: 6px 8px; text-align: start; font-size: 14px; vertical-align: top; }
  .step { margin: 14px 0; }
  .step h3 { margin: 0 0 4px; font-size: 15px; color: var(--ink); }
  p.desc { margin: 4px 0; font-size: 14px; color: var(--text); }
  ul.desc { margin: 4px 0; padding-inline-start: 22px; font-size: 14px; color: var(--text); }
  ul.desc li { margin: 2px 0; }
  .run-label { margin: 8px 0 2px; font-size: 13px; font-weight: 600; color: var(--text-muted); }
  ul.log, ul.warnings { margin: 4px 0; padding-inline-start: 22px; font-size: 14px; }
  ul.warnings li { color: var(--warning); }
  ul.disclaimers { padding-inline-start: 22px; font-size: 13px; color: var(--text-muted); }
  #print-btn {
    float: inline-end;
    padding: 8px 14px;
    font-size: 14px;
    font-weight: 600;
    color: #fff;
    background: var(--accent);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  #print-btn:hover { background: var(--accent-hover); }
  a { color: var(--link); word-break: break-all; }
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
    ${stepSections(report)}
  </section>

  <section>
    <h2>${esc(t(TXT.disclaimers))}</h2>
    <ul class="disclaimers">${DISCLAIMERS.map((d) => `<li>${esc(t(d.text))}</li>`).join('')}</ul>
  </section>
</body>
</html>`;
}
