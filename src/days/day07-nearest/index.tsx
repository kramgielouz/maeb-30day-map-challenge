import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { addBoundary, type BoundaryHandle } from '../../core/boundary';
import { pointInPolys } from '../../core/geo';
import { KINDS } from '../day01-points/icons';

// Facilities come from Day 1 (pipeline/01_osm_facilities.py). No new data needed.
const FAC_URL = '/data/day01-facilities.geojson';
const SURFACE = 'd07-surface';
const SURFACE_LAYER = 'd07-surface-layer';
const FAC = 'd07-fac';
const FAC_LAYER = 'd07-fac-layer';
const LINK = 'd07-link';
const LINK_LAYER = 'd07-link-layer';

const RAD = Math.PI / 180;
const CELL_M = 300;
const NEAR_KM = 5; // "about ten minutes at 30 km/h, as the crow flies"

// distance bands in km, upper bound of each (last is open-ended)
const BANDS = [
  { max: 1, color: '#d9f0e3', label: 'under 1 km' },
  { max: 2, color: '#a6dcc0', label: '1 to 2 km' },
  { max: 5, color: '#f6e27a', label: '2 to 5 km' },
  { max: 10, color: '#f4a259', label: '5 to 10 km' },
  { max: 20, color: '#d1495b', label: '10 to 20 km' },
  { max: Infinity, color: '#7a1f3d', label: 'over 20 km' },
];
const bandOf = (km: number) => BANDS.findIndex((b) => km < b.max);
const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

const KIND_ORDER = ['hospital', 'clinic', 'fire_station', 'police', 'school'];
const SHORT: Record<string, string> = { hospital: 'Hospital', clinic: 'Clinic', fire_station: 'Fire', police: 'Police', school: 'School' };
const NOUN: Record<string, string> = { hospital: 'hospital', clinic: 'clinic or health centre', fire_station: 'fire station', police: 'police station', school: 'school' };

interface Fac {
  lng: number;
  lat: number;
  kind: string;
  name: string;
}
interface Grid {
  west: number;
  north: number;
  cols: number;
  rows: number;
  dLng: number;
  dLat: number;
  mLng: number;
  inside: Uint8Array;
}
interface Stats {
  pct: number[];
  beyond: number;
  mean: number;
  far: { lng: number; lat: number; km: number };
  cityKm2: number;
}

const metres = (a: { lng: number; lat: number }, b: { lng: number; lat: number }, mLng: number) => Math.hypot((a.lng - b.lng) * mLng, (a.lat - b.lat) * 111320);

export default function Day07({ map }: { map: maplibregl.Map }) {
  const [kind, setKind] = useState('hospital');
  const [fac, setFac] = useState<Fac[] | null>(null);
  const [grid, setGrid] = useState<Grid | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [missing, setMissing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const kindRef = useRef(kind);
  kindRef.current = kind;
  const facRef = useRef<Fac[]>([]);
  facRef.current = fac ?? [];

  // setup: city boundary, facilities, and a mask of which grid cells lie inside the city
  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    let bh: BoundaryHandle | null = null;
    const popup = new maplibregl.Popup({ closeButton: false, offset: 12 });

    (async () => {
      bh = await addBoundary(map, 'd07', { signal: ac.signal });
      if (cancelled) return;

      try {
        const r = await fetch(FAC_URL);
        if (!r.ok) throw new Error('missing');
        const gj = await r.json();
        if (cancelled) return;
        const list: Fac[] = gj.features
          .filter((f: any) => f.geometry?.type === 'Point')
          .map((f: any) => ({ lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], kind: f.properties.kind, name: f.properties.name || '' }));
        setFac(list);
        map.addSource(FAC, { type: 'geojson', data: gj });
        map.addSource(LINK, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        map.addLayer({ id: LINK_LAYER, type: 'line', source: LINK, paint: { 'line-color': '#111827', 'line-width': 2, 'line-dasharray': [2, 1.5] } });
        map.addLayer({
          id: FAC_LAYER,
          type: 'circle',
          source: FAC,
          filter: ['==', ['get', 'kind'], kindRef.current],
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 4, 15, 8],
            'circle-color': ['match', ['get', 'kind'], ...KIND_ORDER.flatMap((k) => [k, KINDS[k].color]), '#555'] as any,
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 2,
          },
        });
      } catch {
        if (!cancelled) setMissing(true);
      }

      // which grid cells are inside the city (done once; boundary polygons can be detailed)
      if (!bh || !bh.bounds || cancelled) return;
      const [[w, s], [e, n]] = bh.bounds;
      const mLng = 111320 * Math.cos(((s + n) / 2) * RAD);
      const dLng = CELL_M / mLng;
      const dLat = CELL_M / 111320;
      const cols = Math.ceil((e - w) / dLng);
      const rows = Math.ceil((n - s) / dLat);
      const inside = new Uint8Array(cols * rows);
      for (let k = 0; k < inside.length; k++) {
        const lng = w + ((k % cols) + 0.5) * dLng;
        const lat = n - (Math.floor(k / cols) + 0.5) * dLat;
        if (pointInPolys(lng, lat, bh.polys)) inside[k] = 1;
      }
      if (!cancelled) setGrid({ west: w, north: n, cols, rows, dLng, dLat, mLng, inside });
    })();

    // click anywhere: which one is nearest, and how far
    const onClick = (ev: maplibregl.MapMouseEvent) => {
      const list = facRef.current.filter((f) => f.kind === kindRef.current);
      if (!list.length) return;
      const here = { lng: ev.lngLat.lng, lat: ev.lngLat.lat };
      const mLng = 111320 * Math.cos(here.lat * RAD);
      let best = list[0];
      let bd = Infinity;
      for (const f of list) {
        const d = metres(here, f, mLng);
        if (d < bd) {
          bd = d;
          best = f;
        }
      }
      (map.getSource(LINK) as maplibregl.GeoJSONSource | undefined)?.setData({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: [[here.lng, here.lat], [best.lng, best.lat]] },
      });
      const box = document.createElement('div');
      const b = document.createElement('b');
      b.textContent = best.name || `Unnamed ${NOUN[kindRef.current]}`;
      const sub = document.createElement('div');
      sub.textContent = `${(bd / 1000).toFixed(1)} km in a straight line`;
      sub.style.cssText = 'color:#475569;font-size:12px';
      box.append(b, sub);
      popup.setLngLat([here.lng, here.lat]).setDOMContent(box).addTo(map);
    };
    map.on('click', onClick);

    return () => {
      cancelled = true;
      ac.abort();
      popup.remove();
      map.off('click', onClick);
      [LINK_LAYER, FAC_LAYER, SURFACE_LAYER].forEach((l) => map.getLayer(l) && map.removeLayer(l));
      [LINK, FAC, SURFACE].forEach((s) => map.getSource(s) && map.removeSource(s));
      bh?.remove();
    };
  }, [map]);

  // the surface: distance from every cell to the nearest facility of the chosen kind
  useEffect(() => {
    if (!grid || !fac) return;
    const list = fac.filter((f) => f.kind === kind);
    (map.getSource(LINK) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: [] });
    if (map.getLayer(FAC_LAYER)) map.setFilter(FAC_LAYER, ['==', ['get', 'kind'], kind]);
    if (!list.length) {
      setStats(null);
      setNote(`No ${NOUN[kind]} is mapped in the city.`);
      if (map.getLayer(SURFACE_LAYER)) map.setLayoutProperty(SURFACE_LAYER, 'visibility', 'none');
      return;
    }
    setNote(null);

    const { cols, rows, west, north, dLng, dLat, mLng, inside } = grid;
    const cv = document.createElement('canvas');
    cv.width = cols;
    cv.height = rows;
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(cols, rows);
    const counts = new Array(BANDS.length).fill(0);
    let n = 0;
    let sum = 0;
    let far = { lng: 0, lat: 0, km: -1 };
    for (let k = 0; k < inside.length; k++) {
      if (!inside[k]) continue;
      const p = { lng: west + ((k % cols) + 0.5) * dLng, lat: north - (Math.floor(k / cols) + 0.5) * dLat };
      let d = Infinity;
      for (const f of list) {
        const dd = metres(p, f, mLng);
        if (dd < d) d = dd;
      }
      const km = d / 1000;
      const b = bandOf(km);
      counts[b]++;
      n++;
      sum += km;
      if (km > far.km) far = { ...p, km };
      img.data.set([...hex(BANDS[b].color), 205], k * 4);
    }
    ctx.putImageData(img, 0, 0);

    const url = cv.toDataURL();
    const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [
      [west, north],
      [west + cols * dLng, north],
      [west + cols * dLng, north - rows * dLat],
      [west, north - rows * dLat],
    ];
    const src = map.getSource(SURFACE) as maplibregl.ImageSource | undefined;
    if (src) src.updateImage({ url, coordinates });
    else {
      map.addSource(SURFACE, { type: 'image', url, coordinates });
      map.addLayer({ id: SURFACE_LAYER, type: 'raster', source: SURFACE, paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 0 } }, map.getLayer('d07-bnd-casing') ? 'd07-bnd-casing' : map.getLayer(LINK_LAYER) ? LINK_LAYER : undefined);
    }
    map.setLayoutProperty(SURFACE_LAYER, 'visibility', 'visible');

    let beyond = 0;
    counts.forEach((c, i) => {
      if (BANDS[i].max > NEAR_KM) beyond += c;
    });
    setStats({
      pct: counts.map((c) => (c / n) * 100),
      beyond: (beyond / n) * 100,
      mean: sum / n,
      far,
      cityKm2: (n * CELL_M * CELL_M) / 1e6,
    });
  }, [grid, fac, kind, map]);

  const count = fac?.filter((f) => f.kind === kind).length ?? 0;

  return (
    <div className="legend wide">
      <h4>Nearest {NOUN[kind]}</h4>
      <div className="seg" style={{ flexWrap: 'wrap' }}>
        {KIND_ORDER.map((k) => (
          <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
            {SHORT[k]}
          </button>
        ))}
      </div>

      {stats && (
        <p style={{ margin: '4px 0 8px', fontSize: 14 }}>
          <strong>{stats.beyond.toFixed(0)}%</strong> of the city is more than {NEAR_KM} km from the nearest {NOUN[kind]}. {count} mapped in all.
        </p>
      )}
      {note && <p className="warn">{note}</p>}

      <div className="sub" style={{ marginTop: 0 }}>
        Share of city area by distance
      </div>
      {BANDS.map((b, i) => (
        <div key={i} className="legend-row" style={{ cursor: 'default' }}>
          <span className="swatch" style={{ background: b.color }} />
          <span style={{ flex: 1 }}>{b.label}</span>
          <span className="muted">{stats ? `${stats.pct[i].toFixed(0)}%` : ''}</span>
        </div>
      ))}

      {stats && (
        <>
          <div className="kv">
            <span>Average distance</span>
            <span>{stats.mean.toFixed(1)} km</span>
            <span>Farthest point</span>
            <span>{stats.far.km.toFixed(1)} km</span>
            <span>City area counted</span>
            <span>{stats.cityKm2.toFixed(0)} km²</span>
          </div>
          <button
            onClick={() => map.flyTo({ center: [stats.far.lng, stats.far.lat], zoom: 11, duration: 1200 })}
            style={{ width: '100%', margin: '8px 0 2px', padding: '5px 8px', border: '1px solid var(--line)', borderRadius: 6, background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer' }}
          >
            Fly to the farthest point
          </button>
        </>
      )}

      <p className="muted" style={{ margin: '8px 0 0' }}>
        Click anywhere to see the nearest {NOUN[kind]} and its distance.
      </p>
      {missing && (
        <p className="warn">
          Facility data missing. Run <code>python pipeline/01_osm_facilities.py</code> to create <code>public/data/day01-facilities.geojson</code>.
        </p>
      )}
      <p className="muted" style={{ marginTop: 8 }}>
        Straight-line distance on a {CELL_M} m grid, not travel time by road or river. {NEAR_KM} km is roughly ten minutes at 30 km/h. Only facilities mapped in OpenStreetMap count, so a gap can also be a mapping gap.
      </p>
    </div>
  );
}
