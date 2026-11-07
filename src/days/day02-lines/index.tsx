import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { addBoundary, type BoundaryHandle } from '../../core/boundary';
import { clipLine, coordsBounds, lineLengthM, mergeBounds } from '../../core/geo';

// Data is produced by pipeline/02_osm_waterways.py
const URL = '/data/day02-waterways.geojson';
const SRC = 'd02-waterways';
const BASE = 'd02-lines';
const FLOW = 'd02-flow';

const CLASSES: Record<string, { label: string; color: string }> = {
  river: { label: 'River', color: '#0b5fa5' },
  canal: { label: 'Canal', color: '#0891b2' },
  stream: { label: 'Stream', color: '#38bdf8' },
  drain: { label: 'Drain / ditch', color: '#94a3b8' },
};

const by = (r: number, c: number, s: number, d: number) => ['match', ['get', 'waterway'], 'river', r, 'canal', c, 'stream', s, d];
const WIDTH: any = ['interpolate', ['linear'], ['zoom'], 9, by(2.2, 1.1, 0.7, 0.4), 15, by(9, 4.5, 3, 1.8)];
const FLOW_WIDTH: any = ['interpolate', ['linear'], ['zoom'], 9, by(1.2, 0.7, 0.45, 0.3), 15, by(4.5, 2.5, 1.8, 1)];

// Dash-offset sequence: stepping through it makes the dashes crawl along each line, in the direction it was digitised (downstream in OSM).
const SEQ = [
  [0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0],
  [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5],
];

type Bounds = [[number, number], [number, number]];
interface Stats {
  byClass: Record<string, { km: number; n: number }>;
  top: { name: string; km: number; bounds: Bounds }[];
  totalKm: number;
  unnamedPct: number;
}

export default function Day02({ map }: { map: maplibregl.Map }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [missing, setMissing] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [animate, setAnimate] = useState(true);
  const animRef = useRef(true);
  animRef.current = animate;

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    let raf = 0;
    let bh: BoundaryHandle | null = null;
    const popup = new maplibregl.Popup({ closeButton: false, offset: 10 });

    (async () => {
      bh = await addBoundary(map, 'd02', { signal: ac.signal });
      if (cancelled) return;

      let raw: any;
      try {
        const r = await fetch(URL);
        if (!r.ok) throw new Error('missing');
        raw = await r.json();
      } catch {
        setMissing(true);
        return;
      }
      if (cancelled) return;

      // Clip to the city boundary and measure
      const polys = bh?.polys ?? [];
      const features: any[] = [];
      const byClass: Stats['byClass'] = {};
      const byName = new Map<string, { m: number; b: Bounds }>();
      let totalM = 0;
      let unnamedM = 0;
      for (const f of raw.features) {
        const runs = polys.length ? clipLine(f.geometry.coordinates, polys) : [f.geometry.coordinates];
        for (const run of runs) {
          const len = lineLengthM(run);
          const cls = f.properties.waterway as string;
          const name = f.properties.name as string;
          features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: run }, properties: { waterway: cls, name } });
          byClass[cls] ??= { km: 0, n: 0 };
          byClass[cls].km += len / 1000;
          byClass[cls].n += 1;
          totalM += len;
          if (!name) unnamedM += len;
          else {
            const cur = byName.get(name);
            const b = coordsBounds(run);
            byName.set(name, { m: (cur?.m ?? 0) + len, b: cur ? mergeBounds(cur.b, b) : b });
          }
        }
      }
      const top = [...byName.entries()]
        .map(([name, v]) => ({ name, km: v.m / 1000, bounds: v.b }))
        .sort((a, b) => b.km - a.km)
        .slice(0, 6);
      setStats({ byClass, top, totalKm: totalM / 1000, unnamedPct: totalM ? (unnamedM / totalM) * 100 : 0 });

      map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features } as any });
      map.addLayer({
        id: BASE,
        type: 'line',
        source: SRC,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['match', ['get', 'waterway'], ...Object.entries(CLASSES).flatMap(([k, v]) => [k, v.color]), '#38bdf8'] as any,
          'line-width': WIDTH,
          'line-opacity': 0.95,
        },
      });
      map.addLayer({
        id: FLOW,
        type: 'line',
        source: SRC,
        filter: ['!=', ['get', 'waterway'], 'drain'],
        paint: { 'line-color': '#ffffff', 'line-width': FLOW_WIDTH, 'line-opacity': 0.75, 'line-dasharray': SEQ[0] },
      });

      // hover: a few pixels of tolerance so thin streams are still catchable
      map.on('mousemove', (e) => {
        const pad = 5;
        const hit = map.queryRenderedFeatures(
          [[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]],
          { layers: [BASE] },
        )[0];
        map.getCanvas().style.cursor = hit ? 'pointer' : '';
        if (!hit) return popup.remove();
        const p = hit.properties as Record<string, string>;
        popup.setLngLat(e.lngLat).setHTML(`<strong>${p.name || '(unnamed)'}</strong><br/>${CLASSES[p.waterway]?.label ?? p.waterway}`).addTo(map);
      });

      let last = -1;
      const tick = (t: number) => {
        if (animRef.current) {
          const s = Math.floor(t / 70) % SEQ.length;
          if (s !== last && map.getLayer(FLOW)) {
            last = s;
            map.setPaintProperty(FLOW, 'line-dasharray', SEQ[s]);
          }
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    })();

    return () => {
      cancelled = true;
      ac.abort();
      cancelAnimationFrame(raf);
      popup.remove();
      [FLOW, BASE].forEach((l) => map.getLayer(l) && map.removeLayer(l));
      map.getSource(SRC) && map.removeSource(SRC);
      bh?.remove();
    };
  }, [map]);

  // class filter
  useEffect(() => {
    if (!map.getLayer(BASE)) return;
    const h = [...hidden];
    const keep: any = h.length ? ['!', ['in', ['get', 'waterway'], ['literal', h]]] : null;
    map.setFilter(BASE, keep);
    map.setFilter(FLOW, h.length ? ['all', keep, ['!=', ['get', 'waterway'], 'drain']] : ['!=', ['get', 'waterway'], 'drain']);
  }, [hidden, map, stats]);

  return (
    <div className="legend wide">
      <h4>Waterways in Butuan City</h4>
      {Object.entries(CLASSES).map(([k, v]) => (
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
          <span style={{ width: 22, height: Math.max(2, k === 'river' ? 6 : k === 'canal' ? 4 : 2), background: v.color, borderRadius: 2, display: 'inline-block' }} />
          <span style={{ flex: 1 }}>{v.label}</span>
          {stats && <span className="muted">{(stats.byClass[k]?.km ?? 0).toFixed(1)} km</span>}
        </label>
      ))}
      <label className="legend-row" style={{ marginTop: 6 }}>
        <input type="checkbox" checked={animate} onChange={(e) => setAnimate(e.target.checked)} />
        <span>Animate flow direction</span>
      </label>

      {stats && (
        <>
          <p className="sub">Overview</p>
          <div className="kv">
            <span>Mapped waterways</span>
            <span>{stats.totalKm.toFixed(0)} km</span>
            <span>Length with no name in OSM</span>
            <span>{stats.unnamedPct.toFixed(0)}%</span>
          </div>
          <p className="sub">Longest named waterways</p>
          <ul className="list">
            {stats.top.map((t) => (
              <li key={t.name} onClick={() => map.fitBounds(t.bounds, { padding: 80, maxZoom: 14 })}>
                <div className="row">
                  <span>{t.name}</span>
                  <span className="muted">{t.km.toFixed(1)} km</span>
                </div>
                <div className="bar" style={{ width: `${(t.km / stats.top[0].km) * 100}%` }} />
              </li>
            ))}
          </ul>
        </>
      )}
      {missing && (
        <p className="warn">
          Data missing. Run <code>python pipeline/02_osm_waterways.py</code> (after the Day 1 script) to create <code>public/data/day02-waterways.geojson</code>.
        </p>
      )}
    </div>
  );
}
