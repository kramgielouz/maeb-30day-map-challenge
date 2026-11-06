import { useEffect, useMemo, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { boundsOf, inverseMask, polygonsOf } from '../../core/geo';

// Data is produced by pipeline/01_osm_facilities.py
const FAC_URL = '/data/day01-facilities.geojson';
const BND_URL = '/data/butuan-boundary.geojson';

const FAC = 'd01-facilities';
const BND = 'd01-boundary';
const MASK = 'd01-mask';
const LAYERS = ['d01-mask', 'd01-area', 'd01-glow', 'd01-casing', 'd01-edge', FAC];
const SOURCES = [FAC, BND, MASK];

const KINDS: Record<string, { label: string; color: string }> = {
  hospital: { label: 'Hospital', color: '#e11d48' },
  clinic: { label: 'Clinic / health centre', color: '#f97316' },
  school: { label: 'School', color: '#2563eb' },
  fire_station: { label: 'Fire station', color: '#b91c1c' },
  police: { label: 'Police', color: '#334155' },
};

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
    const popup = new maplibregl.Popup({ closeButton: false, offset: 8 });

    Promise.allSettled([getJson(BND_URL), getJson(FAC_URL)]).then(([bnd, fac]) => {
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

      // 2. Facilities
      if (fac.status === 'fulfilled') {
        const feats = fac.value.features as { properties: { kind: string } }[];
        const c: Record<string, number> = {};
        feats.forEach((f) => (c[f.properties.kind] = (c[f.properties.kind] ?? 0) + 1));
        setCounts(c);

        map.addSource(FAC, { type: 'geojson', data: fac.value });
        map.addLayer({
          id: FAC,
          type: 'circle',
          source: FAC,
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3, 15, 8],
            'circle-color': [
              'match',
              ['get', 'kind'],
              ...Object.entries(KINDS).flatMap(([k, v]) => [k, v.color]),
              '#888',
            ] as unknown as maplibregl.ExpressionSpecification,
            'circle-stroke-color': '#fff',
            'circle-stroke-width': 1.2,
          },
        });
        map.on('mousemove', FAC, (e) => {
          map.getCanvas().style.cursor = 'pointer';
          const f = e.features?.[0];
          if (!f) return;
          const p = f.properties as Record<string, string>;
          popup
            .setLngLat(e.lngLat)
            .setHTML(`<strong>${p.name || '(unnamed)'}</strong><br/>${KINDS[p.kind]?.label ?? p.kind}`)
            .addTo(map);
        });
        map.on('mouseleave', FAC, () => {
          map.getCanvas().style.cursor = '';
          popup.remove();
        });
      }

      if (bnd.status === 'rejected' || fac.status === 'rejected') setMissing(true);
    });

    return () => {
      cancelled = true;
      popup.remove();
      LAYERS.forEach((l) => map.getLayer(l) && map.removeLayer(l));
      SOURCES.forEach((s) => map.getSource(s) && map.removeSource(s));
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
          <span className="swatch" style={{ background: v.color }} />
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
