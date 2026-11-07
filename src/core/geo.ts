// Tiny GeoJSON helpers (no extra dependencies).
type Ring = number[][];
export type PolygonCoords = Ring[]; // [outer, ...holes]

// Accepts a FeatureCollection, Feature, Polygon or MultiPolygon and returns all polygons.
export function polygonsOf(gj: any): PolygonCoords[] {
  if (!gj) return [];
  if (gj.type === 'FeatureCollection') return gj.features.flatMap(polygonsOf);
  if (gj.type === 'Feature') return polygonsOf(gj.geometry);
  if (gj.type === 'Polygon') return [gj.coordinates];
  if (gj.type === 'MultiPolygon') return gj.coordinates;
  return [];
}

export function boundsOf(polys: PolygonCoords[]): [[number, number], [number, number]] | null {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const poly of polys)
    for (const [x, y] of poly[0] ?? []) {
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
    }
  return Number.isFinite(w) ? [[w, s], [e, n]] : null;
}

function inRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// True if the point lies inside any polygon (outer ring in, holes out).
export function pointInPolys(x: number, y: number, polys: PolygonCoords[]): boolean {
  return polys.some((p) => inRing(x, y, p[0]) && !p.slice(1).some((h) => inRing(x, y, h)));
}

// A world-sized polygon with the given polygons cut out. Fill it to dim everything outside.
export function inverseMask(polys: PolygonCoords[]) {
  const world: Ring = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
  return {
    type: 'Feature' as const,
    properties: {},
    geometry: { type: 'Polygon' as const, coordinates: [world, ...polys.map((p) => p[0])] },
  };
}

// ---------- measurements ----------
const R_EARTH = 6371008.8;
const RAD = Math.PI / 180;

export function lineLengthM(c: number[][]): number {
  let s = 0;
  for (let i = 1; i < c.length; i++) {
    const [x1, y1] = c[i - 1];
    const [x2, y2] = c[i];
    const dLat = (y2 - y1) * RAD;
    const dLng = (x2 - x1) * RAD;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(y1 * RAD) * Math.cos(y2 * RAD) * Math.sin(dLng / 2) ** 2;
    s += 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  return s;
}

function ringAreaM2(ring: Ring): number {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    a += (x2 - x1) * RAD * (2 + Math.sin(y1 * RAD) + Math.sin(y2 * RAD));
  }
  return Math.abs((a * R_EARTH * R_EARTH) / 2);
}

export function areaM2(gj: any): number {
  return polygonsOf(gj).reduce((s, p) => s + ringAreaM2(p[0]) - p.slice(1).reduce((h, r) => h + ringAreaM2(r), 0), 0);
}

export function coordsBounds(c: number[][]): [[number, number], [number, number]] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of c) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [[w, s], [e, n]];
}

export function mergeBounds(a: [[number, number], [number, number]], b: [[number, number], [number, number]]): [[number, number], [number, number]] {
  return [[Math.min(a[0][0], b[0][0]), Math.min(a[0][1], b[0][1])], [Math.max(a[1][0], b[1][0]), Math.max(a[1][1], b[1][1])]];
}

// Split a line into the runs of vertices that fall inside the polygons.
export function clipLine(coords: number[][], polys: PolygonCoords[]): number[][][] {
  const out: number[][][] = [];
  let cur: number[][] = [];
  for (const c of coords) {
    if (pointInPolys(c[0], c[1], polys)) cur.push(c);
    else {
      if (cur.length > 1) out.push(cur);
      cur = [];
    }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}
