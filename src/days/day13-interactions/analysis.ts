// Day 13: the numbers behind "does the city grow along its roads?". Pure functions, no map or React.
//
// era[i]  = index of the first epoch cell i counted as built (254 = outside the boundary, 255 = never built).
// For each period t (the five years ending at epoch t) there are two groups of cells:
//   new   = cells first built in epoch t
//   avail = land that was still unbuilt when the period began AND lay within `nearCells` cells of the built-up area
//           (the land where growth could plausibly have gone), plus the new cells themselves.
// The question is whether the new cells sit closer to a road than the available land does.

export interface Sets {
  newIdx: Int32Array[]; // by epoch
  availIdx: Int32Array[];
}

// true where any cell of `mask` lies within r cells (a square window), using running sums
export function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  const pre = new Int32Array(Math.max(w, h) + 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) pre[x + 1] = pre[x] + mask[y * w + x];
    for (let x = 0; x < w; x++) tmp[y * w + x] = pre[Math.min(w - 1, x + r) + 1] - pre[Math.max(0, x - r)] > 0 ? 1 : 0;
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) pre[y + 1] = pre[y] + tmp[y * w + x];
    for (let y = 0; y < h; y++) out[y * w + x] = pre[Math.min(h - 1, y + r) + 1] - pre[Math.max(0, y - r)] > 0 ? 1 : 0;
  }
  return out;
}

export function buildSets(era: Uint8Array, w: number, h: number, epochs: number, nearCells = 15): Sets {
  const newIdx: Int32Array[] = [];
  const availIdx: Int32Array[] = [];
  for (let t = 0; t < epochs; t++) {
    if (t === 0) {
      newIdx.push(new Int32Array(0));
      availIdx.push(new Int32Array(0));
      continue;
    }
    const built = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) built[i] = era[i] < t ? 1 : 0; // 254 and 255 are never < t
    const near = dilate(built, w, h, nearCells);
    const n: number[] = [];
    const a: number[] = [];
    for (let i = 0; i < w * h; i++) {
      const e = era[i];
      if (e === 254) continue;
      if (e === t) {
        n.push(i);
        a.push(i);
      } else if (e > t && near[i]) a.push(i);
    }
    newIdx.push(Int32Array.from(n));
    availIdx.push(Int32Array.from(a));
  }
  return { newIdx, availIdx };
}

const median = (idx: Int32Array, d: Float32Array) => {
  if (!idx.length) return NaN;
  const v = Float32Array.from(idx, (i) => d[i]).sort();
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const within = (idx: Int32Array, d: Float32Array, thr: number) => {
  let c = 0;
  for (let k = 0; k < idx.length; k++) if (d[idx[k]] <= thr) c++;
  return c;
};

export interface PeriodStats {
  n: number; // new cells
  nAvail: number;
  medNew: number; // median metres to the nearest road
  medAvail: number;
  shNew: number; // share within thr metres
  shAvail: number;
  lift: number; // shNew / shAvail: 1 = no different from chance
  cNew: number; // counts, for pooling
  cAvail: number;
}

export function periodStats(sets: Sets, dist: Float32Array, t: number, thr: number): PeriodStats {
  const nw = sets.newIdx[t];
  const av = sets.availIdx[t];
  const cNew = within(nw, dist, thr);
  const cAvail = within(av, dist, thr);
  const shNew = nw.length ? cNew / nw.length : NaN;
  const shAvail = av.length ? cAvail / av.length : NaN;
  return { n: nw.length, nAvail: av.length, medNew: median(nw, dist), medAvail: median(av, dist), shNew, shAvail, lift: shAvail > 0 ? shNew / shAvail : NaN, cNew, cAvail };
}

export function pooled(sets: Sets, dist: Float32Array, thr: number, epochs: number) {
  let nNew = 0;
  let cNew = 0;
  let nAv = 0;
  let cAv = 0;
  for (let t = 1; t < epochs; t++) {
    nNew += sets.newIdx[t].length;
    cNew += within(sets.newIdx[t], dist, thr);
    nAv += sets.availIdx[t].length;
    cAv += within(sets.availIdx[t], dist, thr);
  }
  const shNew = nNew ? cNew / nNew : NaN;
  const shAvail = nAv ? cAv / nAv : NaN;
  return { shNew, shAvail, lift: shAvail > 0 ? shNew / shAvail : NaN };
}