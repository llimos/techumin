// Trace eruv areas out of a map image and emit pixel-space polygons.
//
//   node .claude/skills/eruv-map/trace.mjs poster.png --crop=x,y,w,h \
//        --colours=colours.json [--mode=outline|fill] [--out=traces.json]
//        [--debug=trace-debug.png]
//
// colours.json: [{ "name": "yellow", "hue": 52, "dHue": 18, "sMin": 0.45,
//                  "lMin": 0.25, "lMax": 0.85 }, ...]
// or --hues=52,0,190 for quick defaults.
//
// --mode=outline (default) — the eruvin are DRAWN AS LINES over a photo.
//   Union all eruv colours into one stroke mask, dilate it to bridge the gaps
//   where labels and clutter cut the lines, then take the ENCLOSED regions of
//   the non-stroke pixels. Each enclosed region is one eruv area, so an eruv
//   whose line is only closed by its neighbour's line still comes out, and a
//   shared street wall is recognised as an adjacency.
//     --dilate=3      gap bridging, px
//     --minStroke=60  drop mask blobs whose bbox diagonal is smaller (roofs)
//     --edges=closed  treat the map frame as a wall, for clipped eruvin
//     --by=colour     trace each colour separately, for nested boundaries
//
// --mode=fill — the eruvin are FILLED AREAS on a drawn street map. Each
//   colour is masked on its own, closed to swallow the streets, text and
//   building outlines printed on top of it, and its connected regions traced.
//     --close=4       closing radius, px
import { readFileSync, writeFileSync } from 'node:fs';
import { withImage, writeDataUrl, args, parseCrop } from './lib/page.mjs';

const { opts, rest } = args();
const file = rest[0];
const crop = parseCrop(opts.crop);
if (!file) {
  console.error('usage: trace.mjs <image> [--crop=x,y,w,h] --colours=colours.json [--mode=outline|fill]');
  process.exit(2);
}

let colours;
if (opts.colours) colours = JSON.parse(readFileSync(opts.colours, 'utf8'));
else if (opts.hues)
  colours = String(opts.hues)
    .split(',')
    .map((h) => ({ name: `h${h}`, hue: Number(h) }));
else {
  console.error('need --colours=file.json or --hues=52,0,190');
  process.exit(2);
}

const mode = opts.mode || 'outline';
const params = {
  crop,
  colours,
  mode,
  dilate: Number(opts.dilate ?? 3),
  closeR: Number(opts.close ?? 4),
  minAreaFrac: Number(opts.minArea ?? 0.002),
  simplify: Number(opts.simplify ?? 1.5),
  maxPairPx: Number(opts.maxPair ?? 30),
  minStrokeDiag: Number(opts.minStroke ?? 60),
  closedEdges: opts.edges === 'closed',
  byColour: opts.by === 'colour' || opts.by === 'color',
  holes: opts.holes !== undefined && opts.holes !== 'no',
  holeMinAreaFrac: Number(opts.holeMinArea ?? 0.0005),
  debug: opts.debug !== 'no',
};

const res = await withImage(
  file,
  (p) => {
    const CV = window.CV;
    const img = window.IMG;
    const w = img.width;
    const h = img.height;
    const rect = CV.rect(img, p.crop);
    const cropArea = (rect.x1 - rect.x0) * (rect.y1 - rect.y0);
    const minArea = p.minAreaFrac * cropArea;
    const raw = CV.mask(img, p.colours, p.crop);
    const which = raw.which;

    let labels; // pixel → area id (-1 = none)
    let kept; // [{ id, area, bbox, colour? }]
    let strokePx = 0;
    let blobInfo = null;
    let wallRadius = 0;
    const inkMask = new Uint8Array(w * h); // what survived colour + blob filtering

    if (p.mode === 'fill') {
      labels = new Int32Array(w * h).fill(-1);
      kept = [];
      let next = 0;
      for (let c = 0; c < p.colours.length; c++) {
        const m = new Uint8Array(w * h);
        for (let y = rect.y0; y < rect.y1; y++)
          for (let x = rect.x0; x < rect.x1; x++) {
            const i = y * w + x;
            if (which[i] === c + 1) {
              m[i] = 1;
              strokePx++;
            }
          }
        const closed = CV.close(m, w, h, p.closeR, rect);
        const { labels: bl, list } = CV.blobs(closed, w, h, rect, next);
        next += list.length;
        for (const b of list) {
          if (b.area < minArea) continue;
          kept.push({ ...b, colour: c });
          for (let y = b.bbox[1]; y < b.bbox[1] + b.bbox[3]; y++)
            for (let x = b.bbox[0]; x < b.bbox[0] + b.bbox[2]; x++)
              if (bl[y * w + x] === b.id) labels[y * w + x] = b.id;
        }
      }
      wallRadius = p.closeR;
    } else {
      // One pass over a stroke mask: bridge its gaps, take the enclosed
      // regions, grow them back onto the ink.
      const pass = (srcMask, idBase, colour) => {
        const filtered = CV.filterStrokes(srcMask, w, h, rect, { minDiag: p.minStrokeDiag });
        const mask = filtered.mask;
        for (let i = 0; i < mask.length; i++) {
          strokePx += mask[i];
          if (mask[i]) inkMask[i] = 1;
        }
        const dil = CV.dilate(mask, w, h, p.dilate, rect);
        if (p.closedEdges) {
          // Treat the map frame as a wall, so an eruv the poster cuts off at
          // its edge still closes instead of leaking to the outside.
          for (let x = rect.x0; x < rect.x1; x++) dil[rect.y0 * w + x] = dil[(rect.y1 - 1) * w + x] = 1;
          for (let y = rect.y0; y < rect.y1; y++) dil[y * w + rect.x0] = dil[y * w + rect.x1 - 1] = 1;
        }
        const faces = CV.faces(dil, w, h, rect);
        let sel = faces.faces.filter((f) => !f.border && f.area >= minArea && f.area < 0.9 * cropArea);
        if (p.closedEdges && sel.length) {
          // ...but then the outside world is a face too: it is the biggest one.
          const outside = sel.reduce((a, b) => (a.area > b.area ? a : b));
          sel = sel.filter((f) => f !== outside);
        }
        // Grow the faces back into the dilation halo, all at once so none
        // pours through a real gap in its line and swallows its neighbour.
        const owner = CV.regrowAll(
          faces.labels,
          sel.map((f) => f.id),
          mask,
          dil,
          w,
          h,
          rect,
          p.dilate,
        );
        return {
          owner,
          kept: sel.map((f) => ({ ...f, id: f.id + idBase, colour })),
          idShift: idBase,
          blobs: { kept: filtered.kept, dropped: filtered.dropped },
        };
      };

      if (p.byColour) {
        // Each colour is its own boundary, traced independently. Nested loops
        // (an outer eruv and an inner one drawn inside it) then each come out
        // whole, instead of as the ring between them.
        labels = new Int32Array(w * h).fill(-1);
        kept = [];
        blobInfo = { kept: 0, dropped: 0 };
        let base = 0;
        for (let c = 0; c < p.colours.length; c++) {
          const m = new Uint8Array(w * h);
          for (let y = rect.y0; y < rect.y1; y++)
            for (let x = rect.x0; x < rect.x1; x++) {
              const i = y * w + x;
              if (which[i] === c + 1) m[i] = 1;
            }
          const r = pass(m, base, c);
          blobInfo.kept += r.blobs.kept;
          blobInfo.dropped += r.blobs.dropped;
          for (let i = 0; i < r.owner.length; i++)
            if (r.owner[i] >= 0) labels[i] = r.owner[i] + base;
          kept.push(...r.kept);
          base += 100000;
        }
      } else {
        const r = pass(raw.mask, 0, undefined);
        labels = r.owner;
        kept = r.kept;
        blobInfo = r.blobs;
      }
      wallRadius = p.dilate + 3;
    }

    const out = [];
    for (const f of kept) {
      const { set, start } = CV.setOf(labels, f.id, w, h, rect);
      if (start < 0) continue;
      const ring = CV.simplifyRing(CV.contour(set, w, h, start), p.simplify);
      let area2 = 0;
      for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % ring.length];
        area2 += x1 * y2 - x2 * y1;
      }
      // Areas the boundary encircles to exclude. Opt-in: an area enclosed by
      // another is sometimes a hole (an excluded block, a wadi the line
      // detours around) and sometimes a separate eruv drawn inside a bigger
      // one — only the map can say which.
      const holes = p.holes
        ? CV.holesOf(ring, set, inkMask, w, h, rect, p.holeMinAreaFrac * cropArea).map((hole) => ({
            areaPx: hole.area,
            ringPx: CV.simplifyRing(hole.ring, p.simplify),
          }))
        : [];

      out.push({
        id: f.id,
        holes,
        areaPx: Math.abs(area2) / 2,
        bbox: f.bbox,
        colours:
          f.colour !== undefined
            ? [{ name: p.colours[f.colour].name, n: f.area }]
            : CV.wallColours(set, which, w, h, rect, wallRadius).map((c) => ({
                name: p.colours[c.colour].name,
                n: c.n,
              })),
        ringPx: ring,
      });
    }

    // Gaps are measured between the final areas, so a shared wall reads as the
    // width of what separates them, not as that plus the dilation halo.
    const pairs = CV.faceDistances(
      labels,
      out.map((f) => f.id),
      w,
      h,
      rect,
      p.maxPairPx,
    );

    let png = null;
    if (p.debug) {
      const { c, g } = CV.canvasOf(img, 0.55);
      // The ink that survived colour + blob filtering: breaks in it are why a
      // loop leaks and its interior is lost, so show it.
      const layer = g.getImageData(0, 0, c.width, c.height);
      for (let i = 0; i < inkMask.length; i++)
        if (inkMask[i]) {
          layer.data[i * 4] = 255;
          layer.data[i * 4 + 1] = 255;
          layer.data[i * 4 + 2] = 255;
        }
      g.putImageData(layer, 0, 0);
      const palette = ['#00e5ff', '#ff5722', '#8bc34a', '#e91e63', '#ffc107', '#3f51b5', '#00bfa5'];
      out.forEach((f, i) => {
        g.beginPath();
        f.ringPx.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)));
        g.closePath();
        g.fillStyle = palette[i % palette.length] + '44';
        g.fill();
        g.strokeStyle = palette[i % palette.length];
        g.lineWidth = 2;
        g.stroke();
        const cx = f.bbox[0] + f.bbox[2] / 2;
        const cy = f.bbox[1] + f.bbox[3] / 2;
        g.font = 'bold 26px sans-serif';
        g.fillStyle = '#000';
        g.fillRect(cx - 18, cy - 20, 44, 28);
        g.fillStyle = '#fff';
        g.fillText(String(f.id), cx - 12, cy);
      });
      g.strokeStyle = '#fff';
      g.lineWidth = 2;
      g.strokeRect(rect.x0, rect.y0, rect.x1 - rect.x0, rect.y1 - rect.y0);
      png = CV.toPng(c, 1800);
    }

    return { size: [w, h], rect, strokePx, blobs: blobInfo, faces: out, pairs, png };
  },
  params,
);

const traces = {
  image: file,
  size: res.size,
  crop: [res.rect.x0, res.rect.y0, res.rect.x1 - res.rect.x0, res.rect.y1 - res.rect.y0],
  mode,
  colours,
  params: {
    dilate: params.dilate,
    closeR: params.closeR,
    simplify: params.simplify,
    minAreaFrac: params.minAreaFrac,
  },
  faces: res.faces,
  pairs: res.pairs,
};
const out = opts.out || 'traces.json';
writeFileSync(out, JSON.stringify(traces, null, 1));

console.log(
  `mode ${mode}: ${res.strokePx} coloured px` +
    (res.blobs ? ` (blobs kept ${res.blobs.kept}, dropped ${res.blobs.dropped})` : ''),
);
console.log('id     areaPx  bbox                       vertices  colour');
for (const f of res.faces) {
  const walls = f.colours
    .slice(0, 3)
    .map((c) => `${c.name}:${c.n}`)
    .join(' ');
  console.log(
    `${String(f.id).padStart(3)}  ${String(Math.round(f.areaPx)).padStart(9)}  ${JSON.stringify(f.bbox).padEnd(24)}  ${String(f.ringPx.length).padStart(6)}  ${walls}`,
  );
}
if (res.pairs.length) {
  console.log('adjacent areas (pixel gap):');
  for (const p of res.pairs.sort((a, b) => a.px - b.px))
    console.log(`  ${p.a} ↔ ${p.b}: ${p.px} px`);
}
console.log(`→ ${out}`);
if (res.png)
  console.log(`→ ${writeDataUrl(opts.debug && opts.debug !== true ? opts.debug : 'trace-debug.png', res.png)}`);
