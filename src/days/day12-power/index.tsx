import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { boundsOf, inverseMask, polygonsOf } from '../../core/geo';

// Day 12, Power: the lit and the dark. Built-up land of Caraga as 3D columns.
//   height = night-light brightness (VIIRS): lit land rises, built-up land with no light stays a flat dark stub
//   colour = distance to the nearest power line or substation (OpenStreetMap): gold near the grid, pale, then blue far from it
// The light is faked to look emissive: a blurred ground glow, a faint halo shell round the brightest columns,
// and (in the saved video) a real bloom. The basemap outside the boundary is clean black.
// Data: pipeline/12_power.py (reads gee/day12_viirs_export.js and OSM). Without the export it writes flagged synthetic lights.
// The Record button plays the years while the camera turns, and saves a video file.
const P = 'd12-';
const DATA_URL = '/data/day12-power.json';
const GRID_URL = '/data/day12-grid.geojson';
const BOUNDARY_URL = '/data/caraga-boundary.geojson';
const BUTUAN: [number, number] = [125.54, 8.95];
const L_REF = 25; // radiance (nW/cm2/sr) that gets the full height
const HOLD_MS = 4000; // per year while recording
const SPIN = 0.003; // degrees of camera turn per ms while recording

const GRID_STOPS: [number, string][] = [[0, '#ffcf5c'], [2, '#fff1c9'], [6, '#8fd0ff']];
const DARK = '#3b4352';
const DIM = '#4a4f5c';

interface Power {
  meta: { synthetic: boolean; years: number[]; built_year: number; bbox: number[]; cell_deg: number; attribution: string };
  pts: number[][]; // [lon, lat, built 0..1, km to the grid, radiance per year...]
}

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const rgb = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const mix = (a: string, b: string, t: number) => {
  const x = rgb(a);
  const y = rgb(b);
  return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(',')})`;
};
const gridColor = (d: number) => {
  const dd = clamp(d, 0, GRID_STOPS[GRID_STOPS.length - 1][0]);
  for (let i = 1; i < GRID_STOPS.length; i++) {
    if (dd <= GRID_STOPS[i][0]) {
      const [d0, c0] = GRID_STOPS[i - 1];
      const [d1, c1] = GRID_STOPS[i];
      return mix(c0, c1, (dd - d0) / (d1 - d0));
    }
  }
  return GRID_STOPS[GRID_STOPS.length - 1][1];
};
const WORLD = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]] } } as any;
const EMPTY = { type: 'FeatureCollection', features: [] } as any;

const square = (lon: number, lat: number, half: number) => [[[lon - half, lat - half], [lon + half, lat - half], [lon + half, lat + half], [lon - half, lat + half], [lon - half, lat - half]]];

export default function Day12({ map }: { map: maplibregl.Map }) {
  const [data, setData] = useState<Power | null>(null);
  const [error, setError] = useState(false);
  const [ready, setReady] = useState(false);
  const [yi, setYi] = useState(2);
  const [exag, setExag] = useState(1);
  const [thr, setThr] = useState(0.5); // below this radiance the land counts as dark
  const [glow, setGlow] = useState(true);
  const [dim, setDim] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [recording, setRecording] = useState(false);
  const [probe, setProbe] = useState<{ l: number; d: number; b: number } | null>(null);

  const bounds = useRef<[[number, number], [number, number]] | null>(null);
  const rec = useRef<{ mr: MediaRecorder; chunks: Blob[]; timer: number; frame: () => void; raf: number; discard: boolean; bearing: number } | null>(null);
  const live = useRef({ year: 0, glow: true, thr: 0.5, synthetic: false, attribution: '' });
  const lightBefore = useRef<any>(null);
  const gridData = useRef<any>(EMPTY); // the OSM power lines, loaded with the data

  useEffect(() => {
    let off = false;
    Promise.all([fetch(DATA_URL).then((r) => (r.ok ? r.json() : Promise.reject())), fetch(GRID_URL).then((r) => (r.ok ? r.json() : EMPTY)).catch(() => EMPTY)])
      .then(([d, g]) => {
        if (off) return;
        setData(d);
        setYi(d.meta.years.length - 1); // start on the latest year
        gridData.current = g;
      })
      .catch(() => !off && setError(true));
    return () => {
      off = true;
    };
  }, []);
  const years = data?.meta.years ?? [];
  const half = (data?.meta.cell_deg ?? 0.0041) / 2;

  // columns, halo shells and glow points for the chosen year
  const shapes = useMemo(() => {
    if (!data) return null;
    const cols: any[] = [];
    const halo: any[] = [];
    const bloom: any[] = [];
    for (const p of data.pts) {
      const [lon, lat, b, d] = p;
      const l = p[4 + yi] ?? 0;
      const lit = l >= thr;
      const t = clamp(Math.log1p(Math.max(l, 0)) / Math.log1p(L_REF), 0, 1);
      const h = exag * (lit ? 200 + 3600 * t : 50 + 150 * b);
      const base = gridColor(d);
      const color = lit ? colorMix(DIM, base, 0.3 + 0.7 * Math.sqrt(t)) : DARK;
      cols.push({ type: 'Feature', properties: { h, color, l, d, b }, geometry: { type: 'Polygon', coordinates: square(lon, lat, half * 0.94) } });
      if (lit && t > 0.4) halo.push({ type: 'Feature', properties: { h: h * 0.85, color: base }, geometry: { type: 'Polygon', coordinates: square(lon, lat, half * 1.7) } });
      if (lit) bloom.push({ type: 'Feature', properties: { w: t }, geometry: { type: 'Point', coordinates: [lon, lat] } });
    }
    return { cols: { type: 'FeatureCollection', features: cols } as any, halo: { type: 'FeatureCollection', features: halo } as any, bloom: { type: 'FeatureCollection', features: bloom } as any };
  }, [data, yi, exag, thr, half]);

  // numbers for the panel
  const stats = useMemo(() => {
    if (!data) return null;
    const cellKm2 = data.meta.cell_deg * 111.32 * (data.meta.cell_deg * 111.32 * Math.cos((9 * Math.PI) / 180));
    const per = years.map((_, k) => {
      let lit = 0;
      let dark = 0;
      let darkFar = 0;
      let dLit = 0;
      let dDark = 0;
      let nLit = 0;
      let nDark = 0;
      for (const p of data.pts) {
        const b = p[2];
        if (b < 0.15) continue;
        if ((p[4 + k] ?? 0) >= thr) {
          lit += b;
          dLit += p[3];
          nLit++;
        } else {
          dark += b;
          dDark += p[3];
          nDark++;
          if (p[3] > 3) darkFar += b;
        }
      }
      return { lit: lit * cellKm2, dark: dark * cellKm2, darkShare: dark / Math.max(1e-9, lit + dark), farShare: darkFar / Math.max(1e-9, dark), dLit: nLit ? dLit / nLit : 0, dDark: nDark ? dDark / nDark : 0 };
    });
    return per;
  }, [data, thr, years]);

  // ---- map layers, built once the data is in ----
  useEffect(() => {
    if (!data) return;
    let cancelled = false;
    const ids: string[] = [];
    const srcs: string[] = [];
    const addSrc = (id: string, d: any) => {
      map.addSource(P + id, { type: 'geojson', data: d });
      srcs.push(P + id);
    };
    const addLayer = (l: any) => {
      map.addLayer({ ...l, id: P + l.id });
      ids.push(P + l.id);
    };
    fetch(BOUNDARY_URL)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((gj) => {
        if (cancelled) return;
        const polys = gj ? polygonsOf(gj) : null;
        addSrc('world', WORLD);
        addSrc('mask', polys ? inverseMask(polys) : EMPTY);
        addSrc('bloom', EMPTY);
        addSrc('halo', EMPTY);
        addSrc('cols', EMPTY);
        addSrc('grid', gridData.current);
        // a darkening veil over the basemap, so the lights stand out
        addLayer({ id: 'dim', type: 'fill', source: `${P}world`, paint: { 'fill-color': '#000000', 'fill-opacity': 0.7, 'fill-antialias': false } });
        // soft pools of light on the ground
        addLayer({
          id: 'bloom',
          type: 'heatmap',
          source: `${P}bloom`,
          paint: {
            'heatmap-weight': ['get', 'w'],
            'heatmap-intensity': 1.1,
            'heatmap-radius': ['interpolate', ['exponential', 2], ['zoom'], 6, 8, 9, 30, 12, 90],
            'heatmap-opacity': 0.9,
            'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,0,0,0)', 0.15, 'rgba(255,160,50,0.16)', 0.45, 'rgba(255,196,100,0.42)', 0.8, 'rgba(255,230,170,0.7)', 1, 'rgba(255,248,225,0.9)'],
          },
        });
        // clean black basemap outside the boundary (the outline itself is not drawn)
        addLayer({ id: 'mask', type: 'fill', source: `${P}mask`, paint: { 'fill-color': '#000000', 'fill-opacity': 1, 'fill-antialias': false } });
        addLayer({ id: 'halo', type: 'fill-extrusion', source: `${P}halo`, paint: { 'fill-extrusion-color': ['get', 'color'], 'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-base': 0, 'fill-extrusion-opacity': 0.14, 'fill-extrusion-vertical-gradient': false } });
        addLayer({ id: 'cols', type: 'fill-extrusion', source: `${P}cols`, paint: { 'fill-extrusion-color': ['get', 'color'], 'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-base': 0, 'fill-extrusion-opacity': 0.96, 'fill-extrusion-vertical-gradient': true } });
        addLayer({ id: 'lines-minor', type: 'line', source: `${P}grid`, filter: ['==', ['get', 'k'], 'minor'], paint: { 'line-color': '#5a7fa0', 'line-width': 0.7, 'line-opacity': 0.6 } });
        addLayer({ id: 'lines', type: 'line', source: `${P}grid`, filter: ['==', ['get', 'k'], 'line'], paint: { 'line-color': '#9bd6ff', 'line-width': 1.5, 'line-opacity': 0.9 } });
        addLayer({ id: 'subs-glow', type: 'circle', source: `${P}grid`, filter: ['in', ['get', 'k'], ['literal', ['substation', 'plant']]], paint: { 'circle-radius': 12, 'circle-color': '#9bd6ff', 'circle-opacity': 0.25, 'circle-blur': 1, 'circle-pitch-alignment': 'map' } });
        addLayer({ id: 'subs', type: 'circle', source: `${P}grid`, filter: ['in', ['get', 'k'], ['literal', ['substation', 'plant']]], paint: { 'circle-radius': ['match', ['get', 'k'], 'plant', 6, 3.5], 'circle-color': ['match', ['get', 'k'], 'plant', '#ffffff', '#9bd6ff'], 'circle-stroke-color': '#000000', 'circle-stroke-width': 1, 'circle-pitch-alignment': 'map' } });
        bounds.current = polys ? boundsOf(polys) : (data.meta.bbox ? [[data.meta.bbox[0], data.meta.bbox[1]], [data.meta.bbox[2], data.meta.bbox[3]]] : null);
        // a low, soft light so the columns do not look lit from outside
        try {
          lightBefore.current = (map as any).getLight?.();
          (map as any).setLight({ anchor: 'viewport', color: '#ffffff', intensity: 0.18, position: [1.5, 210, 40] });
        } catch {
          /* older MapLibre: keep the default light */
        }
        if (bounds.current) map.fitBounds(bounds.current, { padding: window.innerWidth > 900 ? { left: 410, right: 30, top: 30, bottom: 30 } : 20, pitch: 58, bearing: -15, duration: 0 });
        setReady(true);
      });
    return () => {
      cancelled = true;
      setReady(false);
      [...ids].reverse().forEach((l) => map.getLayer(l) && map.removeLayer(l));
      srcs.forEach((s) => map.getSource(s) && map.removeSource(s));
      try {
        (map as any).setLight(lightBefore.current ?? {});
      } catch {
        /* nothing to restore */
      }
      map.easeTo({ pitch: 0, bearing: 0, duration: 400 });
    };
  }, [map, data]);

  // push the year's shapes into the map
  useEffect(() => {
    if (!ready || !shapes) return;
    (map.getSource(`${P}cols`) as maplibregl.GeoJSONSource).setData(shapes.cols);
    (map.getSource(`${P}halo`) as maplibregl.GeoJSONSource).setData(shapes.halo);
    (map.getSource(`${P}bloom`) as maplibregl.GeoJSONSource).setData(shapes.bloom);
  }, [ready, shapes, map]);

  // switches
  useEffect(() => {
    if (!ready) return;
    const vis = (id: string, on: boolean) => map.getLayer(P + id) && map.setLayoutProperty(P + id, 'visibility', on ? 'visible' : 'none');
    vis('bloom', glow);
    vis('halo', glow);
    ['lines', 'lines-minor', 'subs', 'subs-glow'].forEach((l) => vis(l, showGrid));
    map.setPaintProperty(`${P}dim`, 'fill-opacity', dim ? 0.7 : 0);
  }, [ready, glow, dim, showGrid, map]);

  // click a column to read it
  useEffect(() => {
    if (!ready) return;
    const onClick = (e: maplibregl.MapMouseEvent) => {
      const f = map.queryRenderedFeatures(e.point, { layers: [`${P}cols`] })[0];
      setProbe(f ? { l: Number(f.properties?.l), d: Number(f.properties?.d), b: Number(f.properties?.b) } : null);
    };
    map.on('click', onClick);
    return () => {
      map.off('click', onClick);
    };
  }, [ready, map]);

  // play through the years
  useEffect(() => {
    if (!playing || recording) return;
    const t = setInterval(() => {
      setYi((cur) => {
        if (cur >= years.length - 1) {
          setPlaying(false);
          return cur;
        }
        return cur + 1;
      });
    }, 1800);
    return () => clearInterval(t);
  }, [playing, recording, years.length]);

  const region = (r: 'caraga' | 'butuan') => {
    if (r === 'butuan') map.flyTo({ center: BUTUAN, zoom: 10.6, pitch: 62, bearing: -20, duration: 1800 });
    else if (bounds.current) map.fitBounds(bounds.current, { padding: window.innerWidth > 900 ? { left: 410, right: 30, top: 30, bottom: 30 } : 20, pitch: 58, bearing: -15, duration: 1800 });
  };

  // ---- video recording: the years play while the camera turns slowly ----
  live.current = { year: years[yi] ?? 0, glow, thr, synthetic: !!data?.meta.synthetic, attribution: data?.meta.attribution ?? '' };

  const cleanupRecording = () => {
    const r = rec.current;
    if (!r) return;
    map.off('render', r.frame);
    clearInterval(r.timer);
    cancelAnimationFrame(r.raf);
  };
  const stopRecording = () => {
    const r = rec.current;
    if (!r) return;
    if (r.mr.state !== 'inactive') r.mr.stop(); // onstop saves the file
  };
  const startRecording = () => {
    if (rec.current || !data || !ready) return;
    setPlaying(false);
    const src = map.getCanvas();
    const off = document.createElement('canvas');
    off.width = src.width & ~1;
    off.height = src.height & ~1;
    const g = off.getContext('2d')!;
    const type = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t));
    if (!type || !('captureStream' in off)) {
      alert('This browser cannot record video from a canvas.');
      return;
    }
    const ext = type.startsWith('video/mp4') ? 'mp4' : 'webm';
    const mr = new MediaRecorder((off as any).captureStream(30), { mimeType: type, videoBitsPerSecond: 10_000_000 });
    const chunks: Blob[] = [];

    const frame = () => {
      const { year, glow: gl, thr: th, synthetic } = live.current;
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
      g.fillStyle = '#000';
      g.fillRect(0, 0, off.width, off.height);
      g.drawImage(src, 0, 0, off.width, off.height);
      // bloom: a blurred copy of the frame added back on top, so the lights seem to emit
      if (gl && 'filter' in g) {
        g.save();
        (g as any).filter = `blur(${Math.max(4, Math.round(off.width / 110))}px)`;
        g.globalCompositeOperation = 'screen';
        g.globalAlpha = 0.55;
        g.drawImage(off, 0, 0);
        g.restore();
      }
      const fs = Math.round(off.width / 30);
      g.lineJoin = 'round';
      g.textBaseline = 'alphabetic';
      g.textAlign = 'left';
      g.fillStyle = '#fff';
      g.strokeStyle = 'rgba(0,0,0,.95)';
      g.font = `700 ${fs}px system-ui, sans-serif`;
      g.lineWidth = fs / 6;
      g.strokeText('Power: the lit and the dark', fs * 0.7, fs * 1.4);
      g.fillText('Power: the lit and the dark', fs * 0.7, fs * 1.4);
      g.font = `${Math.round(fs * 0.5)}px system-ui, sans-serif`;
      g.lineWidth = fs / 10;
      const sub = `Height = night light · colour = distance to the nearest power line · dark stubs = built-up, under ${th} nW/cm²/sr`;
      g.strokeText(sub, fs * 0.7, fs * 2.1);
      g.fillText(sub, fs * 0.7, fs * 2.1);
      g.font = `700 ${fs * 2.6}px system-ui, sans-serif`;
      g.lineWidth = fs / 3;
      g.strokeText(String(year), fs * 0.7, off.height - fs * 0.9);
      g.fillText(String(year), fs * 0.7, off.height - fs * 0.9);
      // colour key
      const bw = off.width * 0.16;
      const bx = off.width - bw - fs * 0.8;
      const by = off.height - fs * 1.7;
      const gr = g.createLinearGradient(bx, 0, bx + bw, 0);
      GRID_STOPS.forEach(([d, c]) => gr.addColorStop(d / GRID_STOPS[GRID_STOPS.length - 1][0], c));
      g.fillStyle = gr;
      g.fillRect(bx, by, bw, fs * 0.4);
      g.fillStyle = '#fff';
      g.font = `${Math.round(fs * 0.42)}px system-ui, sans-serif`;
      g.textAlign = 'left';
      g.fillText('at the grid', bx, by + fs * 0.95);
      g.textAlign = 'right';
      g.fillText('6+ km away', bx + bw, by + fs * 0.95);
      if (synthetic) {
        g.fillStyle = '#b3261e';
        g.fillRect(off.width / 2 - fs * 6, fs * 0.3, fs * 12, fs * 0.9);
        g.fillStyle = '#fff';
        g.textAlign = 'center';
        g.font = `700 ${Math.round(fs * 0.5)}px system-ui, sans-serif`;
        g.fillText('DEMO DATA · synthetic lights', off.width / 2, fs * 0.92);
      }
    };
    map.on('render', frame);
    const timer = window.setInterval(() => map.triggerRepaint(), 33);

    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mr.onstop = () => {
      const r = rec.current;
      cleanupRecording();
      rec.current = null;
      setRecording(false);
      if (r) map.jumpTo({ bearing: r.bearing });
      if (!r || r.discard || !chunks.length) return;
      const url = URL.createObjectURL(new Blob(chunks, { type: type.split(';')[0] }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `power-lit-and-dark.${ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    };

    const bearing = map.getBearing();
    rec.current = { mr, chunks, timer, frame, raf: 0, discard: false, bearing };
    setRecording(true);
    setYi(0);
    mr.start();
    // let the first year sit for a moment, then turn the camera and step through the years
    setTimeout(() => {
      const r = rec.current;
      if (!r) return;
      const t0 = performance.now();
      let shown = 0;
      const tick = (now: number) => {
        const el = now - t0;
        map.setBearing(bearing + el * SPIN);
        const k = Math.min(years.length - 1, Math.floor(el / HOLD_MS));
        if (k !== shown) {
          shown = k;
          setYi(k);
        }
        if (el >= years.length * HOLD_MS + 800) return stopRecording();
        r.raf = requestAnimationFrame(tick);
      };
      r.raf = requestAnimationFrame(tick);
    }, 900);
  };

  // leaving the day discards an unfinished recording
  useEffect(
    () => () => {
      const r = rec.current;
      if (!r) return;
      r.discard = true;
      if (r.mr.state !== 'inactive') r.mr.stop();
      cleanupRecording();
      rec.current = null;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const seg = (on: boolean) => (on ? 'on' : '');
  const s = stats ? stats[yi] : null;
  const s0 = stats ? stats[0] : null;
  return (
    <div className="legend wide" style={{ width: 380, maxWidth: 380 }}>
      <h4>Power: the lit and the dark</h4>
      <p className="muted" style={{ margin: '0 0 6px' }}>
        Built-up land of Caraga as columns. Height is night-light brightness; colour is how far the land is from a power line or substation. Built-up land with no light stays a flat dark stub.
      </p>
      {error && (
        <p className="warn">
          Data missing. Run <code>python pipeline/12_power.py</code> to create <code>public/data/day12-power.json</code>.
        </p>
      )}
      {!data && !error && <p className="muted">Loading…</p>}
      {data?.meta.synthetic && <p className="warn">DEMO DATA: the lights are synthetic, not measured. Export the VIIRS composite (gee/day12_viirs_export.js) and run the pipeline again.</p>}

      {data && (
        <>
          <div style={{ display: 'flex', gap: 8, margin: '8px 0 4px' }}>
            <button
              disabled={recording}
              onClick={() => {
                if (!playing && yi >= years.length - 1) setYi(0);
                setPlaying((p) => !p);
              }}
              aria-label={playing ? 'Pause' : 'Play the years'}
              style={{ width: 40, height: 40, borderRadius: '50%', border: 0, background: 'var(--accent)', color: 'var(--on-accent, #fff)', fontSize: 16, cursor: recording ? 'default' : 'pointer', opacity: recording ? 0.5 : 1 }}
            >
              {playing ? '❚❚' : '▶'}
            </button>
            <div style={{ fontSize: 34, fontWeight: 700, lineHeight: '40px', fontVariantNumeric: 'tabular-nums' }}>{years[yi]}</div>
            <button
              onClick={recording ? stopRecording : startRecording}
              aria-label={recording ? 'Stop recording and save the video' : 'Record the years as a video'}
              style={{ marginLeft: 'auto', padding: '6px 12px', borderRadius: 16, border: 0, background: recording ? '#9b2226' : '#e5e7eb', color: recording ? '#fff' : '#111827', fontSize: 13, cursor: 'pointer', alignSelf: 'center' }}
            >
              {recording ? '■ Stop & save' : '● Record'}
            </button>
          </div>
          <div className="seg">
            {years.map((y, i) => (
              <button key={y} className={seg(yi === i)} disabled={recording} onClick={() => (setPlaying(false), setYi(i))}>
                {y}
              </button>
            ))}
          </div>

          {s && s0 && (
            <>
              <p style={{ margin: '8px 0 4px', fontSize: 14 }}>
                In {years[yi]}, <strong>{Math.round(s.darkShare * 100)}%</strong> of built-up land ({s.dark.toFixed(0)} km²) was dark. Dark land averages <strong>{s.dDark.toFixed(1)} km</strong> from the nearest line or substation, against {s.dLit.toFixed(1)} km for lit land.
              </p>
              <p className="muted" style={{ margin: '0 0 4px' }}>
                Lit built-up land: {s0.lit.toFixed(0)} km² in {years[0]}, {s.lit.toFixed(0)} km² in {years[yi]}. {Math.round(s.farShare * 100)}% of the dark land is more than 3 km from the grid.
              </p>
            </>
          )}
          {probe && (
            <p className="muted" style={{ margin: '0 0 4px' }}>
              Column you clicked: {probe.l.toFixed(1)} nW/cm²/sr, {probe.d.toFixed(1)} km from the grid, {Math.round(probe.b * 100)}% built over.
            </p>
          )}

          <p className="sub">Camera</p>
          <div className="seg">
            <button disabled={recording} onClick={() => region('caraga')}>
              Caraga region
            </button>
            <button disabled={recording} onClick={() => region('butuan')}>
              Fly to Butuan
            </button>
          </div>

          <p className="sub">Colour: distance to the grid</p>
          <div style={{ height: 10, borderRadius: 3, background: `linear-gradient(90deg, ${GRID_STOPS.map(([d, c]) => `${c} ${(d / 6) * 100}%`).join(', ')})`, border: '1px solid rgba(0,0,0,.2)' }} />
          <div className="muted" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
            <span>at a line</span>
            <span>3 km</span>
            <span>6+ km</span>
          </div>
          <div className="legend-row" style={{ cursor: 'default' }}>
            <span className="swatch" style={{ background: DARK, borderRadius: 2 }} />
            <span style={{ flex: 1 }}>Built-up, no light (flat stub)</span>
          </div>

          <label className="legend-row" style={{ display: 'block' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Counts as dark below</span>
              <strong>{thr.toFixed(1)} nW/cm²/sr</strong>
            </div>
            <input className="range" type="range" min={0.2} max={3} step={0.1} value={thr} disabled={recording} onChange={(e) => setThr(Number(e.target.value))} aria-label="Dark threshold" />
          </label>
          <label className="legend-row" style={{ display: 'block' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Height exaggeration</span>
              <strong>{exag.toFixed(1)}×</strong>
            </div>
            <input className="range" type="range" min={0.4} max={3} step={0.1} value={exag} disabled={recording} onChange={(e) => setExag(Number(e.target.value))} aria-label="Height exaggeration" />
          </label>
          {[
            ['Glow (ground bloom, halo, video bloom)', glow, setGlow],
            ['Darken the basemap inside the boundary', dim, setDim],
            ['Power lines and substations', showGrid, setShowGrid],
          ].map(([label, val, set]) => (
            <label key={label as string} className="legend-row">
              <input type="checkbox" checked={val as boolean} disabled={recording} onChange={() => (set as (f: (x: boolean) => boolean) => void)((x) => !x)} />
              <span style={{ flex: 1 }}>{label as string}</span>
            </label>
          ))}

          <details>
            <summary>Data and limits</summary>
            <p className="muted" style={{ margin: '6px 0 4px' }}>
              {data.meta.attribution}
            </p>
            <p className="muted" style={{ margin: '0 0 4px' }}>
              The built-up footprint is the {data.meta.built_year} GHSL layer, so it is the same in every year; only the lights change. Lights for years after {data.meta.built_year} can sit on land that was built later, which the footprint does not show. Night lights are annual composites at about 460 m, so one column is one cell of that grid. Lights are a rough sign of electricity use: street lamps, ports, mines and fishing boats can light up land that is not built over, and a dark cell may have power but little outdoor light.
            </p>
            <p className="muted" style={{ margin: 0 }}>
              OpenStreetMap power data is volunteer-mapped and incomplete, especially for low-voltage lines, so a long distance to the grid can mean a missing line. The glow is a visual effect and carries no data. Heights are exaggerated.
            </p>
          </details>
        </>
      )}
    </div>
  );
}

// css-colour mix for strings that are either #rrggbb or rgb(r,g,b)
function colorMix(a: string, b: string, t: number) {
  const parse = (c: string) => (c.startsWith('#') ? rgb(c) : (c.match(/\d+/g) ?? ['0', '0', '0']).slice(0, 3).map(Number));
  const x = parse(a);
  const y = parse(b);
  return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(',')})`;
}