// Client-side viewshed from open terrain tiles (Terrarium encoding: elevation = R*256 + G + B/256 - 32768).

export const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const Z = 12; // about 38 m per pixel at Butuan's latitude
const TS = 256;
const N = TS * 2 ** Z;
const RAD = Math.PI / 180;

function toPx(lng: number, lat: number): [number, number] {
  const s = Math.sin(lat * RAD);
  return [((lng + 180) / 360) * N, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * N];
}

const cache = new Map<string, Promise<Float32Array | null>>();

function fetchTile(x: number, y: number): Promise<Float32Array | null> {
  const key = `${x}/${y}`;
  let p = cache.get(key);
  if (!p) {
    p = new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = c.height = TS;
        const ctx = c.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, TS, TS).data;
        const out = new Float32Array(TS * TS);
        for (let i = 0; i < out.length; i++) out[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
        resolve(out);
      };
      img.onerror = () => resolve(null);
      img.src = TILE_URL.replace('{z}', String(Z)).replace('{x}', String(x)).replace('{y}', String(y));
    });
    cache.set(key, p);
  }
  return p;
}

export class Dem {
  private tiles = new Map<string, Float32Array>();
  failed = 0;

  // Load every tile that covers a circle of radiusM around the point.
  async load(lng: number, lat: number, radiusM: number) {
    const dLat = radiusM / 111320;
    const dLng = radiusM / (111320 * Math.cos(lat * RAD));
    const [x0, y1] = toPx(lng - dLng, lat - dLat);
    const [x1, y0] = toPx(lng + dLng, lat + dLat);
    const jobs: Promise<void>[] = [];
    for (let tx = Math.floor(x0 / TS); tx <= Math.floor(x1 / TS); tx++) {
      for (let ty = Math.floor(y0 / TS); ty <= Math.floor(y1 / TS); ty++) {
        jobs.push(
          fetchTile(tx, ty).then((t) => {
            if (t) this.tiles.set(`${tx}/${ty}`, t);
            else this.failed++;
          }),
        );
      }
    }
    await Promise.all(jobs);
  }

  private px(ix: number, iy: number): number {
    const t = this.tiles.get(`${Math.floor(ix / TS)}/${Math.floor(iy / TS)}`);
    return t ? t[(iy & 255) * TS + (ix & 255)] : NaN;
  }

  // Bilinear elevation in metres, NaN outside the loaded tiles.
  at(lng: number, lat: number): number {
    const [x, y] = toPx(lng, lat);
    const fx = x - 0.5;
    const fy = y - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const a = this.px(x0, y0);
    const b = this.px(x0 + 1, y0);
    const c = this.px(x0, y0 + 1);
    const d = this.px(x0 + 1, y0 + 1);
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }
}

// Buildings and woodland, rasterised by pipeline/05_osm_obstructions.py (pixel value = height in metres).
export class Obstruction {
  constructor(
    private bbox: [number, number, number, number], // west, south, east, north
    private w: number,
    private h: number,
    private data: Uint8Array,
  ) {}

  at(lng: number, lat: number): number {
    const [west, south, east, north] = this.bbox;
    const i = Math.floor(((lng - west) / (east - west)) * this.w);
    const j = Math.floor(((north - lat) / (north - south)) * this.h);
    return i < 0 || j < 0 || i >= this.w || j >= this.h ? 0 : this.data[j * this.w + i];
  }
}

let obsPromise: Promise<Obstruction | null> | null = null;

// Resolves to null when the pipeline script has not been run yet.
export function loadObstruction(): Promise<Obstruction | null> {
  obsPromise ??= (async () => {
    try {
      const r = await fetch('/data/obstruction.json');
      if (!r.ok) return null;
      const meta = await r.json();
      const img = await new Promise<HTMLImageElement>((ok, bad) => {
        const i = new Image();
        i.onload = () => ok(i);
        i.onerror = bad;
        i.src = '/data/obstruction.png';
      });
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const out = new Uint8Array(c.width * c.height);
      for (let i = 0; i < out.length; i++) out[i] = d[i * 4];
      return new Obstruction(meta.bbox, c.width, c.height, out);
    } catch {
      return null;
    }
  })();
  return obsPromise;
}

export const HORIZON_BINS = 360; // one per degree of azimuth, 0 = north, clockwise

export interface Horizon {
  angle: Float32Array; // skyline elevation angle above the eye, degrees
  dist: Float32Array; // distance to the point that makes the skyline, metres
}

export interface ViewshedResult {
  canvas: HTMLCanvasElement | null; // null in lite mode
  horizon: Horizon | null;
  coordinates: [[number, number], [number, number], [number, number], [number, number]]; // NW, NE, SE, SW
  groundM: number;
  visiblePct: number;
  farthestM: number;
  highestVisibleM: number;
}

const EARTH_R = 6371000;
const REFRACTION = 0.13; // standard atmospheric refraction coefficient

export interface ViewshedOpts {
  obs?: Obstruction | null; // add buildings and trees to the terrain
  lite?: boolean; // statistics only: no image, no skyline
}

const OWN_CLEARANCE = 45; // ignore obstructions this close, so the observer is not "inside" their own building

export function computeViewshed(dem: Dem, lng0: number, lat0: number, eyeM: number, radiusM: number, opts: ViewshedOpts = {}): ViewshedResult | null {
  const { obs = null, lite = false } = opts;
  const ground = dem.at(lng0, lat0);
  if (!Number.isFinite(ground)) return null;
  const z0 = ground + eyeM;
  const mLat = 111320;
  const mLng = 111320 * Math.cos(lat0 * RAD);
  const cell = Math.max(30, Math.round(radiusM / 160));
  const n = Math.ceil(radiusM / cell);
  const size = 2 * n + 1;
  const grid = new Uint8Array(size * size); // 0 untouched, 1 hidden, 2 visible
  const rays = Math.ceil((2 * Math.PI * radiusM) / (0.7 * cell));
  const step = cell / 2;
  let farthest = 0;
  let highest = -Infinity;
  const hAng = new Float32Array(HORIZON_BINS).fill(-90);
  const hDist = new Float32Array(HORIZON_BINS);

  for (let r = 0; r < rays; r++) {
    const az = (r / rays) * 2 * Math.PI;
    const dx = Math.sin(az);
    const dy = Math.cos(az);
    let maxSlope = -Infinity;
    let maxAt = 0;
    for (let d = step; d <= radiusM; d += step) {
      const lg = lng0 + (dx * d) / mLng;
      const lt = lat0 + (dy * d) / mLat;
      let z = dem.at(lg, lt);
      if (!Number.isFinite(z)) continue;
      if (obs && d > OWN_CLEARANCE) z += obs.at(lg, lt);
      const drop = ((d * d) / (2 * EARTH_R)) * (1 - REFRACTION);
      const slope = (z - drop - z0) / d;
      const vis = slope >= maxSlope;
      if (slope > maxSlope) {
        maxSlope = slope;
        maxAt = d;
      }
      const ix = Math.round((dx * d) / cell) + n;
      const iy = n - Math.round((dy * d) / cell);
      const k = iy * size + ix;
      if (vis) {
        grid[k] = 2;
        if (d > farthest) farthest = d;
        if (z > highest) highest = z;
      } else if (grid[k] === 0) grid[k] = 1;
    }
    if (!lite && Number.isFinite(maxSlope)) {
      const b = Math.round((az / (2 * Math.PI)) * HORIZON_BINS) % HORIZON_BINS;
      const a = Math.atan(maxSlope) / RAD;
      if (a > hAng[b]) {
        hAng[b] = a;
        hDist[b] = maxAt;
      }
    }
  }
  grid[n * size + n] = 2;

  // a bin no ray landed on takes the value of the nearest bin that has one
  if (!lite) {
    for (let b = 0; b < HORIZON_BINS; b++) {
      if (hAng[b] > -90) continue;
      for (let o = 1; o < HORIZON_BINS / 2; o++) {
        const nb = hAng[(b + o) % HORIZON_BINS] > -90 ? (b + o) % HORIZON_BINS : hAng[(b - o + HORIZON_BINS) % HORIZON_BINS] > -90 ? (b - o + HORIZON_BINS) % HORIZON_BINS : -1;
        if (nb >= 0) {
          hAng[b] = hAng[nb];
          hDist[b] = hDist[nb];
          break;
        }
      }
    }
  }

  const canvas = lite ? null : document.createElement('canvas');
  if (canvas) canvas.width = canvas.height = size;
  const ctx = canvas ? canvas.getContext('2d')! : null;
  const img = ctx ? ctx.createImageData(size, size) : null;
  let seen = 0;
  let total = 0;
  for (let i = 0; i < grid.length; i++) {
    const g = grid[i];
    if (!g) continue;
    total++;
    const o = i * 4;
    if (g === 2) {
      seen++;
      img?.data.set([20, 184, 166, 150], o);
    } else img?.data.set([8, 20, 32, 120], o);
  }
  if (ctx && img) ctx.putImageData(img, 0, 0);

  const halfLng = ((n + 0.5) * cell) / mLng;
  const halfLat = ((n + 0.5) * cell) / mLat;
  return {
    canvas,
    horizon: lite ? null : { angle: hAng, dist: hDist },
    coordinates: [
      [lng0 - halfLng, lat0 + halfLat],
      [lng0 + halfLng, lat0 + halfLat],
      [lng0 + halfLng, lat0 - halfLat],
      [lng0 - halfLng, lat0 - halfLat],
    ],
    groundM: ground,
    visiblePct: total ? (seen / total) * 100 : 0,
    farthestM: farthest,
    highestVisibleM: Number.isFinite(highest) ? highest : ground,
  };
}
