import { useEffect, useState } from 'react';
import maplibregl from 'maplibre-gl';

// Data is produced by pipeline/01_osm_facilities.py -> public/data/day01-facilities.geojson
const URL = '/data/day01-facilities.geojson';
const SRC = 'd01-facilities';

const KINDS: Record<string, { label: string; color: string }> = {
  hospital: { label: 'Hospital', color: '#d7263d' },
  clinic: { label: 'Clinic / health centre', color: '#f46036' },
  school: { label: 'School', color: '#2e86ab' },
  fire_station: { label: 'Fire station', color: '#8d0801' },
  police: { label: 'Police', color: '#1b263b' },
};

export default function Day01({ map }: { map: maplibregl.Map }) {
  const [count, setCount] = useState<number | null>(null);
  const [missing, setMissing] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const popup = new maplibregl.Popup({ closeButton: false, offset: 8 });

    fetch(URL)
      .then((r) => {
        if (!r.ok) throw new Error('missing');
        return r.json();
      })
      .then((gj) => {
        if (cancelled) return;
        setCount(gj.features.length);
        map.addSource(SRC, { type: 'geojson', data: gj });
        map.addLayer({
          id: SRC,
          type: 'circle',
          source: SRC,
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3, 15, 8],
            'circle-color': [
              'match',
              ['get', 'kind'],
              ...Object.entries(KINDS).flatMap(([k, v]) => [k, v.color]),
              '#888',
            ] as unknown as maplibregl.ExpressionSpecification,
            'circle-stroke-color': '#fff',
            'circle-stroke-width': 1,
          },
        });
        map.on('mousemove', SRC, (e) => {
          map.getCanvas().style.cursor = 'pointer';
          const f = e.features?.[0];
          if (!f) return;
          const p = f.properties as Record<string, string>;
          popup
            .setLngLat(e.lngLat)
            .setHTML(`<strong>${p.name || '(unnamed)'}</strong><br/>${KINDS[p.kind]?.label ?? p.kind}`)
            .addTo(map);
        });
        map.on('mouseleave', SRC, () => {
          map.getCanvas().style.cursor = '';
          popup.remove();
        });
      })
      .catch(() => !cancelled && setMissing(true));

    return () => {
      cancelled = true;
      popup.remove();
      if (map.getLayer(SRC)) map.removeLayer(SRC);
      if (map.getSource(SRC)) map.removeSource(SRC);
    };
  }, [map]);

  // Legend toggles filter the layer
  useEffect(() => {
    if (!map.getLayer(SRC)) return;
    map.setFilter(SRC, hidden.size ? ['!', ['in', ['get', 'kind'], ['literal', [...hidden]]]] : null);
  }, [hidden, map, count]);

  return (
    <div className="legend">
      <h4>Facility type</h4>
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
          {v.label}
        </label>
      ))}
      {count !== null && <p className="muted">{count} features</p>}
      {missing && (
        <p className="warn">
          No data yet. Run <code>python pipeline/01_osm_facilities.py</code> to create <code>public/data/day01-facilities.geojson</code>.
        </p>
      )}
    </div>
  );
}
