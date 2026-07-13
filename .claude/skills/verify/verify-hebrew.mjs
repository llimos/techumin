/**
 * Headless verification of the Hebrew i18n feature:
 *  - default language from the browser locale (en vs he)
 *  - the En/ע toggle switches the sidebar, warnings, map controls, RTL dir
 *  - the choice persists in localStorage across reloads
 *  - the printable report renders in the selected language
 * Run: PORT=5173 node verify-hebrew.mjs
 */
import { chromium } from 'playwright-core';

const PORT = process.env.PORT ?? '5173';
const LAT = 31.72;
const LON = 34.68;

// Synthetic 3×2 grid of 10 m buildings with 5 m gaps → one city (≥ 6 buildings).
function syntheticCity() {
  const mLat = 1 / 110882;
  const mLon = 1 / 94787;
  const elements = [];
  let nodeId = 1;
  let wayId = 1000;
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 3; c++) {
      const x0 = (c - 1.5) * 15;
      const y0 = (r - 1) * 15;
      const ids = [];
      for (const [dx, dy] of [[0, 0], [10, 0], [10, 10], [0, 10]]) {
        elements.push({
          type: 'node',
          id: nodeId,
          lat: LAT + (y0 + dy) * mLat,
          lon: LON + (x0 + dx) * mLon,
        });
        ids.push(nodeId++);
      }
      elements.push({
        type: 'way',
        id: wayId++,
        nodes: [...ids, ids[0]],
        tags: { building: 'yes' },
      });
    }
  }
  return { version: 0.6, elements };
}

const osm = syntheticCity();
let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`);
  if (!ok) failures++;
}

async function newAppPage(context) {
  const page = await context.newPage();
  page.on('pageerror', (err) => check(`no page error (${err.message})`, false));
  await page.route('**/api/interpreter*', (route) => route.fulfill({ json: osm }));
  await page.goto(`http://localhost:${PORT}/?lat=${LAT}&lon=${LON}&debug=1`);
  await page.waitForSelector('#status');
  return page;
}

async function runPipeline(page) {
  await page.waitForTimeout(3000);
  const box = await page.locator('#map').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction(
    () => ['Done.', 'הסתיים.'].includes(document.querySelector('#status')?.textContent),
    null,
    { timeout: 300_000 },
  );
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });

// --- English-locale context: defaults to English, toggle to Hebrew ---
{
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await newAppPage(context);

  check(
    'defaults to English for an en-US browser',
    (await page.locator('#sidebar h2').first().textContent()) === 'Location',
  );
  check(
    'En segment is active by default',
    await page.locator('#lang-toggle button[data-lang="en"]').evaluate((b) => b.classList.contains('active')),
  );

  await runPipeline(page);
  check('pipeline finishes in English', (await page.textContent('#status')) === 'Done.');
  const enWarnings = await page.locator('#warnings li').allTextContents();
  check(
    'has English warnings after run',
    enWarnings.length > 0 && /[a-z]/i.test(enWarnings.join(' ')) && !/[֐-׿]/.test(enWarnings.join(' ')),
    enWarnings.join(' | '),
  );

  // Switch to Hebrew.
  await page.click('#lang-toggle button[data-lang="he"]');
  check('sidebar dir becomes rtl', (await page.getAttribute('#sidebar', 'dir')) === 'rtl');
  check('title stays Techum.app', (await page.textContent('#sidebar h1')) === 'Techum.app');
  check(
    'section headers in Hebrew',
    (await page.locator('#sidebar h2').first().textContent()) === 'מיקום',
  );
  check('status re-rendered in Hebrew', (await page.textContent('#status')) === 'הסתיים.');
  const heWarnings = await page.locator('#warnings li').allTextContents();
  check(
    'existing warnings re-render in Hebrew',
    heWarnings.length === enWarnings.length && /[֐-׿]/.test(heWarnings.join(' ')),
    heWarnings.join(' | '),
  );
  check(
    'eruv button in Hebrew',
    (await page.textContent('#eruv-btn')) === 'הנחת עירוב תחומין',
  );
  check(
    'language persisted to settings',
    await page.evaluate(() => JSON.parse(localStorage.getItem('techumin-settings')).language === 'he'),
  );

  // Map controls: layers overlay labels and the amot scale.
  const layerLabels = await page.locator('.leaflet-control-layers-overlays label').allTextContents();
  check(
    'layer control labels in Hebrew',
    layerLabels.some((l) => l.includes('גבול התחום')),
    layerLabels.join(' | '),
  );
  const scales = await page.locator('.leaflet-control-scale-line').allTextContents();
  check('amot scale bar in Hebrew', scales.some((s) => s.includes('אמות')), scales.join(' | '));
  check(
    'measure tool tooltip in Hebrew',
    (await page.getAttribute('.measure-toggle', 'title')) === 'מדידת מרחק',
  );

  // Printable report in Hebrew.
  const [reportPage] = await Promise.all([
    context.waitForEvent('page'),
    page.click('#report-btn'),
  ]);
  await reportPage.waitForSelector('#print-btn', { timeout: 60_000 });
  check('report html dir=rtl', (await reportPage.getAttribute('html', 'dir')) === 'rtl');
  check('report title in Hebrew', (await reportPage.textContent('h1')) === 'דו"ח תחום שבת');
  const reportBody = await reportPage.textContent('body');
  check('report steps in Hebrew', reportBody.includes('שלבי החישוב') && reportBody.includes('אורך האמה'));
  await reportPage.close();

  // Persists across reload; toggling back restores English.
  await page.reload();
  await page.waitForSelector('#status');
  check(
    'Hebrew persists across reload',
    (await page.getAttribute('#sidebar', 'dir')) === 'rtl' &&
      (await page.locator('#sidebar h2').first().textContent()) === 'מיקום',
  );
  await page.click('#lang-toggle button[data-lang="en"]');
  check(
    'toggling back to English works',
    (await page.getAttribute('#sidebar', 'dir')) === 'ltr' &&
      (await page.locator('#sidebar h2').first().textContent()) === 'Location',
  );
  await context.close();
}

// --- Hebrew-locale context: defaults to Hebrew ---
{
  const context = await browser.newContext({ locale: 'he-IL' });
  const page = await newAppPage(context);
  check(
    'defaults to Hebrew for a he-IL browser',
    (await page.getAttribute('#sidebar', 'dir')) === 'rtl' &&
      (await page.locator('#sidebar h2').first().textContent()) === 'מיקום',
  );
  check(
    'ע segment is active by default',
    await page.locator('#lang-toggle button[data-lang="he"]').evaluate((b) => b.classList.contains('active')),
  );
  await context.close();
}

await browser.close();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
