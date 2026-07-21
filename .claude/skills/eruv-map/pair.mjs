// Show the same ground feature side by side in the poster and the reference,
// each with its own pixel grid — how control points get read off accurately.
//
//   node .claude/skills/eruv-map/pair.mjs poster.png ref.png --align=align.json \
//        --at=1658,476 [--size=160] [--zoom=4] [--out=pair.png]
//   node .claude/skills/eruv-map/pair.mjs poster.png ref.png --a=x,y,w,h --b=x,y,w,h
//
// With --align the reference window is placed by the fitted alignment, so the
// same feature should appear in the middle of both panels; how far it is off
// centre in the right-hand panel is the alignment's local error.
import { openPage, dataUrl, writeDataUrl, args, parseCrop } from './lib/page.mjs';
import { readFileSync } from 'node:fs';

const { opts, rest } = args();
const [posterFile, refFile] = rest;
if (!posterFile || !refFile) {
  console.error('usage: pair.mjs poster.png ref.png (--align=a.json --at=x,y | --a=crop --b=crop)');
  process.exit(2);
}
const zoom = Number(opts.zoom || 4);
let a = parseCrop(opts.a);
let b = parseCrop(opts.b);
if (opts.align && opts.at) {
  const al = JSON.parse(readFileSync(opts.align, 'utf8'));
  const at = String(opts.at).split(',').map(Number);
  const size = Number(opts.size || 160);
  const th = (al.rotationDeg * Math.PI) / 180;
  const dx = at[0] - al.posterCentre[0];
  const dy = at[1] - al.posterCentre[1];
  const rx = al.refCentre[0] + al.scale * (Math.cos(th) * dx - Math.sin(th) * dy);
  const ry = al.refCentre[1] + al.scale * (Math.sin(th) * dx + Math.cos(th) * dy);
  const rs = size * al.scale;
  a = [at[0] - size / 2, at[1] - size / 2, size, size];
  b = [rx - rs / 2, ry - rs / 2, rs, rs];
}
if (!a || !b) {
  console.error('need --align + --at, or both --a and --b');
  process.exit(2);
}

const ctx = await openPage();
let png;
try {
  await ctx.page.evaluate(
    async ([x, y]) => {
      window.A = await window.CV.load(x);
      window.B = await window.CV.load(y);
    },
    [dataUrl(posterFile), dataUrl(refFile)],
  );
  png = await ctx.page.evaluate(
    (p) => {
      const panel = (img, crop, w) => {
        const r = window.CV.rect(img, crop);
        const cw = r.x1 - r.x0;
        const ch = r.y1 - r.y0;
        const s = w / cw;
        const src = document.createElement('canvas');
        src.width = img.width;
        src.height = img.height;
        src.getContext('2d').putImageData(img, 0, 0);
        const c = document.createElement('canvas');
        c.width = w;
        c.height = Math.round(ch * s);
        const g = c.getContext('2d');
        g.imageSmoothingEnabled = false;
        g.drawImage(src, r.x0, r.y0, cw, ch, 0, 0, c.width, c.height);
        const grid = Math.max(10, Math.round(cw / 8 / 10) * 10);
        g.font = '11px monospace';
        for (const [axis, from, to] of [
          ['x', r.x0, r.x1],
          ['y', r.y0, r.y1],
        ]) {
          for (let v = Math.ceil(from / grid) * grid; v < to; v += grid) {
            const q = (v - (axis === 'x' ? r.x0 : r.y0)) * s + 0.5;
            g.strokeStyle = 'rgba(255,0,255,0.5)';
            g.beginPath();
            if (axis === 'x') {
              g.moveTo(q, 0);
              g.lineTo(q, c.height);
            } else {
              g.moveTo(0, q);
              g.lineTo(c.width, q);
            }
            g.stroke();
            g.fillStyle = '#000';
            g.fillStyle = 'rgba(0,0,0,0.8)';
            if (axis === 'x') g.fillRect(q + 1, 0, 32, 13);
            else g.fillRect(0, q + 1, 32, 13);
            g.fillStyle = '#ff0';
            g.fillText(String(v), axis === 'x' ? q + 2 : 2, axis === 'x' ? 10 : q + 11);
          }
        }
        // centre cross-hair: the feature you asked about should sit here
        g.strokeStyle = '#0f0';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(c.width / 2, c.height / 2 - 12);
        g.lineTo(c.width / 2, c.height / 2 + 12);
        g.moveTo(c.width / 2 - 12, c.height / 2);
        g.lineTo(c.width / 2 + 12, c.height / 2);
        g.stroke();
        return c;
      };
      const w = Math.round(p.a[2] * p.zoom);
      const ca = panel(window.A, p.a, w);
      const cb = panel(window.B, p.b, w);
      const out = document.createElement('canvas');
      out.width = ca.width + cb.width + 12;
      out.height = Math.max(ca.height, cb.height) + 20;
      const g = out.getContext('2d');
      g.fillStyle = '#222';
      g.fillRect(0, 0, out.width, out.height);
      g.drawImage(ca, 0, 20);
      g.drawImage(cb, ca.width + 12, 20);
      g.fillStyle = '#fff';
      g.font = 'bold 13px sans-serif';
      g.fillText('poster', 4, 14);
      g.fillText('reference', ca.width + 16, 14);
      return out.toDataURL('image/png');
    },
    { a, b, zoom },
  );
} finally {
  await ctx.close();
}
const out = opts.out || 'pair.png';
writeDataUrl(out, png);
console.log(`${out} — poster ${a.map(Math.round)} | reference ${b.map(Math.round)}`);
