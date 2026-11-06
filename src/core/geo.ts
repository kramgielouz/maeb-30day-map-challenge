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

// A world-sized polygon with the given polygons cut out. Fill it to dim everything outside.
export function inverseMask(polys: PolygonCoords[]) {
  const world: Ring = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
  return {
    type: 'Feature' as const,
    properties: {},
    geometry: { type: 'Polygon' as const, coordinates: [world, ...polys.map((p) => p[0])] },
  };
}
