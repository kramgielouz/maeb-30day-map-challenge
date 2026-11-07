import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { addBoundary, type BoundaryHandle } from '../../core/boundary';
import { pointInPolys, type PolygonCoords } from '../../core/geo';
import { Dem } from '../day05-sight/viewshed';

// Polygons without barangay boundaries: a neutral hexagon grid over the city, each cell scored on
//   exposure: how much of it is low-lying AND close to a river, canal or stream (terrain tiles + Day 2 waterways)
//   access:   straight-line distance to the nearest hospital (Day 1 facilities)
// and drawn as a bivariate map. The darkest cells are exposed and far from help.
const FAC_URL = '/data/day01-facilities.geojson';
const WATER_URL = '/data/day02-waterways.geojson';
const HEX = 'd03-hex';
const HEX_FILL = 'd03-hex-fill';
const HEX_LINE = 'd03-hex-line';
const HEX_HL = 'd03-hex-hl';

const RAD = Math.PI / 180;
const SQ3 = Math.sqrt(3);
const MASK_CELL_M = 40;
const FAR_KM = [2, 5]; // access classes: under 2 km, 2 to 5 km, over 5 km
const EXPO_PCT = [10, 40]; // exposure classes: under 10%, 10 to 40%, over 40%

// bivariate palette: BIV[access][exposure], access 0 = near ... 2 = far; exposure 0 = low ... 2 = high
const BIV = [
  ['#e8e8e8', '#ace4e4', '#5ac8c8'],
  ['#dfb0d6', '#a5add3', '#5698b9'],
  ['#be64ac', '#8c62aa', '#3b4994'],
];
const COLOR_BY_CLS = BIV.flat();

interface Base {
  polys: PolygonCoords[];
  bounds: [[number, number], [number, number]];
  hospitals: { lng: number; lat: number }[];
  water: number[][][];
  dem: Dem;
  mLng: number;
}
interface Hex {
  lng: number;
  lat: number;
  ring: [number, number][];
  elev: Float32Array; // valid (above sea level) samples only
  pts: Float64Array; // lng, lat of each valid sample
  km: number; // to the nearest hospital
}
interface Info {
  ex: number;
  elev: number;
  km: number;
  cls: number;
}
interface Result {
  counts: number[];
  total: number;
  worst: { lng: number; lat: number; ex: number; km: number }[];
}

const km2 = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });

export default function Day03({ map }: { map: maplibregl.Map }) {
  const [base, setBase] = useState<Base | null>(null);
  const [hexKm2, setHexKm2] = useState(1);
  const [lowM, setLowM] = useState(15);
  const [waterM, setWaterM] = useState(300);
  const [hexes, setHexes] = useState<Hex[] | null>(null);
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState(true);
  const [sel, setSel] = useState<number | null>(null);
  const [hover, setHover] = useState<Info | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [tileFail, setTileFail] = useState(false);
  const maskRef = useRef<{ R: number; data: Uint8Array; W: number } | null>(null);

  // setup: boundary, hexagon layers, data, terrain tiles
  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    let bh: BoundaryHandle | null = null;

    const onMove = (e: maplibregl.MapLayerMouseEvent) => {
      const p = e.features?.[0]?.properties as any;
      if (!p) return;
      map.getCanvas().style.cursor = 'pointer';
      setHover({ ex: p.ex, elev: p.elev, km: p.km, cls: p.cls });
      map.setFilter(HEX_HL, ['==', ['get', 'i'], p.i]);
    };
    const onLeave = () => {
      map.getCanvas().style.cursor = '';
      setHover(null);
      map.setFilter(HEX_HL, ['==', ['get', 'i'], -1]);
    };

    (async () => {
      bh = await addBoundary(map, 'd03', { mask: false, signal: ac.signal });
      if (cancelled) return;
      if (!bh || !bh.bounds) {
        setMissing(['city boundary (run pipeline/01_osm_facilities.py)']);
        setBusy(false);
        return;
      }
      const before = map.getLayer('d03-bnd-casing') ? 'd03-bnd-casing' : undefined;
      map.addSource(HEX, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer(
        {
          id: HEX_FILL,
          type: 'fill',
          source: HEX,
          paint: { 'fill-color': ['match', ['get', 'cls'], ...COLOR_BY_CLS.flatMap((c, i) => [i, c]), '#cccccc'] as any, 'fill-opacity': 0.85 },
        },
        before,
      );
      map.addLayer({ id: HEX_LINE, type: 'line', source: HEX, paint: { 'line-color': '#ffffff', 'line-width': 0.6, 'line-opacity': 0.7 } }, before);
      map.addLayer({ id: HEX_HL, type: 'line', source: HEX, filter: ['==', ['get', 'i'], -1], paint: { 'line-color': '#0f172a', 'line-width': 2.5 } }, before);
      map.on('mousemove', HEX_FILL, onMove);
      map.on('mouseleave', HEX_FILL, onLeave);

      const get = (u: string) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const [fac, wat] = await Promise.all([get(FAC_URL), get(WATER_URL)]);
      if (cancelled) return;
      const miss: string[] = [];
      if (!fac) miss.push('Day 1 facilities (run pipeline/01_osm_facilities.py)');
      if (!wat) miss.push('Day 2 waterways (run pipeline/02_osm_waterways.py)');
      if (miss.length) {
        setMissing(miss);
        setBusy(false);
        return;
      }
      const hospitals = fac.features
        .filter((f: any) => f.properties?.kind === 'hospital' && f.geometry?.type === 'Point')
        .map((f: any) => ({ lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }));
      const water: number[][][] = wat.features
        .filter((f: any) => ['river', 'canal', 'stream'].includes(f.properties?.waterway) && f.geometry?.type === 'LineString')
        .map((f: any) => f.geometry.coordinates);

      const [[w, s], [e, n]] = bh.bounds;
      const mLng = 111320 * Math.cos(((s + n) / 2) * RAD);
      const dem = new Dem();
      await dem.load((w + e) / 2, (s + n) / 2, Math.hypot(((e - w) / 2) * mLng, ((n - s) / 2) * 111320) + 1000);
      if (cancelled) return;
      if (dem.failed) setTileFail(true);
      setBase({ polys: bh.polys, bounds: bh.bounds, hospitals, water, dem, mLng });
    })();

    return () => {
      cancelled = true;
      ac.abort();
      map.off('mousemove', HEX_FILL, onMove);
      map.off('mouseleave', HEX_FILL, onLeave);
      [HEX_HL, HEX_LINE, HEX_FILL].forEach((l) => map.getLayer(l) && map.removeLayer(l));
      map.getSource(HEX) && map.removeSource(HEX);
      bh?.remove();
    };
  }, [map]);

  // build the hexagon grid and sample terrain in each cell (only when the cell size changes)
  useEffect(() => {
    if (!base) return;
    setBusy(true);
    const t = setTimeout(() => {
      const s = Math.sqrt((hexKm2 * 1e6) / (1.5 * SQ3)); // circumradius, m
      const w3 = SQ3 * s;
      const [[west, south], [east, north]] = base.bounds;
      const mLng = base.mLng;
      const widthM = (east - west) * mLng;
      const heightM = (north - south) * 111320;
      const step = Math.min(250, Math.max(100, s / 4));
      const out: Hex[] = [];
      for (let r = 0, y = 0; y <= heightM + s; r++, y = r * 1.5 * s) {
        for (let x = (r % 2) * (w3 / 2); x <= widthM + w3; x += w3) {
          const lng = west + x / mLng;
          const lat = south + y / 111320;
          if (!pointInPolys(lng, lat, base.polys)) continue;
          const el: number[] = [];
          const pts: number[] = [];
          let total = 0;
          for (let dy = -s; dy <= s; dy += step) {
            for (let dx = -w3 / 2; dx <= w3 / 2; dx += step) {
              if (Math.abs(dx) > w3 / 2 || Math.abs(dy) + Math.abs(dx) / SQ3 > s) continue;
              total++;
              const pl = lng + dx / mLng;
              const pa = lat + dy / 111320;
              const z = base.dem.at(pl, pa);
              if (Number.isFinite(z) && z > 0) {
                el.push(z);
                pts.push(pl, pa);
              }
            }
          }
          if (!total || el.length < total * 0.4) continue; // mostly open sea
          const ring = Array.from({ length: 7 }, (_, k) => {
            const a = (90 + 60 * (k % 6)) * RAD;
            return [lng + (s * Math.cos(a)) / mLng, lat + (s * Math.sin(a)) / 111320] as [number, number];
          });
          let km = Infinity;
          for (const h of base.hospitals) km = Math.min(km, Math.hypot((h.lng - lng) * mLng, (h.lat - lat) * 111320) / 1000);
          out.push({ lng, lat, ring, elev: Float32Array.from(el), pts: Float64Array.from(pts), km });
        }
      }
      setHexes(out);
    }, 30);
    return () => clearTimeout(t);
  }, [base, hexKm2]);

  // score every cell: cheap enough to redo while a slider moves
  useEffect(() => {
    if (!base || !hexes) return;
    const t = setTimeout(() => {
      const [[west], [, north]] = base.bounds;
      const [[, south], [east]] = base.bounds;
      const widthM = (east - west) * base.mLng;
      const heightM = (north - south) * 111320;
      if (maskRef.current?.R !== waterM) {
        const W = Math.ceil(widthM / MASK_CELL_M);
        const H = Math.ceil(heightM / MASK_CELL_M);
        const cv = document.createElement('canvas');
        cv.width = W;
        cv.height = H;
        const g = cv.getContext('2d', { willReadFrequently: true })!;
        g.fillStyle = '#000';
        g.fillRect(0, 0, W, H);
        g.strokeStyle = '#fff';
        g.lineWidth = Math.max(1, (2 * waterM) / MASK_CELL_M);
        g.lineCap = g.lineJoin = 'round';
        g.beginPath();
        for (const line of base.water) {
          line.forEach(([lg, lt], k) => {
            const px = ((lg - west) * base.mLng) / MASK_CELL_M;
            const py = ((north - lt) * 111320) / MASK_CELL_M;
            if (k === 0) g.moveTo(px, py);
            else g.lineTo(px, py);
          });
        }
        g.stroke();
        const d = g.getImageData(0, 0, W, H).data;
        const data = new Uint8Array(W * H);
        for (let i = 0; i < data.length; i++) data[i] = d[i * 4];
        maskRef.current = { R: waterM, data, W };
      }
      const { data, W } = maskRef.current!;

      const counts = new Array(9).fill(0);
      const worst: Result['worst'] = [];
      const features = hexes.map((h, i) => {
        let exposed = 0;
        let sum = 0;
        for (let k = 0; k < h.elev.length; k++) {
          sum += h.elev[k];
          if (h.elev[k] < lowM) {
            const px = Math.floor(((h.pts[2 * k] - west) * base.mLng) / MASK_CELL_M);
            const py = Math.floor(((north - h.pts[2 * k + 1]) * 111320) / MASK_CELL_M);
            if (data[py * W + px] > 127) exposed++;
          }
        }
        const ex = (exposed / h.elev.length) * 100;
        const xi = ex < EXPO_PCT[0] ? 0 : ex < EXPO_PCT[1] ? 1 : 2;
        const yi = h.km < FAR_KM[0] ? 0 : h.km < FAR_KM[1] ? 1 : 2;
        const cls = yi * 3 + xi;
        counts[cls]++;
        if (cls === 8) worst.push({ lng: h.lng, lat: h.lat, ex, km: h.km });
        return {
          type: 'Feature' as const,
          properties: { i, cls, ex: Math.round(ex), elev: Math.round(sum / h.elev.length), km: Math.round(h.km * 10) / 10 },
          geometry: { type: 'Polygon' as const, coordinates: [h.ring] },
        };
      });
      (map.getSource(HEX) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features });
      worst.sort((a, b) => b.ex * b.km - a.ex * a.km);
      setRes({ counts, total: hexes.length, worst: worst.slice(0, 5) });
      setBusy(false);
    }, 60);
    return () => clearTimeout(t);
  }, [base, hexes, lowM, waterM, map]);

  // dim everything but the chosen legend cell
  useEffect(() => {
    if (!map.getLayer(HEX_FILL)) return;
    map.setPaintProperty(HEX_FILL, 'fill-opacity', sel === null ? 0.85 : (['case', ['==', ['get', 'cls'], sel], 0.95, 0.12] as any));
  }, [sel, map, res]);

  const area = hexKm2;
  const darkest = res ? res.counts[8] * area : 0;
  const totalKm2 = res ? res.total * area : 0;
  const exposedHigh = res ? (res.counts[2] + res.counts[5] + res.counts[8]) * area : 0;

  return (
    <div className="legend wide">
      <h4>Low, wet and far from help</h4>
      <p className="muted" style={{ margin: '0 0 6px' }}>
        The city cut into equal hexagons. Each is scored on how much of it is low-lying and near water, and how far it is from a hospital.
      </p>

      <div className="seg">
        {[0.5, 1, 2].map((v) => (
          <button key={v} className={hexKm2 === v ? 'on' : ''} onClick={() => setHexKm2(v)}>
            {v} km² cells
          </button>
        ))}
      </div>
      <div className="legend-row" style={{ display: 'block' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>Low-lying means below</span>
          <strong>{lowM} m</strong>
        </div>
        <input className="range" type="range" min={5} max={30} step={1} value={lowM} onChange={(e) => setLowM(Number(e.target.value))} />
      </div>
      <div className="legend-row" style={{ display: 'block' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>Near water means within</span>
          <strong>{waterM} m</strong>
        </div>
        <input className="range" type="range" min={100} max={800} step={100} value={waterM} onChange={(e) => setWaterM(Number(e.target.value))} />
      </div>

      <p className="sub">Click a square to isolate it</p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <div style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', fontSize: 11, color: 'var(--muted)' }}>Farther from a hospital →</div>
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 30px)', gap: 2 }}>
            {[2, 1, 0].flatMap((yi) =>
              [0, 1, 2].map((xi) => {
                const cls = yi * 3 + xi;
                return (
                  <button
                    key={cls}
                    onClick={() => setSel(sel === cls ? null : cls)}
                    title={res ? `${res.counts[cls]} cells, about ${km2(res.counts[cls] * area)} km²` : ''}
                    style={{ width: 30, height: 30, padding: 0, background: BIV[yi][xi], border: sel === cls ? '2px solid #0f172a' : '1px solid #fff', cursor: 'pointer' }}
                  />
                );
              }),
            )}
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>More low-lying and near water →</div>
        </div>
      </div>

      {busy && <p className="muted">Working…</p>}
      {res && (
        <p style={{ margin: '8px 0 4px', fontSize: 14 }}>
          <strong>{km2(darkest)} km²</strong> ({totalKm2 ? ((darkest / totalKm2) * 100).toFixed(0) : 0}% of the city) is both highly exposed and over {FAR_KM[1]} km from a hospital.
        </p>
      )}
      {res && (
        <p className="muted" style={{ margin: 0 }}>
          Highly exposed means over {EXPO_PCT[1]}% of a cell is below {lowM} m and within {waterM} m of a river, canal or stream. That covers about {km2(exposedHigh)} km² in all.
        </p>
      )}

      {hover && (
        <div className="kv" style={{ marginTop: 8 }}>
          <span>Average elevation</span>
          <span>{hover.elev} m</span>
          <span>Low and near water</span>
          <span>{hover.ex}% of cell</span>
          <span>Nearest hospital</span>
          <span>{hover.km} km</span>
        </div>
      )}

      {res && res.worst.length > 0 && (
        <>
          <p className="sub">Most exposed and farthest</p>
          <ul className="list">
            {res.worst.map((w, i) => (
              <li key={i} onClick={() => map.flyTo({ center: [w.lng, w.lat], zoom: 12.5, duration: 1000 })}>
                <div className="row">
                  <span>
                    {w.lat.toFixed(3)}, {w.lng.toFixed(3)}
                  </span>
                  <span className="muted">
                    {w.ex.toFixed(0)}% · {w.km.toFixed(1)} km
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {missing.map((m) => (
        <p key={m} className="warn">
          Missing {m}.
        </p>
      ))}
      {tileFail && <p className="warn">Some terrain tiles did not load, so a few cells may be missing or off.</p>}

      <p className="muted" style={{ marginTop: 8 }}>
        A neutral grid is used because mapped barangay boundaries are incomplete. Elevation comes from roughly 38 m terrain tiles, which are rough on flat lowlands, so this is an indicator and not an official flood-hazard map. It counts land area, not people. Distances are straight-line to hospitals mapped inside the city.
      </p>
    </div>
  );
}
