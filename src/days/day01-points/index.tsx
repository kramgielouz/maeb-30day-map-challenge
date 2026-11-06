import { useEffect, useMemo, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { boundsOf, inverseMask, pointInPolys, polygonsOf } from '../../core/geo';
import { KINDS, badgeUrl, imageId, loadBadge } from './icons';

// Data is produced by pipeline/01_osm_facilities.py
const FAC_URL = '/data/day01-facilities.geojson';
const BND_URL = '/data/butuan-boundary.geojson';

const FAC = 'd01-facilities';
const BND = 'd01-boundary';
const MASK = 'd01-mask';
const LAYERS = ['d01-mask', 'd01-area', 'd01-glow', 'd01-casing', 'd01-edge', FAC];
const SOURCES = [FAC, BND, MASK];

const getJson = (u: string) =>
  fetch(u).then((r) => {
    if (!r.ok) throw new Error(u);
    return r.json();
  });

export default function Day01({ map }: { map: maplibregl.Map }) {
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [missing, setMissing] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const popup = new maplibregl.Popup({ closeButton: false, offset: 14 });

    (async () => {
      const [bnd, fac] = await Promise.allSettled([getJson(BND_URL), getJson(FAC_URL)]);
      if (cancelled) return;

      // 1. Boundary: dim the outside, tint the inside, glow the edge
      if (bnd.status === 'fulfilled') {
        const polys = polygonsOf(bnd.value);
        map.addSource(BND, { type: 'geojson', data: bnd.value });
        map.addSource(MASK, { type: 'geojson', data: inverseMask(polys) });

        map.addLayer({ id: 'd01-mask', type: 'fill', source: MASK, paint: { 'fill-color': '#04201f', 'fill-opacity': 0.55 } });
        map.addLayer({ id: 'd01-area', type: 'fill', source: BND, paint: { 'fill-color': '#14b8a6', 'fill-opacity': 0.1 } });
        map.addLayer({
          id: 'd01-glow',
          type: 'line',
          source: BND,
          layout: { 'line-join': 'round' },
          paint: {
            'line-color': '#2dd4bf',
            'line-width': ['interpolate', ['linear'], ['zoom'], 8, 8, 14, 22],
            'line-blur': ['interpolate', ['linear'], ['zoom'], 8, 6, 14, 14],
            'line-opacity': 0.55,
          },
        });
        map.addLayer({ id: 'd01-casing', type: 'line', source: BND, paint: { 'line-color': '#ffffff', 'line-width': 4, 'line-opacity': 0.85 } });
        map.addLayer({ id: 'd01-edge', type: 'line', source: BND, layout: { 'line-join': 'round' }, paint: { 'line-color': '#0f766e', 'line-width': 2 } });

        // Frame the city unless the URL already carries a saved view
        const b = boundsOf(polys);
        if (b && !new URLSearchParams(window.location.search).has('z')) {
          map.fitBounds(b, { padding: 48, duration: 0 });
        }
      }

      // 2. Facilities as icon badges, clipped to the boundary
      if (fac.status === 'fulfilled') {
        const polys = bnd.status === 'fulfilled' ? polygonsOf(bnd.value) : [];
        const feats = (fac.value.features as { geometry: { coordinates: number[] }; properties: { kind: string } }[]).filter(
          (f) => !polys.length || pointInPolys(f.geometry.coordinates[0], f.geometry.coordinates[1], polys),
        );
        const c: Record<string, number> = {};
        feats.forEach((f) => (c[f.properties.kind] = (c[f.properties.kind] ?? 0) + 1));
        setCounts(c);

        // Render each badge once and register it with the map (64 px bitmap shown at 32 px)
        const imgs = await Promise.all(Object.keys(KINDS).map(async (k) => [k, await loadBadge(k)] as const));
        if (cancelled) return;
        imgs.forEach(([k, img]) => {
          if (!map.hasImage(imageId(k))) map.addImage(imageId(k), img, { pixelRatio: 2 });
        });

        map.addSource(FAC, { type: 'geojson', data: { type: 'FeatureCollection', features: feats } as any });
        map.addLayer({
          id: FAC,
          type: 'symbol',
          source: FAC,
          layout: {
            'icon-image': ['concat', 'd01-', ['get', 'kind']],
            'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.28, 10, 0.4, 12, 0.7, 14, 1.05, 17, 1.6],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            // rarer, more critical facilities draw on top of the 300 schools
            'symbol-sort-key': ['match', ['get', 'kind'], 'hospital', 5, 'fire_station', 4, 'police', 4, 'clinic', 3, 1],
          },
        } as maplibregl.LayerSpecification);

        map.on('mousemove', FAC, (e) => {
          map.getCanvas().style.cursor = 'pointer';
          const f = e.features?.[0];
          if (!f) return;
          const p = f.properties as Record<string, string>;
          popup
            .setLngLat((f.geometry as GeoJSON.Point).coordinates as [number, number])
            .setHTML(`<strong>${p.name || '(unnamed)'}</strong><br/>${KINDS[p.kind]?.label ?? p.kind}`)
            .addTo(map);
        });
        map.on('mouseleave', FAC, () => {
          map.getCanvas().style.cursor = '';
          popup.remove();
        });
      }

      if (bnd.status === 'rejected' || fac.status === 'rejected') setMissing(true);
    })();

    return () => {
      cancelled = true;
      popup.remove();
      LAYERS.forEach((l) => map.getLayer(l) && map.removeLayer(l));
      SOURCES.forEach((s) => map.getSource(s) && map.removeSource(s));
      Object.keys(KINDS).forEach((k) => map.hasImage(imageId(k)) && map.removeImage(imageId(k)));
    };
  }, [map]);

  // Legend toggles filter the facility layer
  useEffect(() => {
    if (!map.getLayer(FAC)) return;
    map.setFilter(FAC, hidden.size ? ['!', ['in', ['get', 'kind'], ['literal', [...hidden]]]] : null);
  }, [hidden, map, counts]);

  const total = useMemo(() => (counts ? Object.values(counts).reduce((a, b) => a + b, 0) : null), [counts]);

  return (
    <div className="legend">
      <h4>Facilities in Butuan City</h4>
      {Object.entries(KINDS).map(([k, v]) => (
        <label key={k} className="legend-row">
          <input
            type="checkbox"
            checked={!hidden.has(k)}
            onChange={() =>
              setHidden((h) => {
                const n = new Set(h);
                n.has(k) ? n.delete(k) : n.add(k);
                return n;
              })
            }
          />
          <img src={badgeUrl(k, 40)} width={20} height={20} alt="" />
          <span style={{ flex: 1 }}>{v.label}</span>
          {counts && <span className="muted">{counts[k] ?? 0}</span>}
        </label>
      ))}
      {total !== null && <p className="muted">{total} mapped in OSM</p>}
      {missing && (
        <p className="warn">
          Data missing. Run <code>python pipeline/01_osm_facilities.py</code> to create the boundary and facility files in <code>public/data/</code>.
        </p>
      )}
    </div>
  );
}
