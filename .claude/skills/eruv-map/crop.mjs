// Zoom into part of an image with a labelled pixel grid, so control-point
// coordinates can be read off accurately instead of eyeballed at full size.
//   node .claude/skills/eruv-map/crop.mjs img.png --crop=x,y,w,h [--zoom=3]
//        [--grid=50] [--out=crop.png]
// Grid labels are in the ORIGINAL image's pixel coordinates.
import { withImage, writeDataUrl, args, parseCrop } from './lib/page.mjs';

const { opts, rest } = args();
const file = rest[0];
const crop = parseCrop(opts.crop);
if (!file || !crop) {
  console.error('usage: crop.mjs <image> --crop=x,y,w,h [--zoom=3] [--grid=50] [--out=png]');
  process.exit(2);
}

const res = await withImage(
  file,
  ({ crop, zoom, grid }) => {
    const img = window.IMG;
    const { x0, y0, x1, y1 } = window.CV.rect(img, crop);
    const w = x1 - x0;
    const h = y1 - y0;
    const src = document.createElement('canvas');
    src.width = img.width;
    src.height = img.height;
    src.getContext('2d').putImageData(img, 0, 0);

    const c = document.createElement('canvas');
    c.width = w * zoom;
    c.height = h * zoom;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(src, x0, y0, w, h, 0, 0, c.width, c.height);

    g.font = '11px monospace';
    g.lineWidth = 1;
    const first = (v) => Math.ceil(v / grid) * grid;
    for (let x = first(x0); x < x1; x += grid) {
      const px = (x - x0) * zoom + 0.5;
      g.strokeStyle = 'rgba(255,0,255,0.55)';
      g.beginPath();
      g.moveTo(px, 0);
      g.lineTo(px, c.height);
      g.stroke();
      g.fillStyle = '#000';
      g.fillRect(px + 1, 0, 34, 13);
      g.fillStyle = '#ff0';
      g.fillText(String(x), px + 2, 10);
    }
    for (let y = first(y0); y < y1; y += grid) {
      const py = (y - y0) * zoom + 0.5;
      g.strokeStyle = 'rgba(255,0,255,0.55)';
      g.beginPath();
      g.moveTo(0, py);
      g.lineTo(c.width, py);
      g.stroke();
      g.fillStyle = '#000';
      g.fillRect(0, py + 1, 34, 13);
      g.fillStyle = '#ff0';
      g.fillText(String(y), 2, py + 11);
    }
    return { png: c.toDataURL('image/png'), size: [c.width, c.height] };
  },
  { crop, zoom: Number(opts.zoom) || 3, grid: Number(opts.grid) || 50 },
);

const out = opts.out || 'crop.png';
writeDataUrl(out, res.png);
console.log(`${out} — ${res.size[0]}x${res.size[1]}, grid labels in original pixels`);
