import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { boundsOf, inverseMask, polygonsOf } from '../../core/geo';
import { downloadVideo, drawWrapped, RATIOS, startVideo, type Ratio, type VideoResult, type VideoSession } from '../../core/videoExport';
import ShareBar from '../../core/ShareBar';

// Day 13, Interaction: "The Urban Pulse" — Butuan City Traffic Flow & Commuter Interaction
const META_URL = '/data/day13-roads.json';
const PNG_URL = '/data/day13-roads.png';
const ROADS_URL = '/data/day13-roads.geojson';
const BOUNDARY_URL = '/data/butuan-boundary.geojson';
const P = 'd13-pulse-';

interface Meta {
  w: number;
  h: number;
  bbox: [number, number, number, number];
  attribution: string;
}

interface RoadSegment {
  coords: [number, number][];
  cumDist: number[];
  totalLen: number;
  isMain: boolean;
  mid: [number, number];
}

interface Vehicle {
  segIdx: number;
  t: number;        // 0..1 progress along segment
  dir: 1 | -1;      // travel direction
  baseSpeed: number;
  isMain: boolean;
}

const WORLD = {
  type: 'Feature',
  properties: {},
  geometry: { type: 'Polygon', coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]] },
} as any;
const EMPTY = { type: 'FeatureCollection', features: [] } as any;

const loadImage = (src: string) =>
  new Promise<ImageData>((ok, bad) => {
    const i = new Image();
    i.onload = () => {
      const c = document.createElement('canvas');
      c.width = i.naturalWidth;
      c.height = i.naturalHeight;
      const g = c.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(i, 0, 0);
      ok(g.getImageData(0, 0, c.width, c.height));
    };
    i.onerror = bad;
    i.src = src;
  });

// Ray-casting point-in-polygon helper for strict boundary clipping
function pointInPolygon(pt: [number, number], polygon: number[][]): boolean {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInMultipolygon(pt: [number, number], geometry: any): boolean {
  if (!geometry) return true;
  if (geometry.type === 'Polygon') {
    return pointInPolygon(pt, geometry.coordinates[0]);
  } else if (geometry.type === 'MultiPolygon') {
    for (const poly of geometry.coordinates) {
      if (pointInPolygon(pt, poly[0])) return true;
    }
  }
  return false;
}

function trafficMultiplier(hour: number): { volume: number; congestion: number; label: string } {
  const amPeak = Math.exp(-Math.pow((hour - 8.0) / 1.6, 2));
  const pmPeak = Math.exp(-Math.pow((hour - 17.5) / 2.0, 2));
  const daytime = hour >= 6 && hour <= 21 ? 0.4 : 0.1;
  const volume = Math.min(1, daytime + 0.6 * Math.max(amPeak, pmPeak));
  const congestion = Math.max(0, (volume - 0.5) / 0.5);

  let label = 'Late Night Free-Flow';
  if (hour >= 6.5 && hour < 9.5) label = 'Morning Commute Rush';
  else if (hour >= 9.5 && hour < 16) label = 'Midday Commercial Flow';
  else if (hour >= 16 && hour < 19.5) label = 'Evening Peak Bottleneck';
  else if (hour >= 19.5 && hour < 22.5) label = 'Evening Wind-Down';

  return { volume, congestion, label };
}

export default function Day13({ map }: { map: maplibregl.Map }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [segments, setSegments] = useState<RoadSegment[]>([]);
  const [footprintUrl, setFootprintUrl] = useState<string>('');
  const [error, setError] = useState(false);
  const [ready, setReady] = useState(false);

  // Interactive Simulation & View Controls
  const [hour, setHour] = useState<number>(8.0);
  const [playing, setPlaying] = useState<boolean>(true);
  const [particleCount, setParticleCount] = useState<number>(1100);
  const [showLocalRoads, setShowLocalRoads] = useState<boolean>(true);
  const [is3D, setIs3D] = useState<boolean>(false);
  const [attractor, setAttractor] = useState<[number, number] | null>(null);

  // Video Export State
  const [recording, setRecording] = useState(false);
  const [ratio, setRatio] = useState<Ratio>('3:4');
  const [video, setVideo] = useState<VideoResult | null>(null);
  const [videoError, setVideoError] = useState('');

  const roadsGeoJson = useRef<any>(EMPTY);
  const vehiclesRef = useRef<Vehicle[]>([]);
  const animRef = useRef<number>(0);
  const hourRef = useRef<number>(hour);
  const playingRef = useRef<boolean>(playing);
  const recordingRef = useRef<boolean>(recording);
  const attractorRef = useRef<[number, number] | null>(attractor);
  const session = useRef<VideoSession | null>(null);
  const live = useRef({ timeStr: '08:00', status: '', activeVehicles: 0, attribution: '' });

  hourRef.current = hour;
  playingRef.current = playing;
  recordingRef.current = recording;
  attractorRef.current = attractor;

  // Load metadata, GHSL footprint, boundary, and OSM roads strictly clipped to Butuan boundary polygon
  useEffect(() => {
    let off = false;
    (async () => {
      try {
        const [m, boundaryGj, img, roads] = await Promise.all([
          fetch(META_URL).then((r) => (r.ok ? r.json() : Promise.reject())),
          fetch(BOUNDARY_URL).then((r) => (r.ok ? r.json() : null)).catch(() => null),
          loadImage(PNG_URL).catch(() => null),
          fetch(ROADS_URL).then((r) => (r.ok ? r.json() : EMPTY)),
        ]);
        if (off) return;

        if (img) {
          const cv = document.createElement('canvas');
          cv.width = m.w;
          cv.height = m.h;
          const g = cv.getContext('2d')!;
          const out = g.createImageData(m.w, m.h);
          for (let i = 0; i < m.w * m.h; i++) {
            const e = img.data[i * 4];
            if (e < 254) {
              out.data[i * 4] = 30;
              out.data[i * 4 + 1] = 41;
              out.data[i * 4 + 2] = 59;
              out.data[i * 4 + 3] = 150;
            }
          }
          g.putImageData(out, 0, 0);
          setFootprintUrl(cv.toDataURL());
        }

        const boundaryGeom = boundaryGj?.geometry || boundaryGj?.features?.[0]?.geometry;
        const parsed: RoadSegment[] = [];

        const addLine = (coords: [number, number][], isMain: boolean) => {
          let currentSub: [number, number][] = [];
          
          const flushSub = () => {
            if (currentSub.length >= 2) {
              const cumDist = [0];
              let total = 0;
              for (let i = 1; i < currentSub.length; i++) {
                const dx = currentSub[i][0] - currentSub[i - 1][0];
                const dy = currentSub[i][1] - currentSub[i - 1][1];
                total += Math.hypot(dx, dy);
                cumDist.push(total);
              }
              if (total > 0.0001) {
                const mid = currentSub[Math.floor(currentSub.length / 2)];
                parsed.push({ coords: [...currentSub], cumDist, totalLen: total, isMain, mid });
              }
            }
            currentSub = [];
          };

          for (const c of coords) {
            const inside = !boundaryGeom || pointInMultipolygon(c, boundaryGeom);
            if (inside) {
              currentSub.push(c);
            } else {
              flushSub();
            }
          }
          flushSub();
        };

        (roads.features || []).forEach((f: any) => {
          const isMain = f.properties?.k === 'main';
          if (f.geometry?.type === 'LineString') {
            addLine(f.geometry.coordinates, isMain);
          } else if (f.geometry?.type === 'MultiLineString') {
            f.geometry.coordinates.forEach((line: [number, number][]) => addLine(line, isMain));
          }
        });

        roadsGeoJson.current = roads;
        setSegments(parsed);
        setMeta(m);
      } catch {
        if (!off) setError(true);
      }
    })();
    return () => {
      off = true;
    };
  }, []);

  // Initialize simulated vehicle particles heavily weighted toward main highways (85%)
  useEffect(() => {
    if (!segments.length) return;
    const mainIndices: number[] = [];
    const localIndices: number[] = [];
    segments.forEach((seg, idx) => {
      if (seg.isMain) mainIndices.push(idx);
      else localIndices.push(idx);
    });

    const list: Vehicle[] = [];
    for (let i = 0; i < particleCount; i++) {
      const pickMain = (Math.random() < 0.85 && mainIndices.length > 0) || localIndices.length === 0;
      const pool = pickMain ? mainIndices : localIndices;
      const segIdx = pool[Math.floor(Math.random() * pool.length)];
      list.push({
        segIdx,
        t: Math.random(),
        dir: Math.random() > 0.5 ? 1 : -1,
        baseSpeed: (pickMain ? 0.0055 : 0.0018) * (0.8 + Math.random() * 0.4),
        isMain: pickMain,
      });
    }
    vehiclesRef.current = list;
  }, [segments, particleCount]);

  // Setup MapLibre layers & click attractor
  useEffect(() => {
    if (!meta) return;
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
        const [w0, s0, e0, n0] = meta.bbox;

        addSrc('world', WORLD);
        addSrc('mask', polys ? inverseMask(polys) : EMPTY);
        addSrc('boundary', gj || EMPTY);
        addSrc('roads', roadsGeoJson.current);
        addSrc('vehicles', EMPTY);
        addSrc('attractor', EMPTY);

        if (footprintUrl) {
          map.addSource(P + 'footprint', {
            type: 'image',
            url: footprintUrl,
            coordinates: [[w0, n0], [e0, n0], [e0, s0], [w0, s0]],
          });
          srcs.push(P + 'footprint');
        }

        addLayer({ id: 'veil', type: 'fill', source: `${P}world`, paint: { 'fill-color': '#000000', 'fill-opacity': 1 } });
        addLayer({ id: 'mask', type: 'fill', source: `${P}mask`, paint: { 'fill-color': '#000000', 'fill-opacity': 1 } });

        addLayer({
          id: 'boundary-fill',
          type: 'fill',
          source: `${P}boundary`,
          paint: { 'fill-color': '#0f172a', 'fill-opacity': 0.7 },
        });

        if (footprintUrl) {
          addLayer({ id: 'footprint', type: 'raster', source: `${P}footprint`, paint: { 'raster-opacity': 0.5, 'raster-fade-duration': 0 } });
        }

        addLayer({
          id: 'boundary-line',
          type: 'line',
          source: `${P}boundary`,
          paint: { 'line-color': '#38bdf8', 'line-width': 1.4, 'line-opacity': 0.5, 'line-dasharray': [3, 3] },
        });

        addLayer({
          id: 'roads-local',
          type: 'line',
          source: `${P}roads`,
          filter: ['==', ['get', 'k'], 'local'],
          paint: { 'line-color': '#64748b', 'line-width': 0.6, 'line-opacity': 0.5 },
        });
        addLayer({
          id: 'roads-main',
          type: 'line',
          source: `${P}roads`,
          filter: ['==', ['get', 'k'], 'main'],
          paint: { 'line-color': '#f8fafc', 'line-width': 1.3, 'line-opacity': 0.95 },
        });

        addLayer({
          id: 'vehicles-glow',
          type: 'circle',
          source: `${P}vehicles`,
          paint: {
            'circle-radius': ['case', ['==', ['get', 'main'], 1], 6.0, 3.0],
            'circle-color': [
              'interpolate',
              ['linear'],
              ['get', 'congestion'],
              0, '#00f5d4',
              0.5, '#fee440',
              1, '#ff2a6d',
            ],
            'circle-opacity': 0.35,
            'circle-blur': 0.8,
          },
        });
        addLayer({
          id: 'vehicles-core',
          type: 'circle',
          source: `${P}vehicles`,
          paint: {
            'circle-radius': ['case', ['==', ['get', 'main'], 1], 2.0, 1.0],
            'circle-color': '#ffffff',
            'circle-opacity': 0.95,
          },
        });

        addLayer({
          id: 'attractor-ring',
          type: 'circle',
          source: `${P}attractor`,
          paint: {
            'circle-radius': 18,
            'circle-color': 'rgba(255, 42, 109, 0.15)',
            'circle-stroke-width': 2,
            'circle-stroke-color': '#ff2a6d',
          },
        });

        const b = polys ? boundsOf(polys) : null;
        map.fitBounds(b ?? [[w0, s0], [e0, n0]], {
          padding: window.innerWidth > 900 ? { left: 390, right: 20, top: 20, bottom: 20 } : 20,
          duration: 0,
        });
        setReady(true);
      });

    const onMapClick = (e: maplibregl.MapMouseEvent) => {
      const pt: [number, number] = [e.lngLat.lng, e.lngLat.lat];
      setAttractor(pt);
    };
    map.on('click', onMapClick);

    return () => {
      cancelled = true;
      setReady(false);
      map.off('click', onMapClick);
      [...ids].reverse().forEach((l) => map.getLayer(l) && map.removeLayer(l));
      srcs.forEach((s) => map.getSource(s) && map.removeSource(s));
    };
  }, [map, meta, footprintUrl]);

  // Toggle local road visibility
  useEffect(() => {
    if (!ready) return;
    map.setLayoutProperty(`${P}roads-local`, 'visibility', showLocalRoads ? 'visible' : 'none');
  }, [ready, showLocalRoads, map]);

  // Handle 2D vs 3D View Transition
  useEffect(() => {
    if (!ready) return;
    if (is3D) {
      map.easeTo({ pitch: 55, bearing: -20, duration: 1200 });
    } else {
      map.easeTo({ pitch: 0, bearing: 0, duration: 1200 });
    }
  }, [ready, is3D, map]);

  // Update Attractor GeoJSON
  useEffect(() => {
    if (!ready) return;
    const src = map.getSource(`${P}attractor`) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData(
      attractor
        ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: attractor }, properties: {} }] }
        : EMPTY,
    );
  }, [ready, attractor, map]);

  // 60fps Particle Simulation Loop with Realistic Local Density Slowdowns
  useEffect(() => {
    if (!ready || !segments.length) return;
    let lastTime = performance.now();

    const interpolatePoint = (seg: RoadSegment, t: number): [number, number] => {
      const target = t * seg.totalLen;
      for (let i = 1; i < seg.cumDist.length; i++) {
        if (seg.cumDist[i] >= target) {
          const span = seg.cumDist[i] - seg.cumDist[i - 1] || 1e-9;
          const f = (target - seg.cumDist[i - 1]) / span;
          const p0 = seg.coords[i - 1];
          const p1 = seg.coords[i];
          return [p0[0] + (p1[0] - p0[0]) * f, p0[1] + (p1[1] - p0[1]) * f];
        }
      }
      return seg.coords[seg.coords.length - 1];
    };

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - lastTime) / 1000);
      lastTime = now;

      if (playingRef.current || recordingRef.current) {
        const hourStep = recordingRef.current ? dt * (24 / 15) : dt * 0.4;
        setHour((prev) => (prev + hourStep) % 24);
      }

      const { volume, congestion } = trafficMultiplier(hourRef.current);
      const vehicles = vehiclesRef.current;
      const activeLimit = Math.max(120, Math.floor(vehicles.length * volume));
      const att = attractorRef.current;

      const features: any[] = [];
      for (let i = 0; i < activeLimit; i++) {
        const v = vehicles[i];
        const seg = segments[v.segIdx];
        if (!seg) continue;

        // Realistic Local Density Slowdown: 
        // Vehicles only slow down if close to a clicked attractor hub or if main highways experience peak friction.
        // Empty roads maintain free-flow speed (localCongestion stays near 0).
        let localCongestion = 0;
        if (att) {
          const distToHub = Math.hypot(seg.mid[0] - att[0], seg.mid[1] - att[1]);
          if (distToHub < 0.025) {
            const pull = 1 - distToHub / 0.025;
            localCongestion = pull * 0.8;
          }
        }

        if (v.isMain) {
          localCongestion = Math.min(1, localCongestion + congestion * 0.35);
        }

        const speedFactor = 1 - localCongestion * 0.55;
        v.t += v.dir * v.baseSpeed * speedFactor * (dt * 220);

        if (v.t >= 1 || v.t <= 0) {
          if (att && Math.random() < 0.5) {
            const candidateIdx = Math.floor(Math.random() * segments.length);
            const cand = segments[candidateIdx];
            if (Math.hypot(cand.mid[0] - att[0], cand.mid[1] - att[1]) < 0.03) {
              v.segIdx = candidateIdx;
            }
          } else {
            v.segIdx = Math.floor(Math.random() * segments.length);
          }
          v.dir = Math.random() > 0.5 ? 1 : -1;
          v.t = v.dir === 1 ? 0 : 1;
        }

        const coord = interpolatePoint(seg, Math.max(0, Math.min(1, v.t)));
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: coord },
          properties: {
            main: v.isMain ? 1 : 0,
            congestion: Number(localCongestion.toFixed(2)),
          },
        });
      }

      const src = map.getSource(`${P}vehicles`) as maplibregl.GeoJSONSource | undefined;
      if (src) {
        src.setData({ type: 'FeatureCollection', features });
      }

      animRef.current = requestAnimationFrame(tick);
    };

    animRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animRef.current);
  }, [ready, segments, map]);

  const hh = Math.floor(hour);
  const mm = Math.floor((hour - hh) * 60);
  const timeStr = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  const pulseState = useMemo(() => trafficMultiplier(hour), [hour]);
  const activeCount = Math.max(120, Math.floor(particleCount * pulseState.volume));

  live.current = {
    timeStr,
    status: pulseState.label,
    activeVehicles: activeCount,
    attribution: meta?.attribution ?? 'OSM Road Network & GHSL Built-Up Footprint',
  };

  const fileName = 'butuan-urban-pulse-day13';
  const stopRecording = () => session.current?.stop();
  const drawVideoOverlay = (g: CanvasRenderingContext2D, w: number, h: number) => {
    const { timeStr: tStr, status, activeVehicles, attribution } = live.current;
    const u = Math.min(w, h * 0.75) / 100;
    g.lineJoin = 'round';
    g.textAlign = 'left';
    g.fillStyle = '#fff';
    g.strokeStyle = 'rgba(0,0,0,.9)';

    g.font = `700 ${u * 5.2}px system-ui, sans-serif`;
    g.lineWidth = u * 0.8;
    const y1 = drawWrapped(g, 'The Urban Pulse: Butuan City', u * 5, u * 10, w - u * 10, u * 6.2);

    g.font = `${u * 2.8}px system-ui, sans-serif`;
    g.lineWidth = u * 0.5;
    drawWrapped(g, `${status} · ${activeVehicles} active commuter flows`, u * 5, y1 + u * 0.5, w - u * 10, u * 3.6);

    g.font = `800 ${u * 18}px system-ui, sans-serif`;
    g.lineWidth = u * 1.4;
    g.strokeText(tStr, u * 4.5, h - u * 11);
    g.fillText(tStr, u * 4.5, h - u * 11);

    g.font = `${u * 1.9}px system-ui, sans-serif`;
    g.lineWidth = u * 0.4;
    g.strokeText(attribution, u * 5, h - u * 3.5);
    g.fillText(attribution, u * 5, h - u * 3.5);
  };

  const startRecording = () => {
    if (!meta || session.current) return;
    const W = map.getCanvas().clientWidth;
    const panel = window.innerWidth > 900 ? 390 : 0;
    const phone = window.matchMedia('(pointer: coarse)').matches;
    const s = startVideo({
      map,
      ratio,
      shortSide: phone ? 720 : 1080,
      focus: { x: (panel + (W - panel) / 2) / W, y: 0.5 },
      drawOverlay: drawVideoOverlay,
    });
    if (!s) {
      setVideoError('Browser cannot record canvas video.');
      return;
    }
    setVideoError('');
    session.current = s;
    setVideo(null);
    setRecording(true);
    setHour(0.0);
    setPlaying(true);
    void s.done.then((res) => {
      session.current = null;
      setRecording(false);
      if (!res) return;
      setVideo(res);
      if (!phone) downloadVideo(res, fileName);
    });
    setTimeout(() => session.current?.stop(), 15000);
  };

  return (
    <div className="legend wide" style={{ width: 360, maxWidth: 360 }}>
      <h4>The Urban Pulse: Butuan Traffic</h4>
      <p className="muted" style={{ margin: '0 0 8px' }}>
        Procedural traffic flow simulated across real OpenStreetMap road networks strictly clipped to the city boundary. <strong>Click anywhere on the map</strong> to drop a commuter hub and trigger localized congestion.
      </p>

      {error && <p className="warn">Missing <code>/data/day13-roads.geojson</code> or metadata.</p>}
      {!meta && !error && <p className="muted">Loading network topology…</p>}

      {meta && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <button
              disabled={recording}
              onClick={() => setPlaying((x) => !x)}
              aria-label={playing ? 'Pause' : 'Play'}
              style={{
                width: 38,
                height: 38,
                borderRadius: '50%',
                border: 0,
                background: 'var(--accent, #00f5d4)',
                color: '#050811',
                fontWeight: 700,
                fontSize: 15,
                cursor: 'pointer',
              }}
            >
              {playing ? '❚❚' : '▶'}
            </button>
            <div style={{ fontSize: 34, fontWeight: 800, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{timeStr}</div>
            <button
              onClick={recording ? stopRecording : startRecording}
              style={{
                marginLeft: 'auto',
                padding: '6px 12px',
                borderRadius: 16,
                border: 0,
                background: recording ? '#9b2226' : '#e5e7eb',
                color: recording ? '#fff' : '#111827',
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              {recording ? '■ Stop & save' : '⬇ Record pulse'}
            </button>
          </div>

          <input
            className="range"
            type="range"
            min={0}
            max={23.9}
            step={0.1}
            value={hour}
            disabled={recording}
            onChange={(e) => {
              setPlaying(false);
              setHour(Number(e.target.value));
            }}
            aria-label="Time of Day"
          />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, background: 'rgba(128,128,128,0.1)', padding: 10, borderRadius: 8, margin: '8px 0' }}>
            <div>
              <div className="muted" style={{ fontSize: 11 }}>Traffic Regime</div>
              <strong style={{ fontSize: 13 }}>{pulseState.label}</strong>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 11 }}>Active Flows / Segments</div>
              <strong style={{ fontSize: 13 }}>{activeCount} / {segments.length}</strong>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, margin: '6px 0 2px' }}>
            <span style={{ color: '#00f5d4' }}>● Free-Flow</span>
            <span style={{ color: '#fee440' }}>● Moderate</span>
            <span style={{ color: '#ff2a6d' }}>● Peak Bottleneck</span>
          </div>

          {attractor && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(255, 42, 109, 0.15)', padding: '6px 10px', borderRadius: 6, marginTop: 6, fontSize: 12 }}>
              <span>📍 Active Commuter Hub</span>
              <button
                onClick={() => setAttractor(null)}
                style={{ background: 'transparent', border: '1px solid currentColor', borderRadius: 4, padding: '2px 6px', fontSize: 11, cursor: 'pointer' }}
              >
                Clear
              </button>
            </div>
          )}

          <p className="sub" style={{ marginTop: 10 }}>View Mode</p>
          <div className="seg">
            <button className={!is3D ? 'on' : ''} disabled={recording} onClick={() => setIs3D(false)}>
              2D Flat View
            </button>
            <button className={is3D ? 'on' : ''} disabled={recording} onClick={() => setIs3D(true)}>
              3D Perspective
            </button>
          </div>

          <label className="legend-row" style={{ display: 'block', marginTop: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Fleet Simulation Density</span>
              <strong>{particleCount} vehicles</strong>
            </div>
            <input
              className="range"
              type="range"
              min={200}
              max={2000}
              step={100}
              value={particleCount}
              disabled={recording}
              onChange={(e) => setParticleCount(Number(e.target.value))}
            />
          </label>

          <label className="legend-row">
            <input type="checkbox" checked={showLocalRoads} onChange={() => setShowLocalRoads((x) => !x)} />
            <span style={{ flex: 1 }}>Show residential & local feeder streets</span>
          </label>

          <p className="sub">Video shape</p>
          <div className="seg">
            {RATIOS.map((r) => (
              <button key={r} className={ratio === r ? 'on' : ''} disabled={recording} onClick={() => setRatio(r)}>
                {r === 'screen' ? 'As on screen' : r}
              </button>
            ))}
          </div>
          {videoError && <p className="warn">{videoError}</p>}
          {video && <ShareBar title="The Urban Pulse: Butuan City" text="Simulated 24-hour commuter flow across Butuan's OpenStreetMap road network (#30DayMapChallenge Day 13: Interaction)" video={video} fileName={fileName} />}
        </>
      )}

      <p className="muted" style={{ marginTop: 8 }}>
        {meta?.attribution ?? 'Roads: OpenStreetMap contributors (ODbL). Boundary: Butuan City.'}
      </p>
    </div>
  );
}