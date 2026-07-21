/*
 * Browser-side pixel toolkit (window.CV), injected into a headless Edge page
 * by lib/page.mjs. Everything here runs where the pixels are: the only things
 * that cross back to node are small JSON objects and finished PNG data URLs.
 */
(function () {
  const CV = {};

  CV.load = (url) =>
    new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        res(g.getImageData(0, 0, c.width, c.height));
      };
      img.onerror = () => rej(new Error('image decode failed'));
      img.src = url;
    });

  /** null crop → the whole image. Clamped to the image. */
  CV.rect = (img, crop) => {
    const [x, y, w, h] = crop || [0, 0, img.width, img.height];
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    return {
      x0,
      y0,
      x1: Math.min(img.width, x0 + Math.round(w)),
      y1: Math.min(img.height, y0 + Math.round(h)),
    };
  };

  CV.rgbToHsl = (r, g, b) => {
    r /= 255;
    g /= 255;
    b /= 255;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const l = (mx + mn) / 2;
    const d = mx - mn;
    if (!d) return [0, 0, l];
    const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    let hue;
    if (mx === r) hue = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (mx === g) hue = ((b - r) / d + 2) * 60;
    else hue = ((r - g) / d + 4) * 60;
    return [hue, s, l];
  };

  const hueDist = (a, b) => {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  };
  CV.hueDist = hueDist;

  /**
   * Hue histogram of the saturated pixels in the crop, in `bin`-degree
   * buckets, with the mean colour of each bucket. Used to pick eruv colours
   * from the image rather than guessing them.
   */
  CV.histogram = (img, { crop = null, bin = 10, sMin = 0.3, lMin = 0.2, lMax = 0.85 } = {}) => {
    const { x0, y0, x1, y1 } = CV.rect(img, crop);
    const n = Math.ceil(360 / bin);
    const count = new Float64Array(n);
    const sum = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
    const d = img.data;
    let total = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * img.width + x) * 4;
        const [h, s, l] = CV.rgbToHsl(d[i], d[i + 1], d[i + 2]);
        total++;
        if (s < sMin || l < lMin || l > lMax) continue;
        const b = Math.floor(h / bin) % n;
        count[b]++;
        sum[0][b] += d[i];
        sum[1][b] += d[i + 1];
        sum[2][b] += d[i + 2];
      }
    }
    const bins = [];
    for (let b = 0; b < n; b++) {
      if (!count[b]) continue;
      const rgb = [0, 1, 2].map((k) => Math.round(sum[k][b] / count[b]));
      bins.push({
        hue: b * bin + bin / 2,
        count: count[b],
        pct: (100 * count[b]) / total,
        rgb,
        hex: '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join(''),
      });
    }
    bins.sort((a, b) => b.count - a.count);
    return { total, bins };
  };

  /**
   * Binary stroke mask for a list of colour specs
   * ({name, hue, dHue, sMin, lMin, lMax}). Returns the union mask plus a
   * per-pixel colour index (1-based, 0 = none) for attributing walls later.
   */
  CV.mask = (img, colours, crop) => {
    const { x0, y0, x1, y1 } = CV.rect(img, crop);
    const w = img.width;
    const mask = new Uint8Array(w * img.height);
    const which = new Uint8Array(w * img.height);
    const d = img.data;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = y * w + x;
        const i = p * 4;
        const [h, s, l] = CV.rgbToHsl(d[i], d[i + 1], d[i + 2]);
        for (let c = 0; c < colours.length; c++) {
          const q = colours[c];
          if (
            s >= (q.sMin ?? 0.3) &&
            l >= (q.lMin ?? 0.2) &&
            l <= (q.lMax ?? 0.85) &&
            hueDist(h, q.hue) <= (q.dHue ?? 15)
          ) {
            mask[p] = 1;
            which[p] = c + 1;
            break;
          }
        }
      }
    }
    return { mask, which };
  };

  /**
   * Drop the mask's small connected blobs (8-connected): a drawn eruv line is
   * long, while red roofs, pool tiles and JPEG fringes in the satellite photo
   * are compact. Kept if the blob's bbox diagonal >= minDiag or area >= minArea.
   */
  CV.filterStrokes = (mask, w, h, rect, { minDiag = 60, minArea = Infinity } = {}) => {
    const { x0, y0, x1, y1 } = rect;
    const seen = new Uint8Array(w * h);
    const out = new Uint8Array(w * h);
    let kept = 0;
    let dropped = 0;
    for (let sy = y0; sy < y1; sy++) {
      for (let sx = x0; sx < x1; sx++) {
        const s = sy * w + sx;
        if (!mask[s] || seen[s]) continue;
        const comp = [s];
        seen[s] = 1;
        let bx0 = sx;
        let by0 = sy;
        let bx1 = sx;
        let by1 = sy;
        for (let i = 0; i < comp.length; i++) {
          const p = comp[i];
          const px = p % w;
          const py = (p - px) / w;
          if (px < bx0) bx0 = px;
          if (px > bx1) bx1 = px;
          if (py < by0) by0 = py;
          if (py > by1) by1 = py;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const xx = px + dx;
              const yy = py + dy;
              if (xx < x0 || yy < y0 || xx >= x1 || yy >= y1) continue;
              const q = yy * w + xx;
              if (mask[q] && !seen[q]) {
                seen[q] = 1;
                comp.push(q);
              }
            }
          }
        }
        if (Math.hypot(bx1 - bx0, by1 - by0) >= minDiag || comp.length >= minArea) {
          for (const p of comp) out[p] = 1;
          kept++;
        } else dropped++;
      }
    }
    return { mask: out, kept, dropped };
  };

  /** Square dilation by radius r (two separable max passes). */
  CV.dilate = (mask, w, h, r, crop) => {
    if (r <= 0) return mask.slice();
    const { x0, y0, x1, y1 } = crop || { x0: 0, y0: 0, x1: w, y1: h };
    const tmp = new Uint8Array(mask.length);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        let v = 0;
        for (let k = -r; k <= r && !v; k++) {
          const xx = x + k;
          if (xx >= x0 && xx < x1 && mask[y * w + xx]) v = 1;
        }
        tmp[y * w + x] = v;
      }
    }
    const out = new Uint8Array(mask.length);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        let v = 0;
        for (let k = -r; k <= r && !v; k++) {
          const yy = y + k;
          if (yy >= y0 && yy < y1 && tmp[yy * w + x]) v = 1;
        }
        out[y * w + x] = v;
      }
    }
    return out;
  };

  /** Square erosion by radius r (dilation of the complement). */
  CV.erode = (mask, w, h, r, rect) => {
    if (r <= 0) return mask.slice();
    const inv = new Uint8Array(mask.length);
    const { x0, y0, x1, y1 } = rect;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) inv[y * w + x] = mask[y * w + x] ? 0 : 1;
    const grown = CV.dilate(inv, w, h, r, rect);
    const out = new Uint8Array(mask.length);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) out[y * w + x] = grown[y * w + x] ? 0 : 1;
    return out;
  };

  /**
   * Morphological closing: fills the streets, text and building outlines that
   * punch holes in a printed area fill, without moving its outer edge.
   */
  CV.close = (mask, w, h, r, rect) =>
    CV.erode(CV.dilate(mask, w, h, r, rect), w, h, r, rect);

  /** Connected components of `mask == 1` (8-connected), as a label map. */
  CV.blobs = (mask, w, h, rect, startId = 0) => {
    const { x0, y0, x1, y1 } = rect;
    const labels = new Int32Array(w * h).fill(-1);
    const list = [];
    for (let sy = y0; sy < y1; sy++) {
      for (let sx = x0; sx < x1; sx++) {
        const s = sy * w + sx;
        if (!mask[s] || labels[s] !== -1) continue;
        const id = startId + list.length;
        const stack = [s];
        labels[s] = id;
        let area = 0;
        let bx0 = sx;
        let by0 = sy;
        let bx1 = sx;
        let by1 = sy;
        while (stack.length) {
          const p = stack.pop();
          const px = p % w;
          const py = (p - px) / w;
          area++;
          if (px < bx0) bx0 = px;
          if (px > bx1) bx1 = px;
          if (py < by0) by0 = py;
          if (py > by1) by1 = py;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const xx = px + dx;
              const yy = py + dy;
              if (xx < x0 || yy < y0 || xx >= x1 || yy >= y1) continue;
              const q = yy * w + xx;
              if (mask[q] && labels[q] === -1) {
                labels[q] = id;
                stack.push(q);
              }
            }
        }
        list.push({ id, area, bbox: [bx0, by0, bx1 - bx0 + 1, by1 - by0 + 1], seed: s });
      }
    }
    return { labels, list };
  };

  /**
   * Label the connected regions of `mask == 0` inside the crop (4-connected).
   * Regions touching the crop border are the outside world, and are flagged.
   */
  CV.faces = (mask, w, h, rect) => {
    const { x0, y0, x1, y1 } = rect;
    const labels = new Int32Array(w * h).fill(-1);
    const faces = [];
    const stack = new Int32Array((x1 - x0) * (y1 - y0));
    for (let sy = y0; sy < y1; sy++) {
      for (let sx = x0; sx < x1; sx++) {
        const s = sy * w + sx;
        if (mask[s] || labels[s] !== -1) continue;
        const id = faces.length;
        let top = 0;
        stack[top++] = s;
        labels[s] = id;
        let area = 0;
        let bx0 = sx;
        let by0 = sy;
        let bx1 = sx;
        let by1 = sy;
        let border = false;
        while (top) {
          const p = stack[--top];
          const px = p % w;
          const py = (p - px) / w;
          area++;
          if (px < bx0) bx0 = px;
          if (px > bx1) bx1 = px;
          if (py < by0) by0 = py;
          if (py > by1) by1 = py;
          if (px === x0 || px === x1 - 1 || py === y0 || py === y1 - 1) border = true;
          if (px > x0 && !mask[p - 1] && labels[p - 1] === -1) (labels[p - 1] = id), (stack[top++] = p - 1);
          if (px < x1 - 1 && !mask[p + 1] && labels[p + 1] === -1) (labels[p + 1] = id), (stack[top++] = p + 1);
          if (py > y0 && !mask[p - w] && labels[p - w] === -1) (labels[p - w] = id), (stack[top++] = p - w);
          if (py < y1 - 1 && !mask[p + w] && labels[p + w] === -1) (labels[p + w] = id), (stack[top++] = p + w);
        }
        faces.push({ id, area, bbox: [bx0, by0, bx1 - bx0 + 1, by1 - by0 + 1], seed: s, border });
      }
    }
    return { labels, faces };
  };

  /**
   * Grow every face back into the halo left by dilation, so boundaries hug
   * the real stroke instead of sitting r px inside it. All faces expand at
   * once and each halo pixel goes to whichever reaches it first — otherwise a
   * face would pour through a genuine gap in its line and swallow its
   * neighbour. Returns an owner map (-1 = stroke or unclaimed).
   */
  CV.regrowAll = (labels, ids, orig, dil, w, h, rect, rounds) => {
    const { x0, y0, x1, y1 } = rect;
    const owner = new Int32Array(w * h).fill(-1);
    const want = new Set(ids);
    let frontier = [];
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = y * w + x;
        if (labels[p] >= 0 && want.has(labels[p])) {
          owner[p] = labels[p];
          frontier.push(p);
        }
      }
    }
    for (let r = 0; r < rounds && frontier.length; r++) {
      const next = [];
      const claim = new Map(); // pixel → owner, resolved after the round
      for (const p of frontier) {
        const px = p % w;
        const py = (p - px) / w;
        const nb = [];
        if (px > x0) nb.push(p - 1);
        if (px < x1 - 1) nb.push(p + 1);
        if (py > y0) nb.push(p - w);
        if (py < y1 - 1) nb.push(p + w);
        for (const q of nb) {
          if (owner[q] !== -1 || orig[q] || !dil[q]) continue;
          const prev = claim.get(q);
          if (prev === undefined) claim.set(q, owner[p]);
          else if (prev !== owner[p]) claim.set(q, -2); // contested: leave it as wall
        }
      }
      for (const [q, o] of claim) {
        if (o < 0) continue;
        owner[q] = o;
        next.push(q);
      }
      frontier = next;
    }
    return owner;
  };

  /** Pull one face's pixels out of an owner map. */
  CV.setOf = (owner, id, w, h, rect) => {
    const { x0, y0, x1, y1 } = rect;
    const set = new Uint8Array(w * h);
    let start = -1;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = y * w + x;
        if (owner[p] === id) {
          set[p] = 1;
          if (start < 0) start = p;
        }
      }
    }
    return { set, start };
  };

  /** Moore-neighbourhood boundary walk of a pixel set, from its top-left pixel. */
  CV.contour = (set, w, h, start) => {
    const D = [
      [1, 0],
      [1, 1],
      [0, 1],
      [-1, 1],
      [-1, 0],
      [-1, -1],
      [0, -1],
      [1, -1],
    ];
    const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && set[y * w + x];
    let sx = start % w;
    let sy = (start - sx) / w;
    const pts = [[sx, sy]];
    let cx = sx;
    let cy = sy;
    let dir = 4; // came from the left
    const limit = 8 * (w + h) * 4;
    for (let step = 0; step < limit; step++) {
      let found = false;
      for (let k = 1; k <= 8; k++) {
        const nd = (dir + k) % 8;
        const nx = cx + D[nd][0];
        const ny = cy + D[nd][1];
        if (at(nx, ny)) {
          cx = nx;
          cy = ny;
          dir = (nd + 5) % 8; // back-track direction for the next search
          pts.push([cx, cy]);
          found = true;
          break;
        }
      }
      if (!found) break; // isolated pixel
      if (cx === sx && cy === sy && pts.length > 2) break;
    }
    return pts;
  };

  /**
   * RDP for a closed ring. Run on the raw ring it would keep nothing — first
   * and last point coincide, so every perpendicular distance is zero — so the
   * ring is cut at the point farthest from the start and simplified in halves.
   */
  CV.simplifyRing = (pts, eps) => {
    if (pts.length < 4) return pts.slice();
    const ring = pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]
      ? pts.slice(0, -1)
      : pts.slice();
    let far = 0;
    let farD = -1;
    for (let i = 1; i < ring.length; i++) {
      const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]);
      if (d > farD) {
        farD = d;
        far = i;
      }
    }
    const a = CV.simplify(ring.slice(0, far + 1), eps);
    const b = CV.simplify(ring.slice(far), eps);
    return a.concat(b.slice(1, -1));
  };

  /** Ramer–Douglas–Peucker. */
  CV.simplify = (pts, eps) => {
    if (pts.length < 3) return pts.slice();
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const [ax, ay] = pts[a];
      const [bx, by] = pts[b];
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy) || 1;
      let best = -1;
      let bestD = eps;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs(dy * (pts[i][0] - ax) - dx * (pts[i][1] - ay)) / len;
        if (d > bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best > 0) {
        keep[best] = 1;
        stack.push([a, best], [best, b]);
      }
    }
    return pts.filter((_, i) => keep[i]);
  };

  /**
   * Shortest pixel distance between every pair of faces, by a multi-source
   * BFS over the stroke pixels (capped at maxR). Two eruvin that share a
   * street wall come out a stroke-width apart.
   */
  CV.faceDistances = (labels, faceIds, w, h, rect, maxR) => {
    const { x0, y0, x1, y1 } = rect;
    const owner = new Int32Array(w * h).fill(-1);
    const dist = new Int32Array(w * h).fill(-1);
    let frontier = [];
    const want = new Set(faceIds);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = y * w + x;
        if (labels[p] >= 0 && want.has(labels[p])) {
          owner[p] = labels[p];
          dist[p] = 0;
          frontier.push(p);
        }
      }
    }
    const pairs = new Map();
    const note = (a, b, d) => {
      if (a === b) return;
      const k = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (!pairs.has(k) || pairs.get(k) > d) pairs.set(k, d);
    };
    for (let r = 0; r < maxR && frontier.length; r++) {
      const next = [];
      for (const p of frontier) {
        const px = p % w;
        const py = (p - px) / w;
        const nb = [];
        if (px > x0) nb.push(p - 1);
        if (px < x1 - 1) nb.push(p + 1);
        if (py > y0) nb.push(p - w);
        if (py < y1 - 1) nb.push(p + w);
        for (const q of nb) {
          if (owner[q] === -1) {
            owner[q] = owner[p];
            dist[q] = dist[p] + 1;
            next.push(q);
          } else if (owner[q] !== owner[p]) {
            note(owner[p], owner[q], dist[p] + dist[q] + 1);
          }
        }
      }
      frontier = next;
    }
    return [...pairs].map(([k, d]) => {
      const [a, b] = k.split('-').map(Number);
      return { a, b, px: d };
    });
  };

  /** Colours of the stroke pixels bounding a face, as counts per colour index. */
  CV.wallColours = (set, which, w, h, rect, r) => {
    const { x0, y0, x1, y1 } = rect;
    const counts = new Map();
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (!set[y * w + x]) continue;
        // only look outward from the face's own edge
        if (
          set[y * w + x - 1] &&
          set[y * w + x + 1] &&
          set[(y - 1) * w + x] &&
          set[(y + 1) * w + x]
        )
          continue;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < x0 || yy < y0 || xx >= x1 || yy >= y1) continue;
            const c = which[yy * w + xx];
            if (c) counts.set(c, (counts.get(c) || 0) + 1);
          }
        }
      }
    }
    return [...counts].map(([c, n]) => ({ colour: c - 1, n })).sort((a, b) => b.n - a.n);
  };

  /**
   * Gradient-magnitude pyramid of (part of) an image. Registration runs on
   * edges, not colours: the poster and today's satellite tiles differ in
   * season, exposure and buildings, but the road network's edges agree.
   */
  CV.gradPyramid = (img, crop, levels, { maskDrawn = false, edgePct = 0.75 } = {}) => {
    const { x0, y0, x1, y1 } = CV.rect(img, crop);
    let w = x1 - x0;
    let h = y1 - y0;
    let gray = new Float32Array(w * h);
    let bad = new Float32Array(w * h); // 1 where the pixel is drawn-on, not photo
    const d = img.data;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = ((y + y0) * img.width + (x + x0)) * 4;
        gray[y * w + x] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        if (maskDrawn) {
          const [, s, l] = CV.rgbToHsl(d[i], d[i + 1], d[i + 2]);
          if (s > 0.25 || l > 0.88) bad[y * w + x] = 1; // eruv strokes, labels, text
        }
      }
    const out = [];
    for (let L = 0; L <= levels; L++) {
      if (L) {
        const nw = w >> 1;
        const nh = h >> 1;
        const half = (src) => {
          const next = new Float32Array(nw * nh);
          for (let y = 0; y < nh; y++)
            for (let x = 0; x < nw; x++)
              next[y * nw + x] =
                (src[2 * y * w + 2 * x] +
                  src[2 * y * w + 2 * x + 1] +
                  src[(2 * y + 1) * w + 2 * x] +
                  src[(2 * y + 1) * w + 2 * x + 1]) /
                4;
          return next;
        };
        const g2 = half(gray);
        bad = half(bad);
        gray = g2;
        w = nw;
        h = nh;
      }
      const g = new Float32Array(w * h);
      for (let y = 1; y < h - 1; y++)
        for (let x = 1; x < w - 1; x++) {
          const gx =
            gray[(y - 1) * w + x + 1] + 2 * gray[y * w + x + 1] + gray[(y + 1) * w + x + 1] -
            gray[(y - 1) * w + x - 1] - 2 * gray[y * w + x - 1] - gray[(y + 1) * w + x - 1];
          const gy =
            gray[(y + 1) * w + x - 1] + 2 * gray[(y + 1) * w + x] + gray[(y + 1) * w + x + 1] -
            gray[(y - 1) * w + x - 1] - 2 * gray[(y - 1) * w + x] - gray[(y - 1) * w + x + 1];
          g[y * w + x] = Math.hypot(gx, gy);
        }
      // 3x3 box blur: gives the match a basin to slide into
      const b = new Float32Array(w * h);
      for (let y = 1; y < h - 1; y++)
        for (let x = 1; x < w - 1; x++) {
          let s = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += g[(y + dy) * w + x + dx];
          b[y * w + x] = bad[y * w + x] > 0.2 ? -1 : s / 9;
        }
      // Binarise at a percentile: the poster's drawn roads and the tiles'
      // photographed ones differ in brightness, but "is this an edge" agrees.
      const vals = [];
      for (let i = 0; i < b.length; i++) if (b[i] >= 0) vals.push(b[i]);
      vals.sort((p, q) => p - q);
      const thr = vals[Math.floor(vals.length * edgePct)] || 0;
      const bin = new Int8Array(w * h);
      for (let i = 0; i < b.length; i++) bin[i] = b[i] < 0 ? -1 : b[i] >= thr ? 1 : 0;
      out.push({ w, h, g: b, bin, origin: [x0, y0], step: 1 << L });
    }
    return out;
  };

  /**
   * Sample points spread over a level: the strongest edge pixel in each cell,
   * and the flattest one. Matching both keeps the search honest — a candidate
   * that simply lands everything on busy ground scores nothing.
   */
  CV.samples = (lv, cells) => {
    const cw = Math.ceil(lv.w / cells);
    const ch = Math.ceil(lv.h / cells);
    const edge = [];
    const flat = [];
    for (let cy = 0; cy < cells; cy++)
      for (let cx = 0; cx < cells; cx++) {
        let hi = -Infinity;
        let lo = Infinity;
        let hp = null;
        let lp = null;
        for (let y = Math.max(1, cy * ch); y < Math.min(lv.h - 1, (cy + 1) * ch); y++)
          for (let x = Math.max(1, cx * cw); x < Math.min(lv.w - 1, (cx + 1) * cw); x++) {
            const v = lv.g[y * lv.w + x];
            if (v < 0) continue; // drawn-on pixel
            if (v > hi) {
              hi = v;
              hp = [x, y];
            }
            if (v < lo) {
              lo = v;
              lp = [x, y];
            }
          }
        if (hp) edge.push(hp);
        if (lp) flat.push(lp);
      }
    return { edge, flat };
  };

  /**
   * Score a candidate similarity (scale s, rotation th, poster centre → ref
   * point t): how much more often the poster's edge points land on reference
   * edges than its flat points do. Needs nearly all points inside the frame,
   * so a candidate cannot win by sliding off the edge.
   */
  CV.score = (sm, pc, ref, s, th, tx, ty) => {
    const co = s * Math.cos(th);
    const si = s * Math.sin(th);
    const hits = (pts) => {
      let n = 0;
      let hit = 0;
      for (let i = 0; i < pts.length; i++) {
        const dx = pts[i][0] - pc[0];
        const dy = pts[i][1] - pc[1];
        const x = Math.round(tx + co * dx - si * dy);
        const y = Math.round(ty + si * dx + co * dy);
        if (x < 1 || y < 1 || x >= ref.w - 1 || y >= ref.h - 1) continue;
        const v = ref.bin[y * ref.w + x];
        if (v < 0) continue;
        n++;
        if (v) hit++;
      }
      return { n, r: n ? hit / n : 0 };
    };
    const e = hits(sm.edge);
    if (e.n < sm.edge.length * 0.9) return -1;
    const f = hits(sm.flat);
    if (f.n < sm.flat.length * 0.9) return -1;
    return e.r - f.r;
  };

  /** Rasterise a ring (canvas does the scanline fill for us). */
  CV.fillRing = (ring, w, h) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.beginPath();
    ring.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    g.fill();
    const d = g.getImageData(0, 0, w, h).data;
    const out = new Uint8Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3] ? 1 : 0;
    return out;
  };

  /**
   * Enclosed regions of a face's outer ring that are not the face itself and
   * not ink: an area the boundary loops around to exclude — a wadi the eruv
   * line detours around, an unusable block the inner perimeter cuts out.
   */
  CV.holesOf = (ring, set, ink, w, h, rect, minArea) => {
    const filled = CV.fillRing(ring, w, h);
    const cand = new Uint8Array(w * h);
    for (let y = rect.y0; y < rect.y1; y++)
      for (let x = rect.x0; x < rect.x1; x++) {
        const p = y * w + x;
        if (filled[p] && !set[p] && !ink[p]) cand[p] = 1;
      }
    const { labels, list } = CV.blobs(cand, w, h, rect);
    const holes = [];
    for (const b of list) {
      if (b.area < minArea) continue;
      const { set: hs, start } = CV.setOf(labels, b.id, w, h, rect);
      if (start < 0) continue;
      holes.push({ area: b.area, ring: CV.contour(hs, w, h, start) });
    }
    return holes;
  };

  /** Canvas with the source image dimmed, ready for debug overlays. */
  CV.canvasOf = (img, dim) => {
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d');
    g.putImageData(img, 0, 0);
    if (dim) {
      g.fillStyle = `rgba(0,0,0,${dim})`;
      g.fillRect(0, 0, c.width, c.height);
    }
    return { c, g };
  };

  /** Downscale a canvas to at most `max` px wide, then export as a PNG URL. */
  CV.toPng = (c, max) => {
    if (!max || c.width <= max) return c.toDataURL('image/png');
    const s = max / c.width;
    const o = document.createElement('canvas');
    o.width = Math.round(c.width * s);
    o.height = Math.round(c.height * s);
    o.getContext('2d').drawImage(c, 0, 0, o.width, o.height);
    return o.toDataURL('image/png');
  };

  window.CV = CV;
})();
