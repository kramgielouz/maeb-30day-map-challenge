import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { boundsOf, inverseMask, polygonsOf } from '../../core/geo';

// Day 10, "Built by prompt": one prompt to an AI planner, and a conceptual Site Development Plan for Butuan comes back.
// Everything drawn comes from public/data/day10-plan.geojson, written by pipeline/10_site_plan.py from the city boundary alone.
// The file carries its own legend and statistics, so this page never hard-codes a colour, a class or a number.
const PLAN_URL = '/data/day10-plan.geojson';
const P = 'd10-';
const PAPER = '#f3eee1';
const INK = '#2b2a27';

const PROMPT =
  'You are an expert urban planner, design/reimagine the city using the butuan-boundary.geojson, into a progressive, self sustaining and world-class city. Create a "Site Development Plan"-like map of the city';

interface LegendItem {
  key: string;
  group: string;
  label: string;
  color: string;
  pattern: string | null;
  density: number;
  desc: string;
}
interface Stats {
  city_ha: number;
  urban_ha: number;
  urban_pct: number;
  blocks: number;
  hubs: number;
  stations: number;
  transit_km: number;
  ring_km: number;
  arterial_km: number;
  collector_km: number;
  green_urban_pct: number;
  protected_pct: number;
  farm_pct: number;
  walk_hub_pct: number;
  walk_station_pct: number;
  walk_park_pct: number;
  solar_ha: number;
  solar_mwp: number;
  capacity_persons: number;
  assumptions: string[];
  class_ha: Record<string, number>;
}
interface Plan {
  type: 'FeatureCollection';
  features: any[];
  meta: { title: string; prompt: string; generated: string; source: string };
  legend: LegendItem[];
  stats: Stats;
}

type Group = 'land' | 'parcels' | 'streets' | 'transit' | 'green' | 'projects' | 'labels';
const GROUPS: { id: Group; label: string }[] = [
  { id: 'land', label: 'Land use' },
  { id: 'parcels', label: 'Block outlines' },
  { id: 'streets', label: 'Streets' },
  { id: 'transit', label: 'Transit lines and stations' },
  { id: 'green', label: 'River and greenways' },
  { id: 'projects', label: 'Projects and hubs' },
  { id: 'labels', label: 'Names' },
];

// Small tiling images for the rural classes, drawn on a canvas so no sprite files are needed.
function patternImage(kind: string): ImageData {
  const s = 16;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  g.strokeStyle = 'rgba(43,42,39,.38)';
  g.fillStyle = 'rgba(43,42,39,.38)';
  g.lineWidth = 1;
  if (kind === 'hatch') {
    g.beginPath();
    g.moveTo(0, s);
    g.lineTo(s, 0);
    g.moveTo(-4, 4);
    g.lineTo(4, -4);
    g.moveTo(s - 4, s + 4);
    g.lineTo(s + 4, s - 4);
    g.stroke();
  } else if (kind === 'dots') {
    g.fillStyle = 'rgba(255,255,255,.55)';
    [[4, 4], [12, 12], [12, 4], [4, 12]].forEach(([x, y]) => {
      g.beginPath();
      g.arc(x, y, 1.4, 0, 7);
      g.fill();
    });
  } else if (kind === 'cross') {
    g.strokeStyle = 'rgba(43,42,39,.5)';
    g.beginPath();
    g.moveTo(0, s / 2);
    g.lineTo(s, s / 2);
    g.moveTo(s / 2, 0);
    g.lineTo(s / 2, s);
    g.stroke();
  } else {
    g.strokeStyle = 'rgba(255,255,255,.7)';
    g.beginPath();
    g.moveTo(0, 5);
    g.quadraticCurveTo(4, 1, 8, 5);
    g.quadraticCurveTo(12, 9, 16, 5);
    g.moveTo(0, 13);
    g.quadraticCurveTo(4, 9, 8, 13);
    g.quadraticCurveTo(12, 17, 16, 13);
    g.stroke();
  }
  return g.getImageData(0, 0, s, s);
}

const num = (n: number) => n.toLocaleString('en-US');

export default function Day10({ map }: { map: maplibregl.Map }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState(false);
  const [opacity, setOpacity] = useState(100);
  const [groups, setGroups] = useState<Record<Group, boolean>>({ land: true, parcels: true, streets: true, transit: true, green: true, projects: true, labels: true });
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const popup = useRef<maplibregl.Popup | null>(null);
  // layer id -> [paint property, base opacity], so the slider can fade the whole plan
  const fades = useRef<[string, string, number][]>([]);
  const layersByGroup = useRef<Record<Group, string[]>>({ land: [], parcels: [], streets: [], transit: [], green: [], projects: [], labels: [] });
  const classLayers = useRef<string[]>([]);
  const ownFilters = useRef<Record<string, any>>({});

  useEffect(() => {
    let cancelled = false;
    fetch(PLAN_URL)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j) => !cancelled && setPlan(j))
      .catch(() => !cancelled && setError(true));
    return () => {
      cancelled = true;
    };
  }, []);

  // build every source and layer once the plan has arrived
  useEffect(() => {
    if (!plan) return;
    const feats = plan.features;
    const by = (kind: string) => ({ type: 'FeatureCollection', features: feats.filter((f) => f.properties.kind === kind) }) as any;
    const boundary = feats.find((f) => f.properties.kind === 'boundary');
    const polys = polygonsOf(boundary);
    const colour: any[] = ['match', ['get', 'lu']];
    plan.legend.forEach((l) => colour.push(l.key, l.color));
    colour.push('#cccccc');

    const ids: string[] = [];
    const sources: string[] = [];
    const src = (id: string, data: any) => {
      map.addSource(P + id, { type: 'geojson', data });
      sources.push(P + id);
    };
    const add = (layer: any, group: Group, fade?: [string, number], byClass = false) => {
      const l = { ...layer, id: P + layer.id };
      map.addLayer(l);
      ids.push(l.id);
      layersByGroup.current[group].push(l.id);
      if (fade) fades.current.push([l.id, fade[0], fade[1]]);
      if (byClass) {
        classLayers.current.push(l.id);
        ownFilters.current[l.id] = l.filter ?? null;
      }
    };
    fades.current = [];
    classLayers.current = [];
    ownFilters.current = {};
    (Object.keys(layersByGroup.current) as Group[]).forEach((g) => (layersByGroup.current[g] = []));

    // patterns
    const images: string[] = [];
    [...new Set(plan.legend.map((l) => l.pattern).filter(Boolean) as string[])].forEach((k) => {
      const name = `${P}pat-${k}`;
      if (!map.hasImage(name)) map.addImage(name, patternImage(k));
      images.push(name);
    });

    src('boundary', boundary);
    src('mask', inverseMask(polys) as any);
    src('zones', by('zone'));
    src('blocks', by('block'));
    src('roads', by('road'));
    src('transit', by('transit'));
    src('stations', by('station'));
    src('river', by('river'));
    src('greenways', by('greenway'));
    src('airport', by('airport'));
    src('hubs', by('hub'));
    src('pois', by('poi'));
    src('labels', by('label'));

    // sheet: dimmed surroundings, paper inside the city limit
    map.addLayer({ id: `${P}mask`, type: 'fill', source: `${P}mask`, paint: { 'fill-color': '#1d2326', 'fill-opacity': 0.5 } });
    ids.push(`${P}mask`);
    add({ id: 'paper', type: 'fill', source: `${P}boundary`, paint: { 'fill-color': PAPER, 'fill-opacity': 1 } }, 'land', ['fill-opacity', 1]);

    // land use
    add({ id: 'zones', type: 'fill', source: `${P}zones`, paint: { 'fill-color': colour as any, 'fill-opacity': 0.92 } }, 'land', ['fill-opacity', 0.92], true);
    plan.legend
      .filter((l) => l.pattern)
      .forEach((l) =>
        add(
          { id: `pat-${l.key}`, type: 'fill', source: `${P}zones`, filter: ['==', ['get', 'lu'], l.key], paint: { 'fill-pattern': `${P}pat-${l.pattern}`, 'fill-opacity': 0.9 } },
          'land',
          ['fill-opacity', 0.9],
          true,
        ),
      );
    add({ id: 'blocks', type: 'fill', source: `${P}blocks`, paint: { 'fill-color': colour as any, 'fill-opacity': 1 } }, 'land', ['fill-opacity', 1], true);
    add(
      { id: 'blocks-line', type: 'line', source: `${P}blocks`, minzoom: 11.5, paint: { 'line-color': INK, 'line-opacity': ['interpolate', ['linear'], ['zoom'], 11.5, 0, 13, 0.45], 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.2, 16, 0.9] } },
      'parcels',
      ['line-opacity', 1],
      true,
    );
    // ponds and the rural greenways are zone polygons; the river line sits on top of everything green
    add({ id: 'river-casing', type: 'line', source: `${P}river`, layout: { 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-opacity': 0.8, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 3, 15, 16] } }, 'green', ['line-opacity', 0.8]);
    add({ id: 'river', type: 'line', source: `${P}river`, layout: { 'line-cap': 'round' }, paint: { 'line-color': '#2a8ac0', 'line-opacity': 0.95, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.5, 15, 9] } }, 'green', ['line-opacity', 0.95]);
    add({ id: 'greenways', type: 'line', source: `${P}greenways`, layout: { 'line-cap': 'round' }, paint: { 'line-color': '#2f8f4a', 'line-opacity': 0.9, 'line-dasharray': [0.1, 2], 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.5, 15, 5] } }, 'green', ['line-opacity', 0.9]);

    // airport
    add({ id: 'airport', type: 'fill', source: `${P}airport`, paint: { 'fill-color': '#4b4f55', 'fill-opacity': 0.95 } }, 'land', ['fill-opacity', 0.95]);

    // streets: casing then fill, by class
    const w = (a: number, b: number) => ['interpolate', ['linear'], ['zoom'], 9, a, 16, b] as any;
    const cls = (c: string) => ['==', ['get', 'cls'], c] as any;
    add({ id: 'regional-casing', type: 'line', source: `${P}roads`, filter: cls('regional'), paint: { 'line-color': PAPER, 'line-opacity': 0.9, 'line-width': w(3, 9) } }, 'streets', ['line-opacity', 0.9]);
    add({ id: 'regional', type: 'line', source: `${P}roads`, filter: cls('regional'), paint: { 'line-color': INK, 'line-opacity': 0.8, 'line-width': w(1, 4) } }, 'streets', ['line-opacity', 0.8]);
    add({ id: 'collector', type: 'line', source: `${P}roads`, minzoom: 12, filter: cls('collector'), paint: { 'line-color': '#77705f', 'line-opacity': 0.7, 'line-width': w(0.4, 2) } }, 'streets', ['line-opacity', 0.7]);
    add({ id: 'arterial-casing', type: 'line', source: `${P}roads`, filter: ['in', ['get', 'cls'], ['literal', ['arterial', 'ring']]], paint: { 'line-color': PAPER, 'line-opacity': 0.95, 'line-width': w(3.5, 14) } }, 'streets', ['line-opacity', 0.95]);
    add({ id: 'arterial', type: 'line', source: `${P}roads`, filter: ['in', ['get', 'cls'], ['literal', ['arterial', 'ring']]], paint: { 'line-color': INK, 'line-opacity': 0.9, 'line-width': w(1.2, 6) } }, 'streets', ['line-opacity', 0.9]);

    // transit
    add({ id: 'transit-casing', type: 'line', source: `${P}transit`, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-opacity': 0.95, 'line-width': w(4, 14) } }, 'transit', ['line-opacity', 0.95]);
    add({ id: 'transit', type: 'line', source: `${P}transit`, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-opacity': 1, 'line-width': w(2, 8) } }, 'transit', ['line-opacity', 1]);
    add(
      {
        id: 'stations',
        type: 'circle',
        source: `${P}stations`,
        minzoom: 11,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, ['case', ['get', 'hub'], 4, 2], 16, ['case', ['get', 'hub'], 10, 6]],
          'circle-color': '#ffffff',
          'circle-stroke-color': ['get', 'color'],
          'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11, 1, 16, 2.5],
          'circle-opacity': 1,
          'circle-stroke-opacity': 1,
        },
      },
      'transit',
      ['circle-opacity', 1],
    );

    // neighbourhood hubs and numbered projects
    add(
      { id: 'hubs', type: 'circle', source: `${P}hubs`, minzoom: 12.5, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 12.5, 2.5, 16, 7], 'circle-color': '#ffffff', 'circle-stroke-color': '#1f4fa8', 'circle-stroke-width': 1.6, 'circle-opacity': 1, 'circle-stroke-opacity': 1 } },
      'projects',
      ['circle-opacity', 1],
    );
    add({ id: 'poi', type: 'circle', source: `${P}pois`, paint: { 'circle-radius': 11, 'circle-color': '#16213e', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2, 'circle-opacity': 1, 'circle-stroke-opacity': 1 } }, 'projects', ['circle-opacity', 1]);
    add(
      { id: 'poi-num', type: 'symbol', source: `${P}pois`, layout: { 'text-field': ['to-string', ['get', 'num']], 'text-font': ['Noto Sans Bold'], 'text-size': 11, 'text-allow-overlap': true, 'text-ignore-placement': true }, paint: { 'text-color': '#ffffff', 'text-opacity': 1 } },
      'projects',
      ['text-opacity', 1],
    );

    // names
    add(
      {
        id: 'labels',
        type: 'symbol',
        source: `${P}labels`,
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['case', ['get', 'italic'], ['literal', ['Noto Sans Italic']], ['==', ['get', 'rank'], 1], ['literal', ['Noto Sans Bold']], ['literal', ['Noto Sans Regular']]] as any,
          'text-size': ['interpolate', ['linear'], ['zoom'], 9, ['case', ['==', ['get', 'rank'], 1], 11, 0], 12, ['case', ['==', ['get', 'rank'], 1], 14, 11], 15, ['case', ['==', ['get', 'rank'], 1], 18, 14]],
          'text-letter-spacing': ['case', ['==', ['get', 'rank'], 1], 0.12, 0.02],
          'text-max-width': 9,
          'text-allow-overlap': false,
          'text-padding': 4,
          'symbol-sort-key': ['get', 'rank'],
        },
        paint: { 'text-color': ['case', ['get', 'italic'], '#f4f1e6', INK], 'text-halo-color': ['case', ['get', 'italic'], 'rgba(20,50,35,.65)', 'rgba(243,238,225,.9)'], 'text-halo-width': 1.6, 'text-opacity': 1 },
      },
      'labels',
      ['text-opacity', 1],
    );

    // city limit, drawn like a plan: a dashed black line with a pale halo
    add({ id: 'limit-halo', type: 'line', source: `${P}boundary`, paint: { 'line-color': '#ffffff', 'line-width': 5, 'line-opacity': 0.8 } }, 'land', ['line-opacity', 0.8]);
    add({ id: 'limit', type: 'line', source: `${P}boundary`, paint: { 'line-color': '#111111', 'line-width': 1.8, 'line-dasharray': [6, 2, 1, 2] } }, 'land');

    // fit the city under the panel
    const b = boundsOf(polys);
    if (b && !new URLSearchParams(window.location.search).has('z')) {
      map.fitBounds(b, { padding: window.innerWidth > 900 ? { left: 410, right: 30, top: 50, bottom: 40 } : 30, duration: 0 });
    }

    // click for details
    const clickable = ['poi', 'stations', 'hubs', 'blocks', 'zones'].map((n) => P + n);
    const onClick = (e: maplibregl.MapMouseEvent) => {
      const f = map.queryRenderedFeatures(e.point, { layers: clickable })[0];
      if (!f) return;
      const p = f.properties as any;
      let html = '';
      if (p.kind === 'poi') html = `<strong>${p.num}. ${p.name}</strong><br/><span style="opacity:.7">${p.cat}</span><br/>${p.desc}`;
      else if (p.kind === 'station') html = `<strong>Station ${p.name}</strong><br/>${plan.features.find((x) => x.properties.kind === 'transit' && x.properties.line === p.line)?.properties.name ?? ''}`;
      else if (p.kind === 'hub') html = `<strong>Neighbourhood hub</strong><br/>School, health centre, public market and evacuation shelter, within an 800 m walk of nearly every home in its block cluster.`;
      else {
        const l = plan.legend.find((x) => x.key === p.lu);
        if (!l) return;
        html = `<strong>${l.label}</strong><br/>${l.desc}`;
      }
      popup.current?.remove();
      popup.current = new maplibregl.Popup({ maxWidth: '280px' }).setLngLat(e.lngLat).setHTML(`<div style="font-size:12.5px;line-height:1.45;color:#1d2a2e">${html}</div>`).addTo(map);
    };
    const over = () => (map.getCanvas().style.cursor = 'pointer');
    const out = () => (map.getCanvas().style.cursor = '');
    map.on('click', onClick);
    clickable.forEach((l) => {
      map.on('mouseenter', l, over);
      map.on('mouseleave', l, out);
    });

    return () => {
      popup.current?.remove();
      map.off('click', onClick);
      clickable.forEach((l) => {
        map.off('mouseenter', l, over);
        map.off('mouseleave', l, out);
      });
      [...ids].reverse().forEach((l) => map.getLayer(l) && map.removeLayer(l));
      sources.forEach((s) => map.getSource(s) && map.removeSource(s));
      images.forEach((i) => map.hasImage(i) && map.removeImage(i));
    };
  }, [map, plan]);

  // controls -> map
  useEffect(() => {
    fades.current.forEach(([id, prop, base]) => map.getLayer(id) && map.setPaintProperty(id, prop, base * (opacity / 100)));
  }, [opacity, map, plan]);
  useEffect(() => {
    (Object.keys(groups) as Group[]).forEach((g) => layersByGroup.current[g].forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', groups[g] ? 'visible' : 'none')));
  }, [groups, map, plan]);
  useEffect(() => {
    const keep = plan ? plan.legend.map((l) => l.key).filter((k) => !hidden.has(k)) : [];
    const f: any = ['in', ['get', 'lu'], ['literal', keep]];
    classLayers.current.forEach((id) => {
      if (!map.getLayer(id)) return;
      // pattern layers keep their own class test; the others only get the visibility test
      const own = ownFilters.current[id];
      map.setFilter(id, own ? ['all', own, f] : f);
    });
  }, [hidden, map, plan]);

  const groupsOfLegend = useMemo(() => {
    const o: Record<string, LegendItem[]> = {};
    plan?.legend.forEach((l) => (o[l.group] = [...(o[l.group] ?? []), l]));
    return o;
  }, [plan]);
  const projects = useMemo(
    () =>
      (plan?.features ?? [])
        .filter((f) => f.properties.kind === 'poi')
        .map((f) => ({ num: f.properties.num as number, name: f.properties.name as string, cat: f.properties.cat as string, ll: f.geometry.coordinates as [number, number], desc: f.properties.desc as string })),
    [plan],
  );
  const s = plan?.stats;
  const toggle = (k: string) =>
    setHidden((h) => {
      const n = new Set(h);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });
  const fly = (p: { ll: [number, number]; name: string; desc: string; num: number; cat: string }) => {
    map.flyTo({ center: p.ll, zoom: p.cat === 'Protected' || p.cat === 'Energy' || p.cat === 'Utilities' ? 12 : 13.2, duration: 1100 });
    popup.current?.remove();
    popup.current = new maplibregl.Popup({ maxWidth: '280px' })
      .setLngLat(p.ll)
      .setHTML(`<div style="font-size:12.5px;line-height:1.45;color:#1d2a2e"><strong>${p.num}. ${p.name}</strong><br/><span style="opacity:.7">${p.cat}</span><br/>${p.desc}</div>`)
      .addTo(map);
  };

  const rowStyle = { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', cursor: 'pointer' } as const;

  return (
    <>
      <div style={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 3, pointerEvents: 'none', background: 'rgba(17,24,39,.82)', color: '#fff', padding: '5px 12px', borderRadius: 6, fontSize: 12, whiteSpace: 'nowrap' }}>
        AI-generated concept plan · not a survey · not an official zoning map
      </div>

      <div className="legend wide" style={{ width: 380, maxWidth: 380 }}>
        <h4>Butuan 2050 · Site Development Plan</h4>
        <p className="muted" style={{ margin: '0 0 6px' }}>
          One prompt to an AI planner, one city boundary, one plan. Click any block, station or numbered project.
        </p>
        {error && (
          <p className="warn">
            Plan data missing. Run <code>python pipeline/10_site_plan.py</code> to create <code>public/data/day10-plan.geojson</code>.
          </p>
        )}
        {!plan && !error && <p className="muted">Loading the plan…</p>}

        {plan && s && (
          <>
            <div className="legend-row" style={{ display: 'block', cursor: 'default' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Plan opacity (fade to see the real map)</span>
                <strong>{opacity}%</strong>
              </div>
              <input className="range" type="range" min={0} max={100} step={5} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} aria-label="Opacity of the plan" />
            </div>

            <p className="sub">Layers</p>
            {GROUPS.map((g) => (
              <label key={g.id} className="legend-row">
                <input type="checkbox" checked={groups[g.id]} onChange={() => setGroups((x) => ({ ...x, [g.id]: !x[g.id] }))} />
                <span style={{ flex: 1 }}>{g.label}</span>
              </label>
            ))}

            <p className="sub">Land use (click to show or hide)</p>
            {Object.entries(groupsOfLegend).map(([g, items]) => (
              <div key={g}>
                <div className="muted" style={{ margin: '6px 0 1px', fontSize: 11 }}>
                  {g}
                </div>
                {items.map((l) => {
                  const off = hidden.has(l.key);
                  const area = s.class_ha[l.key];
                  return (
                    <div key={l.key} style={{ ...rowStyle, opacity: off ? 0.4 : 1 }} onClick={() => toggle(l.key)} role="button" aria-pressed={!off} title={l.desc}>
                      <i style={{ width: 16, height: 11, borderRadius: 2, background: l.color, border: '1px solid rgba(0,0,0,.35)', flex: 'none' }} />
                      <span style={{ flex: 1, fontSize: 12.5 }}>{l.label}</span>
                      <span className="muted" style={{ fontSize: 11 }}>
                        {area ? `${num(area)} ha` : ''}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}

            <p className="sub">Transit and streets</p>
            <div style={{ fontSize: 12.5, lineHeight: 1.6 }}>
              {[['#d6313b', 'L1 East–West'], ['#1769c4', 'L2 North–South'], ['#7a3fb0', 'L3 North-east'], ['#1b9a59', 'L4 Orbital bus']].map(([c, n]) => (
                <span key={n} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginRight: 12 }}>
                  <i style={{ width: 18, height: 4, background: c, borderRadius: 2 }} />
                  {n}
                </span>
              ))}
              <br />
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginRight: 12 }}>
                <i style={{ width: 18, height: 3, background: INK }} />
                Arterial and loop road
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <i style={{ width: 18, height: 2, background: '#77705f' }} />
                Collector
              </span>
            </div>

            <p className="sub">Does the plan keep its promises?</p>
            <p className="muted" style={{ margin: '0 0 4px' }}>
              Measured from the generated geometry, in straight lines. Targets are the brief, not guarantees.
            </p>
            <div className="kv">
              <span>Urban area, share of the city</span>
              <span>{num(s.urban_ha)} ha · {s.urban_pct}%</span>
              <span>Protected forest and mangrove</span>
              <span>{s.protected_pct}%</span>
              <span>Farm belt kept as farmland</span>
              <span>{s.farm_pct}%</span>
              <span>Green and blue land inside the urban area</span>
              <span>{s.green_urban_pct}%</span>
              <span>Homes within 800 m of a neighbourhood hub</span>
              <span>{s.walk_hub_pct}%</span>
              <span>Homes within 800 m of a transit station</span>
              <span>{s.walk_station_pct}%</span>
              <span>Homes within 400 m of a park</span>
              <span>{s.walk_park_pct}%</span>
              <span>Transit lines · stations</span>
              <span>{s.transit_km} km · {s.stations}</span>
              <span>Solar land (assumed yield)</span>
              <span>{num(s.solar_ha)} ha · ~{num(s.solar_mwp)} MWp</span>
              <span>Capacity at assumed densities</span>
              <span>~{num(s.capacity_persons)} people</span>
            </div>
            <p className="muted" style={{ margin: '6px 0 0', fontSize: 11.5 }}>
              Station access is the weakest number: only part of the urban area sits within 800 m of the four lines, so a real plan would add feeder buses and a fifth line.
            </p>

            <p className="sub">Project key (click to fly there)</p>
            <ul className="list">
              {projects.map((p) => (
                <li key={p.num} onClick={() => fly(p)}>
                  <div className="row">
                    <span>
                      <strong>{p.num}</strong> · {p.name}
                    </span>
                    <span className="muted">{p.cat}</span>
                  </div>
                </li>
              ))}
            </ul>

            <details>
              <summary>Made by prompt</summary>
              <p className="muted" style={{ margin: '6px 0 4px' }}>
                The whole plan came from this one prompt. An AI assistant read the boundary file, then wrote the planning brief, the land-use classes, the street grid generator (<code>pipeline/10_site_plan.py</code>) and this page:
              </p>
              <blockquote style={{ margin: '0 0 6px', padding: '4px 10px', borderLeft: '3px solid var(--accent)', fontSize: 12, lineHeight: 1.45 }}>{PROMPT}</blockquote>
              <p className="muted" style={{ margin: '0 0 4px' }}>
                What the AI decided: a compact core, five town centres on four transit lines, a farm belt and protected forest, a river corridor with retention ponds, three solar farms and a circular-economy park. Fifteen-minute neighbourhoods follow from a 1 km superblock with one hub each.
              </p>
              <p className="muted" style={{ margin: 0 }}>
                Limits: no terrain, flood, soil, land-ownership or hazard data went in, only the boundary. Downtown and the airport use approximate real positions; the river alignment, zoning outside the urban area and every project site are invented. Use it as a conversation starter, not as a plan.
              </p>
              <ul style={{ margin: '6px 0 0' }}>
                {s.assumptions.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </details>

            <p className="muted" style={{ marginTop: 8, fontSize: 11 }}>
              City boundary: OpenStreetMap contributors (ODbL). Plan: AI-generated by script on {plan.meta.generated}.
            </p>
          </>
        )}
      </div>

      {/* title block, as on a drawing sheet */}
      <div style={{ position: 'absolute', right: 12, bottom: 36, zIndex: 3, width: 250, background: PAPER, color: INK, border: '1.5px solid #111', fontSize: 11, lineHeight: 1.35, boxShadow: '0 2px 8px rgba(0,0,0,.25)', pointerEvents: 'none' }}>
        <div style={{ display: 'flex', borderBottom: '1px solid #111' }}>
          <div style={{ flex: 1, padding: '6px 8px' }}>
            <div style={{ fontWeight: 700, fontSize: 12.5, letterSpacing: '.04em' }}>BUTUAN 2050</div>
            <div>Site Development Plan</div>
            <div style={{ opacity: 0.7 }}>Concept master plan</div>
          </div>
          <div style={{ width: 54, borderLeft: '1px solid #111', display: 'grid', placeItems: 'center' }}>
            <svg width="34" height="40" viewBox="0 0 34 40" aria-label="North arrow">
              <polygon points="17,3 26,34 17,27 8,34" fill="#111" />
              <polygon points="17,3 17,27 8,34" fill="#fff" stroke="#111" strokeWidth="1" />
              <text x="17" y="14" textAnchor="middle" fontSize="0" />
            </svg>
          </div>
        </div>
        <div style={{ padding: '4px 8px', borderBottom: '1px solid #111' }}>Prepared by: an AI planner, from one prompt</div>
        <div style={{ display: 'flex' }}>
          <div style={{ flex: 1, padding: '4px 8px', borderRight: '1px solid #111' }}>#30DayMapChallenge 2026 · Day 10</div>
          <div style={{ padding: '4px 8px' }}>Not to be used for construction</div>
        </div>
      </div>
    </>
  );
}
