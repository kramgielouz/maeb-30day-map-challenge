import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { addBoundary, type BoundaryHandle } from '../../core/boundary';
import type { PolygonCoords } from '../../core/geo';

// How did Butuan's urban area grow? Built-up surface from the GHSL (GHS-BUILT-S R2023A), 1975 to 2020.
// Every ~100 m cell is classed by how built-up its neighbourhood is. The insights are about the main urban area
// (the largest connected urban patch), so none of the numbers depend on where the city boundary is drawn.
// Two extents: Butuan City (~100 m cells) and the whole Caraga region (~460 m cells), with the towns of Caraga ranked by urban area.
// Data: pipeline/09_ghsl_built.py (both extents) and pipeline/09_osm_towns.py (town names).
// The Record button plays the timeline and saves the map (with year, title and attribution burned in) as a video.
type Extent = 'butuan' | 'caraga';
const EXTENTS: Record<Extent, { label: string; meta: string; png: string; nbR: number; core: number; fringe: number; minKm2: number }> = {
  // nbR: neighbourhood radius in cells (butuan: 5 x 5 cells of ~100 m; caraga: 3 x 3 cells of ~460 m)
  butuan: { label: 'Butuan City', meta: '/data/day09-built.json', png: '/data/day09-built.png', nbR: 2, core: 25, fringe: 8, minKm2: 0.5 },
  caraga: { label: 'Caraga region', meta: '/data/day09-caraga-built.json', png: '/data/day09-caraga-built.png', nbR: 1, core: 15, fringe: 5, minKm2: 2 },
};
const TOWNS_URL = '/data/day09-towns.geojson';
const CARAGA_OUTLINE_URL = '/data/caraga-boundary.geojson';
const IMG = 'd09-img';
const IMG_LAYER = 'd09-img-layer';
const CITY = 'd09-cities';
const CITY_LAYER = 'd09-cities-layer';
const MASK = 'd09-mask'; // opaque black over the basemap, with a hole where the boundary is
const SETTLE = 0.01; // "rural settlement": at least 1% built-up around the cell
const ERA_T = 0.15; // a cell counts as built-up once 15% of it is built over
const STEP_MS = 900;

const CLASSES = [
  { name: 'Urban core', color: '#9b2226' },
  { name: 'Built-up fringe', color: '#ee6c4d' },
  { name: 'Rural settlement', color: '#f4d58d' },
  { name: 'Rural, open land', color: '#8fb996' },
];
const ERA_COLORS = ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'];

export interface Town {
  name: string;
  lng: number;
  lat: number;
  place: string;
  pop: number;
}
export interface City {
  id: number; // label of its patch in the final year
  cx: number;
  cy: number;
  area: number[]; // km2 of urban land per year, inside its final-year footprint
  patches: number[]; // how many separate patches it was made of, per year
  name?: string;
}

export interface Built {
  w: number;
  h: number;
  west: number;
  north: number;
  bbox: [number, number, number, number];
  years: number[];
  frac: Uint8Array[]; // per year, built-up share of each cell, 0..255
  nb: Float32Array[]; // per year, built-up share of the 5 x 5 neighbourhood, 0..1
  cd: number; // cell size in degrees
  inside: Uint8Array | null; // Butuan only: 1 = cell centre inside the city outline; used only to clip the picture
  cellKm2: number;
  attribution: string;
}

// Give each urban area the name of the town inside it (cities first, then by population), or else the nearest town within maxKm.
export function nameCities(cities: City[], labK: Int32Array, built: Built, towns: Town[], mLng: number, mLat: number, maxKm = 8): City[] {
  const { w, h, west, north, cd } = built;
  const inside = new Map<number, Town[]>();
  for (const t of towns) {
    const i = Math.floor((t.lng - west) / cd);
    const j = Math.floor((north - t.lat) / cd);
    if (i < 0 || j < 0 || i >= w || j >= h) continue;
    const id = labK[j * w + i];
    if (id < 0) continue;
    inside.set(id, [...(inside.get(id) ?? []), t]);
  }
  const out: City[] = [];
  for (const c of cities) {
    const here = inside.get(c.id);
    let town: Town | undefined = here?.sort((a, b) => (a.place === 'city' ? 0 : 1) - (b.place === 'city' ? 0 : 1) || b.pop - a.pop)[0];
    if (!town) {
      let best = maxKm;
      for (const t of towns) {
        const d = Math.hypot((t.lng - c.cx) * mLng, (t.lat - c.cy) * mLat);
        if (d < best) {
          best = d;
          town = t;
        }
      }
    }
    if (town) out.push({ ...c, name: town.name });
  }
  return out;
}

const WINDS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = (deg: number) => WINDS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
const hexRgb = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

export function boxMean(src: Uint8Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) {
        s += src[y * w + k];
        n++;
      }
      tmp[y * w + x] = s / n;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) {
        s += tmp[k * w + x];
        n++;
      }
      out[y * w + x] = s / n / 255;
    }
  return out;
}

// Rasterise the city polygon onto the grid, so the map can be clipped to it (testing every cell against a detailed boundary would be far slower).
function insideMask(polys: PolygonCoords[], west: number, north: number, cd: number, w: number, h: number): Uint8Array {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.fillStyle = '#fff';
  g.beginPath();
  for (const poly of polys)
    for (const ring of poly) {
      ring.forEach(([lng, lat], k) => {
        const x = (lng - west) / cd;
        const y = (north - lat) / cd;
        if (k === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      });
      g.closePath();
    }
  g.fill('evenodd');
  const d = g.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4] > 127 ? 1 : 0;
  return out;
}

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

// Classify every cell in every year and find the main urban area (the largest connected urban patch) in each.
export function analyse(built: Built, coreT: number, fringeT: number, cityMinKm2: number | null = null) {
  const withCities = cityMinKm2 !== null;
  const { w, h, nb, frac, years, cellKm2, west, north, cd } = built;
  const T1 = coreT / 100;
  const T2 = Math.min(fringeT, coreT) / 100;
  const mLng = 111.32 * Math.cos(((north - (h / 2) * cd) * Math.PI) / 180); // km per degree
  const mLat = 111.32;
  const cls = years.map(() => new Uint8Array(w * h));
  const counts = years.map(() => [0, 0, 0, 0]);
  const builtKm2 = years.map(() => 0);
  const main = years.map(() => null as null | { areaKm2: number; builtKm2: number; cx: number; cy: number; r80: number });
  const seen = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  const lab = withCities ? years.map(() => new Int32Array(w * h).fill(-1)) : [];
  const compSize: number[][] = years.map(() => []);
  const compRep: number[][] = years.map(() => []);

  years.forEach((_, yi) => {
    const a = nb[yi];
    const mask = new Uint8Array(w * h);
    let b = 0;
    for (let i = 0; i < w * h; i++) {
      const c = a[i] >= T1 ? 0 : a[i] >= T2 ? 1 : a[i] >= SETTLE ? 2 : 3;
      cls[yi][i] = c;
      counts[yi][c]++;
      b += frac[yi][i] / 255;
      if (c < 2) mask[i] = 1;
    }
    builtKm2[yi] = b * cellKm2;

    // largest 8-connected patch of urban core and fringe
    seen.fill(0);
    let best: Int32Array | null = null;
    for (let s0 = 0; s0 < w * h; s0++) {
      if (!mask[s0] || seen[s0]) continue;
      let qs = 0;
      let qe = 0;
      queue[qe++] = s0;
      seen[s0] = 1;
      const cid = compSize[yi].length;
      while (qs < qe) {
        const i = queue[qs++];
        if (withCities) lab[yi][i] = cid;
        const x = i % w;
        const y = (i - x) / w;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const j = yy * w + xx;
            if (mask[j] && !seen[j]) {
              seen[j] = 1;
              queue[qe++] = j;
            }
          }
      }
      compSize[yi].push(qe);
      compRep[yi].push(s0);
      if (!best || qe > best.length) best = queue.slice(0, qe);
    }
    if (!best) return;

    // its size, its centre of gravity (weighted by how built-up each cell is) and how far its built-up land reaches
    let wsum = 0;
    let sx = 0;
    let sy = 0;
    for (const i of best) {
      const wt = frac[yi][i] / 255;
      wsum += wt;
      sx += (i % w) * wt;
      sy += Math.floor(i / w) * wt;
    }
    if (wsum === 0) return;
    const cxCell = sx / wsum;
    const cyCell = sy / wsum;
    const d = Array.from(best, (i) => ({ km: Math.hypot(((i % w) - cxCell) * cd * mLng, (Math.floor(i / w) - cyCell) * cd * mLat), wt: frac[yi][i] / 255 }));
    d.sort((p, q) => p.km - q.km);
    let acc = 0;
    let r80 = 0;
    for (const e of d) {
      acc += e.wt;
      r80 = e.km;
      if (acc >= 0.8 * wsum) break;
    }
    main[yi] = { areaKm2: best.length * cellKm2, builtKm2: wsum * cellKm2, cx: west + (cxCell + 0.5) * cd, cy: north - (cyCell + 0.5) * cd, r80 };
  });

  // the first year each cell counts as built-up
  const era = new Uint8Array(w * h).fill(255);
  for (let i = 0; i < w * h; i++)
    for (let yi = 0; yi < years.length; yi++)
      if (frac[yi][i] / 255 >= ERA_T) {
        era[i] = yi;
        break;
      }
  // fastest five-year jump in built-up land
  let fastest = 1;
  for (let yi = 2; yi < years.length; yi++) if (builtKm2[yi] - builtKm2[yi - 1] > builtKm2[fastest] - builtKm2[fastest - 1]) fastest = yi;

  // Urban areas of the final year, and how each one grew: its area in earlier years, and how many separate patches it was made of.
  // Urban land only ever increases, so the patches of an earlier year sit inside the final-year areas.
  let cities: City[] = [];
  let labK: Int32Array | null = null;
  if (withCities) {
    const K = years.length - 1;
    labK = lab[K];
    const minCells = Math.max(2, Math.round((cityMinKm2 ?? 0) / cellKm2));
    const ids = compSize[K].map((sz, id) => ({ sz, id })).filter((c) => c.sz >= minCells).sort((a, b) => b.sz - a.sz).slice(0, 60);
    const idToJ = new Int32Array(compSize[K].length).fill(-1);
    ids.forEach((c, j) => (idToJ[c.id] = j));
    cities = ids.map((c) => ({ id: c.id, cx: 0, cy: 0, area: new Array(years.length).fill(0), patches: new Array(years.length).fill(0) }));
    const sx = new Float64Array(ids.length);
    const sy = new Float64Array(ids.length);
    const sw = new Float64Array(ids.length);
    for (let i = 0; i < w * h; i++) {
      const j = labK[i] >= 0 ? idToJ[labK[i]] : -1;
      if (j < 0) continue;
      const wt = frac[K][i] / 255;
      sx[j] += (i % w) * wt;
      sy[j] += Math.floor(i / w) * wt;
      sw[j] += wt;
    }
    cities.forEach((c, j) => {
      c.cx = west + ((sw[j] ? sx[j] / sw[j] : 0) + 0.5) * cd;
      c.cy = north - ((sw[j] ? sy[j] / sw[j] : 0) + 0.5) * cd;
    });
    years.forEach((_, yi) => {
      for (let i = 0; i < w * h; i++) {
        if (lab[yi][i] < 0 || labK![i] < 0) continue;
        const j = idToJ[labK![i]];
        if (j >= 0) cities[j].area[yi] += cellKm2;
      }
      compSize[yi].forEach((sz, c) => {
        if (sz < 2) return;
        const li = labK![compRep[yi][c]];
        const j = li >= 0 ? idToJ[li] : -1;
        if (j >= 0) cities[j].patches[yi]++;
      });
    });
  }
  return { cls, counts, builtKm2, main, era, fastest, mLng, mLat, cities, labK };
}

export default function Day09({ map }: { map: maplibregl.Map }) {
  const [extent, setExtent] = useState<Extent>('butuan');
  const [built, setBuilt] = useState<(Built & { extent: Extent }) | null>(null);
  const [towns, setTowns] = useState<Town[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [noOutline, setNoOutline] = useState(false);
  const [k, setK] = useState(9); // index of the year being shown
  const [mode, setMode] = useState<'classes' | 'era'>('classes');
  const [thr, setThr] = useState({ butuan: { core: EXTENTS.butuan.core, fringe: EXTENTS.butuan.fringe }, caraga: { core: EXTENTS.caraga.core, fringe: EXTENTS.caraga.fringe } });
  const [playing, setPlaying] = useState(false);
  const [recording, setRecording] = useState(false);
  const cache = useRef<Partial<Record<Extent, Built & { extent: Extent }>>>({});
  const chart = useRef<HTMLCanvasElement>(null);
  const rec = useRef<{
    mr: MediaRecorder;
    chunks: Blob[];
    timer: number;
    draw: () => void;
    armed: boolean;
    discard: boolean;
    ext: string;
  } | null>(null);
  // latest values for the video overlay, read from inside the map's render handler
  const live = useRef({ year: 0, title: '', attribution: '' });

  const coreT = thr[extent].core;
  const fringeT = thr[extent].fringe;
  const dCore = useDeferredValue(coreT);
  const dFringe = useDeferredValue(fringeT);
  const setT = (key: 'core' | 'fringe', v: number) => setThr((t) => ({ ...t, [extent]: { ...t[extent], [key]: v } }));

  // town names, once (optional file)
  useEffect(() => {
    fetch(TOWNS_URL)
      .then((r) => (r.ok ? r.json() : null))
      .then((gj) => {
        if (!gj) return;
        setTowns(gj.features.map((f: any) => ({ name: f.properties.name, place: f.properties.place, pop: f.properties.population ?? 0, lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] })));
      })
      .catch(() => undefined);
  }, []);

  // load the chosen extent. Butuan comes with the city outline (dimming the rest); Caraga has no outline at all.
  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    let bh: BoundaryHandle | null = null;
    const cfg = EXTENTS[extent];
    setBuilt(cache.current[extent] ?? null);
    setStatus(cache.current[extent] ? 'ready' : 'loading');
    setPlaying(false);
    (async () => {
      // Butuan needs its outline; for Caraga the outline is optional (it clips and dims the picture, as Butuan's does)
      bh = await addBoundary(map, 'd09', extent === 'caraga' ? { url: CARAGA_OUTLINE_URL, fit: false, signal: ac.signal } : { signal: ac.signal });
      if (cancelled) return void bh?.remove();
      setNoOutline(extent === 'caraga' && !bh);
      if (bh) {
        // the outline itself is not drawn: hide its layers, and black out the basemap everywhere outside it instead
        (map.getStyle().layers ?? []).forEach((l) => l.id.startsWith('d09-bnd') && map.setLayoutProperty(l.id, 'visibility', 'none'));
        const world = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
        const data = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [world, ...bh.polys.flatMap((poly) => poly)] } } as any;
        const first = (map.getStyle().layers ?? []).find((l) => l.id.startsWith('d09') && l.id !== MASK)?.id;
        map.addSource(MASK, { type: 'geojson', data });
        map.addLayer({ id: MASK, type: 'fill', source: MASK, paint: { 'fill-color': '#000000', 'fill-opacity': 1, 'fill-antialias': false } }, first);
      }
      let data = cache.current[extent];
      if (!data) {
        const meta = await fetch(cfg.meta).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        if (cancelled) return;
        if (!meta || (extent === 'butuan' && !bh)) return void setStatus('missing');
        try {
          const img = await loadImage(cfg.png);
          if (cancelled) return;
          const { w, h, years } = meta as { w: number; h: number; years: number[] };
          const frac = years.map((_, yi) => {
            const a = new Uint8Array(w * h);
            const off = yi * w * h;
            for (let i = 0; i < w * h; i++) a[i] = img.data[(off + i) * 4];
            return a;
          });
          const [west, south, , north] = meta.bbox;
          const cd = meta.cell_deg;
          data = {
            extent,
            w,
            h,
            west,
            north,
            bbox: meta.bbox,
            years,
            frac,
            nb: frac.map((f) => boxMean(f, w, h, cfg.nbR)),
            cd,
            inside: bh ? insideMask(bh.polys, west, north, cd, w, h) : null,
            cellKm2: cd * 111.32 * (cd * 111.32 * Math.cos((((south + north) / 2) * Math.PI) / 180)),
            attribution: meta.attribution,
          };
          cache.current[extent] = data;
        } catch {
          if (!cancelled) setStatus('missing');
          return;
        }
      }
      if (cancelled) return;
      setBuilt(data);
      setStatus('ready');
      if (extent === 'caraga') {
        const [west, south, east, north] = data.bbox;
        const pad = window.innerWidth > 900 ? { left: 390, right: 20, top: 20, bottom: 20 } : 20;
        map.fitBounds([[west, south], [east, north]], { padding: pad, duration: 1200 });
      }
    })();
    return () => {
      cancelled = true;
      ac.abort();
      bh?.remove();
      if (map.getLayer(MASK)) map.removeLayer(MASK);
      if (map.getSource(MASK)) map.removeSource(MASK);
    };
  }, [extent, map]);

  // remove our layers when leaving the day
  useEffect(
    () => () => {
      [CITY_LAYER, IMG_LAYER, MASK].forEach((l) => map.getLayer(l) && map.removeLayer(l));
      [CITY, IMG, MASK].forEach((s) => map.getSource(s) && map.removeSource(s));
    },
    [map],
  );

  const stats = useMemo(() => (built ? analyse(built, dCore, dFringe, built.extent === 'caraga' ? EXTENTS.caraga.minKm2 : null) : null), [built, dCore, dFringe]);

  // Caraga: name each urban area after its town; without the towns file they are just numbered
  const cities = useMemo<City[]>(() => {
    if (!built || !stats || built.extent !== 'caraga' || !stats.labK) return [];
    if (towns.length) return nameCities(stats.cities, stats.labK, built, towns, stats.mLng, stats.mLat);
    return stats.cities.slice(0, 8).map((c, i) => ({ ...c, name: `Urban area ${i + 1}` }));
  }, [built, stats, towns]);
  const topCities = useMemo(() => [...cities].sort((a, b) => b.area[b.area.length - 1] - a.area[a.area.length - 1]).slice(0, 8), [cities]);

  // draw the chosen year on the map
  useEffect(() => {
    const vis = (on: boolean) => map.getLayer(IMG_LAYER) && map.setLayoutProperty(IMG_LAYER, 'visibility', on ? 'visible' : 'none');
    if (!built || !stats) return void vis(false);
    const { w, h, bbox, inside } = built;
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const g = cv.getContext('2d')!;
    const img = g.createImageData(w, h);
    if (mode === 'classes') {
      const c = stats.cls[k];
      for (let i = 0; i < w * h; i++) if ((!inside || inside[i]) && c[i] < 3) img.data.set([...hexRgb(CLASSES[c[i]].color), 215], i * 4);
    } else {
      for (let i = 0; i < w * h; i++) if ((!inside || inside[i]) && stats.era[i] <= k) img.data.set([...hexRgb(ERA_COLORS[stats.era[i]]), 235], i * 4);
    }
    g.putImageData(img, 0, 0);
    const [west, south, east, north] = bbox;
    const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [[west, north], [east, north], [east, south], [west, south]];
    const url = cv.toDataURL();
    const src = map.getSource(IMG) as maplibregl.ImageSource | undefined;
    if (src) src.updateImage({ url, coordinates });
    else {
      map.addSource(IMG, { type: 'image', url, coordinates });
      map.addLayer({ id: IMG_LAYER, type: 'raster', source: IMG, paint: { 'raster-opacity': 0.9, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' } }, map.getLayer('d09-bnd-casing') ? 'd09-bnd-casing' : undefined);
    }
    vis(true);
  }, [built, stats, k, mode, map]);

  // names of the biggest urban areas, on the map (Caraga only)
  useEffect(() => {
    const features = topCities.map((c) => ({ type: 'Feature', properties: { name: c.name }, geometry: { type: 'Point', coordinates: [c.cx, c.cy] } }));
    const data = { type: 'FeatureCollection', features } as any;
    const src = map.getSource(CITY) as maplibregl.GeoJSONSource | undefined;
    if (src) src.setData(data);
    else if (features.length) {
      map.addSource(CITY, { type: 'geojson', data });
      map.addLayer({
        id: CITY_LAYER,
        type: 'symbol',
        source: CITY,
        layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-allow-overlap': false, 'text-offset': [0, -1] },
        paint: { 'text-color': '#111827', 'text-halo-color': '#ffffff', 'text-halo-width': 1.8 },
      });
    }
  }, [topCities, map]);

  // play: step through the years
  useEffect(() => {
    if (!playing || !built) return;
    const t = setInterval(() => {
      setK((cur) => {
        if (cur >= built.years.length - 1) {
          setPlaying(false);
          return cur;
        }
        return cur + 1;
      });
    }, STEP_MS);
    return () => clearInterval(t);
  }, [playing, built]);

  // recording: finish automatically once playback reaches the last year, hold it for 1.5 s, then stop and save
  useEffect(() => {
    const r = rec.current;
    if (!recording || !r || !r.armed || playing || !built) return;
    if (k < built.years.length - 1) return; // paused part-way: use the Stop button
    const t = setTimeout(stopRecording, 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, playing, k, built]);

  // switching extent or leaving the day discards an unfinished recording
  useEffect(() => {
    return () => {
      const r = rec.current;
      if (!r) return;
      r.discard = true;
      if (r.mr.state !== 'inactive') r.mr.stop();
    };
  }, [extent]);

  // the growth chart
  const seriesA = useMemo(() => {
    if (!built || !stats) return [];
    if (built.extent === 'caraga') return built.years.map((_, yi) => cities.reduce((s, c) => s + c.area[yi], 0));
    return stats.main.map((m) => (m ? m.areaKm2 : 0));
  }, [built, stats, cities]);
  useEffect(() => {
    const c = chart.current;
    if (!c || !built || !stats) return;
    const dpr = window.devicePixelRatio || 1;
    const W = 336;
    const H = 130;
    c.width = W * dpr;
    c.height = H * dpr;
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, W, H);
    const n = built.years.length;
    const padB = 16;
    const plotH = H - padB - 4;
    const max = Math.max(...stats.builtKm2, ...seriesA) * 1.1 || 1;
    const x = (i: number) => 4 + (i / (n - 1)) * (W - 8);
    const y = (v: number) => 4 + plotH - (v / max) * plotH;
    g.fillStyle = 'rgba(238,108,77,.35)';
    g.beginPath();
    g.moveTo(x(0), y(0));
    seriesA.forEach((v, i) => g.lineTo(x(i), y(v)));
    g.lineTo(x(n - 1), y(0));
    g.closePath();
    g.fill();
    g.strokeStyle = '#ee6c4d';
    g.lineWidth = 2;
    g.beginPath();
    seriesA.forEach((v, i) => (i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v))));
    g.stroke();
    g.strokeStyle = '#9b2226';
    g.beginPath();
    stats.builtKm2.forEach((v, i) => (i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v))));
    g.stroke();
    g.fillStyle = '#6b7280';
    g.font = '10px system-ui, sans-serif';
    g.textAlign = 'center';
    built.years.forEach((yr, i) => {
      if (i % 2 === 0 || i === n - 1) g.fillText(String(yr), Math.min(W - 12, Math.max(12, x(i))), H - 3);
    });
    g.strokeStyle = '#111827';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(x(k), 2);
    g.lineTo(x(k), H - padB);
    g.stroke();
    [stats.builtKm2[k], seriesA[k]].forEach((v) => {
      g.fillStyle = '#fff';
      g.beginPath();
      g.arc(x(k), y(v), 3.5, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    });
  }, [built, stats, seriesA, k]);

  const scrub = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!built || recording || (e.type === 'pointermove' && e.buttons !== 1)) return;
    const r = e.currentTarget.getBoundingClientRect();
    const f = (e.clientX - r.left - 4) / (r.width - 8);
    setPlaying(false);
    setK(Math.min(built.years.length - 1, Math.max(0, Math.round(f * (built.years.length - 1)))));
  };

  // ---- video recording ----
  const cleanupRecording = () => {
    const r = rec.current;
    if (!r) return;
    map.off('render', r.draw);
    clearInterval(r.timer);
  };

  const stopRecording = () => {
    const r = rec.current;
    if (!r) return;
    setPlaying(false);
    if (r.mr.state !== 'inactive') r.mr.stop(); // onstop does the download and cleanup
  };

  const startRecording = () => {
    if (!built || rec.current) return;
    const src = map.getCanvas();
    const off = document.createElement('canvas');
    off.width = src.width & ~1; // even dimensions suit video encoders
    off.height = src.height & ~1;
    const g = off.getContext('2d')!;

    const type = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t));
    if (!type || !('captureStream' in off)) {
      alert('This browser cannot record video from a canvas.');
      return;
    }
    const ext = type.startsWith('video/mp4') ? 'mp4' : 'webm';
    const mr = new MediaRecorder((off as any).captureStream(30), { mimeType: type, videoBitsPerSecond: 8_000_000 });
    const chunks: Blob[] = [];

    // Runs right after the map renders, while its WebGL buffer is still readable.
    const draw = () => {
      const { year, title, attribution } = live.current;
      g.fillStyle = '#000';
      g.fillRect(0, 0, off.width, off.height); // clean black background
      g.drawImage(src, 0, 0, off.width, off.height);
      const fs = Math.round(off.width / 16);
      g.lineJoin = 'round';
      g.fillStyle = '#fff';
      g.strokeStyle = 'rgba(0,0,0,.95)';
      g.textBaseline = 'alphabetic';
      g.textAlign = 'left';
      g.font = `700 ${fs}px system-ui, sans-serif`;
      g.lineWidth = fs / 7;
      g.strokeText(String(year), fs * 0.4, off.height - fs * 0.5);
      g.fillText(String(year), fs * 0.4, off.height - fs * 0.5);
      g.font = `600 ${Math.round(fs / 3)}px system-ui, sans-serif`;
      g.lineWidth = fs / 20;
      g.strokeText(title, fs * 0.4, fs * 0.6);
      g.fillText(title, fs * 0.4, fs * 0.6);
      g.font = `${Math.round(fs / 6)}px system-ui, sans-serif`;
      g.textAlign = 'right';
      g.lineWidth = 3;
      g.strokeText(attribution, off.width - 10, off.height - 8);
      g.fillText(attribution, off.width - 10, off.height - 8);
    };
    map.on('render', draw);
    // keep the map rendering so frames keep flowing while the picture is static
    const timer = window.setInterval(() => map.triggerRepaint(), 33);

    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mr.onstop = () => {
      const r = rec.current;
      cleanupRecording();
      rec.current = null;
      setRecording(false);
      if (!r || r.discard || !chunks.length) return;
      const url = URL.createObjectURL(new Blob(chunks, { type: type.split(';')[0] }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${extent}-urban-growth-1975-2020.${ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    };

    rec.current = { mr, chunks, timer, draw, armed: false, discard: false, ext };
    mr.start();
    setRecording(true);
    setPlaying(false);
    setK(0);
    // let the first year sit for a moment, then play
    setTimeout(() => {
      if (!rec.current) return;
      rec.current.armed = true;
      setPlaying(true);
    }, 800);
  };

  const year = built ? built.years[k] : 0;
  const last = built ? built.years.length - 1 : 0;
  const counts = stats ? stats.counts[k] : [0, 0, 0, 0];
  const km2 = (c: number) => (built ? c * built.cellKm2 : 0);
  const isCaraga = built?.extent === 'caraga';

  // values the video overlay reads on every map render
  live.current = {
    year,
    title: `How ${extent === 'caraga' ? 'Caraga' : 'Butuan'} grew, 1975 to 2020`,
    attribution: built?.attribution ?? '',
  };

  // Butuan: the main urban area
  const m = stats ? stats.main[k] : null;
  const k0 = stats ? Math.max(0, stats.main.findIndex((q) => q && q.areaKm2 >= 0.5)) : 0;
  const m0 = stats ? stats.main[k0] : null;
  const shift = m && m0 && stats ? { dx: (m.cx - m0.cx) * stats.mLng, dy: (m.cy - m0.cy) * stats.mLat } : null;
  const shiftKm = shift ? Math.hypot(shift.dx, shift.dy) : 0;
  const shiftDeg = shift ? (((Math.atan2(shift.dx, shift.dy) * 180) / Math.PI) % 360 + 360) % 360 : 0;
  const b0 = stats ? stats.builtKm2[0] : 0;
  const bk = stats ? stats.builtKm2[k] : 0;

  // Caraga: the ranking of urban areas in the chosen year, and the stories in it
  const ranking = topCities
    .map((c) => ({ c, area: c.area[k], patches: c.patches[k] }))
    .filter((r) => r.area > 0)
    .sort((a, b) => b.area - a.area);
  const biggest = ranking[0];
  const added = topCities.length ? [...topCities].sort((a, b) => b.area[last] - b.area[0] - (a.area[last] - a.area[0]))[0] : null;
  const merged = topCities
    .map((c) => ({ c, pMax: Math.max(...c.patches), yMax: built ? built.years[c.patches.indexOf(Math.max(...c.patches))] : 0 }))
    .filter((r) => r.pMax > 1 && r.c.patches[last] === 1)
    .sort((a, b) => b.pMax - a.pMax)[0];

  return (
    <div className="legend wide" style={{ width: 360, maxWidth: 360 }}>
      <h4>How {extent === 'caraga' ? 'Caraga' : 'Butuan'} grew, 1975 to 2020</h4>
      <div className="seg">
        {(Object.keys(EXTENTS) as Extent[]).map((e) => (
          <button key={e} className={extent === e ? 'on' : ''} disabled={recording} onClick={() => setExtent(e)}>
            {EXTENTS[e].label}
          </button>
        ))}
      </div>

      {status === 'missing' && (
        <p className="warn">
          Built-up data missing. Run <code>python pipeline/09_ghsl_built.py{extent === 'caraga' ? ' --only caraga' : ''}</code> to create the <code>{extent === 'caraga' ? 'day09-caraga-built' : 'day09-built'}</code> files in <code>public/data</code>.
        </p>
      )}
      {status === 'loading' && <p className="muted">Loading built-up data…</p>}
      {noOutline && (
        <p className="muted">
          No Caraga outline yet, so nothing is clipped. Run <code>python pipeline/09_caraga_boundary.py</code> to add it.
        </p>
      )}

      {built && stats && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              disabled={recording}
              onClick={() => {
                if (!playing && k >= built.years.length - 1) setK(0);
                setPlaying((p) => !p);
              }}
              aria-label={playing ? 'Pause' : 'Play'}
              style={{ width: 38, height: 38, borderRadius: '50%', border: 0, background: 'var(--accent)', color: 'var(--on-accent, #fff)', font: 'inherit', fontSize: 16, cursor: recording ? 'default' : 'pointer', opacity: recording ? 0.5 : 1 }}
            >
              {playing ? '❚❚' : '▶'}
            </button>
            <div style={{ fontSize: 36, fontWeight: 700, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{year}</div>
            <button
              onClick={recording ? stopRecording : startRecording}
              aria-label={recording ? 'Stop recording and save the video' : 'Record the animation as a video'}
              style={{ marginLeft: 'auto', padding: '6px 12px', borderRadius: 16, border: 0, background: recording ? '#9b2226' : '#e5e7eb', color: recording ? '#fff' : '#111827', font: 'inherit', fontSize: 13, cursor: 'pointer' }}
            >
              {recording ? '■ Stop & save' : '● Record'}
            </button>
          </div>
          <input
            className="range"
            type="range"
            min={0}
            max={built.years.length - 1}
            step={1}
            value={k}
            disabled={recording}
            onChange={(e) => {
              setPlaying(false);
              setK(Number(e.target.value));
            }}
            aria-label="Year"
          />

          {isCaraga ? (
            <>
              {biggest ? (
                <p style={{ margin: '6px 0 4px', fontSize: 14 }}>
                  In {year} the largest urban area in Caraga was <strong>{biggest.c.name}</strong>, at <strong>{biggest.area.toFixed(1)} km²</strong>.
                </p>
              ) : (
                <p style={{ margin: '6px 0 4px', fontSize: 14 }}>In {year} no urban area of {EXTENTS.caraga.minKm2} km² or more had formed yet at these settings.</p>
              )}
              {added && added.area[last] - added.area[0] > 0 && (
                <p className="muted" style={{ margin: '0 0 4px' }}>
                  From {built.years[0]} to {built.years[last]}, <strong>{added.name}</strong> added the most urban land: {(added.area[last] - added.area[0]).toFixed(1)} km².
                </p>
              )}
              {merged && (
                <p className="muted" style={{ margin: '0 0 6px' }}>
                  <strong>{merged.c.name}</strong> was {merged.pMax} separate patches in {merged.yMax}. Today it is one connected urban area.
                </p>
              )}
            </>
          ) : (
            <>
              {m ? (
                <p style={{ margin: '6px 0 4px', fontSize: 14 }}>
                  In {year} the main urban area covered <strong>{m.areaKm2.toFixed(1)} km²</strong>
                  {k > k0 && m0 ? ` (${(m.areaKm2 / m0.areaKm2).toFixed(1)}× its ${built.years[k0]} size)` : ''}. Four-fifths of its built-up land lies within <strong>{m.r80.toFixed(1)} km</strong> of its centre.
                </p>
              ) : (
                <p style={{ margin: '6px 0 4px', fontSize: 14 }}>In {year} there was no connected urban area yet at these settings.</p>
              )}
              {k > k0 && shift && (
                <p className="muted" style={{ margin: '0 0 4px' }}>
                  {shiftKm >= 0.3 ? (
                    <>
                      Since {built.years[k0]} its centre of gravity has moved {shiftKm.toFixed(1)} km toward the {compass(shiftDeg)}.
                    </>
                  ) : (
                    <>Since {built.years[k0]} it has grown outward fairly evenly in every direction.</>
                  )}
                </p>
              )}
            </>
          )}
          <p className="muted" style={{ margin: '0 0 6px' }}>
            Fastest growth: {built.years[stats.fastest - 1]} to {built.years[stats.fastest]}, adding {(stats.builtKm2[stats.fastest] - stats.builtKm2[stats.fastest - 1]).toFixed(1)} km² of built-up land. In the whole area shown, built-up surface was {bk.toFixed(1)} km² in {year}
            {k > 0 && b0 > 0 ? `, ${(bk / b0).toFixed(1)}× its 1975 size` : ''}.
          </p>

          <div className="seg">
            <button className={mode === 'classes' ? 'on' : ''} onClick={() => setMode('classes')}>
              Urban or rural
            </button>
            <button className={mode === 'era' ? 'on' : ''} onClick={() => setMode('era')}>
              When it was built
            </button>
          </div>

          {mode === 'classes' ? (
            <>
              {CLASSES.map((c, i) => (
                <div key={c.name} className="legend-row" style={{ cursor: 'default' }}>
                  <span className="swatch" style={{ background: c.color, borderRadius: 2 }} />
                  <span style={{ flex: 1 }}>{c.name}</span>
                  <span className="muted">{i < 3 ? `${km2(counts[i]).toFixed(1)} km²` : ''}</span>
                </div>
              ))}
              <div className="legend-row" style={{ display: 'block' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Urban core: over</span>
                  <strong>{coreT}% built-up nearby</strong>
                </div>
                <input className="range" type="range" min={10} max={60} step={5} value={coreT} disabled={recording} onChange={(e) => setT('core', Number(e.target.value))} />
              </div>
              <div className="legend-row" style={{ display: 'block' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Built-up fringe: over</span>
                  <strong>{Math.min(fringeT, coreT)}%</strong>
                </div>
                <input className="range" type="range" min={2} max={25} step={1} value={fringeT} disabled={recording} onChange={(e) => setT('fringe', Number(e.target.value))} />
              </div>
            </>
          ) : (
            <>
              <div style={{ display: 'flex', height: 10, borderRadius: 3, overflow: 'hidden', margin: '8px 0 2px' }}>
                {ERA_COLORS.map((c) => (
                  <i key={c} style={{ flex: 1, background: c }} />
                ))}
              </div>
              <div className="ramp-l" style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>built by {built.years[0]}</span>
                <span>{built.years[built.years.length - 1]}</span>
              </div>
              <p className="muted" style={{ margin: '4px 0 0' }}>
                Each cell is coloured by the first year it was at least {Math.round(ERA_T * 100)}% built over. Move the year to watch it fill in.
              </p>
            </>
          )}

          {isCaraga && (
            <>
              <p className="sub">Biggest urban areas in {year}</p>
              <ul className="list">
                {ranking.slice(0, 8).map((r) => (
                  <li key={r.c.id} onClick={() => map.flyTo({ center: [r.c.cx, r.c.cy], zoom: 11, duration: 1200 })}>
                    <div className="row">
                      <span>{r.c.name}</span>
                      <span className="muted">
                        {r.area.toFixed(1)} km²
                        {r.patches > 1 ? ` · ${r.patches} patches` : ''}
                      </span>
                    </div>
                    <div className="bar" style={{ width: `${(r.area / ranking[0].area) * 100}%` }} />
                  </li>
                ))}
              </ul>
              {!towns.length && (
                <p className="muted">
                  Town names missing: run <code>python pipeline/09_osm_towns.py</code> to name these.
                </p>
              )}
            </>
          )}

          <p className="sub">{isCaraga ? 'Urban land of these towns and built-up land over time' : 'Main urban area and built-up land over time'}</p>
          <canvas ref={chart} onPointerDown={scrub} onPointerMove={scrub} style={{ width: 336, height: 130, display: 'block', borderRadius: 4, cursor: 'ew-resize', touchAction: 'none' }} />
          <div style={{ display: 'flex', gap: 14, fontSize: 11, margin: '2px 0 0' }}>
            <span style={{ color: '#ee6c4d' }}>━ {isCaraga ? 'Listed urban areas' : 'Main urban area'} (km²)</span>
            <span style={{ color: '#9b2226' }}>━ Built-up surface (km²)</span>
          </div>
        </>
      )}

      <p className="muted" style={{ marginTop: 8 }}>
        {built?.attribution ?? 'GHS-BUILT-S R2023A, European Commission, Joint Research Centre (JRC), CC BY 4.0'}. The urban and rural classes are my own, from how built-up the surrounding area is. They are not the official degree-of-urbanisation classes, so move the sliders to see how sensitive the story is.{' '}
        {isCaraga
          ? 'The Caraga view uses cells of about 460 m. The picture is clipped to the OpenStreetMap outline of the region and only towns inside it are listed. That outline is not official, and the numbers do not use it, so an urban area, a connected patch of core and fringe, can extend past it or run into the next town.'
          : 'The map is clipped to the city outline for display only. That outline is not official, and the numbers do not use it: the main urban area is the largest connected patch of core and fringe wherever it lies, so it can extend past the outline into neighbouring towns.'}{' '}
        Years before the satellite era are modelled estimates.
      </p>
    </div>
  );
}