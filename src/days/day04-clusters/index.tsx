import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { addBoundary, type BoundaryHandle } from '../../core/boundary';
import { pointInPolys } from '../../core/geo';

// Data is produced by pipeline/04_osm_pois.py
const URL = '/data/day04-pois.geojson';
const CL = 'd04-clustered'; // clustered source
const HT = 'd04-heat'; // plain source for the heatmap
const HOT = 'd04-hotspots';

const GROUPS: Record<string, { label: string; color: string }> = {
  food: { label: 'Food & drink', color: '#f59e0b' },
  retail: { label: 'Shops', color: '#8b5cf6' },
  health: { label: 'Health', color: '#e11d48' },
  education: { label: 'Education', color: '#2563eb' },
  finance: { label: 'Finance', color: '#059669' },
  worship: { label: 'Worship', color: '#a16207' },
  government: { label: 'Government', color: '#334155' },
  lodging: { label: 'Lodging', color: '#0891b2' },
  other: { label: 'Other', color: '#64748b' },
};

const CELL = 0.005; // about 550 m
type Mode = 'clusters' | 'heat';
interface Hot {
  n: number;
  lng: number;
  lat: number;
  top: string;
}

export default function Day04({ map }: { map: maplibregl.Map }) {
  const [all, setAll] = useState<any[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [mode, setMode] = useState<Mode>('clusters');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const ready = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    let bh: BoundaryHandle | null = null;
    const popup = new maplibregl.Popup({ closeButton: false, offset: 8 });

    (async () => {
      bh = await addBoundary(map, 'd04', { signal: ac.signal });
      if (cancelled) return;
      let gj: any;
      try {
        const r = await fetch(URL);
        if (!r.ok) throw new Error('missing');
        gj = await r.json();
      } catch {
        setMissing(true);
        return;
      }
      if (cancelled) return;
      const polys = bh?.polys ?? [];
      const feats = (gj.features as any[]).filter((f) => !polys.length || pointInPolys(f.geometry.coordinates[0], f.geometry.coordinates[1], polys));
      const empty = { type: 'FeatureCollection', features: [] } as any;

      map.addSource(HOT, { type: 'geojson', data: empty });
      map.addSource(HT, { type: 'geojson', data: empty });
      map.addSource(CL, { type: 'geojson', data: empty, cluster: true, clusterRadius: 48, clusterMaxZoom: 15 });

      map.addLayer({
        id: 'd04-heat',
        type: 'heatmap',
        source: HT,
        layout: { visibility: 'none' },
        paint: {
          'heatmap-weight': 1,
          'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 9, 0.6, 15, 2.2],
          'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 9, 8, 13, 22, 16, 46],
          'heatmap-opacity': 0.88,
          'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(255,255,255,0)', 0.15, '#fde68a', 0.4, '#fb923c', 0.7, '#ef4444', 1, '#7f1d1d'],
        },
      } as maplibregl.LayerSpecification);
      map.addLayer({
        id: 'd04-hot',
        type: 'line',
        source: HOT,
        paint: { 'line-color': '#f97316', 'line-width': 2, 'line-dasharray': [2, 1.5] },
      });
      map.addLayer({
        id: 'd04-cl',
        type: 'circle',
        source: CL,
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': ['step', ['get', 'point_count'], '#fcd34d', 10, '#fb923c', 50, '#ef4444', 200, '#991b1b'] as any,
          'circle-radius': ['step', ['get', 'point_count'], 13, 10, 18, 50, 25, 200, 34] as any,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
          'circle-opacity': 0.92,
        },
      });
      map.addLayer({
        id: 'd04-cl-n',
        type: 'symbol',
        source: CL,
        filter: ['has', 'point_count'],
        layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-allow-overlap': true },
        paint: { 'text-color': '#1f1300' },
      } as maplibregl.LayerSpecification);
      map.addLayer({
        id: 'd04-pt',
        type: 'circle',
        source: CL,
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-color': ['match', ['get', 'group'], ...Object.entries(GROUPS).flatMap(([k, v]) => [k, v.color]), '#64748b'] as any,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 3, 17, 7],
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 1,
        },
      });

      map.on('click', 'd04-cl', async (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const src = map.getSource(CL) as maplibregl.GeoJSONSource;
        const zoom = await src.getClusterExpansionZoom(f.properties.cluster_id);
        map.easeTo({ center: (f.geometry as GeoJSON.Point).coordinates as [number, number], zoom: zoom + 0.5 });
      });
      map.on('mouseenter', 'd04-cl', () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', 'd04-cl', () => (map.getCanvas().style.cursor = ''));
      map.on('mousemove', 'd04-pt', (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties as Record<string, string>;
        popup
          .setLngLat((f.geometry as GeoJSON.Point).coordinates as [number, number])
          .setHTML(`<strong>${p.name || '(unnamed)'}</strong><br/>${GROUPS[p.group]?.label ?? p.group}: ${p.cat}`)
          .addTo(map);
      });
      map.on('mouseleave', 'd04-pt', () => popup.remove());

      ready.current = true;
      setAll(feats);
    })();

    return () => {
      cancelled = true;
      ac.abort();
      ready.current = false;
      popup.remove();
      ['d04-pt', 'd04-cl-n', 'd04-cl', 'd04-hot', 'd04-heat'].forEach((l) => map.getLayer(l) && map.removeLayer(l));
      [CL, HT, HOT].forEach((s) => map.getSource(s) && map.removeSource(s));
      bh?.remove();
    };
  }, [map]);

  const filtered = useMemo(() => (all ? all.filter((f) => !hidden.has(f.properties.group)) : null), [all, hidden]);

  // hotspots: busiest ~550 m grid cells
  const hotspots = useMemo<Hot[]>(() => {
    if (!filtered) return [];
    const cells = new Map<string, { n: number; g: Record<string, number>; ix: number; iy: number }>();
    for (const f of filtered) {
      const [x, y] = f.geometry.coordinates;
      const ix = Math.floor(x / CELL);
      const iy = Math.floor(y / CELL);
      const k = `${ix}:${iy}`;
      const c = cells.get(k) ?? { n: 0, g: {}, ix, iy };
      c.n++;
      c.g[f.properties.group] = (c.g[f.properties.group] ?? 0) + 1;
      cells.set(k, c);
    }
    return [...cells.values()]
      .sort((a, b) => b.n - a.n)
      .slice(0, 8)
      .map((c) => ({
        n: c.n,
        lng: (c.ix + 0.5) * CELL,
        lat: (c.iy + 0.5) * CELL,
        top: GROUPS[Object.entries(c.g).sort((a, b) => b[1] - a[1])[0][0]]?.label ?? 'Mixed',
      }));
  }, [filtered]);

  useEffect(() => {
    if (!ready.current || !filtered) return;
    const fc = { type: 'FeatureCollection', features: filtered } as any;
    (map.getSource(CL) as maplibregl.GeoJSONSource)?.setData(fc);
    (map.getSource(HT) as maplibregl.GeoJSONSource)?.setData(fc);
    (map.getSource(HOT) as maplibregl.GeoJSONSource)?.setData({
      type: 'FeatureCollection',
      features: hotspots.map((h) => ({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [h.lng - CELL / 2, h.lat - CELL / 2], [h.lng + CELL / 2, h.lat - CELL / 2],
            [h.lng + CELL / 2, h.lat + CELL / 2], [h.lng - CELL / 2, h.lat + CELL / 2], [h.lng - CELL / 2, h.lat - CELL / 2],
          ]],
        },
      })),
    } as any);
  }, [filtered, hotspots, map]);

  useEffect(() => {
    if (!ready.current) return;
    const vis = (id: string, on: boolean) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    vis('d04-heat', mode === 'heat');
    ['d04-cl', 'd04-cl-n', 'd04-pt'].forEach((l) => vis(l, mode === 'clusters'));
  }, [mode, map, all]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    all?.forEach((f) => (c[f.properties.group] = (c[f.properties.group] ?? 0) + 1));
    return c;
  }, [all]);

  const share = useMemo(() => {
    if (!filtered || !filtered.length) return null;
    const top = hotspots.reduce((s, h) => s + h.n, 0);
    return Math.round((top / filtered.length) * 100);
  }, [filtered, hotspots]);

  return (
    <div className="legend wide">
      <h4>Where things gather</h4>
      <div className="seg">
        <button className={mode === 'clusters' ? 'on' : ''} onClick={() => setMode('clusters')}>
          Clusters
        </button>
        <button className={mode === 'heat' ? 'on' : ''} onClick={() => setMode('heat')}>
          Heat
        </button>
      </div>

      {Object.entries(GROUPS).map(([k, v]) => (
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
          {all && <span className="muted">{counts[k] ?? 0}</span>}
        </label>
      ))}

      {filtered && (
        <>
          <p className="sub">Busiest 550 m cells</p>
          {share !== null && (
            <p className="muted" style={{ margin: '0 0 4px' }}>
              The 8 busiest cells hold {share}% of the {filtered.length.toLocaleString()} places shown.
            </p>
          )}
          <ul className="list">
            {hotspots.map((h, i) => (
              <li key={i} onClick={() => map.flyTo({ center: [h.lng, h.lat], zoom: 15.5 })}>
                <div className="row">
                  <span>
                    {i + 1}. mostly {h.top.toLowerCase()}
                  </span>
                  <span className="muted">{h.n}</span>
                </div>
                <div className="bar" style={{ width: `${(h.n / hotspots[0].n) * 100}%` }} />
              </li>
            ))}
          </ul>
        </>
      )}
      {missing && (
        <p className="warn">
          Data missing. Run <code>python pipeline/04_osm_pois.py</code> to create <code>public/data/day04-pois.geojson</code>.
        </p>
      )}
    </div>
  );
}
