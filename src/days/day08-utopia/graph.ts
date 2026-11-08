// Day 8: the waterways as a routable network. Pure geometry and graph code, no DOM and no map, so it can be tested alone.

export type Pt = [number, number];

// ---------- local metric frame ----------
const R = 6371008.8;
const RAD = Math.PI / 180;
export interface Frame {
  lon0: number;
  lat0: number;
  kx: number;
  ky: number;
}
export const makeFrame = (lon0: number, lat0: number): Frame => ({ lon0, lat0, kx: R * RAD * Math.cos(lat0 * RAD), ky: R * RAD });
export const project = (f: Frame, lon: number, lat: number): Pt => [(lon - f.lon0) * f.kx, (lat - f.lat0) * f.ky];
export const unproject = (f: Frame, x: number, y: number): Pt => [x / f.kx + f.lon0, y / f.ky + f.lat0];

// ---------- network ----------
export interface RawLine {
  coords: Pt[]; // lon/lat
  cls: string;
}
export interface Edge {
  a: number;
  b: number;
  len: number;
  cls: string;
}
export interface Network {
  x: Float64Array;
  y: Float64Array;
  edges: Edge[];
  adj: number[][]; // node -> edge ids
  comp: Int32Array; // connected component per node
  compLen: number[]; // total length (m) per component
  main: number; // longest component, -1 when empty
  key: Map<string, number>;
  grid: Map<string, number[]>; // spatial hash of nodes, CELL metres
}

const CELL = 50;
const cellKey = (x: number, y: number) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
const nodeKey = (x: number, y: number) => `${Math.round(x)},${Math.round(y)}`;

class UnionFind {
  p: Int32Array;
  constructor(n: number) {
    this.p = Int32Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.p[i] !== i) {
      this.p[i] = this.p[this.p[i]];
      i = this.p[i];
    }
    return i;
  }
  union(a: number, b: number) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.p[ra] = rb;
  }
}

/**
 * Vertices that coincide (to the metre) become one node, which is how OSM junctions connect. Then every
 * dead end within `gap` metres of a different piece is joined to it, so small mapping gaps do not split the network.
 */
export function buildNetwork(lines: RawLine[], frame: Frame, gap = 12): Network {
  const key = new Map<string, number>();
  const xs: number[] = [];
  const ys: number[] = [];
  const nodeOf = (x: number, y: number) => {
    const k = nodeKey(x, y);
    let id = key.get(k);
    if (id === undefined) {
      id = xs.length;
      key.set(k, id);
      xs.push(x);
      ys.push(y);
    }
    return id;
  };

  const edges: Edge[] = [];
  for (const l of lines) {
    let prev = -1;
    for (const [lon, lat] of l.coords) {
      const [x, y] = project(frame, lon, lat);
      const id = nodeOf(x, y);
      if (prev >= 0 && id !== prev) edges.push({ a: prev, b: id, len: Math.hypot(xs[id] - xs[prev], ys[id] - ys[prev]), cls: l.cls });
      prev = id;
    }
  }

  const n = xs.length;
  const uf = new UnionFind(n);
  const adj: number[][] = Array.from({ length: n }, () => []);
  edges.forEach((e, i) => {
    adj[e.a].push(i);
    adj[e.b].push(i);
    uf.union(e.a, e.b);
  });

  const grid = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const k = cellKey(xs[i], ys[i]);
    const c = grid.get(k);
    if (c) c.push(i);
    else grid.set(k, [i]);
  }

  // close small gaps at dead ends
  const reach = Math.ceil(gap / CELL);
  const ends: number[] = [];
  for (let i = 0; i < n; i++) if (adj[i].length === 1) ends.push(i);
  for (const e of ends) {
    const cx = Math.floor(xs[e] / CELL);
    const cy = Math.floor(ys[e] / CELL);
    let best = -1;
    let bd = gap;
    for (let dx = -reach; dx <= reach; dx++)
      for (let dy = -reach; dy <= reach; dy++) {
        for (const v of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (v === e || uf.find(v) === uf.find(e)) continue;
          const d = Math.hypot(xs[v] - xs[e], ys[v] - ys[e]);
          if (d < bd) {
            bd = d;
            best = v;
          }
        }
      }
    if (best >= 0) {
      const id = edges.length;
      edges.push({ a: e, b: best, len: bd, cls: edges[adj[e][0]].cls });
      adj[e].push(id);
      adj[best].push(id);
      uf.union(e, best);
    }
  }

  const label = new Map<number, number>();
  const comp = new Int32Array(n);
  const compLen: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = uf.find(i);
    let c = label.get(r);
    if (c === undefined) {
      c = label.size;
      label.set(r, c);
      compLen.push(0);
    }
    comp[i] = c;
  }
  for (const e of edges) compLen[comp[e.a]] += e.len;
  let main = -1;
  compLen.forEach((l, c) => {
    if (main < 0 || l > compLen[main]) main = c;
  });

  return { x: Float64Array.from(xs), y: Float64Array.from(ys), edges, adj, comp, compLen, main, key, grid };
}

export const nodeAt = (net: Network, x: number, y: number): number => net.key.get(nodeKey(x, y)) ?? -1;

/** Nearest network node within maxD metres, or -1. */
export function nearestNode(net: Network, x: number, y: number, maxD: number, onlyMain = true): number {
  const reach = Math.ceil(maxD / CELL);
  const cx = Math.floor(x / CELL);
  const cy = Math.floor(y / CELL);
  let best = -1;
  let bd = maxD;
  for (let dx = -reach; dx <= reach; dx++)
    for (let dy = -reach; dy <= reach; dy++)
      for (const v of net.grid.get(`${cx + dx},${cy + dy}`) ?? []) {
        if (onlyMain && net.comp[v] !== net.main) continue;
        const d = Math.hypot(net.x[v] - x, net.y[v] - y);
        if (d < bd) {
          bd = d;
          best = v;
        }
      }
  return best;
}

// ---------- shortest path (by travel time) ----------
class MinHeap {
  k: number[] = [];
  v: number[] = [];
  get size() {
    return this.k.length;
  }
  push(key: number, val: number) {
    let i = this.k.length;
    this.k.push(key);
    this.v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= this.k[i]) break;
      [this.k[p], this.k[i]] = [this.k[i], this.k[p]];
      [this.v[p], this.v[i]] = [this.v[i], this.v[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const top: [number, number] = [this.k[0], this.v[0]];
    const lk = this.k.pop() as number;
    const lv = this.v.pop() as number;
    if (this.k.length) {
      this.k[0] = lk;
      this.v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.k.length && this.k[l] < this.k[m]) m = l;
        if (r < this.k.length && this.k[r] < this.k[m]) m = r;
        if (m === i) break;
        [this.k[m], this.k[i]] = [this.k[i], this.k[m]];
        [this.v[m], this.v[i]] = [this.v[i], this.v[m]];
        i = m;
      }
    }
    return top;
  }
}

export type Speeds = Record<string, number>; // metres per second, by class

export interface Route {
  nodes: number[];
  seconds: number;
  metres: number;
}

export function shortest(net: Network, src: number, dst: number, speed: Speeds): Route | null {
  if (src < 0 || dst < 0) return null;
  const n = net.x.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const heap = new MinHeap();
  dist[src] = 0;
  heap.push(0, src);
  while (heap.size) {
    const [d, u] = heap.pop();
    if (d > dist[u]) continue;
    if (u === dst) break;
    for (const ei of net.adj[u]) {
      const e = net.edges[ei];
      const v = e.a === u ? e.b : e.a;
      const nd = d + e.len / (speed[e.cls] || 1);
      if (nd < dist[v]) {
        dist[v] = nd;
        prev[v] = u;
        heap.push(nd, v);
      }
    }
  }
  if (!Number.isFinite(dist[dst])) return null;
  const nodes: number[] = [];
  for (let v = dst; v !== -1; v = prev[v]) nodes.push(v);
  nodes.reverse();
  let metres = 0;
  for (let i = 1; i < nodes.length; i++) metres += Math.hypot(net.x[nodes[i]] - net.x[nodes[i - 1]], net.y[nodes[i]] - net.y[nodes[i - 1]]);
  return { nodes, seconds: dist[dst], metres };
}

// ---------- a route as a polyline you can move along ----------
export interface Path {
  xs: Float64Array;
  ys: Float64Array;
  t: Float64Array; // seconds from the start, per vertex
  d: Float64Array; // metres from the start, per vertex
}

export function makePath(net: Network, route: Route, speed: Speeds): Path {
  const m = route.nodes.length;
  const xs = new Float64Array(m);
  const ys = new Float64Array(m);
  const t = new Float64Array(m);
  const d = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    xs[i] = net.x[route.nodes[i]];
    ys[i] = net.y[route.nodes[i]];
    if (i === 0) continue;
    const a = route.nodes[i - 1];
    const b = route.nodes[i];
    // the class of the edge joining a and b (the fastest one if several run in parallel)
    let sp = 0;
    for (const ei of net.adj[a]) {
      const e = net.edges[ei];
      if ((e.a === a && e.b === b) || (e.b === a && e.a === b)) sp = Math.max(sp, speed[e.cls] || 1);
    }
    const len = Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    d[i] = d[i - 1] + len;
    t[i] = t[i - 1] + len / (sp || 1);
  }
  return { xs, ys, t, d };
}

const seg = (arr: Float64Array, v: number): number => {
  let lo = 0;
  let hi = arr.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= v) lo = mid;
    else hi = mid;
  }
  return lo;
};

/** Position and heading (degrees clockwise from north) after `time` seconds. Clamped to the ends. */
export function positionAt(p: Path, time: number): { x: number; y: number; heading: number; dist: number } {
  const last = p.t.length - 1;
  if (last < 1) return { x: p.xs[0] ?? 0, y: p.ys[0] ?? 0, heading: 0, dist: 0 };
  const tt = Math.min(Math.max(time, 0), p.t[last]);
  const i = Math.min(seg(p.t, tt), last - 1);
  const span = p.t[i + 1] - p.t[i];
  const f = span > 0 ? (tt - p.t[i]) / span : 0;
  const dx = p.xs[i + 1] - p.xs[i];
  const dy = p.ys[i + 1] - p.ys[i];
  return { x: p.xs[i] + dx * f, y: p.ys[i] + dy * f, heading: (Math.atan2(dx, dy) / RAD + 360) % 360, dist: p.d[i] + (p.d[i + 1] - p.d[i]) * f };
}

/** Point at a given distance along the path (for wake trails). */
export function pointAtDist(p: Path, dist: number): Pt {
  const last = p.d.length - 1;
  if (last < 1) return [p.xs[0] ?? 0, p.ys[0] ?? 0];
  const dd = Math.min(Math.max(dist, 0), p.d[last]);
  const i = Math.min(seg(p.d, dd), last - 1);
  const span = p.d[i + 1] - p.d[i];
  const f = span > 0 ? (dd - p.d[i]) / span : 0;
  return [p.xs[i] + (p.xs[i + 1] - p.xs[i]) * f, p.ys[i] + (p.ys[i + 1] - p.ys[i]) * f];
}

// ---------- distance to a set of segments ----------
export class SegIndex {
  private cells = new Map<string, number[]>();
  private s: number[] = [];
  constructor(private cell = 400) {}
  add(ax: number, ay: number, bx: number, by: number) {
    const id = this.s.length / 4;
    this.s.push(ax, ay, bx, by);
    const x0 = Math.floor(Math.min(ax, bx) / this.cell);
    const x1 = Math.floor(Math.max(ax, bx) / this.cell);
    const y0 = Math.floor(Math.min(ay, by) / this.cell);
    const y1 = Math.floor(Math.max(ay, by) / this.cell);
    for (let cx = x0; cx <= x1; cx++)
      for (let cy = y0; cy <= y1; cy++) {
        const k = `${cx},${cy}`;
        const c = this.cells.get(k);
        if (c) c.push(id);
        else this.cells.set(k, [id]);
      }
  }
  /** True if some segment is within r metres of (x, y). r must not exceed the cell size. */
  within(x: number, y: number, r: number): boolean {
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const id of this.cells.get(`${cx + dx},${cy + dy}`) ?? []) {
          const [ax, ay, bx, by] = [this.s[id * 4], this.s[id * 4 + 1], this.s[id * 4 + 2], this.s[id * 4 + 3]];
          const vx = bx - ax;
          const vy = by - ay;
          const L = vx * vx + vy * vy;
          const t = L ? Math.min(1, Math.max(0, ((x - ax) * vx + (y - ay) * vy) / L)) : 0;
          if (Math.hypot(x - (ax + vx * t), y - (ay + vy * t)) <= r) return true;
        }
    return false;
  }
}

export function indexEdges(net: Network, onlyMain: boolean): SegIndex {
  const idx = new SegIndex();
  for (const e of net.edges) {
    if (onlyMain && net.comp[e.a] !== net.main) continue;
    idx.add(net.x[e.a], net.y[e.a], net.x[e.b], net.y[e.b]);
  }
  return idx;
}

export function indexPath(p: Path): SegIndex {
  const idx = new SegIndex();
  for (let i = 1; i < p.xs.length; i++) idx.add(p.xs[i - 1], p.ys[i - 1], p.xs[i], p.ys[i]);
  return idx;
}

// ---------- where to put landings ----------
/**
 * Greedy: the node with the most facilities within `radius` metres first, then the next best one at least `spacing`
 * metres away from every landing chosen so far, up to `max`. With no facilities it still spreads landings out.
 */
export function chooseLandings(net: Network, facilities: Pt[], o: { spacing: number; radius: number; max: number }): number[] {
  if (net.main < 0) return [];
  const fg = new Map<string, number[]>();
  facilities.forEach(([x, y], i) => {
    const k = `${Math.floor(x / o.radius)},${Math.floor(y / o.radius)}`;
    const c = fg.get(k);
    if (c) c.push(i);
    else fg.set(k, [i]);
  });
  const score = (x: number, y: number) => {
    let s = 0;
    const cx = Math.floor(x / o.radius);
    const cy = Math.floor(y / o.radius);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const i of fg.get(`${cx + dx},${cy + dy}`) ?? []) if (Math.hypot(facilities[i][0] - x, facilities[i][1] - y) <= o.radius) s++;
    return s;
  };
  const cand: { id: number; s: number }[] = [];
  for (let i = 0; i < net.x.length; i++) if (net.comp[i] === net.main) cand.push({ id: i, s: score(net.x[i], net.y[i]) });
  cand.sort((a, b) => b.s - a.s || a.id - b.id);
  const out: number[] = [];
  for (const c of cand) {
    if (out.length >= o.max) break;
    if (out.every((q) => Math.hypot(net.x[q] - net.x[c.id], net.y[q] - net.y[c.id]) >= o.spacing)) out.push(c.id);
  }
  return out;
}
