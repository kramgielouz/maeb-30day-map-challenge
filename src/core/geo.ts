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
