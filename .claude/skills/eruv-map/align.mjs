// Register the poster's map against the reference render automatically, by
// correlating road-edge gradients over scale, rotation and translation. This
// is what turns "somewhere around this coordinate" into a real transform;
// control points then only have to confirm or refine it.
//
//   node .claude/skills/eruv-map/align.mjs poster.png ref.png --crop=x,y,w,h \
//        [--scale=0.5,1.4] [--rot=-25,25] [--out=align.json] [--check=align-check.png]
//
// --scale is poster pixels measured in reference pixels (so ref m/px × scale
// = poster m/px). Widen the ranges if the score comes out low.
//
// --mask=none keeps the saturated and near-white pixels in the match. Use it
// for a DRAWN map against an OSM reference, where the white streets are the
// signal; the default masks them out, which is right for a satellite poster
// where they are ink painted over the photo.
import { writeFileSync } from 'node:fs';
import { openPage, dataUrl, writeDataUrl, args, parseCrop } from './lib/page.mjs';

const { opts, rest } = args();
const [posterFile, refFile] = rest;
if (!posterFile || !refFile) {
  console.error('usage: align.mjs poster.png ref.png [--crop=x,y,w,h] [--scale=lo,hi] [--rot=lo,hi]');
  process.exit(2);
}
const crop = parseCrop(opts.crop);
const [sLo, sHi] = String(opts.scale || '0.5,1.4').split(',').map(Number);
const [rLo, rHi] = String(opts.rot || '-25,25').split(',').map(Number);

const ctx = await openPage();
let res;
try {
  await ctx.page.evaluate(
    async ([a, b]) => {
      window.POSTER = await window.CV.load(a);
      window.REF = await window.CV.load(b);
    },
    [dataUrl(posterFile), dataUrl(refFile)],
  );
  res = await ctx.page.evaluate((p) => {
    const CV = window.CV;
    const LEVELS = 4; // 0 = full res … 4 = 1/16
    const pp = CV.gradPyramid(window.POSTER, p.crop, LEVELS, { maskDrawn: p.maskDrawn });
    const rp = CV.gradPyramid(window.REF, null, LEVELS);

    // Coarse: whole search space at 1/16.
    let L = LEVELS;
    let pts = CV.samples(pp[L], 14);
    let pc = [pp[L].w / 2, pp[L].h / 2];
    let best = { score: -1 };
    const rot = (deg) => (deg * Math.PI) / 180;
    for (let s = p.sLo; s <= p.sHi + 1e-9; s *= 1.04) {
      for (let th = p.rLo; th <= p.rHi + 1e-9; th += 2) {
        for (let ty = 0; ty < rp[L].h; ty += 1) {
          for (let tx = 0; tx < rp[L].w; tx += 1) {
            const sc = CV.score(pts, pc, rp[L], s, rot(th), tx, ty);
            if (sc > best.score) best = { score: sc, s, th, tx, ty, level: L };
          }
        }
      }
    }

    // Refine down the pyramid: each step doubles resolution, so the previous
    // translation doubles too and the window shrinks.
    for (L = LEVELS - 1; L >= 0; L--) {
      pts = CV.samples(pp[L], L >= 2 ? 22 : 30);
      pc = [pp[L].w / 2, pp[L].h / 2];
      const base = { s: best.s, th: best.th, tx: best.tx * 2, ty: best.ty * 2 };
      let b2 = { score: -1 };
      const dS = 0.03 / (LEVELS - L);
      const dTh = 2 / (LEVELS - L);
      for (let s = base.s * (1 - dS); s <= base.s * (1 + dS); s += base.s * dS * 0.25) {
        for (let th = base.th - dTh; th <= base.th + dTh + 1e-9; th += dTh / 4) {
          for (let ty = base.ty - 6; ty <= base.ty + 6; ty++) {
            for (let tx = base.tx - 6; tx <= base.tx + 6; tx++) {
              const sc = CV.score(pts, pc, rp[L], s, rot(th), tx, ty);
              if (sc > b2.score) b2 = { score: sc, s, th, tx, ty, level: L };
            }
          }
        }
      }
      best = b2;
    }

    // Express the result in FULL-image pixels of both images.
    const step = 1 << best.level;
    const org = pp[best.level].origin;
    const posterCentreFull = [
      org[0] + (pp[best.level].w / 2) * step,
      org[1] + (pp[best.level].h / 2) * step,
    ];
    const refCentreFull = [best.tx * step, best.ty * step];
    return {
      score: best.score,
      scale: best.s,
      rotationDeg: best.th,
      posterCentre: posterCentreFull,
      refCentre: refCentreFull,
      crop: p.crop,
    };
  }, { crop, sLo, sHi, rLo, rHi, maskDrawn: opts.mask !== 'none' });

  // Visual check: the poster's map warped onto the reference, half opacity.
  if (opts.check !== 'no') {
    const png = await ctx.page.evaluate((a) => {
      const c = document.createElement('canvas');
      c.width = window.REF.width;
      c.height = window.REF.height;
      const g = c.getContext('2d');
      g.putImageData(window.REF, 0, 0);
      const src = document.createElement('canvas');
      src.width = window.POSTER.width;
      src.height = window.POSTER.height;
      src.getContext('2d').putImageData(window.POSTER, 0, 0);
      const th = (a.rotationDeg * Math.PI) / 180;
      const co = a.scale * Math.cos(th);
      const si = a.scale * Math.sin(th);
      g.globalAlpha = 0.5;
      g.setTransform(co, si, -si, co, a.refCentre[0], a.refCentre[1]);
      g.drawImage(src, -a.posterCentre[0], -a.posterCentre[1]);
      g.setTransform(1, 0, 0, 1, 0, 0);
      return c.toDataURL('image/png');
    }, res);
    writeDataUrl(opts.check && opts.check !== true ? opts.check : 'align-check.png', png);
  }
} finally {
  await ctx.close();
}

const out = opts.out || 'align.json';
writeFileSync(out, JSON.stringify(res, null, 1));
console.log(
  `score ${res.score.toFixed(3)} — scale ${res.scale.toFixed(4)} ref-px/poster-px, rotation ${res.rotationDeg.toFixed(2)}°`,
);
console.log(
  `poster ${res.posterCentre.map(Math.round).join(',')} → ref ${res.refCentre.map(Math.round).join(',')}`,
);
console.log(`→ ${out}${opts.check === 'no' ? '' : ' + align-check overlay'}`);
console.log('Check the overlay: roads must line up. Score < ~0.3 means the fit is junk.');
