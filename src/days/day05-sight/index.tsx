import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { addBoundary, type BoundaryHandle } from '../../core/boundary';
import { BUTUAN_CENTER } from '../../core/BaseMap';
import { Dem, HORIZON_BINS, TILE_URL, computeViewshed, loadObstruction, type Obstruction, type ViewshedResult } from './viewshed';

const DEM = 'd05-dem';
const VS = 'd05-viewshed';
const HILL = 'd05-hillshade';
const VS_LAYER = 'd05-viewshed-layer';
const SCAN = 'd05-scan';
const SCAN_LAYER = 'd05-scan-layer';
const BEAR = 'd05-bearing';
const BEAR_LAYER = 'd05-bearing-layer';

const RAD = Math.PI / 180;
const SCAN_R = 2000; // each cell of the "best views" map sees up to 2 km
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

type Mode = 'view' | 'scan';
interface Cmp {
  terrain: number;
  real: number;
}
interface Spot {
  lng: number;
  lat: number;
  km2: number;
}
interface ScanResult {
  min: number;
  max: number;
  top: Spot[];
}

// dark blue -> teal -> green -> yellow
const RAMP: [number, number, number][] = [[13, 27, 62], [27, 120, 140], [94, 201, 120], [253, 231, 37]];
function ramp(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x));
  const f = x - i;
  return [0, 1, 2].map((c) => Math.round(RAMP[i][c] * (1 - f) + RAMP[i + 1][c] * f)) as [number, number, number];
}
const rampCss = `linear-gradient(90deg, ${RAMP.map((c) => `rgb(${c.join(',')})`).join(',')})`;

const compass = (az: number) => COMPASS[Math.round(az / 45) % 8];

// 360 degree skyline: what the horizon looks like from the pin. Hover to point a bearing line on the map.
function Panorama({ res, radiusM, onBearing, onLook }: { res: ViewshedResult; radiusM: number; onBearing: (az: number | null) => void; onLook?: (az: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [tip, setTip] = useState<{ az: number; a: number; d: number } | null>(null);
  const hz = res.horizon;

  useEffect(() => {
    const c = ref.current;
    if (!c || !hz) return;
    const W = (c.width = 580);
    const H = (c.height = 170);
    const g = c.getContext('2d')!;
    const top = Math.max(3, Math.max(...hz.angle) * 1.15);
    const bot = Math.min(-1, Math.min(...hz.angle) - 0.5);
    const y = (a: number) => ((top - a) / (top - bot)) * H;
    const sky = g.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#6ea8d8');
    sky.addColorStop(1, '#dbeaf4');
    g.fillStyle = sky;
    g.fillRect(0, 0, W, H);
    const bw = W / HORIZON_BINS;
    for (let i = 0; i < HORIZON_BINS; i++) {
      const t = Math.min(1, hz.dist[i] / radiusM); // distance haze: far skyline fades toward the sky
      const col = [11 + t * 120, 37 + t * 130, 48 + t * 130].map(Math.round);
      g.fillStyle = `rgb(${col.join(',')})`;
      g.fillRect(i * bw, y(hz.angle[i]), bw + 0.6, H);
    }
    g.strokeStyle = 'rgba(255,255,255,.7)';
    g.setLineDash([4, 4]);
    g.beginPath();
    g.moveTo(0, y(0));
    g.lineTo(W, y(0));
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = '#fff';
    g.strokeStyle = 'rgba(0,0,0,.5)';
    g.lineWidth = 3;
    g.font = '600 20px system-ui, sans-serif';
    g.textBaseline = 'top';
    ['N', 'E', 'S', 'W'].forEach((l, k) => {
      const x = (k / 4) * W + 6;
      g.strokeText(l, x, 6);
      g.fillText(l, x, 6);
    });
  }, [hz, radiusM]);

  if (!hz) return null;
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const az = Math.min(359, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * 360)));
    setTip({ az, a: hz.angle[az], d: hz.dist[az] });
    onBearing(az);
  };
  const leave = () => {
    setTip(null);
    onBearing(null);
  };

  return (
    <>
      <p className="sub">Skyline from the pin</p>
      <canvas ref={ref} onPointerMove={move} onPointerLeave={leave} onClick={() => tip && onLook?.(tip.az)} style={{ width: '100%', height: 85, borderRadius: 6, display: 'block', cursor: 'crosshair', touchAction: 'none' }} />
      <p className="muted" style={{ margin: '4px 0 0', minHeight: 32 }}>
        {tip
          ? `Facing ${tip.az}° ${compass(tip.az)}: the skyline is ${tip.a.toFixed(1)}° ${tip.a >= 0 ? 'above' : 'below'} eye level, ${tip.d >= 1000 ? (tip.d / 1000).toFixed(1) + ' km' : Math.round(tip.d) + ' m'} away.`
          : onLook
            ? 'Hover to see where each direction ends, click to look that way in 3D.'
            : 'Hover to see where each direction ends. Darker means closer.'}
      </p>
    </>
  );
}

export default function Day05({ map }: { map: maplibregl.Map }) {
  const [mode, setMode] = useState<Mode>('view');
  const [view3d, setView3d] = useState(false);
  const [exag, setExag] = useState(2.5);
  const [eye, setEye] = useState(2);
  const [radiusKm, setRadiusKm] = useState(10);
  const [obs, setObs] = useState<Obstruction | null>(null);
  const [obsChecked, setObsChecked] = useState(false);
  const [useObs, setUseObs] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [res, setRes] = useState<ViewshedResult | null>(null);
  const [cmp, setCmp] = useState<Cmp | null>(null);
  const [pos, setPos] = useState<[number, number]>(BUTUAN_CENTER);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanPct, setScanPct] = useState<number | null>(null); // progress while scanning
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const runId = useRef(0);
  const scanId = useRef(0);

  // one-time setup: terrain, boundary outline, draggable observer, obstruction data
  useEffect(() => {
    let bh: BoundaryHandle | null = null;
    let cancelled = false;
    const ac = new AbortController();

    map.addSource(DEM, { type: 'raster-dem', tiles: [TILE_URL], tileSize: 256, encoding: 'terrarium', maxzoom: 15 });
    map.addLayer({
      id: HILL,
      type: 'hillshade',
      source: DEM,
      paint: { 'hillshade-exaggeration': 0.55, 'hillshade-shadow-color': '#1b2b34', 'hillshade-highlight-color': '#ffffff' },
    });
    map.addSource(BEAR, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: BEAR_LAYER, type: 'line', source: BEAR, paint: { 'line-color': '#f97316', 'line-width': 2.5, 'line-dasharray': [2, 1.5] } });

    addBoundary(map, 'd05', { mask: false, fit: false, signal: ac.signal }).then((h) => {
      if (cancelled) h?.remove();
      else bh = h;
    });

    loadObstruction().then((o) => {
      if (cancelled) return;
      setObs(o);
      setObsChecked(true);
      if (o) setUseObs(true);
    });

    const marker = new maplibregl.Marker({ color: '#f97316', draggable: true }).setLngLat(BUTUAN_CENTER).addTo(map);
    markerRef.current = marker;
    marker.on('dragend', () => {
      const p = marker.getLngLat();
      setPos([p.lng, p.lat]);
    });
    const onClick = (e: maplibregl.MapMouseEvent) => {
      marker.setLngLat(e.lngLat);
      setPos([e.lngLat.lng, e.lngLat.lat]);
    };
    map.on('click', onClick);

    return () => {
      cancelled = true;
      ac.abort();
      scanId.current++;
      map.off('click', onClick);
      marker.remove();
      map.setTerrain(null);
      map.setMaxPitch(60);
      map.easeTo({ pitch: 0, bearing: 0, duration: 0 });
      [BEAR_LAYER, SCAN_LAYER, VS_LAYER, HILL].forEach((l) => map.getLayer(l) && map.removeLayer(l));
      [BEAR, SCAN, VS, DEM].forEach((s) => map.getSource(s) && map.removeSource(s));
      bh?.remove();
    };
  }, [map]);

  // recompute whenever the observer, eye height, radius or terrain/real-world switch changes
  useEffect(() => {
    if (mode !== 'view') return;
    const id = ++runId.current;
    const t = setTimeout(async () => {
      setBusy(true);
      setError(false);
      const dem = new Dem();
      await dem.load(pos[0], pos[1], radiusKm * 1000);
      if (id !== runId.current) return;
      const R = radiusKm * 1000;
      const out = dem.failed ? null : computeViewshed(dem, pos[0], pos[1], eye, R, { obs: useObs ? obs : null });
      setBusy(false);
      if (!out || !out.canvas) {
        setError(true);
        return;
      }
      // the same view the other way round, for the "terrain vs real world" comparison
      const alt = obs ? computeViewshed(dem, pos[0], pos[1], eye, R, { obs: useObs ? null : obs, lite: true }) : null;
      setCmp(alt ? { terrain: useObs ? alt.visiblePct : out.visiblePct, real: useObs ? out.visiblePct : alt.visiblePct } : null);
      setRes(out);
      const url = out.canvas.toDataURL();
      const src = map.getSource(VS) as maplibregl.ImageSource | undefined;
      if (src) src.updateImage({ url, coordinates: out.coordinates });
      else if (map.getSource(DEM)) {
        map.addSource(VS, { type: 'image', url, coordinates: out.coordinates });
        map.addLayer({ id: VS_LAYER, type: 'raster', source: VS, paint: { 'raster-opacity': 0.9, 'raster-fade-duration': 0 } }, BEAR_LAYER);
      }
    }, 250); // debounce slider drags
    return () => clearTimeout(t);
  }, [pos, eye, radiusKm, map, mode, useObs, obs]);

  // 2D / 3D: real terrain from the same tiles, tilted camera. Only in "one viewpoint" mode.
  const first3d = useRef(true);
  useEffect(() => {
    const on = view3d && mode === 'view';
    if (!map.getSource(DEM)) return;
    if (on) {
      map.setMaxPitch(85);
      map.setTerrain({ source: DEM, exaggeration: exag });
      if (map.getPitch() < 40) map.easeTo({ pitch: 60, duration: 700 });
    } else {
      map.setTerrain(null);
      if (!first3d.current) map.easeTo({ pitch: 0, bearing: 0, duration: 500 });
      map.setMaxPitch(60);
    }
    first3d.current = false;
  }, [view3d, mode, exag, map]);

  // a scan is only valid for the settings it was made with
  useEffect(() => {
    scanId.current++;
    setScan(null);
    setScanPct(null);
  }, [useObs, eye]);

  // show the viewshed in "view" mode and the best-views raster in "scan" mode
  useEffect(() => {
    const vis = (id: string, on: boolean) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    vis(VS_LAYER, mode === 'view');
    vis(SCAN_LAYER, mode === 'scan' && !!scan);
    if (mode === 'scan') setBearing(null);
  }, [mode, scan, map, res]);

  const setBearing = (az: number | null) => {
    const src = map.getSource(BEAR) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    if (az === null) {
      src.setData({ type: 'FeatureCollection', features: [] });
      return;
    }
    const R = radiusKm * 1000;
    const end: [number, number] = [pos[0] + (Math.sin(az * RAD) * R) / (111320 * Math.cos(pos[1] * RAD)), pos[1] + (Math.cos(az * RAD) * R) / 111320];
    src.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [pos, end] } });
  };

  // "Best views": a small viewshed from every cell of a grid over the current map window
  const runScan = async () => {
    const id = ++scanId.current;
    setScan(null);
    setScanPct(0);
    setError(false);
    const c = map.getCenter();
    const b = map.getBounds();
    const mLat = 111320;
    const mLng = 111320 * Math.cos(c.lat * RAD);
    const halfW = Math.min(((b.getEast() - b.getWest()) / 2) * mLng, 20000);
    const halfH = Math.min(((b.getNorth() - b.getSouth()) / 2) * mLat, 20000);
    const step = Math.max(150, (2 * halfW) / 28);
    const cols = Math.max(6, Math.round((2 * halfW) / step));
    const rows = Math.max(4, Math.min(45, Math.round((2 * halfH) / step)));
    const west = c.lng - (cols * step) / 2 / mLng;
    const north = c.lat + (rows * step) / 2 / mLat;

    const dem = new Dem();
    await dem.load(c.lng, c.lat, Math.hypot(halfW, halfH) + SCAN_R + step);
    if (id !== scanId.current) return;
    if (dem.failed) {
      setScanPct(null);
      setError(true);
      return;
    }

    const maxArea = Math.PI * (SCAN_R / 1000) ** 2;
    const vals = new Float32Array(cols * rows).fill(NaN);
    const o = useObs ? obs : null;
    for (let k = 0; k < vals.length; k++) {
      const lng = west + ((k % cols) + 0.5) * (step / mLng);
      const lat = north - (Math.floor(k / cols) + 0.5) * (step / mLat);
      const r = computeViewshed(dem, lng, lat, eye, SCAN_R, { obs: o, lite: true });
      if (r && r.groundM > 1) vals[k] = (r.visiblePct / 100) * maxArea; // skip open water and sea
      if (k % 8 === 7) {
        setScanPct(Math.round((k / vals.length) * 100));
        await new Promise((ok) => setTimeout(ok));
        if (id !== scanId.current) return;
      }
    }

    let min = Infinity;
    let max = -Infinity;
    vals.forEach((v) => {
      if (Number.isFinite(v)) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    });
    if (!Number.isFinite(min)) {
      setScanPct(null);
      return;
    }
    const cv = document.createElement('canvas');
    cv.width = cols;
    cv.height = rows;
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(cols, rows);
    vals.forEach((v, k) => {
      if (Number.isFinite(v)) img.data.set([...ramp(max > min ? (v - min) / (max - min) : 0.5), 215], k * 4);
    });
    ctx.putImageData(img, 0, 0);
    const east = west + (cols * step) / mLng;
    const south = north - (rows * step) / mLat;
    const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [[west, north], [east, north], [east, south], [west, south]];
    const url = cv.toDataURL();
    const s = map.getSource(SCAN) as maplibregl.ImageSource | undefined;
    if (s) s.updateImage({ url, coordinates });
    else {
      map.addSource(SCAN, { type: 'image', url, coordinates });
      map.addLayer({ id: SCAN_LAYER, type: 'raster', source: SCAN, paint: { 'raster-opacity': 0.8, 'raster-resampling': 'nearest', 'raster-fade-duration': 0 } }, BEAR_LAYER);
    }

    // best spots, at least 3 cells apart so the list is not one hill five times
    const order = [...vals.keys()].filter((k) => Number.isFinite(vals[k])).sort((a, b2) => vals[b2] - vals[a]);
    const top: Spot[] = [];
    for (const k of order) {
      const cx = k % cols;
      const cy = Math.floor(k / cols);
      if (top.some((t) => Math.max(Math.abs(t.lng - (west + (cx + 0.5) * (step / mLng))) * mLng, Math.abs(t.lat - (north - (cy + 0.5) * (step / mLat))) * mLat) < step * 3)) continue;
      top.push({ lng: west + (cx + 0.5) * (step / mLng), lat: north - (cy + 0.5) * (step / mLat), km2: vals[k] });
      if (top.length === 5) break;
    }
    setScan({ min, max, top });
    setScanPct(null);
  };

  // stand on the pin and face the chosen bearing
  const lookAt = (az: number) => {
    map.easeTo({ center: pos, bearing: az, pitch: 78, zoom: Math.max(map.getZoom(), 13.5), duration: 900 });
  };

  const goTo = (s: Spot) => {
    markerRef.current?.setLngLat([s.lng, s.lat]);
    setPos([s.lng, s.lat]);
    map.easeTo({ center: [s.lng, s.lat], duration: 600 });
  };

  const obsToggle = (
    <>
      <div className="seg">
        <button className={!useObs ? 'on' : ''} onClick={() => setUseObs(false)}>
          Terrain only
        </button>
        <button className={useObs ? 'on' : ''} disabled={!obs} onClick={() => setUseObs(true)} style={!obs ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}>
          + Buildings & trees
        </button>
      </div>
      {obsChecked && !obs && (
        <p className="warn">
          Obstruction data missing. Run <code>python pipeline/05_osm_obstructions.py</code> to create <code>public/data/obstruction.png</code>.
        </p>
      )}
    </>
  );

  const eyeSlider = (
    <div className="legend-row" style={{ display: 'block' }}>
      <div className="row" style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>Eye height</span>
        <strong>{eye} m</strong>
      </div>
      <input className="range" type="range" min={1.6} max={100} step={0.4} value={eye} onChange={(e) => setEye(Number(e.target.value))} />
    </div>
  );

  return (
    <div className="legend wide">
      <h4>What can you see from here?</h4>
      <div className="seg">
        <button className={mode === 'view' ? 'on' : ''} onClick={() => setMode('view')}>
          One viewpoint
        </button>
        <button className={mode === 'scan' ? 'on' : ''} onClick={() => setMode('scan')}>
          Best views
        </button>
      </div>
      {obsToggle}

      {mode === 'view' ? (
        <>
          <p className="muted" style={{ margin: '0 0 6px' }}>
            Click the map or drag the orange pin to move the observer.
          </p>
          <div className="seg">
            <button className={!view3d ? 'on' : ''} onClick={() => setView3d(false)}>
              2D map
            </button>
            <button className={view3d ? 'on' : ''} onClick={() => setView3d(true)}>
              3D terrain
            </button>
          </div>
          {view3d && (
            <div className="legend-row" style={{ display: 'block' }}>
              <div className="row" style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Exaggeration</span>
                <strong>{exag}×</strong>
              </div>
              <input className="range" type="range" min={1} max={4} step={0.5} value={exag} onChange={(e) => setExag(Number(e.target.value))} />
              <p className="muted" style={{ margin: '2px 0 0' }}>Drag with right-click or two fingers to tilt and rotate.</p>
            </div>
          )}
          {eyeSlider}
          <div className="legend-row" style={{ display: 'block' }}>
            <div className="row" style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Radius</span>
              <strong>{radiusKm} km</strong>
            </div>
            <input className="range" type="range" min={2} max={20} step={1} value={radiusKm} onChange={(e) => setRadiusKm(Number(e.target.value))} />
          </div>

          <div className="ramp-l" style={{ justifyContent: 'flex-start', gap: 14, margin: '8px 0 2px' }}>
            <span>
              <i style={{ background: 'rgba(20,184,166,.8)', display: 'inline-block', width: 10, height: 10, borderRadius: 2, marginRight: 4 }} />
              visible
            </span>
            <span>
              <i style={{ background: 'rgba(8,20,32,.7)', display: 'inline-block', width: 10, height: 10, borderRadius: 2, marginRight: 4 }} />
              hidden
            </span>
          </div>

          {res && (
            <div className="kv">
              <span>Visible area</span>
              <span>{res.visiblePct.toFixed(0)}%</span>
              <span>Ground elevation</span>
              <span>{res.groundM.toFixed(0)} m</span>
              <span>Farthest visible point</span>
              <span>{(res.farthestM / 1000).toFixed(1)} km</span>
              <span>Highest visible ground</span>
              <span>{res.highestVisibleM.toFixed(0)} m</span>
            </div>
          )}
          {cmp && (
            <p className="muted" style={{ margin: '8px 0 0' }}>
              From this spot, terrain alone suggests <strong>{cmp.terrain.toFixed(0)}%</strong> is visible. With buildings and trees it is <strong>{cmp.real.toFixed(0)}%</strong>.
            </p>
          )}
          {busy && <p className="muted">Computing viewshed…</p>}
          {res && <Panorama res={res} radiusM={radiusKm * 1000} onBearing={setBearing} onLook={view3d ? lookAt : undefined} />}
        </>
      ) : (
        <>
          <p className="muted" style={{ margin: '0 0 6px' }}>
            Zoom to an area, then scan it. Every cell is coloured by how much ground a person standing there can see within {SCAN_R / 1000} km.
          </p>
          {eyeSlider}
          <button
            onClick={runScan}
            disabled={scanPct !== null}
            style={{ width: '100%', margin: '8px 0 4px', padding: '6px 8px', border: 0, borderRadius: 6, background: 'var(--accent)', color: '#fff', font: 'inherit', cursor: scanPct !== null ? 'wait' : 'pointer' }}
          >
            {scanPct !== null ? `Scanning… ${scanPct}%` : scan ? 'Scan this window again' : 'Scan this window'}
          </button>
          {scan && (
            <>
              <div style={{ height: 8, borderRadius: 4, background: rampCss, margin: '8px 0 2px' }} />
              <div className="ramp-l" style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{scan.min.toFixed(1)} km²</span>
                <span>{scan.max.toFixed(1)} km² in view</span>
              </div>
              <p className="sub">Best viewpoints</p>
              <ul className="list">
                {scan.top.map((s, i) => (
                  <li key={i} onClick={() => goTo(s)}>
                    <div className="row">
                      <span>
                        {i + 1}. {s.lat.toFixed(3)}, {s.lng.toFixed(3)}
                      </span>
                      <span className="muted">{s.km2.toFixed(1)} km²</span>
                    </div>
                    <div className="bar" style={{ width: `${(s.km2 / scan.top[0].km2) * 100}%` }} />
                  </li>
                ))}
              </ul>
              <p className="muted">Click one to drop the pin there and switch to One viewpoint for its skyline.</p>
            </>
          )}
        </>
      )}
      {error && <p className="warn">Could not load terrain tiles. Check your connection and try again.</p>}

      <p className="muted" style={{ marginTop: 8 }}>
        {useObs
          ? 'Buildings and woodland come from OpenStreetMap, with typical heights where none are mapped. Single trees, fences and unmapped buildings are missing, so real views are still shorter. '
          : 'Terrain only: buildings and trees are not modelled, so real views from the flat Agusan plain are shorter than shown. '}
        Includes earth curvature and standard refraction.
      </p>
    </div>
  );
}
