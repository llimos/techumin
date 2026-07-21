// Report the saturated-colour clusters in a map image, so the eruv colours are
// picked from the data instead of guessed.
//   node .claude/skills/eruv-map/palette.mjs poster.png [--crop=x,y,w,h]
//                                            [--bin=10] [--top=12] [--out=palette.png]
import { withImage, writeDataUrl, args, parseCrop } from './lib/page.mjs';

const { opts, rest } = args();
const file = rest[0];
if (!file) {
  console.error('usage: palette.mjs <image> [--crop=x,y,w,h] [--bin=deg] [--top=n] [--out=png]');
  process.exit(2);
}
const crop = parseCrop(opts.crop);

const res = await withImage(
  file,
  ({ crop, bin, sMin, top }) => {
    const { total, bins } = window.CV.histogram(window.IMG, { crop, bin, sMin });
    const shown = bins.slice(0, top);
    // Swatch strip: one block per cluster, widest first.
    const c = document.createElement('canvas');
    c.width = 80 * Math.max(1, shown.length);
    c.height = 100;
    const g = c.getContext('2d');
    g.fillStyle = '#111';
    g.fillRect(0, 0, c.width, c.height);
    shown.forEach((b, i) => {
      g.fillStyle = b.hex;
      g.fillRect(i * 80 + 5, 5, 70, 60);
      g.fillStyle = '#fff';
      g.font = '12px sans-serif';
      g.fillText(`h${Math.round(b.hue)}`, i * 80 + 8, 82);
      g.fillText(b.pct.toFixed(2) + '%', i * 80 + 8, 96);
    });
    return {
      total,
      size: [window.IMG.width, window.IMG.height],
      bins: shown,
      png: c.toDataURL('image/png'),
    };
  },
  { crop, bin: Number(opts.bin) || 10, sMin: Number(opts.sMin) || 0.3, top: Number(opts.top) || 12 },
);

console.log(`image ${res.size[0]}x${res.size[1]}, ${res.total} px in crop`);
console.log('hue   hex      pixels    % of crop');
for (const b of res.bins) {
  console.log(
    `${String(Math.round(b.hue)).padStart(3)}   ${b.hex}  ${String(b.count).padStart(8)}  ${b.pct.toFixed(3)}`,
  );
}
const out = opts.out || 'palette.png';
writeDataUrl(out, res.png);
console.log(`swatches → ${out}`);
