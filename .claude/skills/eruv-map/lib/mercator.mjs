// Web-Mercator metres and the poster-pixel → ground affine fit.
// Fitting happens in Mercator metres (not degrees) so x and y share a unit;
// ground distances divide out the latitude stretch (see groundScale).

export const R = 6378137;

export function toMerc([lat, lon]) {
  const y = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  return [(R * lon * Math.PI) / 180, y];
}

export function toLatLon([x, y]) {
  const lat = (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI);
  return [lat, (x * 180) / (Math.PI * R)];
}

/** Mercator metres per ground metre at this latitude. */
export const mercStretch = (lat) => 1 / Math.cos((lat * Math.PI) / 180);

/** Solve A·x = b for small dense systems (Gaussian elimination, partial pivot). */
export function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) throw new Error('degenerate control points');
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / M[i][i]);
}

/**
 * Least-squares fit of pixel [x,y] → Mercator [X,Y].
 *   'affine'     — 6 params (scale, rotation, shear, translation); needs >= 3
 *   'similarity' — 4 params (uniform scale, rotation, translation); needs >= 2
 * Returns [a,b,c,d,e,f] with X = a·x + b·y + c, Y = d·x + e·y + f.
 */
export function fit(pixels, mercs, kind = 'affine') {
  const n = pixels.length;
  if (kind === 'affine') {
    if (n < 3) throw new Error('affine needs >= 3 control points');
    const N = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    const bx = [0, 0, 0];
    const by = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const v = [pixels[i][0], pixels[i][1], 1];
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) N[r][c] += v[r] * v[c];
        bx[r] += v[r] * mercs[i][0];
        by[r] += v[r] * mercs[i][1];
      }
    }
    const [a, b, c] = solve(N.map((r) => [...r]), bx);
    const [d, e, f] = solve(N.map((r) => [...r]), by);
    return [a, b, c, d, e, f];
  }
  if (n < 2) throw new Error('similarity needs >= 2 control points');
  // Two candidates, because pixel y grows downwards while northing grows up:
  //   direct    X = s·x − t·y + c ; Y = t·x + s·y + f
  //   reflected X = p·x + q·y + c ; Y = q·x − p·y + f   ← the usual one
  // Fitting only the direct form silently contorts a north-up map into a
  // rotated one, so fit both and keep whichever actually matches.
  const build = (rowsOf) => {
    const N = [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    const rhs = [0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
      for (const [row, val] of rowsOf(pixels[i], mercs[i])) {
        for (let r = 0; r < 4; r++) {
          for (let c = 0; c < 4; c++) N[r][c] += row[r] * row[c];
          rhs[r] += row[r] * val;
        }
      }
    }
    return solve(N, rhs);
  };
  const direct = build(([x, y], [X, Y]) => [
    [[x, -y, 1, 0], X],
    [[y, x, 0, 1], Y],
  ]);
  const reflected = build(([x, y], [X, Y]) => [
    [[x, y, 1, 0], X],
    [[-y, x, 0, 1], Y],
  ]);
  const candidates = [
    [direct[0], -direct[1], direct[2], direct[1], direct[0], direct[3]],
    [reflected[0], reflected[1], reflected[2], reflected[1], -reflected[0], reflected[3]],
  ];
  const err = (T) =>
    pixels.reduce((a, p, i) => {
      const [X, Y] = apply(T, p);
      return a + (X - mercs[i][0]) ** 2 + (Y - mercs[i][1]) ** 2;
    }, 0);
  // With only 2 points both forms fit exactly and their errors are pure
  // rounding noise, so the margin has to be absolute (in square metres), not
  // relative. Ties go to the reflected form: an image whose y grows downwards
  // over a north-up map IS reflected. The direct form wins only for a genuine
  // mirror image.
  return err(candidates[0]) + 1 < err(candidates[1]) * 0.9 ? candidates[0] : candidates[1];
}

export const apply = (T, [x, y]) => [T[0] * x + T[1] * y + T[2], T[3] * x + T[4] * y + T[5]];

/** Human-readable scale (ground m per pixel) and rotation (deg) of a fit. */
export function describe(T, lat) {
  const k = mercStretch(lat);
  const sx = Math.hypot(T[0], T[3]) / k;
  const sy = Math.hypot(T[1], T[4]) / k;
  const rot = (Math.atan2(T[3], T[0]) * 180) / Math.PI;
  return { mPerPxX: sx, mPerPxY: sy, rotationDeg: rot };
}
