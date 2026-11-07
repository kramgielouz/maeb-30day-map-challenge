import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { addBoundary, type BoundaryHandle } from '../../core/boundary';
import { areaM2, boundsOf, polygonsOf } from '../../core/geo';

// Data: public/data/barangays.geojson (pipeline/03_osm_barangays.py, or your own file with a `name` property).
// Optional: public/data/barangay-population.csv with columns name,population to unlock the density view.
const URL = '/data/barangays.geojson';
const POP_URL = '/data/barangay-population.csv';
const SRC = 'd03-barangays';
const FILL = 'd03-fill';
const LINE = 'd03-line';
const HL = 'd03-hl';
const LABEL = 'd03-label';

const COLORS = ['#e3f3ef', '#a9dccf', '#5cbcab', '#1f8f82', '#0a5a52'];

type Metric = 'area' | 'density';
interface Row {
  name: string;
  areaKm2: number;
  pop: number | null;
  density: number | null;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/\b(barangay|brgy|bgy)\b\.?/g, '')
    .replace(/[^a-z0-9]/g, '');

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

async function loadPopulation(): Promise<Map<string, number> | null> {
  try {
    const r = await fetch(POP_URL);
    if (!r.ok) return null;
    const txt = await r.text();
    if (txt.trimStart().startsWith('<')) return null; // SPA fallback page, not a CSV
    const lines = txt.split(/\r?\n/).filter(Boolean);
    const head = splitCsv(lines[0]).map((h) => h.toLowerCase());
    const ni = head.findIndex((h) => h === 'name' || h.startsWith('barangay'));
    const pi = head.findIndex((h) => h.startsWith('pop'));
    if (ni < 0 || pi < 0) return null;
    const m = new Map<string, number>();
    for (const l of lines.slice(1)) {
      const c = splitCsv(l);
      const v = Number(String(c[pi]).replace(/[, ]/g, ''));
      if (c[ni] && Number.isFinite(v)) m.set(norm(c[ni]), v);
    }
    return m.size ? m : null;
  } catch {
    return null;
  }
}

const fmt = (n: number, d = 0) => n.toLocaleString(undefined, { maximumFractionDigits: d });

export default function Day03({ map }: { map: maplibregl.Map }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [unmatched, setUnmatched] = useState(0);
  const [metric, setMetric] = useState<Metric>('area');
  const [hover, setHover] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const gjRef = useRef<any>(null);
  const boundsRef = useRef<Record<string, [[number, number], [number, number]]>>({});

  const hasPop = !!rows?.some((r) => r.density !== null);

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    let bh: BoundaryHandle | null = null;

    (async () => {
      bh = await addBoundary(map, 'd03', { mask: false, signal: ac.signal });
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
      const pops = await loadPopulation();
      if (cancelled) return;

      let miss = 0;
      const list: Row[] = [];
      for (const f of gj.features) {
        const name: string = f.properties?.name || '(unnamed)';
        const areaKm2 = areaM2(f) / 1e6;
        const csvPop = pops?.get(norm(name));
        const pop = csvPop ?? (typeof f.properties?.pop === 'number' ? f.properties.pop : null);
        if (pops && csvPop === undefined) miss++;
        const density = pop !== null && areaKm2 > 0 ? pop / areaKm2 : null;
        f.properties = { ...f.properties, name, areaKm2, pop, density, value: 0, cls: -1 };
        const b = boundsOf(polygonsOf(f));
        if (b) boundsRef.current[name] = b;
        list.push({ name, areaKm2, pop, density });
      }
      setUnmatched(miss);
      gjRef.current = gj;
      setRows(list);

      map.addSource(SRC, { type: 'geojson', data: gj });
      map.addLayer({
        id: FILL,
        type: 'fill',
        source: SRC,
        paint: {
          'fill-color': ['match', ['get', 'cls'], 0, COLORS[0], 1, COLORS[1], 2, COLORS[2], 3, COLORS[3], 4, COLORS[4], '#cfd6d4'] as any,
          'fill-opacity': 0.82,
        },
      });
      map.addLayer({ id: LINE, type: 'line', source: SRC, paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.6, 14, 1.6], 'line-opacity': 0.9 } });
      map.addLayer({ id: HL, type: 'line', source: SRC, filter: ['==', ['get', 'name'], ''], paint: { 'line-color': '#0f172a', 'line-width': 3 } });
      map.addLayer({
        id: LABEL,
        type: 'symbol',
        source: SRC,
        minzoom: 11,
        layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-max-width': 7 },
        paint: { 'text-color': '#0f172a', 'text-halo-color': '#ffffff', 'text-halo-width': 1.4 },
      } as maplibregl.LayerSpecification);

      map.on('mousemove', FILL, (e) => {
        map.getCanvas().style.cursor = 'pointer';
        setHover((e.features?.[0]?.properties as any)?.name ?? null);
      });
      map.on('mouseleave', FILL, () => {
        map.getCanvas().style.cursor = '';
        setHover(null);
      });
      map.on('click', FILL, (e) => {
        const name = (e.features?.[0]?.properties as any)?.name as string | undefined;
        if (!name) return;
        setSelected(name);
        const b = boundsRef.current[name];
        if (b) map.fitBounds(b, { padding: 80, maxZoom: 14 });
      });
    })();

    return () => {
      cancelled = true;
      ac.abort();
      [LABEL, HL, LINE, FILL].forEach((l) => map.getLayer(l) && map.removeLayer(l));
      map.getSource(SRC) && map.removeSource(SRC);
      bh?.remove();
    };
  }, [map]);

  // value + quantile class for the chosen metric
  const legend = useMemo(() => {
    if (!rows) return null;
    const m: Metric = metric === 'density' && hasPop ? 'density' : 'area';
    const vals = rows.map((r) => (m === 'density' ? r.density : r.areaKm2)).filter((v): v is number => v !== null).sort((a, b) => a - b);
    if (!vals.length) return null;
    const q = (p: number) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))];
    const breaks = [q(0.2), q(0.4), q(0.6), q(0.8)];
    return { m, breaks, min: vals[0], max: vals[vals.length - 1] };
  }, [rows, metric, hasPop]);

  useEffect(() => {
    const gj = gjRef.current;
    const src = map.getSource(SRC) as maplibregl.GeoJSONSource | undefined;
    if (!gj || !src || !legend) return;
    for (const f of gj.features) {
      const v = legend.m === 'density' ? f.properties.density : f.properties.areaKm2;
      f.properties.value = v;
      f.properties.cls = v === null || v === undefined ? -1 : legend.breaks.filter((b) => v >= b).length;
    }
    src.setData(gj);
  }, [legend, map, rows]);

  useEffect(() => {
    if (!map.getLayer(HL)) return;
    map.setFilter(HL, ['==', ['get', 'name'], hover ?? selected ?? '']);
  }, [hover, selected, map, rows]);

  const ranked = useMemo(() => {
    if (!rows || !legend) return [];
    const key = (r: Row) => (legend.m === 'density' ? r.density : r.areaKm2);
    return rows
      .filter((r) => key(r) !== null)
      .sort((a, b) => (key(b) as number) - (key(a) as number))
      .slice(0, 8);
  }, [rows, legend]);

  const shown = rows?.find((r) => r.name === (hover ?? selected));
  const unit = legend?.m === 'density' ? 'people / km²' : 'km²';
  const val = (r: Row) => (legend?.m === 'density' ? r.density : r.areaKm2) ?? 0;

  return (
    <div className="legend wide">
      <h4>Barangays</h4>
      <div className="seg">
        <button className={metric === 'area' ? 'on' : ''} onClick={() => setMetric('area')}>
          Land area
        </button>
        <button className={metric === 'density' && hasPop ? 'on' : ''} disabled={!hasPop} onClick={() => setMetric('density')} title={hasPop ? '' : 'Add public/data/barangay-population.csv'}>
          Population density
        </button>
      </div>

      {legend && (
        <>
          <div className="ramp">
            {COLORS.map((c) => (
              <i key={c} style={{ background: c }} />
            ))}
          </div>
          <div className="ramp-l">
            <span>{fmt(legend.min, 1)}</span>
            <span>{unit}</span>
            <span>{fmt(legend.max, 1)}</span>
          </div>
        </>
      )}

      {rows && (
        <div className="kv">
          <span>Barangays mapped</span>
          <span>{rows.length}</span>
          <span>Total area</span>
          <span>{fmt(rows.reduce((s, r) => s + r.areaKm2, 0))} km²</span>
        </div>
      )}

      {shown && (
        <div className="card2">
          <strong>{shown.name}</strong>
          <div className="kv">
            <span>Area</span>
            <span>{fmt(shown.areaKm2, 2)} km²</span>
            {shown.pop !== null && (
              <>
                <span>Population</span>
                <span>{fmt(shown.pop)}</span>
                <span>Density</span>
                <span>{fmt(shown.density ?? 0)} / km²</span>
              </>
            )}
          </div>
        </div>
      )}

      {ranked.length > 0 && (
        <>
          <p className="sub">Highest {legend?.m === 'density' ? 'density' : 'area'}</p>
          <ul className="list">
            {ranked.map((r) => (
              <li
                key={r.name}
                onClick={() => {
                  setSelected(r.name);
                  const b = boundsRef.current[r.name];
                  if (b) map.fitBounds(b, { padding: 80, maxZoom: 14 });
                }}
              >
                <div className="row">
                  <span>{r.name}</span>
                  <span className="muted">{fmt(val(r), legend?.m === 'density' ? 0 : 1)}</span>
                </div>
                <div className="bar" style={{ width: `${(val(r) / val(ranked[0])) * 100}%` }} />
              </li>
            ))}
          </ul>
        </>
      )}

      {unmatched > 0 && <p className="muted">{unmatched} barangay boundaries had no matching row in the population CSV (check the spelling of names).</p>}
      {missing && (
        <p className="warn">
          Data missing. Run <code>python pipeline/03_osm_barangays.py</code> to create <code>public/data/barangays.geojson</code>.
        </p>
      )}
    </div>
  );
}
