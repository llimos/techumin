// Headless Edge as an image-processing runtime: no image library is installed
// on this machine, but a browser decodes PNG/JPEG/WebP and gives raw pixels
// through <canvas>. Every heavy loop runs inside the page (lib/cv.js) — only
// small JSON results and finished PNGs cross back over CDP.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export function dataUrl(file) {
  const ext = extname(file).toLowerCase();
  const mime = MIME[ext] || 'image/png';
  return `data:${mime};base64,${readFileSync(file).toString('base64')}`;
}

/** Open a page with lib/cv.js injected. Caller must call close(). */
export async function openPage({ width = 1280, height = 900 } = {}) {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('[page]', m.text());
  });
  await page.goto('about:blank');
  await page.addScriptTag({ path: resolve(HERE, 'cv.js') });
  return { browser, page, close: () => browser.close() };
}

/**
 * Load `file` into the page as `window.IMG` (an ImageData), then run `fn`
 * there with `arg`. Returns whatever `fn` returns.
 */
export async function withImage(file, fn, arg) {
  const ctx = await openPage();
  try {
    await ctx.page.evaluate(async (url) => {
      window.IMG = await window.CV.load(url);
    }, dataUrl(file));
    return await ctx.page.evaluate(fn, arg);
  } finally {
    await ctx.close();
  }
}

/** Write a base64 data URL produced in the page (canvas.toDataURL) to disk. */
export function writeDataUrl(file, url) {
  writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
  return file;
}

/** --key=value / --flag argv parsing shared by the scripts. */
export function args(argv = process.argv.slice(2)) {
  const opts = {};
  const rest = [];
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      opts[k] = v === undefined ? true : v;
    } else rest.push(a);
  }
  return { opts, rest };
}

/** "x,y,w,h" → [x,y,w,h]; undefined → null (whole image). */
export function parseCrop(s) {
  if (!s || s === true) return null;
  const n = String(s).split(',').map(Number);
  if (n.length !== 4 || n.some(Number.isNaN)) throw new Error(`bad --crop: ${s}`);
  return n;
}
