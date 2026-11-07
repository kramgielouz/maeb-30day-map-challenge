import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { BUTUAN_CENTER } from '../../core/BaseMap';
import { TILE_URL } from '../day05-sight/viewshed';

const HERITAGE_URL = '/data/day06-heritage.geojson';
const RAD = Math.PI / 180;

// Ink and paper
const PAPER = '#f1e4bf';
const SEA = '#d9c690';
const INK = '#4a2f17';
const WATER_INK = '#4f6b75';

const KINDS: Record<string, { label: string; color: string }> = {
  archaeological: { label: 'Archaeological / balanghai', color: '#9b2226' },
  museum: { label: 'Museum', color: '#2d5a3d' },
  monument: { label: 'Monument / memorial', color: '#5a3d7a' },
  other: { label: 'Other heritage', color: '#7a5a2e' },
};

// Illustrative partners: places named in records and finds, joined to Butuan by a straight rhumb line (a constant compass bearing).
const PARTNERS = [
  { name: 'Guangzhou', lng: 113.26, lat: 23.13, note: 'Butuan sent a trade mission to the Song court in 1001 AD, recorded in Chinese annals.' },
  { name: 'Champa', lng: 108.33, lat: 15.88, note: 'Coastal kingdom of central Vietnam, part of the same South China Sea trading world.' },
  { name: 'Srivijaya', lng: 104.76, lat: -2.98, note: 'Sumatran sea-power. Hindu-Buddhist objects found in Agusan, such as the golden tara, point toward this world.' },
  { name: 'Brunei', lng: 114.94, lat: 4.89, note: 'A trading neighbour across the Sulu and Mindanao seas.' },
  { name: 'Sulu', lng: 121.0, lat: 6.05, note: 'The nearest great trading hub to the south-west.' },
];

const WINDS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

const merc = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2));

// Constant compass bearing (degrees from north) between two points: a straight line on a Mercator chart.
function rhumbBearing(a: [number, number], b: [number, number]) {
  const d = Math.atan2((b[0] - a[0]) * RAD, merc(b[1]) - merc(a[1])) / RAD;
  return (d + 360) % 360;
}

function greatCircleKm(a: [number, number], b: [number, number]) {
  const dLat = (b[1] - a[1]) * RAD;
  const dLng = (b[0] - a[0]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

// A point `len` radians away along a rhumb line (Mercator geometry), so the line really is straight on screen.
function rhumbEnd(from: [number, number], bearingDeg: number, len: number): [number, number] {
  const dx = Math.sin(bearingDeg * RAD) * len;
  const dy = Math.cos(bearingDeg * RAD) * len;
  const y = merc(from[1]) + dy;
  return [from[0] + dx / RAD, (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / RAD];
}

const fan = (() => {
  const features = [];
  for (let i = 0; i < 16; i++) {
    const principal = i % 4 === 0;
    const eighth = i % 2 === 0;
    features.push({
      type: 'Feature',
      properties: { w: principal ? 1.4 : eighth ? 1 : 0.6 },
      geometry: { type: 'LineString', coordinates: [BUTUAN_CENTER, rhumbEnd(BUTUAN_CENTER, i * 22.5, 0.5)] },
    });
  }
  return { type: 'FeatureCollection', features } as any;
})();

const partnerData = (() => {
  const routes = PARTNERS.map((p) => ({
    type: 'Feature',
    properties: { name: p.name },
    geometry: { type: 'LineString', coordinates: [BUTUAN_CENTER, [p.lng, p.lat]] },
  }));
  const points = PARTNERS.map((p) => ({
    type: 'Feature',
    properties: { label: `${p.name.toUpperCase()}\n${Math.round(greatCircleKm(BUTUAN_CENTER, [p.lng, p.lat]) / 10) * 10} km` },
    geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
  }));
  return {
    routes: { type: 'FeatureCollection', features: routes } as any,
    points: { type: 'FeatureCollection', features: points } as any,
  };
})();

// Soft stipple for the sea, in the manner of an engraved chart.
function stippleImage() {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(110,80,40,0.55)';
  [[3, 4], [11, 2], [7, 10], [14, 13], [1, 13], [9, 6]].forEach(([x, y]) => g.fillRect(x, y, 1, 1));
  return g.getImageData(0, 0, 16, 16);
}

// A side-on sailing boat in ink, as drawn on old charts. Two images so it can face the way it is sailing.
function shipImage(facingRight: boolean) {
  const c = document.createElement('canvas');
  c.width = c.height = 72;
  const g = c.getContext('2d')!;
  if (!facingRight) {
    g.translate(72, 0);
    g.scale(-1, 1);
  }
  g.lineJoin = 'round';
  g.strokeStyle = INK;
  g.lineWidth = 2;
  // sail
  g.fillStyle = '#f6ecd0';
  g.beginPath();
  g.moveTo(26, 12);
  g.lineTo(52, 15);
  g.lineTo(49, 41);
  g.lineTo(25, 41);
  g.closePath();
  g.fill();
  g.stroke();
  g.beginPath();
  g.moveTo(38, 6);
  g.lineTo(38, 46);
  g.stroke();
  // pennant
  g.fillStyle = '#9b2226';
  g.beginPath();
  g.moveTo(38, 6);
  g.lineTo(50, 9);
  g.lineTo(38, 12);
  g.closePath();
  g.fill();
  // hull
  g.fillStyle = INK;
  g.beginPath();
  g.moveTo(8, 44);
  g.quadraticCurveTo(36, 62, 66, 40);
  g.lineTo(62, 46);
  g.quadraticCurveTo(36, 56, 14, 48);
  g.closePath();
  g.fill();
  return g.getImageData(0, 0, 72, 72);
}

// Ships shuttle out to a partner and back, two per route, one Mercator-straight rhumb line each.
const ROUTES = PARTNERS.map((p) => {
  const y0 = merc(BUTUAN_CENTER[1]);
  const y1 = merc(p.lat);
  return { lng0: BUTUAN_CENTER[0], lng1: p.lng, y0, y1, km: greatCircleKm(BUTUAN_CENTER, [p.lng, p.lat]) };
});
const SHIP_KM_PER_S = 50; // chart speed: one second of clock is 50 km of sailing (a time-lapse, not real speed)
const DWELL_S = 4;
const SHIPS_PER_ROUTE = 2;
const EMPTY = { type: 'FeatureCollection', features: [] } as any;

function shipsAt(clock: number) {
  const features: any[] = [];
  ROUTES.forEach((r, i) => {
    const leg = r.km / SHIP_KM_PER_S;
    const cycle = 2 * (leg + DWELL_S);
    for (let k = 0; k < SHIPS_PER_ROUTE; k++) {
      const u = (((clock + (k / SHIPS_PER_ROUTE) * cycle + i * 7) % cycle) + cycle) % cycle;
      let f: number;
      let dir: number;
      if (u < leg) [f, dir] = [u / leg, 1];
      else if (u < leg + DWELL_S) [f, dir] = [1, 1];
      else if (u < 2 * leg + DWELL_S) [f, dir] = [1 - (u - leg - DWELL_S) / leg, -1];
      else [f, dir] = [0, -1];
      const lng = r.lng0 + f * (r.lng1 - r.lng0);
      const lat = (2 * Math.atan(Math.exp(r.y0 + f * (r.y1 - r.y0))) - Math.PI / 2) / RAD;
      const east = (r.lng1 - r.lng0) * dir >= 0;
      features.push({ type: 'Feature', properties: { east }, geometry: { type: 'Point', coordinates: [lng, lat] } });
    }
  });
  return { type: 'FeatureCollection', features } as any;
}

function Rose({ bearing }: { bearing: number }) {
  const tips = Array.from({ length: 16 }, (_, i) => {
    const R = i % 4 === 0 ? 58 : i % 2 === 0 ? 44 : 30;
    const a = (i * 22.5 - 90) * RAD;
    const l = a - 11.25 * RAD;
    const r = a + 11.25 * RAD;
    const pt = (ang: number, rad: number) => `${(70 + Math.cos(ang) * rad).toFixed(1)},${(70 + Math.sin(ang) * rad).toFixed(1)}`;
    return { d: `M${pt(a, R)} L${pt(l, 9)} L${pt(r, 9)} Z`, major: i % 2 === 0 };
  });
  return (
    <svg className="d06-rose" viewBox="0 0 140 140" width="120" height="120" style={{ transform: `rotate(${-bearing}deg)` }}>
      <circle cx="70" cy="70" r="64" fill="rgba(241,228,191,.85)" stroke={INK} strokeWidth="1.5" />
      <circle cx="70" cy="70" r="60" fill="none" stroke={INK} strokeWidth="0.6" />
      {tips.map((t, i) => (
        <path key={i} d={t.d} fill={t.major ? INK : 'none'} stroke={INK} strokeWidth="0.8" strokeLinejoin="round" />
      ))}
      <text x="70" y="13" textAnchor="middle" fontSize="12" fontWeight="700" fill={INK} fontFamily="Georgia, serif">
        N
      </text>
    </svg>
  );
}

const CSS = `
.legend.d06-panel { background: #f3e6c4; color: ${INK}; border-color: #b89b62; font-family: 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif; }
.d06-panel h4 { color: #7a5a2e; }
.d06-panel .muted, .d06-panel .sub { color: #7a5a2e; }
.d06-panel .seg button { border-color: #b89b62; color: ${INK}; }
.d06-panel .seg button.on { background: ${INK}; border-color: ${INK}; color: #f3e6c4; }
.d06-panel .list li { cursor: pointer; }
.d06-panel .bar { background: #8a6a3c; }
.d06-panel .warn { background: #e9d49a; color: #4a2f17; }
.d06-panel a { color: #7a2e1c; }
.d06-texture { position: absolute; inset: 0; z-index: 1; pointer-events: none; mix-blend-mode: multiply;
  background:
    radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, rgba(92,58,22,.38) 100%),
    url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 .45  0 0 0 0 .32  0 0 0 0 .15  0 0 0 .45 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>"); }
.d06-cartouche { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2; pointer-events: none; text-align: center;
  border: 5px double #6b4a22; background: rgba(243,230,196,.93); padding: 6px 26px 8px; color: ${INK}; font-family: 'Palatino Linotype', Palatino, Georgia, serif; }
.d06-cartouche b { display: block; font-size: 17px; letter-spacing: .14em; }
.d06-cartouche i { font-size: 12px; }
.d06-rose { position: absolute; right: 12px; bottom: 44px; z-index: 2; pointer-events: none; }
@media (max-width: 1000px) { .d06-cartouche { display: none; } }
`;

export default function Day06({ map }: { map: maplibregl.Map }) {
  const reduced = useMemo(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false, []);
  const [show, setShow] = useState({ relief: true, fan: true, trade: true, heritage: true, names: true, ships: !reduced });
  const [speed, setSpeed] = useState(1);
  const [view3d, setView3d] = useState(false);
  const [exag, setExag] = useState(2.5);
  const speedRef = useRef(1);
  speedRef.current = speed;
  const was3d = useRef(false);
  const [bearing, setBearing] = useState(0);
  const [heritage, setHeritage] = useState<any[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    const style = map.getStyle();
    const vsrc = Object.entries(style.sources).find(([, src]) => src.type === 'vector')?.[0];
    if (!vsrc) {
      setError(true);
      return;
    }
    let cancelled = false;
    const popup = new maplibregl.Popup({ closeButton: false, offset: 10 });
    const added: string[] = [];
    const srcs: string[] = [];

    // Hide the modern basemap; this chapter draws its own.
    const saved = style.layers.map((l) => ({ id: l.id, vis: map.getLayoutProperty(l.id, 'visibility') ?? 'visible' }));
    saved.forEach((l) => map.setLayoutProperty(l.id, 'visibility', 'none'));

    const layer = (l: any) => {
      map.addLayer(l);
      added.push(l.id);
    };
    const source = (id: string, spec: any) => {
      map.addSource(id, spec);
      srcs.push(id);
    };
    const water = { source: vsrc, 'source-layer': 'water' } as const;
    const wwy = { source: vsrc, 'source-layer': 'waterway' } as const;

    map.addImage('d06-stipple', stippleImage());
    map.addImage('d06-ship-r', shipImage(true), { pixelRatio: 2 });
    map.addImage('d06-ship-l', shipImage(false), { pixelRatio: 2 });
    source('d06-dem', { type: 'raster-dem', tiles: [TILE_URL], tileSize: 256, encoding: 'terrarium', maxzoom: 15 });
    source('d06-fan', { type: 'geojson', data: fan });
    source('d06-routes', { type: 'geojson', data: partnerData.routes });
    source('d06-partners', { type: 'geojson', data: partnerData.points });
    source('d06-ships', { type: 'geojson', data: EMPTY });
    source('d06-origin', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: BUTUAN_CENTER } } });

    layer({ id: 'd06-paper', type: 'background', paint: { 'background-color': PAPER } });
    layer({ id: 'd06-wood', type: 'fill', source: vsrc, 'source-layer': 'landcover', filter: ['==', ['get', 'class'], 'wood'], paint: { 'fill-color': '#c9b57e', 'fill-opacity': 0.35 } });
    layer({ id: 'd06-relief', type: 'hillshade', source: 'd06-dem', paint: { 'hillshade-shadow-color': '#6a4a28', 'hillshade-highlight-color': '#f7ecc9', 'hillshade-accent-color': '#8a6a3c', 'hillshade-exaggeration': 0.55 } });
    layer({ id: 'd06-sea', type: 'fill', ...water, paint: { 'fill-color': SEA } });
    layer({ id: 'd06-sea-stipple', type: 'fill', ...water, paint: { 'fill-pattern': 'd06-stipple', 'fill-opacity': 0.7 } });
    layer({ id: 'd06-shore-wash', type: 'line', ...water, layout: { 'line-join': 'round' }, paint: { 'line-color': '#7a5a2e', 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 4, 12, 16], 'line-blur': ['interpolate', ['linear'], ['zoom'], 4, 3, 12, 10], 'line-opacity': 0.16 } });
    layer({ id: 'd06-shore', type: 'line', ...water, layout: { 'line-join': 'round' }, paint: { 'line-color': INK, 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.6, 12, 1.4], 'line-opacity': 0.85 } });
    layer({ id: 'd06-stream', type: 'line', ...wwy, minzoom: 10, filter: ['in', ['get', 'class'], ['literal', ['stream', 'canal']]], paint: { 'line-color': WATER_INK, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 15, 2], 'line-opacity': 0.8 } });
    layer({ id: 'd06-river', type: 'line', ...wwy, filter: ['==', ['get', 'class'], 'river'], layout: { 'line-cap': 'round' }, paint: { 'line-color': WATER_INK, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.8, 12, 3, 15, 7] } });
    layer({ id: 'd06-fan-lines', type: 'line', source: 'd06-fan', paint: { 'line-color': INK, 'line-width': ['get', 'w'], 'line-opacity': 0.4 } });
    layer({ id: 'd06-routes-lines', type: 'line', source: 'd06-routes', paint: { 'line-color': '#9b2226', 'line-width': 1.6, 'line-dasharray': [3, 2], 'line-opacity': 0.85 } });
    layer({ id: 'd06-origin-ring', type: 'circle', source: 'd06-origin', paint: { 'circle-radius': 16, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': INK, 'circle-stroke-width': 1.2 } });
    layer({ id: 'd06-origin-dot', type: 'circle', source: 'd06-origin', paint: { 'circle-radius': 4.5, 'circle-color': '#9b2226', 'circle-stroke-color': PAPER, 'circle-stroke-width': 1.5 } });
    layer({
      id: 'd06-ship-wake',
      type: 'circle',
      source: 'd06-ships',
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 6, 12, 12], 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': INK, 'circle-stroke-width': 1, 'circle-stroke-opacity': 0.35, 'circle-translate': [0, 9] },
    });
    layer({
      id: 'd06-ships-sym',
      type: 'symbol',
      source: 'd06-ships',
      layout: {
        'icon-image': ['case', ['get', 'east'], 'd06-ship-r', 'd06-ship-l'],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 3, 0.55, 12, 1.1],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    });
    layer({
      id: 'd06-partners-pt',
      type: 'circle',
      source: 'd06-partners',
      paint: { 'circle-radius': 4, 'circle-color': '#9b2226', 'circle-stroke-color': PAPER, 'circle-stroke-width': 1.5 },
    });
    layer({
      id: 'd06-partners-label',
      type: 'symbol',
      source: 'd06-partners',
      layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Italic'], 'text-size': 12, 'text-letter-spacing': 0.12, 'text-anchor': 'left', 'text-offset': [0.8, 0], 'text-allow-overlap': true },
      paint: { 'text-color': '#7a1a1e', 'text-halo-color': PAPER, 'text-halo-width': 1.6 },
    });
    layer({
      id: 'd06-river-label',
      type: 'symbol',
      ...wwy,
      minzoom: 9,
      filter: ['all', ['has', 'name'], ['==', ['get', 'class'], 'river']],
      layout: { 'symbol-placement': 'line', 'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']], 'text-font': ['Noto Sans Italic'], 'text-size': 12, 'text-letter-spacing': 0.25 },
      paint: { 'text-color': '#2f4a54', 'text-halo-color': PAPER, 'text-halo-width': 1.5 },
    });
    layer({
      id: 'd06-names',
      type: 'symbol',
      source: vsrc,
      'source-layer': 'place',
      minzoom: 9,
      filter: ['in', ['get', 'class'], ['literal', ['city', 'town', 'village', 'suburb']]],
      layout: {
        'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
        'text-font': ['Noto Sans Italic'],
        'text-size': ['match', ['get', 'class'], 'city', 15, 'town', 13, 11.5],
        'text-letter-spacing': 0.08,
      },
      paint: { 'text-color': INK, 'text-halo-color': PAPER, 'text-halo-width': 1.6 },
    });

    // heritage sites from OpenStreetMap
    (async () => {
      try {
        const r = await fetch(HERITAGE_URL);
        if (!r.ok) throw new Error('missing');
        const gj = await r.json();
        if (cancelled) return;
        setHeritage(gj.features);
        source('d06-heritage', { type: 'geojson', data: gj });
        const color = ['match', ['get', 'kind'], ...Object.entries(KINDS).flatMap(([k, v]) => [k, v.color]), '#7a5a2e'] as any;
        layer({ id: 'd06-heritage-pt', type: 'circle', source: 'd06-heritage', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3, 15, 7], 'circle-color': color, 'circle-stroke-color': PAPER, 'circle-stroke-width': 1.5 } });
        layer({
          id: 'd06-heritage-label',
          type: 'symbol',
          source: 'd06-heritage',
          minzoom: 12.5,
          layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Italic'], 'text-size': 11.5, 'text-anchor': 'top', 'text-offset': [0, 0.9], 'text-optional': true },
          paint: { 'text-color': INK, 'text-halo-color': PAPER, 'text-halo-width': 1.6 },
        });
        map.on('mouseenter', 'd06-heritage-pt', () => (map.getCanvas().style.cursor = 'pointer'));
        map.on('mouseleave', 'd06-heritage-pt', () => (map.getCanvas().style.cursor = ''));
        map.on('click', 'd06-heritage-pt', onSite);
        // keep sites above the labels' siblings but below nothing else; honour the current toggles
        map.setLayoutProperty('d06-heritage-pt', 'visibility', showRef.current.heritage ? 'visible' : 'none');
        map.setLayoutProperty('d06-heritage-label', 'visibility', showRef.current.heritage ? 'visible' : 'none');
      } catch {
        if (!cancelled) setMissing(true);
      }
    })();

    function onSite(e: maplibregl.MapLayerMouseEvent) {
      const f = e.features?.[0];
      if (!f) return;
      const box = document.createElement('div');
      const b = document.createElement('b');
      b.textContent = String(f.properties?.name ?? '');
      const sub = document.createElement('div');
      sub.textContent = String(f.properties?.detail ?? '');
      sub.style.cssText = 'color:#7a5a2e;font-size:12px';
      box.append(b, sub);
      popup.setLngLat((f.geometry as any).coordinates).setDOMContent(box).addTo(map);
    }

    const onRotate = () => setBearing(map.getBearing());
    map.on('rotate', onRotate);

    return () => {
      cancelled = true;
      popup.remove();
      map.setTerrain(null);
      map.setMaxPitch(60);
      map.easeTo({ pitch: 0, duration: 0 });
      map.off('rotate', onRotate);
      map.off('click', 'd06-heritage-pt', onSite);
      [...added].reverse().forEach((id) => map.getLayer(id) && map.removeLayer(id));
      srcs.forEach((id) => map.getSource(id) && map.removeSource(id));
      ['d06-stipple', 'd06-ship-r', 'd06-ship-l'].forEach((i) => map.hasImage(i) && map.removeImage(i));
      saved.forEach((l) => map.getLayer(l.id) && map.setLayoutProperty(l.id, 'visibility', l.vis));
    };
  }, [map]);

  // toggles
  const showRef = useMemo(() => ({ current: show }), []); // eslint-friendly mutable box
  showRef.current = show;
  useEffect(() => {
    const vis = (ids: string[], on: boolean) => ids.forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'));
    vis(['d06-relief'], show.relief);
    vis(['d06-fan-lines'], show.fan);
    vis(['d06-routes-lines', 'd06-partners-pt', 'd06-partners-label'], show.trade);
    vis(['d06-heritage-pt', 'd06-heritage-label'], show.heritage);
    vis(['d06-names'], show.names);
    vis(['d06-ships-sym', 'd06-ship-wake'], show.ships);
  }, [show, map, heritage]);

  // moving ships
  useEffect(() => {
    const src = () => map.getSource('d06-ships') as maplibregl.GeoJSONSource | undefined;
    if (!show.ships) {
      src()?.setData(EMPTY);
      return;
    }
    let raf = 0;
    let last = performance.now();
    let drawn = 0;
    let clock = 0;
    const tick = (now: number) => {
      clock += Math.min(0.1, (now - last) / 1000) * speedRef.current;
      last = now;
      if (now - drawn > 33) {
        drawn = now;
        src()?.setData(shipsAt(clock));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [map, show.ships]);

  // 2D chart / 3D relief
  useEffect(() => {
    if (!map.getSource('d06-dem')) return;
    if (view3d) {
      map.setMaxPitch(85);
      map.setTerrain({ source: 'd06-dem', exaggeration: exag });
      if (map.getPitch() < 40) map.easeTo({ pitch: 60, duration: 800 });
    } else {
      map.setTerrain(null);
      if (was3d.current) map.easeTo({ pitch: 0, bearing: 0, duration: 600 });
      map.setMaxPitch(60);
    }
    was3d.current = view3d;
  }, [view3d, exag, map]);

  const sail = () => map.fitBounds([[102, -6], [128, 25]], { padding: { top: 90, bottom: 40, left: 320, right: 40 }, duration: 1800 });
  const home = () => map.flyTo({ center: BUTUAN_CENTER, zoom: 11.5, bearing: 0, duration: 1500 });
  const toPartner = (p: (typeof PARTNERS)[number]) =>
    map.fitBounds([BUTUAN_CENTER, [p.lng, p.lat]], { padding: { top: 90, bottom: 60, left: 320, right: 60 }, duration: 1500 });

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    heritage?.forEach((f) => (c[f.properties.kind] = (c[f.properties.kind] ?? 0) + 1));
    return c;
  }, [heritage]);

  const flip = (k: keyof typeof show) => setShow((s) => ({ ...s, [k]: !s[k] }));

  return (
    <>
      <style>{CSS}</style>
      <div className="d06-texture" />
      <div className="d06-cartouche">
        <b>THE PORT OF THE BALANGHAI</b>
        <i>Butuan, on the Agusan river · a chart after the old manner</i>
      </div>
      <Rose bearing={bearing} />

      <div className="legend wide d06-panel">
        <h4>Port of the balanghai</h4>
        <div className="seg">
          <button onClick={home}>The river port</button>
          <button onClick={sail}>The trading world</button>
        </div>
        <div className="seg">
          <button className={!view3d ? 'on' : ''} onClick={() => setView3d(false)}>
            2D chart
          </button>
          <button className={view3d ? 'on' : ''} onClick={() => setView3d(true)}>
            3D relief
          </button>
        </div>
        {view3d && (
          <div className="legend-row" style={{ display: 'block' }}>
            <div className="row" style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Exaggeration</span>
              <strong>{exag}×</strong>
            </div>
            <input className="range" type="range" min={1} max={4} step={0.5} value={exag} onChange={(e) => setExag(Number(e.target.value))} />
            <p className="muted" style={{ margin: '2px 0 4px' }}>Right-click drag or two fingers to tilt and turn. The relief shows best near the hills.</p>
          </div>
        )}
        <p className="muted" style={{ margin: '0 0 6px' }}>
          Long before roads, the Agusan was the highway. In 1976 plank-built boats were dug up at Libertad, one radiocarbon-dated to about 320 AD. Nine have been found in all.
        </p>

        {[
          ['relief', 'Relief'],
          ['fan', 'Rhumb lines'],
          ['trade', 'Trading partners'],
          ['heritage', 'Heritage sites'],
          ['names', 'Modern place names'],
          ['ships', 'Sailing ships'],
        ].map(([k, label]) => (
          <label key={k} className="legend-row">
            <input type="checkbox" checked={show[k as keyof typeof show]} onChange={() => flip(k as keyof typeof show)} />
            <span style={{ flex: 1 }}>{label}</span>
          </label>
        ))}

        {show.ships && (
          <div className="legend-row" style={{ display: 'block' }}>
            <div className="row" style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Voyage speed</span>
              <strong>{speed}×</strong>
            </div>
            <input className="range" type="range" min={0.5} max={4} step={0.5} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
          </div>
        )}

        <p className="sub">Reached by sea</p>
        <ul className="list">
          {PARTNERS.map((p) => {
            const b = rhumbBearing(BUTUAN_CENTER, [p.lng, p.lat]);
            return (
              <li key={p.name} onClick={() => toPartner(p)}>
                <div className="row">
                  <span>{p.name}</span>
                  <span className="muted">
                    {Math.round(b)}° {WINDS[Math.round(b / 22.5) % 16]} · {Math.round(greatCircleKm(BUTUAN_CENTER, [p.lng, p.lat]) / 10) * 10} km
                  </span>
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {p.note}
                </div>
              </li>
            );
          })}
        </ul>

        {heritage && (
          <>
            <p className="sub">Heritage sites in the city</p>
            {Object.entries(KINDS).map(([k, v]) => (
              <div key={k} className="legend-row" style={{ cursor: 'default' }}>
                <span className="swatch" style={{ background: v.color }} />
                <span style={{ flex: 1 }}>{v.label}</span>
                <span className="muted">{counts[k] ?? 0}</span>
              </div>
            ))}
          </>
        )}
        {missing && (
          <p className="warn">
            Heritage data missing. Run <code>python pipeline/06_osm_heritage.py</code> to create <code>public/data/day06-heritage.geojson</code>.
          </p>
        )}
        {error && <p className="warn">Could not find the vector basemap to restyle.</p>}

        <p className="muted" style={{ marginTop: 8 }}>
          An imagined chart, not a survey. The ships are a time-lapse, two per route, not a record of real voyages. Today's coastline and rivers stand in for the old ones, and partners are straight rhumb lines to places named in records and finds, not sailing tracks. Dates and routes are debated.
        </p>
      </div>
    </>
  );
}
