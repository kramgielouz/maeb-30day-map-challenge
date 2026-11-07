import maplibregl from 'maplibre-gl';
import { boundsOf, inverseMask, polygonsOf, type PolygonCoords } from './geo';

export const BND_URL = '/data/butuan-boundary.geojson';

export interface BoundaryHandle {
  polys: PolygonCoords[];
  bounds: [[number, number], [number, number]] | null;
  remove: () => void;
}

// Adds the city boundary (optional dimming mask, tint, glow, outline) under whatever the day adds next.
// Returns null when public/data/butuan-boundary.geojson is missing.
export async function addBoundary(
  map: maplibregl.Map,
  prefix: string,
  opts: { mask?: boolean; fit?: boolean; signal?: AbortSignal } = {},
): Promise<BoundaryHandle | null> {
  const { mask = true, fit = true, signal } = opts;
  let gj: any;
  try {
    const r = await fetch(BND_URL);
    if (!r.ok) return null;
    gj = await r.json();
  } catch {
    return null;
  }
  if (signal?.aborted) return null; // the day was closed while we were fetching
  const polys = polygonsOf(gj);
  const src = `${prefix}-bnd`;
  const msrc = `${prefix}-bnd-mask`;
  const layers: string[] = [];
  const add = (l: any) => {
    map.addLayer(l);
    layers.push(l.id);
  };

  map.addSource(src, { type: 'geojson', data: gj });
  if (mask) {
    map.addSource(msrc, { type: 'geojson', data: inverseMask(polys) as any });
    add({ id: `${prefix}-bnd-mask`, type: 'fill', source: msrc, paint: { 'fill-color': '#04201f', 'fill-opacity': 0.55 } });
  }
  add({ id: `${prefix}-bnd-area`, type: 'fill', source: src, paint: { 'fill-color': '#14b8a6', 'fill-opacity': mask ? 0.1 : 0 } });
  add({
    id: `${prefix}-bnd-glow`,
    type: 'line',
    source: src,
    layout: { 'line-join': 'round' },
    paint: {
      'line-color': '#2dd4bf',
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 8, 14, 22],
      'line-blur': ['interpolate', ['linear'], ['zoom'], 8, 6, 14, 14],
      'line-opacity': 0.55,
    },
  });
  add({ id: `${prefix}-bnd-casing`, type: 'line', source: src, paint: { 'line-color': '#ffffff', 'line-width': 4, 'line-opacity': 0.85 } });
  add({ id: `${prefix}-bnd-edge`, type: 'line', source: src, layout: { 'line-join': 'round' }, paint: { 'line-color': '#0f766e', 'line-width': 2 } });

  const bounds = boundsOf(polys);
  if (fit && bounds && !new URLSearchParams(window.location.search).has('z')) {
    map.fitBounds(bounds, { padding: 48, duration: 0 });
  }

  return {
    polys,
    bounds,
    remove: () => {
      layers.forEach((l) => map.getLayer(l) && map.removeLayer(l));
      [src, msrc].forEach((s) => map.getSource(s) && map.removeSource(s));
    },
  };
}
