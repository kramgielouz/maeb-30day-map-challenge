import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { addBoundary, type BoundaryHandle } from '../../core/boundary';
import { clipLine, lineLengthM } from '../../core/geo';
import { KINDS, loadBadge } from '../day01-points/icons';
import {
  buildNetwork,
  chooseLandings,
  indexEdges,
  indexPath,
  makeFrame,
  makePath,
  nearestNode,
  nodeAt,
  pointAtDist,
  positionAt,
  project,
  shortest,
  unproject,
  type Frame,
  type Path,
  type Pt,
  type RawLine,
  type Speeds,
} from './graph';

// Utopia: every river, canal and creek in Butuan developed into a transport channel, with boats running between landings.
// Data: Day 2 waterways, Day 1 facilities, Day 4 points of interest. Nothing new to download.
const WW_URL = '/data/day02-waterways.geojson';
const FAC_URL = '/data/day01-facilities.geojson';
const POI_URL = '/data/day04-pois.geojson';

const S = { net: 'd08-net', stops: 'd08-stops', route: 'd08-route', wake: 'd08-wake', pts: 'd08-boat-pts', hull: 'd08-boat-hull', fac: 'd08-fac', poi: 'd08-poi', near: 'd08-near' };
const L = {
  dim: 'd08-dim',
  bld: 'd08-bld',
  glow: 'd08-glow',
  casing: 'd08-casing',
  water: 'd08-water',
  core: 'd08-core',
  routeCasing: 'd08-route-casing',
  route: 'd08-route-line',
  poi: 'd08-poi-dot',
  fac: 'd08-fac-icon',
  poiLabel: 'd08-poi-label',
  facLabel: 'd08-fac-label',
  near: 'd08-near-ring',
  wake: 'd08-wake-line',
  stops: 'd08-stops-circle',
  pulse: 'd08-boat-glow',
  dot: 'd08-boat-dot',
  track: 'd08-boat-track',
  hull: 'd08-boat-3d',
};
const BND = 'd08-bnd-area'; // first layer added by addBoundary, so our basemap layers go underneath it
const imgId = (k: string) => `d08-fac-${k}`;

const CLS = ['river', 'canal', 'stream', 'drain'];
// width is the imagined width of the developed channel; kmh is an assumed boat speed
const CI: Record<string, { label: string; color: string; width: number; kmh: number }> = {
  river: { label: 'River', color: '#0b7fb8', width: 44, kmh: 22 },
  canal: { label: 'Canal', color: '#1496c8', width: 28, kmh: 16 },
  stream: { label: 'Creek', color: '#3bb3da', width: 16, kmh: 11 },
  drain: { label: 'Drain / ditch', color: '#7cc8e0', width: 10, kmh: 8 },
};
const SPEEDS: Speeds = Object.fromEntries(CLS.map((c) => [c, CI[c].kmh / 3.6]));

// same groups and colours as Day 4
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
const DUP_CATS = new Set(['hospital', 'clinic', 'school', 'fire_station', 'police']); // already shown as Day 1 facilities

const WALK_M = 400; // about a five-minute walk
const POI_REACH_M = 150; // shops within this distance of a channel are shown
const R_IN = 140; // a place pops up when the tracked boat is this close
const R_OUT = 190; // and goes away again beyond this
const BOAT_LEN = 34;
const BOAT_W = 10;
const EMPTY = { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection;
const fc = (features: unknown[]) => ({ type: 'FeatureCollection', features }) as GeoJSON.FeatureCollection;
const fmt = (n: number, d = 0) => n.toLocaleString(undefined, { maximumFractionDigits: d });
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const pretty = (s: string) => (s ? s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : '');

interface Fac {
  id: string;
  x: number;
  y: number;
  lon: number;
  lat: number;
  kind: string;
  name: string;
}
interface Poi {
  id: string;
  x: number;
  y: number;
  lon: number;
  lat: number;
  group: string;
  cat: string;
  name: string;
}
// a place a boat can pass: a Day 1 facility or a Day 4 shop or service
interface Place {
  id: string;
  x: number;
  y: number;
  lon: number;
  lat: number;
  name: string;
  type: string; // e.g. Hospital, Fast food
  group: string; // e.g. Critical facility, Shops
  fac: boolean;
}
interface Boat {
  path: Path | null;
  from: number;
  to: number;
  start: number;
  hold: number;
}
interface Passing {
  id: string;
  name: string;
  type: string;
  group: string;
  d: number;
  left: boolean;
}
interface Trip {
  from: number;
  to: number;
  pct: number;
}
type Cam = 'overview' | 'follow' | 'free';

export default function Day08({ map }: { map: maplibregl.Map }) {
  const [lines, setLines] = useState<RawLine[] | null>(null);
  const [facs, setFacs] = useState<Fac[]>([]);
  const [pois, setPois] = useState<Poi[]>([]);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [missing, setMissing] = useState(false);
  const [ready, setReady] = useState(false);
  const [enabled, setEnabled] = useState<Set<string>>(new Set(CLS));
  const [boatsN, setBoatsN] = useState(24);
  const [warp, setWarp] = useState(20);
  const [night, setNight] = useState(true);
  const [cam, setCam] = useState<Cam>('overview');
  const [extra, setExtra] = useState<Pt[]>([]);
  const [sel, setSel] = useState<number[]>([]);
  const [showFac, setShowFac] = useState(true);
  const [showPoi, setShowPoi] = useState(true);
  const [tracked, setTracked] = useState(0);
  const [passing, setPassing] = useState<Passing[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [trip, setTrip] = useState<Trip | null>(null);

  // live values the animation loop and map handlers read without re-subscribing
  const boundsRef = useRef<[[number, number], [number, number]] | null>(null);
  const boatsRef = useRef(boatsN);
  const warpRef = useRef(warp);
  const camRef = useRef<Cam>(cam);
  const trackedRef = useRef(tracked);
  const netRef = useRef<ReturnType<typeof buildNetwork> | null>(null);
  const frameRef = useRef<Frame | null>(null);
  const gridRef = useRef<Map<string, Place[]>>(new Map());
  boatsRef.current = boatsN;
  warpRef.current = warp;
  camRef.current = cam;
  trackedRef.current = tracked;
  frameRef.current = frame;

  // ---------- the network and its landings ----------
  const net = useMemo(() => (lines && frame ? buildNetwork(lines.filter((l) => enabled.has(l.cls)), frame) : null), [lines, frame, enabled]);
  const auto = useMemo(() => (net ? chooseLandings(net, facs.map((f) => [f.x, f.y] as Pt), { spacing: 700, radius: WALK_M, max: 36 }) : []), [net, facs]);
  const landings = useMemo(() => {
    if (!net) return [];
    const out = [...auto];
    for (const [x, y] of extra) {
      const n = nearestNode(net, x, y, 250);
      if (n >= 0 && !out.includes(n)) out.push(n);
    }
    return out;
  }, [net, auto, extra]);
  netRef.current = net;

  useEffect(() => setSel([]), [landings]);

  // ---------- places along the channels ----------
  const places = useMemo(() => {
    if (!net) return { fac: [] as Place[], poi: [] as Place[] };
    const chan = indexEdges(net, true);
    const facIds = new Set(facs.map((f) => f.id));
    const fac: Place[] = facs
      .filter((f) => chan.within(f.x, f.y, WALK_M))
      .map((f) => ({ id: f.id, x: f.x, y: f.y, lon: f.lon, lat: f.lat, name: f.name, type: KINDS[f.kind]?.label ?? pretty(f.kind), group: 'Critical facility', fac: true }));
    const poi: Place[] = pois
      .filter((p) => p.name && !facIds.has(p.id) && !DUP_CATS.has(p.cat) && chan.within(p.x, p.y, POI_REACH_M))
      .slice(0, 3000)
      .map((p) => ({ id: p.id, x: p.x, y: p.y, lon: p.lon, lat: p.lat, name: p.name, type: pretty(p.cat), group: GROUPS[p.group]?.label ?? 'Other', fac: false }));
    return { fac, poi };
  }, [net, facs, pois]);

  // spatial hash of the named places, for "what is the boat passing?"
  useEffect(() => {
    const g = new Map<string, Place[]>();
    for (const p of [...places.fac, ...places.poi]) {
      if (!p.name) continue;
      const k = `${Math.floor(p.x / 200)},${Math.floor(p.y / 200)}`;
      const c = g.get(k);
      if (c) c.push(p);
      else g.set(k, [p]);
    }
    gridRef.current = g;
  }, [places]);

  // a landing is named after the nearest named facility, or failing that the nearest named shop
  const landingNames = useMemo(() => {
    if (!net) return [] as string[];
    const nearest = (n: number, list: Place[], r: number) => {
      let best = '';
      let bd = r;
      for (const p of list) {
        if (!p.name) continue;
        const d = Math.hypot(p.x - net.x[n], p.y - net.y[n]);
        if (d < bd) {
          bd = d;
          best = p.name;
        }
      }
      return best;
    };
    return landings.map((n) => nearest(n, places.fac, WALK_M) || nearest(n, places.poi, 250));
  }, [net, landings, places]);
  const lname = (i: number) => `Landing ${i + 1}${landingNames[i] ? ` · ${landingNames[i]}` : ''}`;

  // ---------- mount: boundary, data, layers, handlers ----------
  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    let bh: BoundaryHandle | null = null;
    const popup = new maplibregl.Popup({ closeButton: false, offset: 12 });
    const cleanups: (() => void)[] = [];

    (async () => {
      bh = await addBoundary(map, 'd08', { mask: false, signal: ac.signal });
      if (cancelled) return;
      boundsRef.current = bh?.bounds ?? null;

      let ww: { geometry: { coordinates: number[][] }; properties: { waterway: string } }[];
      let fp: { geometry: { coordinates: number[] }; properties: { osm_id?: string; kind: string; name?: string } }[] = [];
      let pp: { geometry: { coordinates: number[] }; properties: { osm_id?: string; group: string; cat: string; name?: string } }[] = [];
      try {
        const r = await fetch(WW_URL);
        if (!r.ok) throw new Error('missing');
        ww = (await r.json()).features;
      } catch {
        setMissing(true);
        return;
      }
      // facilities and shops are optional: the map still works without them
      try {
        const r = await fetch(FAC_URL);
        if (r.ok) fp = (await r.json()).features;
      } catch {
        /* optional */
      }
      try {
        const r = await fetch(POI_URL);
        if (r.ok) pp = (await r.json()).features;
      } catch {
        /* optional */
      }
      if (cancelled) return;

      const polys = bh?.polys ?? [];
      const raw: RawLine[] = [];
      for (const f of ww) {
        const runs = polys.length ? clipLine(f.geometry.coordinates, polys) : [f.geometry.coordinates];
        for (const run of runs) if (run.length > 1) raw.push({ coords: run.map(([x, y]) => [x, y] as Pt), cls: f.properties.waterway });
      }
      if (!raw.length) {
        setMissing(true);
        return;
      }
      const c0 = bh?.bounds ? [(bh.bounds[0][0] + bh.bounds[1][0]) / 2, (bh.bounds[0][1] + bh.bounds[1][1]) / 2] : raw[0].coords[0];
      const fr = makeFrame(c0[0], c0[1]);
      setFrame(fr);
      setLines(raw);
      setFacs(
        fp.map((f, i) => {
          const [lon, lat] = f.geometry.coordinates;
          const [x, y] = project(fr, lon, lat);
          return { id: f.properties.osm_id ?? `fac/${i}`, x, y, lon, lat, kind: f.properties.kind, name: f.properties.name ?? '' };
        }),
      );
      setPois(
        pp.map((f, i) => {
          const [lon, lat] = f.geometry.coordinates;
          const [x, y] = project(fr, lon, lat);
          return { id: f.properties.osm_id ?? `poi/${i}`, x, y, lon, lat, group: f.properties.group, cat: f.properties.cat, name: f.properties.name ?? '' };
        }),
      );

      // facility badges (same artwork as Day 1)
      try {
        const imgs = await Promise.all(Object.keys(KINDS).map(async (k) => [k, await loadBadge(k)] as const));
        if (cancelled) return;
        for (const [k, img] of imgs) if (!map.hasImage(imgId(k))) map.addImage(imgId(k), img, { pixelRatio: 2 });
      } catch {
        /* the facility layer simply shows no icons */
      }

      // ----- layers -----
      const before = map.getLayer(BND) ? BND : undefined;
      const add = (l: unknown, b?: string) => map.addLayer(l as maplibregl.LayerSpecification, b);
      const lat0 = fr.lat0;
      const mpp = (z: number) => (156543.03392 * Math.cos((lat0 * Math.PI) / 180)) / 2 ** z;
      // line width in pixels that stays a fixed width in metres at every zoom
      const meters = (extra = 0) => {
        const at = (z: number) => ['match', ['get', 'cls'], ...CLS.slice(0, 3).flatMap((c) => [c, (CI[c].width + extra) / mpp(z)]), (CI.drain.width + extra) / mpp(z)];
        return ['interpolate', ['exponential', 2], ['zoom'], 10, at(10), 20, at(20)];
      };

      for (const s of Object.values(S)) map.addSource(s, { type: 'geojson', data: EMPTY });

      add({ id: L.dim, type: 'background', paint: { 'background-color': '#06182a', 'background-opacity': 0 } }, before);

      // 3D buildings from the basemap's vector tiles; if that source is not there the map just stays flat
      try {
        const style = map.getStyle();
        const entry = Object.entries(style.sources ?? {}).find(([, s]) => (s as { type?: string }).type === 'vector');
        if (entry)
          add(
            {
              id: L.bld,
              type: 'fill-extrusion',
              source: entry[0],
              'source-layer': 'building',
              minzoom: 14,
              paint: {
                'fill-extrusion-color': '#d8d2c4',
                'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 6],
                'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
                'fill-extrusion-opacity': 0.9,
              },
            },
            before,
          );
      } catch {
        /* flat map */
      }

      const conn = ['case', ['==', ['get', 'conn'], 1], 1, 0.35];
      add({ id: L.glow, type: 'line', source: S.net, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#22d3ee', 'line-width': meters(60), 'line-blur': 14, 'line-opacity': 0 } });
      add({ id: L.casing, type: 'line', source: S.net, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#0b2538', 'line-width': meters(12), 'line-opacity': conn } });
      add({
        id: L.water,
        type: 'line',
        source: S.net,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['match', ['get', 'cls'], ...CLS.slice(0, 3).flatMap((c) => [c, CI[c].color]), CI.drain.color], 'line-width': meters(), 'line-opacity': conn },
      });
      add({ id: L.core, type: 'line', source: S.net, layout: { 'line-cap': 'round' }, paint: { 'line-color': '#bdeefb', 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.2, 15, 0.8], 'line-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0.8, 16, 0.25] } });
      add({ id: L.routeCasing, type: 'line', source: S.route, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 9 } });
      add({ id: L.route, type: 'line', source: S.route, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#f59e0b', 'line-width': 5 } });

      // shops, food and services (dots) and facilities (badges), with names once you are close enough to read them
      add({
        id: L.poi,
        type: 'circle',
        source: S.poi,
        minzoom: 13.5,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 13.5, 2.2, 16, 4.5, 18, 6],
          'circle-color': ['match', ['get', 'group'], ...Object.entries(GROUPS).flatMap(([k, v]) => [k, v.color]), '#64748b'],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1,
        },
      });
      add({
        id: L.fac,
        type: 'symbol',
        source: S.fac,
        layout: {
          'icon-image': ['concat', 'd08-fac-', ['get', 'kind']],
          'icon-size': ['interpolate', ['linear'], ['zoom'], 11, 0.3, 14, 0.62, 17, 1.0],
          'icon-allow-overlap': true,
        },
      });
      const labelLayout = (minzoom: number) => ({
        minzoom,
        layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true },
        paint: { 'text-color': '#e2e8f0', 'text-halo-color': 'rgba(6,24,42,0.9)', 'text-halo-width': 1.4 },
      });
      add({ id: L.poiLabel, type: 'symbol', source: S.poi, ...labelLayout(16.2) });
      add({ id: L.facLabel, type: 'symbol', source: S.fac, ...labelLayout(14.6) });
      add({ id: L.near, type: 'circle', source: S.near, paint: { 'circle-radius': 15, 'circle-color': 'rgba(251,191,36,0.15)', 'circle-stroke-color': '#fbbf24', 'circle-stroke-width': 3 } });

      add({ id: L.wake, type: 'line', source: S.wake, layout: { 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1, 18, 5], 'line-opacity': 0.55, 'line-blur': 1 } });
      add({
        id: L.stops,
        type: 'circle',
        source: S.stops,
        paint: {
          'circle-radius': ['case', ['==', ['get', 'sel'], 1], 10, 6.5],
          'circle-color': '#ffffff',
          'circle-stroke-color': ['case', ['==', ['get', 'sel'], 1], '#f59e0b', '#0f766e'],
          'circle-stroke-width': 3,
        },
      });
      add({ id: L.pulse, type: 'circle', source: S.pts, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 7, 16, 16], 'circle-color': '#fbbf24', 'circle-opacity': 0.22, 'circle-blur': 1 } });
      add({
        id: L.dot,
        type: 'circle',
        source: S.pts,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2.6, 15, 4.2, 18, 5],
          'circle-color': '#fbbf24',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1,
          'circle-opacity': ['interpolate', ['linear'], ['zoom'], 16.4, 1, 18, 0],
          'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 16.4, 1, 18, 0],
        },
      });
      add({ id: L.track, type: 'circle', source: S.pts, filter: ['==', ['get', 'tr'], 1], paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 9, 16, 20], 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 } });
      add({ id: L.hull, type: 'fill-extrusion', source: S.hull, paint: { 'fill-extrusion-color': ['get', 'c'], 'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-base': ['get', 'b'], 'fill-extrusion-opacity': 0.96 } });

      // ----- interaction -----
      const onStopsMove = (e: maplibregl.MapLayerMouseEvent) => {
        map.getCanvas().style.cursor = 'pointer';
        const p = e.features?.[0]?.properties;
        if (p) popup.setLngLat(e.lngLat).setHTML(`<strong>Landing ${Number(p.i) + 1}</strong>${p.name ? `<br/>${esc(String(p.name))}` : ''}<br/>${p.fac} facilities within a 5-minute walk`).addTo(map);
      };
      const onStopsLeave = () => {
        map.getCanvas().style.cursor = '';
        popup.remove();
      };
      const onClick = (e: maplibregl.MapMouseEvent) => {
        const stop = map.queryRenderedFeatures(e.point, { layers: [L.stops] })[0];
        if (stop && typeof stop.properties?.i === 'number') {
          const i = stop.properties.i as number;
          setSel((s) => (s.length === 1 && s[0] !== i ? [s[0], i] : [i]));
          return;
        }
        const boat = map.queryRenderedFeatures(e.point, { layers: [L.pulse] })[0];
        if (boat && typeof boat.properties?.i === 'number') {
          setTracked(boat.properties.i as number);
          return;
        }
        // a click on or near the water adds a landing
        const f = frameRef.current;
        const n = netRef.current;
        if (!f || !n) return;
        const [x, y] = project(f, e.lngLat.lng, e.lngLat.lat);
        const near = nearestNode(n, x, y, 150);
        if (near >= 0) setExtra((ex) => [...ex, [n.x[near], n.y[near]] as Pt]);
      };
      const bail = (e: { originalEvent?: unknown }) => {
        if (e.originalEvent && camRef.current === 'follow') setCam('free');
      };
      map.on('mousemove', L.stops, onStopsMove);
      map.on('mouseleave', L.stops, onStopsLeave);
      map.on('click', onClick);
      const userMoves = ['dragstart', 'rotatestart', 'pitchstart', 'zoomstart'] as const;
      userMoves.forEach((ev) => map.on(ev as 'dragstart', bail));
      cleanups.push(() => {
        map.off('mousemove', L.stops, onStopsMove);
        map.off('mouseleave', L.stops, onStopsLeave);
        map.off('click', onClick);
        userMoves.forEach((ev) => map.off(ev as 'dragstart', bail));
      });

      map.easeTo({ pitch: 55, bearing: -20, duration: 1400 });
      setReady(true);
    })();

    return () => {
      cancelled = true;
      ac.abort();
      setReady(false);
      cleanups.forEach((f) => f());
      popup.remove();
      Object.values(L).forEach((l) => map.getLayer(l) && map.removeLayer(l));
      Object.values(S).forEach((s) => map.getSource(s) && map.removeSource(s));
      Object.keys(KINDS).forEach((k) => map.hasImage(imgId(k)) && map.removeImage(imgId(k)));
      bh?.remove();
      try {
        map.easeTo({ pitch: 0, bearing: 0, duration: 400 });
      } catch {
        /* map already removed */
      }
    };
  }, [map]);

  // ---------- data for the channel, landing and marker layers ----------
  useEffect(() => {
    if (!ready || !net || !lines || !frame) return;
    const src = map.getSource(S.net) as maplibregl.GeoJSONSource | undefined;
    src?.setData(
      fc(
        lines
          .filter((l) => enabled.has(l.cls))
          .map((l) => {
            const [x, y] = project(frame, l.coords[0][0], l.coords[0][1]);
            const n = nodeAt(net, x, y);
            return { type: 'Feature', geometry: { type: 'LineString', coordinates: l.coords }, properties: { cls: l.cls, conn: n >= 0 && net.comp[n] === net.main ? 1 : 0 } };
          }),
      ),
    );
  }, [ready, net, lines, frame, enabled, map]);

  useEffect(() => {
    if (!ready || !net || !frame) return;
    const src = map.getSource(S.stops) as maplibregl.GeoJSONSource | undefined;
    src?.setData(
      fc(
        landings.map((n, i) => {
          const fac = facs.reduce((c, f) => c + (Math.hypot(f.x - net.x[n], f.y - net.y[n]) <= WALK_M ? 1 : 0), 0);
          return { type: 'Feature', geometry: { type: 'Point', coordinates: unproject(frame, net.x[n], net.y[n]) }, properties: { i, fac, name: landingNames[i] ?? '', sel: sel.includes(i) ? 1 : 0 } };
        }),
      ),
    );
  }, [ready, net, frame, landings, landingNames, facs, sel, map]);

  useEffect(() => {
    if (!ready) return;
    const kindOf = new Map(facs.map((f) => [f.id, f.kind]));
    (map.getSource(S.fac) as maplibregl.GeoJSONSource | undefined)?.setData(
      fc(places.fac.map((p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: { name: p.name, kind: kindOf.get(p.id) ?? 'hospital' } }))),
    );
    const groupOf = new Map(pois.map((p) => [p.id, p.group]));
    (map.getSource(S.poi) as maplibregl.GeoJSONSource | undefined)?.setData(
      fc(places.poi.map((p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: { name: p.name, group: groupOf.get(p.id) ?? 'other' } }))),
    );
  }, [ready, places, facs, pois, map]);

  useEffect(() => {
    if (!ready) return;
    const vis = (layers: string[], on: boolean) => layers.forEach((l) => map.getLayer(l) && map.setLayoutProperty(l, 'visibility', on ? 'visible' : 'none'));
    vis([L.fac, L.facLabel], showFac);
    vis([L.poi, L.poiLabel], showPoi);
  }, [ready, showFac, showPoi, map]);

  // ---------- the route between two chosen landings ----------
  const routeInfo = useMemo(() => {
    if (!net || !frame || sel.length !== 2) return null;
    const r = shortest(net, landings[sel[0]], landings[sel[1]], SPEEDS);
    if (!r) return null;
    const path = makePath(net, r, SPEEDS);
    const idx = indexPath(path);
    const by: Record<string, number> = {};
    for (const f of facs) if (idx.within(f.x, f.y, WALK_M)) by[f.kind] = (by[f.kind] ?? 0) + 1;
    return { km: r.metres / 1000, min: r.seconds / 60, coords: Array.from(path.xs, (x, i) => unproject(frame, x, path.ys[i])), by };
  }, [net, frame, landings, sel, facs]);

  useEffect(() => {
    if (!ready) return;
    const src = map.getSource(S.route) as maplibregl.GeoJSONSource | undefined;
    src?.setData(routeInfo ? fc([{ type: 'Feature', geometry: { type: 'LineString', coordinates: routeInfo.coords }, properties: {} }]) : EMPTY);
  }, [ready, routeInfo, map]);

  // ---------- day and night ----------
  useEffect(() => {
    if (!ready) return;
    const set = (l: string, p: string, v: unknown) => map.getLayer(l) && map.setPaintProperty(l, p, v);
    set(L.dim, 'background-opacity', night ? 0.62 : 0);
    set(L.bld, 'fill-extrusion-color', night ? '#26364b' : '#d8d2c4');
    set(L.casing, 'line-color', night ? '#0b2538' : '#f1ede2');
    set(L.glow, 'line-opacity', night ? 0.38 : 0);
    set(L.pulse, 'circle-opacity', night ? 0.35 : 0.2);
    for (const l of [L.facLabel, L.poiLabel]) {
      set(l, 'text-color', night ? '#e2e8f0' : '#0f172a');
      set(l, 'text-halo-color', night ? 'rgba(6,24,42,0.9)' : 'rgba(255,255,255,0.92)');
    }
  }, [ready, night, map]);

  // ---------- camera ----------
  useEffect(() => {
    if (!ready) return;
    if (cam === 'overview' && boundsRef.current) map.fitBounds(boundsRef.current, { pitch: 55, bearing: -20, padding: 50, duration: 1600 });
  }, [cam, ready, map]);

  // ---------- the fleet, and what the tracked boat is passing ----------
  useEffect(() => {
    const clearData = () => {
      (map.getSource(S.pts) as maplibregl.GeoJSONSource | undefined)?.setData(EMPTY);
      (map.getSource(S.hull) as maplibregl.GeoJSONSource | undefined)?.setData(EMPTY);
      (map.getSource(S.wake) as maplibregl.GeoJSONSource | undefined)?.setData(EMPTY);
      (map.getSource(S.near) as maplibregl.GeoJSONSource | undefined)?.setData(EMPTY);
    };
    if (!ready || !net || !frame || landings.length < 2) {
      clearData();
      return;
    }
    const fleet: Boat[] = [];
    const cache = new Map<string, Path | null>();
    let sim = 0;
    let last = performance.now();
    let lastInfo = 0;
    let raf = 0;

    // popups for the places the tracked boat is passing
    const popups = new Map<string, maplibregl.Popup>();
    let shown = new Set<string>();
    let lastTracked = -1;
    let lastSig = '';
    let lastTrip = '';
    let recent: string[] = [];
    const dropPopups = () => {
      popups.forEach((p) => p.remove());
      popups.clear();
      shown = new Set();
    };

    const pathBetween = (a: number, b: number, counter: { n: number }) => {
      const k = `${a}-${b}`;
      if (!cache.has(k)) {
        counter.n++;
        const r = shortest(net, landings[a], landings[b], SPEEDS);
        cache.set(k, r ? makePath(net, r, SPEEDS) : null);
      }
      return cache.get(k) ?? null;
    };
    const begin = (bt: Boat, counter: { n: number }, first: boolean) => {
      const from = first ? Math.floor(Math.random() * landings.length) : bt.to;
      let to = Math.floor(Math.random() * landings.length);
      if (to === from) to = (to + 1) % landings.length;
      const p = pathBetween(from, to, counter);
      bt.from = from;
      bt.to = to;
      bt.path = p;
      bt.hold = 20 + Math.random() * 30;
      if (p) bt.start = sim - (first ? Math.random() * p.t[p.t.length - 1] : 0);
    };

    const updatePassing = (tr: { x: number; y: number; heading: number; from: number; to: number; pct: number }) => {
      if (lastTracked !== trackedRef.current) {
        dropPopups();
        recent = [];
        lastSig = '';
        lastTracked = trackedRef.current;
        setHistory([]);
      }
      // places within reach, nearest facilities first; places already shown stay until the boat is well past them
      const g = gridRef.current;
      const cx = Math.floor(tr.x / 200);
      const cy = Math.floor(tr.y / 200);
      const h = (tr.heading * Math.PI) / 180;
      const fx = Math.sin(h);
      const fy = Math.cos(h);
      const hits: Passing[] = [];
      const byId = new Map<string, Place>();
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (const p of g.get(`${cx + dx},${cy + dy}`) ?? []) {
            const d = Math.hypot(p.x - tr.x, p.y - tr.y);
            if (d > (shown.has(p.id) ? R_OUT : R_IN)) continue;
            byId.set(p.id, p);
            hits.push({ id: p.id, name: p.name, type: p.type, group: p.group, d, left: fx * (p.y - tr.y) - fy * (p.x - tr.x) > 0 });
          }
      hits.sort((a, b) => Number(byId.get(b.id)?.fac) - Number(byId.get(a.id)?.fac) || a.d - b.d);
      const top = hits.slice(0, 3);
      const keys = new Set(top.map((t) => t.id));

      popups.forEach((p, id) => {
        if (!keys.has(id)) {
          p.remove();
          popups.delete(id);
        }
      });
      for (const t of top) {
        const p = byId.get(t.id);
        if (!p) continue;
        if (!popups.has(t.id)) {
          popups.set(
            t.id,
            new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 16, maxWidth: '230px' })
              .setLngLat([p.lon, p.lat])
              .setHTML(`<strong>${esc(p.name)}</strong><br/>${esc(p.type)} · ${esc(p.group)}<br/>on your ${t.left ? 'left' : 'right'}`)
              .addTo(map),
          );
          if (recent[recent.length - 1] !== p.name) recent = [...recent.slice(-5), p.name];
        }
      }
      shown = keys;
      (map.getSource(S.near) as maplibregl.GeoJSONSource | undefined)?.setData(
        fc(top.map((t) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [byId.get(t.id)?.lon ?? 0, byId.get(t.id)?.lat ?? 0] }, properties: {} }))),
      );

      const sig = top.map((t) => `${t.id}:${Math.round(t.d / 10)}`).join('|');
      if (sig !== lastSig) {
        lastSig = sig;
        setPassing(top);
        setHistory(recent);
      }
      const tsig = `${tr.from}-${tr.to}-${Math.round(tr.pct * 20)}`;
      if (tsig !== lastTrip) {
        lastTrip = tsig;
        setTrip({ from: tr.from, to: tr.to, pct: tr.pct });
      }
    };

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      sim += dt * warpRef.current;

      while (fleet.length < boatsRef.current) fleet.push({ path: null, from: 0, to: 0, start: 0, hold: 0 });
      fleet.length = boatsRef.current;
      const tIdx = fleet.length ? Math.min(trackedRef.current, fleet.length - 1) : -1;

      const counter = { n: 0 }; // routes computed this frame, kept small so the page never stutters
      const pts: unknown[] = [];
      const hull: unknown[] = [];
      const wake: unknown[] = [];
      const follow: { ll: Pt | null; heading: number; tr: { x: number; y: number; heading: number; from: number; to: number; pct: number } | null } = { ll: null, heading: 0, tr: null };

      fleet.forEach((bt, bi) => {
        if (!bt.path && counter.n < 3) begin(bt, counter, true);
        if (!bt.path) return;
        const T = bt.path.t[bt.path.t.length - 1];
        const tau = sim - bt.start;
        if (tau > T + bt.hold && counter.n < 3) {
          begin(bt, counter, false);
          if (!bt.path) return;
        }
        const pos = positionAt(bt.path, sim - bt.start);
        const c = unproject(frame, pos.x, pos.y);
        pts.push({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { i: bi, tr: bi === tIdx ? 1 : 0 } });

        const h = (pos.heading * Math.PI) / 180;
        const fx = Math.sin(h);
        const fy = Math.cos(h);
        const rx = Math.cos(h);
        const ry = -Math.sin(h);
        const corner = (f: number, r: number): Pt => unproject(frame, pos.x + fx * f + rx * r, pos.y + fy * f + ry * r);
        const hl = BOAT_LEN / 2;
        const hw = BOAT_W / 2;
        const ring = [corner(hl, 0), corner(hl * 0.25, hw), corner(-hl, hw), corner(-hl, -hw), corner(hl * 0.25, -hw)];
        hull.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] }, properties: { c: bi === tIdx ? '#f97316' : '#fbbf24', h: 5, b: 0 } });
        const cab = [corner(hl * 0.1, hw * 0.65), corner(-hl * 0.45, hw * 0.65), corner(-hl * 0.45, -hw * 0.65), corner(hl * 0.1, -hw * 0.65)];
        hull.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...cab, cab[0]]] }, properties: { c: '#ffffff', h: 9, b: 5 } });

        const trail = [0, 30, 70, 130, 220].map((back) => {
          const q = pointAtDist(bt.path as Path, pos.dist - back);
          return unproject(frame, q[0], q[1]);
        });
        wake.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: trail }, properties: {} });

        if (bi === tIdx) {
          follow.ll = c;
          follow.heading = pos.heading;
          follow.tr = { x: pos.x, y: pos.y, heading: pos.heading, from: bt.from, to: bt.to, pct: T > 0 ? Math.min(1, Math.max(0, (sim - bt.start) / T)) : 1 };
        }
      });

      (map.getSource(S.pts) as maplibregl.GeoJSONSource | undefined)?.setData(fc(pts));
      (map.getSource(S.hull) as maplibregl.GeoJSONSource | undefined)?.setData(fc(hull));
      (map.getSource(S.wake) as maplibregl.GeoJSONSource | undefined)?.setData(fc(wake));

      // what is the tracked boat passing? a few times a second is plenty
      if (now - lastInfo > 250) {
        lastInfo = now;
        if (follow.tr) updatePassing(follow.tr);
        else if (popups.size) {
          dropPopups();
          (map.getSource(S.near) as maplibregl.GeoJSONSource | undefined)?.setData(EMPTY);
          lastSig = '';
          setPassing([]);
        }
      }

      const target = follow.ll;
      if (camRef.current === 'follow' && target) {
        const cc = map.getCenter();
        const br = map.getBearing();
        const dBr = ((follow.heading - br + 540) % 360) - 180;
        map.jumpTo({
          center: [cc.lng + (target[0] - cc.lng) * 0.15, cc.lat + (target[1] - cc.lat) * 0.15],
          bearing: br + dBr * 0.06,
          zoom: map.getZoom() + (16.5 - map.getZoom()) * 0.05,
          pitch: map.getPitch() + (66 - map.getPitch()) * 0.05,
        });
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      dropPopups();
      (map.getSource(S.near) as maplibregl.GeoJSONSource | undefined)?.setData(EMPTY);
    };
  }, [ready, net, frame, landings, map]);

  // ---------- numbers for the panel ----------
  const classKm = useMemo(() => {
    const km: Record<string, number> = {};
    lines?.forEach((l) => (km[l.cls] = (km[l.cls] ?? 0) + lineLengthM(l.coords) / 1000));
    return km;
  }, [lines]);

  const stats = useMemo(() => {
    if (!net) return null;
    const total = net.compLen.reduce((a, b) => a + b, 0);
    const main = net.main >= 0 ? net.compLen[net.main] : 0;
    const chan = indexEdges(net, true);
    let nearLanding = 0;
    let nearChannel = 0;
    let health = 0;
    let healthNear = 0;
    for (const f of facs) {
      const isHealth = f.kind === 'hospital' || f.kind === 'clinic';
      if (isHealth) health++;
      if (landings.some((n) => Math.hypot(f.x - net.x[n], f.y - net.y[n]) <= WALK_M)) {
        nearLanding++;
        if (isHealth) healthNear++;
      }
      if (chan.within(f.x, f.y, WALK_M)) nearChannel++;
    }
    const nf = facs.length || 1;
    return { km: main / 1000, connected: total ? (main / total) * 100 : 0, nearLanding: (nearLanding / nf) * 100, nearChannel: (nearChannel / nf) * 100, health, healthNear: health ? (healthNear / health) * 100 : 0 };
  }, [net, facs, landings]);

  const groupCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const p of pois) c[p.group] = (c[p.group] ?? 0) + 1;
    return c;
  }, [pois]);

  const toggle = (c: string) =>
    setEnabled((s) => {
      const n = new Set(s);
      if (n.has(c)) n.delete(c);
      else n.add(c);
      return n.size ? n : s; // keep at least one class
    });

  const tIdx = Math.min(tracked, Math.max(0, boatsN - 1));

  return (
    <div className="legend wide">
      <h4>Waterway city</h4>
      <p className="muted" style={{ margin: '0 0 6px' }}>
        Utopia: every river, canal and creek developed into a transport channel, with boats between landings.
      </p>

      {CLS.map((c) => (
        <label key={c} className="legend-row">
          <input type="checkbox" checked={enabled.has(c)} onChange={() => toggle(c)} />
          <span style={{ width: 22, height: Math.max(3, CI[c].width / 8), background: CI[c].color, borderRadius: 2, display: 'inline-block' }} />
          <span style={{ flex: 1 }}>{CI[c].label}</span>
          <span className="muted">
            {fmt(classKm[c] ?? 0, 0)} km · {CI[c].kmh} km/h
          </span>
        </label>
      ))}

      <p className="sub">Places along the water</p>
      <label className="legend-row">
        <input type="checkbox" checked={showFac} onChange={() => setShowFac((v) => !v)} />
        <span style={{ flex: 1 }}>Hospitals, clinics, schools, fire and police</span>
        <span className="muted">{places.fac.length}</span>
      </label>
      <label className="legend-row">
        <input type="checkbox" checked={showPoi} onChange={() => setShowPoi((v) => !v)} />
        <span style={{ flex: 1 }}>Shops, food and services</span>
        <span className="muted">{places.poi.length}</span>
      </label>
      {showPoi && places.poi.length > 0 && (
        <div className="muted" style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 10px', margin: '2px 0 4px' }}>
          {Object.entries(GROUPS)
            .filter(([k]) => groupCounts[k] && !DUP_CATS.has(k))
            .map(([k, v]) => (
              <span key={k} style={{ whiteSpace: 'nowrap' }}>
                <i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: v.color, marginRight: 4 }} />
                {v.label}
              </span>
            ))}
        </div>
      )}

      <p className="sub">Boats: {boatsN}</p>
      <input className="range" type="range" min={0} max={60} step={2} value={boatsN} onChange={(e) => setBoatsN(Number(e.target.value))} />

      <p className="sub">Simulation speed</p>
      <div className="seg">
        {[10, 20, 60].map((w) => (
          <button key={w} className={warp === w ? 'on' : ''} onClick={() => setWarp(w)}>
            ×{w}
          </button>
        ))}
      </div>

      <p className="sub">Look</p>
      <div className="seg">
        <button className={!night ? 'on' : ''} onClick={() => setNight(false)}>
          Day
        </button>
        <button className={night ? 'on' : ''} onClick={() => setNight(true)}>
          Night
        </button>
      </div>

      <p className="sub">Camera</p>
      <div className="seg">
        <button className={cam === 'overview' ? 'on' : ''} onClick={() => setCam('overview')}>
          Overview
        </button>
        <button className={cam === 'follow' ? 'on' : ''} onClick={() => setCam('follow')}>
          Ride boat {tIdx + 1}
        </button>
        <button onClick={() => setTracked((t) => (t + 1) % Math.max(1, boatsN))}>Next boat</button>
      </div>

      {boatsN > 0 && trip && (
        <div className="card2">
          <strong>Boat {tIdx + 1}</strong>
          <div className="kv">
            <span>From</span>
            <span>{lname(trip.from)}</span>
            <span>To</span>
            <span>{lname(trip.to)}</span>
            <span>Progress</span>
            <span>{fmt(trip.pct * 100)}%</span>
          </div>
          <p className="sub" style={{ marginTop: 6 }}>
            Passing now
          </p>
          {passing.length ? (
            <ul className="list">
              {passing.map((p) => (
                <li key={p.id}>
                  <div className="row">
                    <span>{p.name}</span>
                    <span className="muted">
                      {p.type} · {fmt(p.d, 0)} m {p.left ? 'left' : 'right'}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              Open water. Nothing named within {R_IN} m.
            </p>
          )}
          {history.length > 0 && (
            <>
              <p className="sub" style={{ marginTop: 6 }}>
                Recently passed
              </p>
              <p className="muted" style={{ margin: 0 }}>
                {[...history].reverse().join(' · ')}
              </p>
            </>
          )}
          <p className="muted" style={{ margin: '6px 0 0' }}>
            Click any boat on the map to track it.
          </p>
        </div>
      )}

      {stats && (
        <div className="kv">
          <span>Connected channels</span>
          <span>
            {fmt(stats.km, 0)} km ({fmt(stats.connected)}% of all)
          </span>
          <span>Landings</span>
          <span>{landings.length}</span>
          <span>Facilities within 5 min walk of a landing</span>
          <span>{fmt(stats.nearLanding)}%</span>
          <span>…of any channel</span>
          <span>{fmt(stats.nearChannel)}%</span>
          {stats.health > 0 && (
            <>
              <span>Hospitals and clinics near a landing</span>
              <span>{fmt(stats.healthNear)}%</span>
            </>
          )}
        </div>
      )}

      <p className="muted" style={{ marginTop: 8 }}>
        Click a landing, then another, for a route. Click the water to add a landing.
        {extra.length > 0 && (
          <>
            {' '}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                setExtra([]);
              }}
            >
              Remove added landings
            </a>
          </>
        )}
      </p>

      {routeInfo && (
        <div className="card2">
          <strong>
            {lname(sel[0])} to {lname(sel[1])}
          </strong>
          <div className="kv">
            <span>Distance</span>
            <span>{fmt(routeInfo.km, 1)} km</span>
            <span>Travel time</span>
            <span>{fmt(routeInfo.min, 0)} min</span>
            <span>Within a 5 min walk of the route</span>
            <span>
              {Object.keys(routeInfo.by).length
                ? Object.entries(routeInfo.by)
                    .map(([k, n]) => `${n} ${KINDS[k]?.label.toLowerCase() ?? k}`)
                    .join(', ')
                : 'none'}
            </span>
          </div>
        </div>
      )}

      <p className="muted" style={{ marginTop: 8 }}>
        A scenario, not a plan. Channel widths and boat speeds are assumed. Many of these waterways are narrow, culverted or drains today, and bridge clearances are not in the data. Faint channels are not connected to the main network. Only places mapped in OpenStreetMap with a name can pop up.
      </p>
      {missing && (
        <p className="warn">
          Data missing. Run <code>python pipeline/02_osm_waterways.py</code> (after <code>01_osm_facilities.py</code>).
        </p>
      )}
    </div>
  );
}
