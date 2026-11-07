// Pure geometry for Day 3 "Who is nearest?": Voronoi cells, rasterising the city, nearest-site statistics.
// No dependencies, no DOM, so it can be tested on its own.

export type Pt = [number, number];
export type Box = [number, number, number, number]; // minx, miny, maxx, maxy

const R = 6371008.8;
const RAD = Math.PI / 180;

// ---------- local metric frame (metres), accurate enough at city scale ----------
export interface Frame {
  lon0: number;
  lat0: number;
  kx: number;
  ky: number;
}
export function makeFrame(lon0: number, lat0: number): Frame {
  return { lon0, lat0, kx: R * RAD * Math.cos(lat0 * RAD), ky: R * RAD };
}
export const project = (f: Frame, lon: number, lat: number): Pt => [(lon - f.lon0) * f.kx, (lat - f.lat0) * f.ky];
export const unproject = (f: Frame, x: number, y: number): Pt => [x / f.kx + f.lon0, y / f.ky + f.lat0];

// ---------- Voronoi by half-plane clipping ----------
// Keeps the points p with a*x + b*y <= c (Sutherland-Hodgman against one line; the cell is convex).
function clip(poly: Pt[], a: number, b: number, c: number): Pt[] {
  const out: Pt[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    const dp = a * p[0] + b * p[1] - c;
    const dq = a * q[0] + b * q[1] - c;
    if (dp <= 0) out.push(p);
    if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) {
      const t = dp / (dp - dq);
      out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
    }
  }
  return out;
}

const maxR2 = (cell: Pt[]) => cell.reduce((m, [x, y]) => Math.max(m, x * x + y * y), 0);

/**
 * One convex cell per site, each clipped to `box`. Cells are computed relative to their own site
 * (better numerics), neighbours are tried nearest-first, and the loop stops as soon as the next
 * neighbour is too far away to cut the cell, so it is close to O(n log n) per site in practice.
 */
export function voronoiCells(sites: Pt[], box: Box): Pt[][] {
  const n = sites.length;
  const out: Pt[][] = [];
  for (let i = 0; i < n; i++) {
    const [sx, sy] = sites[i];
    let cell: Pt[] = [
      [box[0] - sx, box[1] - sy],
      [box[2] - sx, box[1] - sy],
      [box[2] - sx, box[3] - sy],
      [box[0] - sx, box[3] - sy],
    ];
    const order: { dx: number; dy: number; d2: number }[] = [];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const dx = sites[j][0] - sx;
      const dy = sites[j][1] - sy;
      order.push({ dx, dy, d2: dx * dx + dy * dy });
    }
    order.sort((p, q) => p.d2 - q.d2);
    let r2 = maxR2(cell);
    for (const { dx, dy, d2 } of order) {
      if (d2 > 4 * r2) break; // its bisector lies beyond the farthest corner of the cell
      if (d2 === 0) continue; // identical site: merge these first (see mergeNear)
      cell = clip(cell, dx, dy, d2 / 2); // closer to site i than to site j
      if (cell.length < 3) break;
      r2 = maxR2(cell);
    }
    out.push(cell.map(([x, y]) => [x + sx, y + sy] as Pt));
  }
  return out;
}

/** Group points that lie within `tol` metres of a group's first point. Returns groups of indices. */
export function mergeNear(pts: Pt[], tol: number): number[][] {
  const groups: number[][] = [];
  const tol2 = tol * tol;
  pts.forEach((p, i) => {
    for (const g of groups) {
      const q = pts[g[0]];
      const dx = p[0] - q[0];
      const dy = p[1] - q[1];
      if (dx * dx + dy * dy <= tol2) {
        g.push(i);
        return;
      }
    }
    groups.push([i]);
  });
  return groups;
}

// ---------- rasterising the city ----------
export interface Grid {
  xs: Float64Array;
  ys: Float64Array;
  step: number;
}

/** Cell-centre points of a `step`-metre grid that fall inside the rings (even-odd, so holes work). */
export function rasterise(rings: Pt[][], step: number): Grid {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const r of rings)
    for (const [x, y] of r) {
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
    }
  const xs: number[] = [];
  const ys: number[] = [];
  if (!Number.isFinite(minx)) return { xs: new Float64Array(0), ys: new Float64Array(0), step };

  for (let y = miny + step / 2; y < maxy; y += step) {
    const cross: number[] = [];
    for (const r of rings) {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [x1, y1] = r[j];
        const [x2, y2] = r[i];
        if (y1 > y !== y2 > y) cross.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
      }
    }
    cross.sort((a, b) => a - b);
    for (let k = 0; k + 1 < cross.length; k += 2) {
      const m0 = Math.ceil((cross[k] - minx) / step - 0.5);
      const m1 = Math.floor((cross[k + 1] - minx) / step - 0.5);
      for (let m = m0; m <= m1; m++) {
        xs.push(minx + (m + 0.5) * step);
        ys.push(y);
      }
    }
  }
  return { xs: Float64Array.from(xs), ys: Float64Array.from(ys), step };
}

// ---------- nearest-site statistics ----------
export interface Assignment {
  site: Int32Array;
  dist: Float32Array; // metres to the nearest site
}

export function assignNearest(xs: Float64Array, ys: Float64Array, sites: Pt[]): Assignment {
  const n = xs.length;
  const site = new Int32Array(n);
  const dist = new Float32Array(n);
  const sx = Float64Array.from(sites, (s) => s[0]);
  const sy = Float64Array.from(sites, (s) => s[1]);
  for (let k = 0; k < n; k++) {
    let best = Infinity;
    let bi = -1;
    for (let i = 0; i < sx.length; i++) {
      const dx = xs[k] - sx[i];
      const dy = ys[k] - sy[i];
      const d = dx * dx + dy * dy;
      if (d < best) {
        best = d;
        bi = i;
      }
    }
    site[k] = bi;
    dist[k] = Math.sqrt(best);
  }
  return { site, dist };
}

export interface SiteStat {
  areaM2: number; // part of the territory that lies inside the city
  maxDist: number; // farthest point of that territory, metres
  bbox: Box | null; // extent of that territory (metres)
}

export function perSite(n: number, grid: Grid, asg: Assignment): SiteStat[] {
  const cnt = new Int32Array(n);
  const mx = new Float32Array(n);
  const bb: Box[] = Array.from({ length: n }, () => [Infinity, Infinity, -Infinity, -Infinity]);
  for (let k = 0; k < grid.xs.length; k++) {
    const s = asg.site[k];
    if (s < 0) continue;
    cnt[s]++;
    if (asg.dist[k] > mx[s]) mx[s] = asg.dist[k];
    const b = bb[s];
    const h = grid.step / 2;
    if (grid.xs[k] - h < b[0]) b[0] = grid.xs[k] - h;
    if (grid.ys[k] - h < b[1]) b[1] = grid.ys[k] - h;
    if (grid.xs[k] + h > b[2]) b[2] = grid.xs[k] + h;
    if (grid.ys[k] + h > b[3]) b[3] = grid.ys[k] + h;
  }
  return Array.from({ length: n }, (_, i) => ({
    areaM2: cnt[i] * grid.step * grid.step,
    maxDist: mx[i],
    bbox: cnt[i] ? bb[i] : null,
  }));
}

export function median(a: Float32Array): number {
  if (!a.length) return 0;
  const s = Float32Array.from(a).sort();
  return s[Math.floor(s.length / 2)];
}

/** Share (0..1) of grid points whose nearest site is within `r` metres. */
export function shareWithin(dist: Float32Array, r: number): number {
  if (!dist.length) return 0;
  let c = 0;
  for (let i = 0; i < dist.length; i++) if (dist[i] <= r) c++;
  return c / dist.length;
}

/** Closed ring approximating a circle of radius r metres. */
export function circle(cx: number, cy: number, r: number, k = 40): Pt[] {
  const ring: Pt[] = [];
  for (let i = 0; i < k; i++) {
    const a = (i / k) * 2 * Math.PI;
    ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  ring.push(ring[0]);
  return ring;
}
