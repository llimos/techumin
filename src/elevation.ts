/**
 * Terrain elevation from AWS Terrain Tiles (Terrarium encoding):
 * https://registry.opendata.aws/terrain-tiles/
 * elevation = (R·256 + G + B/256) − 32768, in meters.
 */

const TILE_URL = (z: number, x: number, y: number) =>
  `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${z}/${x}/${y}.png`;

const ZOOM = 13;
const TILE_SIZE = 256;

const tileCache = new Map<string, Promise<ImageData | null>>();

async function loadTile(z: number, x: number, y: number): Promise<ImageData | null> {
  const key = `${z}/${x}/${y}`;
  let cached = tileCache.get(key);
  if (!cached) {
    cached = (async () => {
      try {
        const res = await fetch(TILE_URL(z, x, y));
        if (!res.ok) return null;
        const blob = await res.blob();
        const bitmap = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
        const g = canvas.getContext('2d')!;
        g.drawImage(bitmap, 0, 0);
        return g.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
      } catch {
        return null;
      }
    })();
    tileCache.set(key, cached);
  }
  return cached;
}

/** Elevation in meters, or null when tile data is unavailable. */
export async function elevationAt(lat: number, lon: number): Promise<number | null> {
  const n = 2 ** ZOOM;
  const xf = ((lon + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const yf = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  const tileX = Math.floor(xf);
  const tileY = Math.floor(yf);
  const img = await loadTile(ZOOM, tileX, tileY);
  if (!img) return null;
  const px = Math.min(TILE_SIZE - 1, Math.floor((xf - tileX) * TILE_SIZE));
  const py = Math.min(TILE_SIZE - 1, Math.floor((yf - tileY) * TILE_SIZE));
  const i = (py * TILE_SIZE + px) * 4;
  const [r, g, b] = [img.data[i], img.data[i + 1], img.data[i + 2]];
  return r * 256 + g + b / 256 - 32768;
}
