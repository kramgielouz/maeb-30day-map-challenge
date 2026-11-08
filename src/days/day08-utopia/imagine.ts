// Day 8: the imagined architecture. Everything here is invented from the waterway graph by simple rules:
// landing towers with sky-bridges, port-style harbour districts, landmark towers and LED screens.
// Pure geometry, no DOM and no map. Each shape is a "prism": a polygon extruded from `b` to `h` metres.
import { indexEdges, unproject, type Frame, type Network, type Pt } from './graph';

export interface Prism {
  ring: Pt[]; // closed ring, lon/lat
  c: string; // colour
  h: number; // top, metres
  b: number; // base, metres
  g: string; // group: 'hub' | 'landmark' | 'harbour'
  led?: number; // 1 for an LED screen
  ph?: number; // colour-cycle phase, 0..5, for LED screens
}

const rnd = (i: number) => {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

const ngon = (f: Frame, cx: number, cy: number, r: number, n = 8): Pt[] => {
  const ring = Array.from({ length: n }, (_, i) => unproject(f, cx + r * Math.cos((i / n) * 2 * Math.PI + Math.PI / n), cy + r * Math.sin((i / n) * 2 * Math.PI + Math.PI / n)));
  return [...ring, ring[0]];
};

/** Rectangle centred on (cx, cy), `len` long along the unit vector (ux, uy) and `wid` wide. */
const box = (f: Frame, cx: number, cy: number, ux: number, uy: number, len: number, wid: number): Pt[] => {
  const ax = (ux * len) / 2;
  const ay = (uy * len) / 2;
  const bx = (-uy * wid) / 2;
  const by = (ux * wid) / 2;
  const ring = [unproject(f, cx - ax + bx, cy - ay + by), unproject(f, cx + ax + bx, cy + ay + by), unproject(f, cx + ax - bx, cy + ay - by), unproject(f, cx - ax - bx, cy - ay - by)];
  return [...ring, ring[0]];
};

/** A thin rectangle from (ax, ay) to (bx, by). */
const bar = (f: Frame, ax: number, ay: number, bx: number, by: number, w: number): Pt[] => {
  const l = Math.hypot(bx - ax, by - ay) || 1;
  return box(f, (ax + bx) / 2, (ay + by) / 2, (bx - ax) / l, (by - ay) / l, l, w);
};

export interface Axes {
  x: number; // landing position, metres
  y: number;
  ux: number; // along the channel
  uy: number;
  nx: number; // across the channel
  ny: number;
  width: number; // channel width, metres
}

/** The direction of the widest channel at a landing, so towers and harbours line up with it. */
export function axesAt(net: Network, node: number, widths: Record<string, number>): Axes | null {
  const adj = net.adj[node];
  if (!adj.length) return null;
  let best = adj[0];
  let bw = -1;
  for (const ei of adj) {
    const w = widths[net.edges[ei].cls] ?? 0;
    if (w > bw) {
      bw = w;
      best = ei;
    }
  }
  const e = net.edges[best];
  const o = e.a === node ? e.b : e.a;
  let ux = net.x[o] - net.x[node];
  let uy = net.y[o] - net.y[node];
  const l = Math.hypot(ux, uy) || 1;
  ux /= l;
  uy /= l;
  return { x: net.x[node], y: net.y[node], ux, uy, nx: -uy, ny: ux, width: Math.max(bw, 8) };
}

export const LED_COLOURS = ['#ff3d81', '#ffb300', '#7cff6b', '#b388ff', '#ffffff', '#ff6e40'];

// ---------- landing towers: a pair framing the channel, joined by a sky-bridge ----------
export function hubTowers(f: Frame, a: Axes, facilities: number, seed: number): Prism[] {
  const out: Prism[] = [];
  const off = 70;
  const H = 70 + Math.min(facilities, 12) * 8;
  for (const side of [1, -1]) {
    const cx = a.x + a.nx * off * side;
    const cy = a.y + a.ny * off * side;
    const hh = side === 1 ? H : H * 0.78;
    out.push({ ring: ngon(f, cx, cy, 26), c: '#5b21b6', h: 16, b: 0, g: 'hub' }); // podium
    out.push({ ring: ngon(f, cx, cy, 15), c: '#e2e8f0', h: hh, b: 16, g: 'hub' }); // tower
    out.push({ ring: ngon(f, cx, cy, 9), c: '#fb923c', h: hh + 14, b: hh, g: 'hub' }); // crown
    out.push({ ring: ngon(f, cx, cy, 2.5, 6), c: '#ffffff', h: hh + 48, b: hh + 14, g: 'hub' }); // spire
  }
  out.push({ ring: bar(f, a.x - a.nx * (off - 14), a.y - a.ny * (off - 14), a.x + a.nx * (off - 14), a.y + a.ny * (off - 14), 6), c: '#f1f5f9', h: 38, b: 34, g: 'hub' });
  // an LED screen on the channel-facing side of the taller tower
  const sx = a.x + a.nx * (off - 15.8);
  const sy = a.y + a.ny * (off - 15.8);
  out.push({ ring: box(f, sx, sy, a.ux, a.uy, 11, 1.6), c: '#ff3d81', h: 24 + H * 0.55, b: 24, g: 'hub', led: 1, ph: Math.floor(rnd(seed) * 6) });
  return out;
}

// ---------- a port-style harbour district on one bank ----------
const CONTAINERS = ['#ef4444', '#3b82f6', '#f59e0b', '#10b981', '#a855f7', '#f8fafc', '#fb7185'];

export function harbour(net: Network, f: Frame, a: Axes, seed: number): Prism[] {
  const idx = indexEdges(net, false);
  const W = a.width;
  // build on the bank with more room: not near any other channel
  const free = (s: number) => !idx.within(a.x + a.nx * s * (W / 2 + 55), a.y + a.ny * s * (W / 2 + 55), 45);
  const side = free(1) || !free(-1) ? 1 : -1;
  const vx = a.nx * side;
  const vy = a.ny * side;
  const at = (u: number, v: number): Pt => [a.x + a.ux * u + vx * v, a.y + a.uy * u + vy * v];
  const out: Prism[] = [];
  const P = (ring: Pt[], c: string, h: number, b = 0) => out.push({ ring, c, h, b, g: 'harbour' });

  // quay along the bank
  {
    const [cx, cy] = at(0, W / 2 + 9);
    P(box(f, cx, cy, a.ux, a.uy, 210, 12), '#94a3b8', 2.5);
  }
  // container yard: 3 rows of stacks
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 9; c++) {
      const [cx, cy] = at((c - 4) * 13, W / 2 + 24 + r * 7);
      const levels = 1 + Math.floor(rnd(seed * 31 + r * 9 + c) * 3);
      P(box(f, cx, cy, a.ux, a.uy, 11, 5.5), CONTAINERS[Math.floor(rnd(seed * 17 + r * 11 + c * 3) * CONTAINERS.length)], 2.6 * levels);
    }
  // two warehouse sheds behind the yard
  for (const u of [-45, 45]) {
    const [cx, cy] = at(u, W / 2 + 62);
    P(box(f, cx, cy, a.ux, a.uy, 70, 22), '#475569', 11);
  }
  // two gantry cranes: legs on the quay, a boom reaching out over the water
  for (const u of [-34, 34]) {
    for (const du of [-6, 6]) {
      const [cx, cy] = at(u + du, W / 2 + 7);
      P(box(f, cx, cy, a.ux, a.uy, 2.4, 2.4), '#fb923c', 36);
    }
    const [x0, y0] = at(u, W / 2 + 20);
    const [x1, y1] = at(u, Math.max(W / 2 - 18, 2));
    P(bar(f, x0, y0, x1, y1, 3), '#fdba74', 40, 36);
  }
  // control tower with a glass cab
  {
    const [cx, cy] = at(78, W / 2 + 14);
    P(ngon(f, cx, cy, 5), '#cbd5e1', 52);
    P(ngon(f, cx, cy, 8), '#fde047', 60, 52);
  }
  // floating berths for the boats
  for (const u of [-30, 30]) {
    const [cx, cy] = at(u, Math.max(W / 2 - 7, 3));
    P(box(f, cx, cy, a.ux, a.uy, 46, 4), '#fde68a', 0.9);
  }
  return out;
}

// ---------- landmark towers around the busiest landing ----------
export function landmarks(f: Frame, a: Axes, seed: number): Prism[] {
  const out: Prism[] = [];
  const at = (u: number, v: number): Pt => [a.x + a.ux * u + a.nx * v, a.y + a.uy * u + a.ny * v];
  const P = (ring: Pt[], c: string, h: number, b: number) => out.push({ ring, c, h, b, g: 'landmark' });
  const led = (cx: number, cy: number, faceU: number, faceV: number, len: number, b: number, h: number, k: number) =>
    out.push({ ring: box(f, cx + faceU, cy + faceV, a.ux, a.uy, len, 1.6), c: '#ff3d81', h, b, g: 'landmark', led: 1, ph: Math.floor(rnd(seed + k) * 6) });

  // 1. the Spire: five round tiers
  {
    const [cx, cy] = at(40, 170);
    const tiers: [number, number, number, string][] = [
      [24, 0, 60, '#6d28d9'],
      [18, 60, 120, '#a855f7'],
      [12, 120, 180, '#f472b6'],
      [7, 180, 230, '#fda4af'],
      [2.5, 230, 280, '#ffffff'],
    ];
    for (const [r, b, h, c] of tiers) P(ngon(f, cx, cy, r, 12), c, h, b);
    led(cx, cy, -a.nx * 24.9, -a.ny * 24.9, 14, 10, 52, 1);
  }
  // 2. the Stepped tower: square tiers shrinking upward
  {
    const [cx, cy] = at(-60, -175);
    const tiers: [number, number, number, string][] = [
      [56, 0, 40, '#9d174d'],
      [44, 40, 85, '#be185d'],
      [32, 85, 135, '#fb7185'],
      [20, 135, 190, '#fecdd3'],
      [10, 190, 240, '#ffffff'],
    ];
    for (const [s, b, h, c] of tiers) P(box(f, cx, cy, a.ux, a.uy, s, s), c, h, b);
    led(cx, cy, a.nx * 28.9, a.ny * 28.9, 30, 6, 36, 2);
    led(cx, cy, a.nx * 22.9, a.ny * 22.9, 26, 46, 80, 3);
  }
  // 3. the Twin towers joined near the top
  {
    const [cx, cy] = at(-140, 195);
    for (const du of [-24, 24]) {
      const [x, y] = [cx + a.ux * du, cy + a.uy * du];
      P(box(f, x, y, a.ux, a.uy, 20, 20), '#c084fc', 210, 0);
      P(box(f, x, y, a.ux, a.uy, 12, 12), '#f0abfc', 235, 210);
    }
    P(box(f, cx, cy, a.ux, a.uy, 30, 8), '#fdf4ff', 160, 150);
    led(cx - a.ux * 24, cy - a.uy * 24, -a.nx * 10.9, -a.ny * 10.9, 9, 30, 170, 4);
  }
  return out;
}

export interface Layout {
  prisms: Prism[]; // hub towers, landmarks, LED screens (these follow the skyline slider)
  harbours: Prism[]; // port districts (these do not)
  harbourNodes: number[];
  downtown: number; // node of the busiest landing, -1 if none
}

/**
 * Lays out the whole imagined city from the landings. `fac[i]` is the number of facilities near landing i;
 * `widths` is the imagined channel width per class.
 */
export function layout(net: Network, f: Frame, landings: number[], fac: number[], widths: Record<string, number>): Layout {
  const prisms: Prism[] = [];
  const axes = landings.map((n) => axesAt(net, n, widths));
  landings.forEach((_, i) => {
    const a = axes[i];
    if (a) prisms.push(...hubTowers(f, a, fac[i] ?? 0, i + 1));
  });

  // the busiest landing gets the landmarks
  let top = -1;
  fac.forEach((c, i) => {
    if (axes[i] && (top < 0 || c > fac[top])) top = i;
  });
  if (top >= 0) prisms.push(...landmarks(f, axes[top] as Axes, 7));

  // harbours: the busiest landings on the widest channels, at least 1.5 km apart, up to five
  const order = landings
    .map((_, i) => i)
    .filter((i) => axes[i])
    .sort((p, q) => (axes[q]?.width ?? 0) - (axes[p]?.width ?? 0) || fac[q] - fac[p]);
  const widest = axes[order[0]]?.width ?? 0;
  const pick: number[] = [];
  for (const i of order) {
    if (pick.length >= 5) break;
    if ((axes[i]?.width ?? 0) < Math.min(widest, 28)) continue;
    if (pick.every((j) => Math.hypot(net.x[landings[i]] - net.x[landings[j]], net.y[landings[i]] - net.y[landings[j]]) >= 1500)) pick.push(i);
  }
  const harbours: Prism[] = [];
  pick.forEach((i) => harbours.push(...harbour(net, f, axes[i] as Axes, i + 3)));

  return { prisms, harbours, harbourNodes: pick.map((i) => landings[i]), downtown: top >= 0 ? landings[top] : -1 };
}
