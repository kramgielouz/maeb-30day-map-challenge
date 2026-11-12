import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { boundsOf, inverseMask, polygonsOf } from '../../core/geo';

// Day 11, Senses: Sound. "Hear the heat": land surface temperature (Landsat) turned into pitch.
// Pick a line across the city, press play, and a note follows it: hotter ground sounds higher and brighter,
// and a steady drone sits at the temperature of the surrounding countryside, so the gap between the two notes
// is the urban heat island. All sound is synthesized in the browser with the Web Audio API (no audio files).
// Data: pipeline/11_heat.py (reads the export from gee/day11_lst_export.js). Without that export it writes a
// clearly flagged synthetic demo, and this page shows a banner while the demo is loaded.
// The Record button plays the line once and saves a video file (map, chart, title and the sound).
const P = 'd11-';
const HEAT_URL = '/data/day11-heat.json';
const BOUNDARY_URL = '/data/butuan-boundary.geojson';

const LON0 = 125.5406;
const LAT0 = 8.9475;
const KX = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const KY = 110950;
const toX = (lon: number) => (lon - LON0) * KX;
const toY = (lat: number) => (lat - LAT0) * KY;

const LST_STOPS: [number, string][] = [[25, '#313695'], [29, '#74add1'], [33, '#ffffbf'], [37, '#fdae61'], [41, '#d73027'], [45, '#7f0000']];
const UHI_STOPS: [number, string][] = [[-4, '#2166ac'], [-1, '#92c5de'], [0, '#f7f7f7'], [2, '#fddbc7'], [5, '#ef8a62'], [8, '#b2182b'], [11, '#67001f']];
const ramp = (stops: [number, string][]) => `linear-gradient(90deg, ${stops.map(([v, c]) => `${c} ${((v - stops[0][0]) / (stops[stops.length - 1][0] - stops[0][0])) * 100}%`).join(', ')})`;
const COL_A = '#c0392b';
const COL_B = '#2471a3';

type Metric = 'lst' | 'uhi';
type Pt = [number, number];
const PRESETS: { id: string; label: string; desc: string; line: Pt[] }[] = [
  { id: 'we', label: 'West → East', desc: 'Bancasi airport, downtown, then the eastern edge', line: [[125.4788, 8.9515], [125.5406, 8.9475], [125.585, 8.953], [125.633, 8.928]] },
  { id: 'ns', label: 'North → South', desc: 'The bay side, downtown, then the southern town', line: [[125.505, 8.99], [125.5406, 8.9475], [125.553, 8.91], [125.565, 8.836]] },
];

interface Heat {
  meta: { synthetic: boolean; years: number[]; season: string; grid_m: number; ref: Record<string, number>; ref_method: string[]; generated: string; source: string };
  pts: (number | null)[][]; // [lon, lat, lst per year...]
}
interface Cell {
  x: number;
  y: number;
  lon: number;
  lat: number;
  v: (number | null)[];
}
interface Samples {
  dist: number[]; // km along the line
  lon: number[];
  lat: number[];
  v: (number | null)[][]; // per year index
}

// ---------- sound ----------
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const freqOf = (t: number, snap: boolean) => 220 * Math.pow(2, ((snap ? Math.round(t * 2) / 2 : t) - 28) / 6); // 28 °C = A3, one octave per 6 °C
const noteName = (f: number) => {
  const m = Math.round(69 + 12 * Math.log2(f / 440));
  return `${NOTES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
};

type Scale = 'pmaj' | 'pmin' | 'glide';
const SCALES: Record<Exclude<Scale, 'glide'>, number[]> = { pmaj: [0, 2, 4, 7, 9], pmin: [0, 3, 5, 7, 10] }; // pitch classes above the root A
// pitch of a temperature: a free glide, or the nearest note of an A pentatonic scale (same octave-per-6-degrees line)
const pitch = (t: number, scale: Scale) => {
  if (scale === 'glide') return freqOf(t, false);
  const mid = 57 + (12 * (t - 28)) / 6; // A3 = MIDI 57 = 28 °C
  let best = Math.round(mid);
  let dist = 99;
  for (let m = Math.round(mid) - 3; m <= Math.round(mid) + 3; m++) {
    if (!SCALES[scale].includes((((m - 9) % 12) + 12) % 12)) continue;
    if (Math.abs(m - mid) < dist) {
      dist = Math.abs(m - mid);
      best = m;
    }
  }
  return 440 * Math.pow(2, (best - 69) / 12);
};

interface Voice {
  o1: OscillatorNode;
  o2: OscillatorNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  pan: StereoPannerNode;
}
class Synth {
  ctx: AudioContext;
  master: GainNode;
  send: GainNode;
  dest: MediaStreamAudioDestinationNode; // a copy of the output, for the video recorder
  voices: Voice[] = [];
  constructor(n: number) {
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    const comp = this.ctx.createDynamicsCompressor();
    this.master.connect(comp);
    comp.connect(this.ctx.destination);
    this.dest = this.ctx.createMediaStreamDestination();
    comp.connect(this.dest);
    // a small room: generated noise that fades away over ~2.4 s
    const len = Math.floor(this.ctx.sampleRate * 2.4);
    const ir = this.ctx.createBuffer(2, len, this.ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
    }
    const conv = this.ctx.createConvolver();
    conv.buffer = ir;
    const wet = this.ctx.createGain();
    wet.gain.value = 0.32;
    this.send = this.ctx.createGain();
    this.send.connect(conv);
    conv.connect(wet);
    wet.connect(this.master);
    for (let i = 0; i < n; i++) {
      const o1 = this.ctx.createOscillator();
      const o2 = this.ctx.createOscillator();
      o1.type = 'triangle';
      o2.type = i >= 2 ? 'sine' : 'sawtooth';
      const mix2 = this.ctx.createGain();
      mix2.gain.value = i >= 2 ? 0 : 0.35;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.Q.value = 0.7;
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      const pan = this.ctx.createStereoPanner();
      o1.connect(filter);
      o2.connect(mix2);
      mix2.connect(filter);
      filter.connect(gain);
      gain.connect(pan);
      pan.connect(this.master);
      if (i >= 2) pan.connect(this.send); // the chord under the melody sits in the room
      o1.start();
      o2.start();
      this.voices.push({ o1, o2, filter, gain, pan });
    }
  }
  resume() {
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }
  volume(v: number) {
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
  }
  set(i: number, freq: number, cutoff: number, detune: number, level: number, pan: number) {
    const v = this.voices[i];
    const t = this.ctx.currentTime;
    v.o1.frequency.setTargetAtTime(freq, t, 0.04);
    v.o2.frequency.setTargetAtTime(freq, t, 0.04);
    v.o2.detune.setTargetAtTime(detune, t, 0.08);
    v.filter.frequency.setTargetAtTime(cutoff, t, 0.05);
    v.gain.gain.setTargetAtTime(level, t, 0.03);
    v.pan.pan.setTargetAtTime(pan, t, 0.05);
  }
  // one soft plucked note: triangle plus a quiet octave, a detuned twin for warmth, a filter that closes as it fades
  pluck(freq: number, level: number, pan: number, detuneCents: number, cutoff: number, when: number) {
    const c = this.ctx;
    const t0 = Math.max(when, c.currentTime);
    const out = c.createGain();
    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.5;
    filter.frequency.setValueAtTime(cutoff, t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(300, cutoff * 0.25), t0 + 0.9);
    const p = c.createStereoPanner();
    p.pan.value = pan;
    out.gain.setValueAtTime(0.0001, t0);
    out.gain.exponentialRampToValueAtTime(level, t0 + 0.008);
    out.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.1);
    const mk = (type: OscillatorType, f: number, det: number, g: number) => {
      const o = c.createOscillator();
      const og = c.createGain();
      o.type = type;
      o.frequency.value = f;
      o.detune.value = det;
      og.gain.value = g;
      o.connect(og);
      og.connect(filter);
      o.start(t0);
      o.stop(t0 + 1.2);
    };
    mk('triangle', freq, 0, 1);
    mk('triangle', freq, detuneCents, 0.6);
    mk('sine', freq * 2, 0, 0.25);
    filter.connect(out);
    out.connect(p);
    p.connect(this.master);
    p.connect(this.send);
  }
  hush(i?: number) {
    this.voices.forEach((v, k) => (i === undefined || i === k) && v.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05));
  }
  dispose() {
    this.voices.forEach((v) => {
      try {
        v.o1.stop();
        v.o2.stop();
      } catch {
        /* already stopped */
      }
    });
    void this.ctx.close();
  }
}

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const squares = (cells: Cell[], v: (c: Cell) => number | null, half: number) => {
  const dx = half / KX;
  const dy = half / KY;
  return {
    type: 'FeatureCollection',
    features: cells.flatMap((c) => {
      const val = v(c);
      if (val === null) return [];
      return [{ type: 'Feature', properties: { v: val }, geometry: { type: 'Polygon', coordinates: [[[c.lon - dx, c.lat - dy], [c.lon + dx, c.lat - dy], [c.lon + dx, c.lat + dy], [c.lon - dx, c.lat + dy], [c.lon - dx, c.lat - dy]]] } }];
    }),
  } as any;
};

export default function Day11({ map }: { map: maplibregl.Map }) {
  const [heat, setHeat] = useState<Heat | null>(null);
  const [error, setError] = useState(false);
  const [ready, setReady] = useState(false);
  const [yearA, setYearA] = useState(2);
  const [yearB, setYearB] = useState<number | null>(null);
  const [metric, setMetric] = useState<Metric>('lst');
  const [preset, setPreset] = useState('we');
  const [custom, setCustom] = useState<Pt[] | null>(null);
  const [drawing, setDrawing] = useState<Pt[] | null>(null);
  const [playing, setPlaying] = useState(false);
  const [recording, setRecording] = useState(false);
  const [scale, setScale] = useState<Scale>('pmaj');
  const [drone, setDrone] = useState(true);
  const [loop, setLoop] = useState(false);
  const [volume, setVolume] = useState(60);
  const [seconds, setSeconds] = useState(20);
  const [probe, setProbe] = useState<{ t: number; lon: number; lat: number } | null>(null);

  const synth = useRef<Synth | null>(null);
  const tRef = useRef(0);
  const raf = useRef(0);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const drag = useRef(false);
  const probeTimer = useRef(0);
  const rec = useRef<{
    mr: MediaRecorder;
    chunks: Blob[];
    timer: number;
    draw: () => void;
    armed: boolean;
    discard: boolean;
  } | null>(null);

  useEffect(() => {
    let off = false;
    fetch(HEAT_URL)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j) => !off && setHeat(j))
      .catch(() => !off && setError(true));
    return () => {
      off = true;
    };
  }, []);

  const years = heat?.meta.years ?? [];
  const grid = heat?.meta.grid_m ?? 500;
  const cells: Cell[] = useMemo(() => (heat ? heat.pts.map((p) => ({ lon: p[0] as number, lat: p[1] as number, x: toX(p[0] as number), y: toY(p[1] as number), v: p.slice(2) as (number | null)[] })) : []), [heat]);
  const buckets = useMemo(() => {
    const m = new Map<string, Cell[]>();
    cells.forEach((c) => {
      const k = `${Math.floor(c.x / grid)},${Math.floor(c.y / grid)}`;
      (m.get(k) ?? m.set(k, []).get(k)!).push(c);
    });
    return m;
  }, [cells, grid]);

  // inverse-distance value of one year at a point, from the cells within ~1.2 grid steps
  const valueAt = (lon: number, lat: number, yi: number): number | null => {
    const x = toX(lon);
    const y = toY(lat);
    const bx = Math.floor(x / grid);
    const by = Math.floor(y / grid);
    let sw = 0;
    let s = 0;
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        for (const c of buckets.get(`${bx + i},${by + j}`) ?? []) {
          const v = c.v[yi];
          if (v === null || v === undefined) continue;
          const d = Math.hypot(c.x - x, c.y - y);
          if (d > grid * 1.2) continue;
          const w = 1 / Math.max(60, d) ** 2;
          sw += w;
          s += w * v;
        }
    return sw > 0 ? s / sw : null;
  };

  const line: Pt[] = preset === 'custom' && custom ? custom : (PRESETS.find((p) => p.id === preset) ?? PRESETS[0]).line;
  const samples: Samples | null = useMemo(() => {
    if (!heat) return null;
    const step = 200;
    const out: Samples = { dist: [], lon: [], lat: [], v: years.map(() => []) };
    let travelled = 0;
    for (let i = 0; i < line.length - 1; i++) {
      const [x1, y1] = [toX(line[i][0]), toY(line[i][1])];
      const [x2, y2] = [toX(line[i + 1][0]), toY(line[i + 1][1])];
      const len = Math.hypot(x2 - x1, y2 - y1);
      const n = Math.max(1, Math.round(len / step));
      for (let k = i === 0 ? 0 : 1; k <= n; k++) {
        const f = k / n;
        const lon = line[i][0] + (line[i + 1][0] - line[i][0]) * f;
        const lat = line[i][1] + (line[i + 1][1] - line[i][1]) * f;
        out.dist.push((travelled + len * f) / 1000);
        out.lon.push(lon);
        out.lat.push(lat);
        years.forEach((_, yi) => out.v[yi].push(valueAt(lon, lat, yi)));
      }
      travelled += len;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heat, line, buckets]);

  // everything the animation loop and the canvas need, kept in one ref so handlers never go stale
  const cfg = useRef({ samples, yearA, yearB, scale, drone, volume, seconds, loop, heat, metric });
  cfg.current = { samples, yearA, yearB, scale, drone, volume, seconds, loop, heat, metric };

  const sampleAt = (t: number, yi: number): number | null => {
    const s = cfg.current.samples;
    if (!s || s.dist.length === 0) return null;
    const f = clamp(t, 0, 1) * (s.dist.length - 1);
    const i = Math.floor(f);
    const a = s.v[yi][i];
    const b = s.v[yi][Math.min(i + 1, s.dist.length - 1)];
    if (a === null || a === undefined) return b ?? null;
    if (b === null || b === undefined) return a;
    return a + (b - a) * (f - i);
  };
  const posAt = (t: number): Pt => {
    const s = cfg.current.samples!;
    const f = clamp(t, 0, 1) * (s.dist.length - 1);
    const i = Math.floor(f);
    const j = Math.min(i + 1, s.dist.length - 1);
    return [s.lon[i] + (s.lon[j] - s.lon[i]) * (f - i), s.lat[i] + (s.lat[j] - s.lat[i]) * (f - i)];
  };

  const draw = () => {
    const c = canvas.current;
    const { samples: s, yearA: a, yearB: b, heat: h } = cfg.current;
    if (!c || !s || !h || s.dist.length < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth;
    const H = c.clientHeight;
    if (c.width !== Math.round(W * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const L = 40, R = 10, T = 12, B = 22;
    const ref = h.meta.ref[String(h.meta.years[a])];
    const all = [a, ...(b !== null ? [b] : [])].flatMap((yi) => s.v[yi].filter((x): x is number => x !== null));
    const lo = Math.floor(Math.min(ref, ...all) - 1);
    const hi = Math.ceil(Math.max(ref, ...all) + 1);
    const total = s.dist[s.dist.length - 1];
    const X = (km: number) => L + (km / total) * (W - L - R);
    const Y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    g.font = '11px system-ui, sans-serif';
    g.fillStyle = '#4a5560';
    g.strokeStyle = 'rgba(0,0,0,.09)';
    g.lineWidth = 1;
    for (let v = Math.ceil(lo / 2) * 2; v <= hi; v += 2) {
      g.beginPath();
      g.moveTo(L, Y(v));
      g.lineTo(W - R, Y(v));
      g.stroke();
      g.textAlign = 'right';
      g.fillText(`${v}°`, L - 5, Y(v) + 4);
    }
    g.textAlign = 'center';
    for (let km = 0; km <= total; km += total > 20 ? 5 : 2) g.fillText(`${km} km`, X(km), H - 6);
    g.setLineDash([5, 4]);
    g.strokeStyle = '#6b7a86';
    g.beginPath();
    g.moveTo(L, Y(ref));
    g.lineTo(W - R, Y(ref));
    g.stroke();
    g.setLineDash([]);
    g.textAlign = 'left';
    g.fillStyle = '#6b7a86';
    g.fillText('rural reference', L + 4, Y(ref) - 4);
    const trace = (yi: number, col: string) => {
      g.strokeStyle = col;
      g.lineWidth = 2;
      g.beginPath();
      let pen = false;
      s.dist.forEach((d, i) => {
        const v = s.v[yi][i];
        if (v === null) {
          pen = false;
          return;
        }
        if (!pen) g.moveTo(X(d), Y(v));
        else g.lineTo(X(d), Y(v));
        pen = true;
      });
      g.stroke();
    };
    if (b !== null) trace(b, COL_B);
    trace(a, COL_A);
    // playhead
    const px = X(clamp(tRef.current, 0, 1) * total);
    g.strokeStyle = '#111';
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(px, T);
    g.lineTo(px, H - B);
    g.stroke();
    const va = sampleAt(tRef.current, a);
    if (va !== null) {
      g.fillStyle = COL_A;
      g.beginPath();
      g.arc(px, Y(va), 4, 0, 7);
      g.fill();
    }
    const vb = b !== null ? sampleAt(tRef.current, b) : null;
    if (vb !== null) {
      g.fillStyle = COL_B;
      g.beginPath();
      g.arc(px, Y(vb), 4, 0, 7);
      g.fill();
    }
  };

  // sound and marker for position t: the drone chord always, and the gliding voices when the scale is "glide"
  const voiceAt = (t: number) => {
    const sy = synth.current;
    const { yearA: a, yearB: b, scale: sc, drone: dr, heat: h } = cfg.current;
    if (!sy || !h) return;
    const ref = h.meta.ref[String(h.meta.years[a])];
    if (sc === 'glide') {
      const one = (idx: number, yi: number, pan: number) => {
        const v = sampleAt(t, yi);
        if (v === null) return sy.hush(idx);
        sy.set(idx, pitch(v, sc), 500 + clamp(v - 24, 0, 24) * 140, clamp(v - h.meta.ref[String(h.meta.years[yi])], 0, 12) * 5, 0.2, pan);
      };
      const pos = posAt(t);
      const centre = clamp((pos[0] - LON0) / 0.1, -1, 1) * 0.5;
      one(0, a, b !== null ? -0.8 : centre);
      if (b !== null) one(1, b, 0.8);
      else sy.hush(1);
    } else {
      sy.hush(0);
      sy.hush(1);
    }
    chord(sy, dr, ref, sc);
  };
  // the quiet chord at the rural reference: its note and the fifth above it
  const chord = (sy: Synth, on: boolean, ref: number, sc: Scale) => {
    if (!on) {
      sy.hush(2);
      sy.hush(3);
      return;
    }
    const root = pitch(ref, sc);
    sy.set(2, root, 900, 0, 0.07, -0.15);
    sy.set(3, root * 1.5, 800, 0, 0.04, 0.15);
  };
  // one beat of the tune: a plucked note for each year being heard
  const lastNote = useRef<number[]>([0, 0]);
  const pulse = (t: number, accent: boolean) => {
    const sy = synth.current;
    const { yearA: a, yearB: b, scale: sc, heat: h } = cfg.current;
    if (!sy || !h || sc === 'glide') return;
    const one = (slot: number, yi: number, pan: number) => {
      const v = sampleAt(t, yi);
      if (v === null) return;
      const f = pitch(v, sc);
      const uhi = v - h.meta.ref[String(h.meta.years[yi])];
      const same = Math.abs(f - lastNote.current[slot]) < 0.5;
      if (same && !accent) return; // a held note breathes: it only returns on the strong beats
      lastNote.current[slot] = f;
      const level = (accent ? 0.26 : 0.2) * (same ? 0.6 : 1) * (1 + clamp(uhi, 0, 10) / 25);
      const at = sy.ctx.currentTime + (slot === 1 ? 0.125 : 0.02); // the second year plays on the off-beat
      sy.pluck(f, level, pan, clamp(uhi, 0, 12) * 2.5, 1300 + clamp(v - 24, 0, 24) * 190, at);
      if (uhi > 6) sy.pluck(f * 2, level * 0.3, pan, 0, 5000, at); // strong heat adds a bright octave
    };
    const pos = posAt(t);
    one(0, a, b !== null ? -0.7 : clamp((pos[0] - LON0) / 0.1, -1, 1) * 0.5);
    if (b !== null) one(1, b, 0.7);
  };
  const move = (t: number, sound: boolean) => {
    tRef.current = clamp(t, 0, 1);
    if (!cfg.current.samples || cfg.current.samples.dist.length < 2) return;
    const src = map.getSource(`${P}play`) as maplibregl.GeoJSONSource | undefined;
    src?.setData({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: posAt(tRef.current) } } as any);
    if (sound) voiceAt(tRef.current);
    draw();
  };

  const ensureSynth = () => {
    if (!synth.current) synth.current = new Synth(4);
    synth.current.resume();
    synth.current.volume(cfg.current.volume / 100);
    return synth.current;
  };
  const stop = () => {
    cancelAnimationFrame(raf.current);
    setPlaying(false);
    synth.current?.hush();
  };
  const play = () => {
    ensureSynth();
    if (tRef.current >= 0.999) tRef.current = 0;
    setPlaying(true);
    let last = performance.now();
    let nextPulse = last;
    let beat = 0;
    lastNote.current = [0, 0];
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      let t = tRef.current + dt / cfg.current.seconds;
      if (t >= 1) {
        if (cfg.current.loop && !rec.current) t = 0; // a recording always ends at the end of the line
        else {
          move(1, true);
          pulse(1, true);
          setTimeout(stop, 1200);
          return;
        }
      }
      move(t, true);
      while (now >= nextPulse) {
        pulse(tRef.current, beat % 4 === 0);
        beat++;
        nextPulse += 250;
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  };
  const lastScrub = useRef({ at: 0, f: 0 });
  const scrubNote = (t: number) => {
    const sy = synth.current;
    const v = sampleAt(t, cfg.current.yearA);
    if (!sy || v === null || cfg.current.scale === 'glide') return;
    const f = pitch(v, cfg.current.scale);
    const now = performance.now();
    if (f !== lastScrub.current.f || now - lastScrub.current.at > 450) {
      lastScrub.current = { at: now, f };
      lastNote.current = [0, 0];
      pulse(t, true);
    }
  };

  // ---- video recording: map + chart + title + the sound, one pass along the line ----
  const cleanupRecording = () => {
    const r = rec.current;
    if (!r) return;
    map.off('render', r.draw);
    clearInterval(r.timer);
  };
  const stopRecording = () => {
    const r = rec.current;
    if (!r) return;
    stop();
    if (r.mr.state !== 'inactive') r.mr.stop(); // onstop saves the file
  };
  const startRecording = () => {
    if (rec.current || !cfg.current.samples || !cfg.current.heat) return;
    const sy = ensureSynth(); // started from a click, so the browser allows audio
    stop();
    const src = map.getCanvas();
    const off = document.createElement('canvas');
    off.width = src.width & ~1; // even dimensions suit video encoders
    off.height = src.height & ~1;
    const g = off.getContext('2d')!;

    const type = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1,opus', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t));
    if (!type || !('captureStream' in off)) {
      alert('This browser cannot record video from a canvas.');
      return;
    }
    const ext = type.startsWith('video/mp4') ? 'mp4' : 'webm';
    const stream: MediaStream = (off as any).captureStream(30);
    sy.dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    const mr = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 160_000 });
    const chunks: Blob[] = [];

    // Runs right after the map renders, while its WebGL buffer is still readable.
    const frame = () => {
      const { yearA: a, yearB: b, heat: h, metric: me } = cfg.current;
      if (!h) return;
      const k = off.width / src.clientWidth; // CSS pixels to video pixels
      g.fillStyle = '#000';
      g.fillRect(0, 0, off.width, off.height);
      g.drawImage(src, 0, 0, off.width, off.height);

      // the chart panel, in the place it has on screen
      const cv = canvas.current;
      if (cv) {
        const m = src.getBoundingClientRect();
        const r = cv.getBoundingClientRect();
        const x = (r.left - m.left) * k;
        const y = (r.top - m.top) * k;
        const w = r.width * k;
        const hh = r.height * k;
        g.fillStyle = 'rgba(255,255,255,.95)';
        g.fillRect(x - 4 * k, y - 4 * k, w + 8 * k, hh + 8 * k);
        g.drawImage(cv, x, y, w, hh);
        g.font = `700 ${Math.round(11.5 * k)}px system-ui, sans-serif`;
        g.textAlign = 'right';
        g.textBaseline = 'alphabetic';
        let tx = x + w - 8 * k;
        if (b !== null) {
          g.fillStyle = COL_B;
          g.fillText(`● ${h.meta.years[b]}`, tx, y + 10 * k);
          tx -= 56 * k;
        }
        g.fillStyle = COL_A;
        g.fillText(`● ${h.meta.years[a]}`, tx, y + 10 * k);
      }

      // title, years, and the colour key
      const fs = Math.round(off.width / 34);
      g.lineJoin = 'round';
      g.textAlign = 'left';
      g.textBaseline = 'alphabetic';
      g.fillStyle = '#fff';
      g.strokeStyle = 'rgba(0,0,0,.95)';
      g.font = `700 ${fs}px system-ui, sans-serif`;
      g.lineWidth = fs / 6;
      const title = `Hear the heat · ${h.meta.years[a]}${b !== null ? ` vs ${h.meta.years[b]}` : ''}`;
      g.strokeText(title, fs * 0.7, fs * 1.4);
      g.fillText(title, fs * 0.7, fs * 1.4);
      g.font = `${Math.round(fs * 0.55)}px system-ui, sans-serif`;
      g.lineWidth = fs / 10;
      const sub = me === 'lst' ? 'Land surface temperature (Landsat)' : 'Degrees above the rural reference';
      g.strokeText(sub, fs * 0.7, fs * 2.2);
      g.fillText(sub, fs * 0.7, fs * 2.2);
      const stops = me === 'lst' ? LST_STOPS : UHI_STOPS;
      const bw = off.width * 0.18;
      const bx = off.width - bw - fs * 0.7;
      const by = fs * 0.9;
      const gr = g.createLinearGradient(bx, 0, bx + bw, 0);
      stops.forEach(([v, c]) => gr.addColorStop((v - stops[0][0]) / (stops[stops.length - 1][0] - stops[0][0]), c));
      g.fillStyle = gr;
      g.fillRect(bx, by, bw, fs * 0.45);
      g.strokeStyle = 'rgba(255,255,255,.7)';
      g.lineWidth = 1;
      g.strokeRect(bx, by, bw, fs * 0.45);
      g.font = `${Math.round(fs * 0.5)}px system-ui, sans-serif`;
      g.fillStyle = '#fff';
      g.textAlign = 'left';
      g.fillText(`${stops[0][0]} °C`, bx, by + fs * 1.1);
      g.textAlign = 'right';
      g.fillText(`${stops[stops.length - 1][0]} °C`, bx + bw, by + fs * 1.1);
    };
    map.on('render', frame);
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
      a.download = `hear-the-heat-${cfg.current.heat?.meta.years[cfg.current.yearA] ?? ''}.${ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    };

    rec.current = { mr, chunks, timer, draw: frame, armed: false, discard: false };
    tRef.current = 0;
    move(0, false);
    mr.start();
    setRecording(true);
    // let the first frame sit for a moment, then play the line once
    setTimeout(() => {
      if (!rec.current) return;
      rec.current.armed = true;
      play();
    }, 700);
  };

  const latest = useRef({ play, stop, move, ensureSynth, voiceAt, draw, scrubNote, chord, pulse });
  latest.current = { play, stop, move, ensureSynth, voiceAt, draw, scrubNote, chord, pulse };

  // map layers
  useEffect(() => {
    if (!heat) return;
    let cancelled = false;
    const ids: string[] = [];
    const srcs: string[] = [];
    const addSrc = (id: string, data: any) => {
      map.addSource(P + id, { type: 'geojson', data });
      srcs.push(P + id);
    };
    const addLayer = (l: any) => {
      map.addLayer({ ...l, id: P + l.id });
      ids.push(P + l.id);
    };
    const empty = { type: 'FeatureCollection', features: [] } as any;
    fetch(BOUNDARY_URL)
      .then((r) => r.json())
      .then((gj) => {
        if (cancelled) return;
        const polys = polygonsOf(gj);
        addSrc('tiles', empty);
        addSrc('mask', inverseMask(polys));
        addSrc('line', empty);
        addSrc('draw', empty);
        addSrc('play', empty);
        addLayer({ id: 'tiles', type: 'fill', source: `${P}tiles`, paint: { 'fill-color': ['interpolate', ['linear'], ['get', 'v'], ...LST_STOPS.flat()] as any, 'fill-opacity': 0.88, 'fill-antialias': false } });
        // clean black basemap outside the city: opaque black everywhere except the boundary shape (the outline itself is not drawn)
        addLayer({ id: 'mask', type: 'fill', source: `${P}mask`, paint: { 'fill-color': '#000000', 'fill-opacity': 1, 'fill-antialias': false } });
        addLayer({ id: 'line-casing', type: 'line', source: `${P}line`, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#000000', 'line-width': 6, 'line-opacity': 0.7 } });
        addLayer({ id: 'line', type: 'line', source: `${P}line`, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 2.5, 'line-dasharray': [1.5, 1.5] } });
        addLayer({ id: 'draw', type: 'circle', source: `${P}draw`, paint: { 'circle-radius': 6, 'circle-color': '#ffd60a', 'circle-stroke-color': '#000', 'circle-stroke-width': 2 } });
        addLayer({ id: 'play-halo', type: 'circle', source: `${P}play`, paint: { 'circle-radius': 15, 'circle-color': '#ffffff', 'circle-opacity': 0.35 } });
        addLayer({ id: 'play', type: 'circle', source: `${P}play`, paint: { 'circle-radius': 7, 'circle-color': '#111111', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 } });
        const b = boundsOf(polys);
        if (b && !new URLSearchParams(window.location.search).has('z')) map.fitBounds(b, { padding: window.innerWidth > 900 ? { left: 410, right: 30, top: 50, bottom: 210 } : 30, duration: 0 });
        setReady(true);
      })
      .catch(() => !cancelled && setError(true));
    return () => {
      cancelled = true;
      setReady(false);
      [...ids].reverse().forEach((l) => map.getLayer(l) && map.removeLayer(l));
      srcs.forEach((s) => map.getSource(s) && map.removeSource(s));
    };
  }, [map, heat]);

  // colour the tiles for the chosen year and measure
  useEffect(() => {
    if (!ready || !heat) return;
    const ref = heat.meta.ref[String(years[yearA])];
    const stops = metric === 'lst' ? LST_STOPS : UHI_STOPS;
    map.setPaintProperty(`${P}tiles`, 'fill-color', ['interpolate', ['linear'], ['get', 'v'], ...stops.flat()] as any);
    (map.getSource(`${P}tiles`) as maplibregl.GeoJSONSource).setData(squares(cells, (c) => (c.v[yearA] === null || c.v[yearA] === undefined ? null : metric === 'lst' ? (c.v[yearA] as number) : (c.v[yearA] as number) - ref), (grid / 2) * 1.05));
  }, [ready, heat, cells, yearA, metric, grid, map, years]);

  // the transect on the map; a new line means a fresh start
  useEffect(() => {
    if (!ready) return;
    stop();
    (map.getSource(`${P}line`) as maplibregl.GeoJSONSource).setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } } as any);
    latest.current.move(0, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, preset, custom, samples]);

  useEffect(() => {
    if (!ready) return;
    (map.getSource(`${P}draw`) as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features: (drawing ?? []).map((c) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } })) } as any);
  }, [ready, drawing, map]);

  // settings that should be heard straight away, and redraw the chart when options change
  useEffect(() => {
    synth.current?.volume(volume / 100);
  }, [volume]);
  useEffect(() => {
    if (!playing) {
      draw();
      return;
    }
    latest.current.voiceAt(tRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yearA, yearB, scale, drone, playing, samples]);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(c);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heat]);

  // recording ends by itself: once the line has played, wait for the last notes to die away, then save
  useEffect(() => {
    const r = rec.current;
    if (!recording || !r || !r.armed || playing) return;
    const t = setTimeout(stopRecording, 1800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, playing]);

  // clicks on the map: draw a line, or listen to one spot
  useEffect(() => {
    if (!ready) return;
    const onClick = (e: maplibregl.MapMouseEvent) => {
      if (rec.current) return; // no interruptions while recording
      const here: Pt = [e.lngLat.lng, e.lngLat.lat];
      if (drawing) {
        const next = [...drawing, here];
        if (next.length >= 2) {
          setCustom(next);
          setPreset('custom');
          setDrawing(null);
        } else setDrawing(next);
        return;
      }
      const { heat: h, yearA: a, yearB: b, scale: sc } = cfg.current;
      if (!h) return;
      const v = valueAt(here[0], here[1], a);
      if (v === null) {
        setProbe(null);
        return;
      }
      setProbe({ t: v, lon: here[0], lat: here[1] });
      (map.getSource(`${P}play`) as maplibregl.GeoJSONSource).setData({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: here } } as any);
      const sy = latest.current.ensureSynth();
      latest.current.stop();
      const ref = h.meta.ref[String(h.meta.years[a])];
      const vb = b !== null ? valueAt(here[0], here[1], b) : null;
      if (sc === 'glide') {
        sy.set(0, pitch(v, sc), 500 + clamp(v - 24, 0, 24) * 140, clamp(v - ref, 0, 12) * 5, 0.2, b !== null ? -0.8 : 0);
        if (vb !== null) sy.set(1, pitch(vb, sc), 500 + clamp(vb - 24, 0, 24) * 140, clamp(vb - h.meta.ref[String(h.meta.years[b as number])], 0, 12) * 5, 0.2, 0.8);
      } else {
        const hit = (val: number, yi: number, pan: number, delay: number) => {
          const uhi = val - h.meta.ref[String(h.meta.years[yi])];
          sy.pluck(pitch(val, sc), 0.28, pan, clamp(uhi, 0, 12) * 2.5, 1300 + clamp(val - 24, 0, 24) * 190, sy.ctx.currentTime + delay);
        };
        hit(v, a, b !== null ? -0.7 : 0, 0.02);
        if (vb !== null) hit(vb, b as number, 0.7, 0.2);
      }
      latest.current.chord(sy, cfg.current.drone, ref, sc);
      window.clearTimeout(probeTimer.current);
      probeTimer.current = window.setTimeout(() => sy.hush(), sc === 'glide' ? 1300 : 1500);
    };
    map.on('click', onClick);
    map.getCanvas().style.cursor = 'crosshair';
    return () => {
      map.off('click', onClick);
      map.getCanvas().style.cursor = '';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, drawing, map, buckets]);

  // space bar plays and pauses
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.code !== 'Space' || tag === 'INPUT' || tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      if (rec.current) return; // the recording runs by itself
      if (raf.current && cfgPlaying.current) latest.current.stop();
      else latest.current.play();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const cfgPlaying = useRef(false);
  cfgPlaying.current = playing;

  // tidy up when leaving the day (an unfinished recording is discarded)
  useEffect(
    () => () => {
      const r = rec.current;
      if (r) {
        r.discard = true;
        if (r.mr.state !== 'inactive') r.mr.stop();
        cleanupRecording();
        rec.current = null;
      }
      cancelAnimationFrame(raf.current);
      window.clearTimeout(probeTimer.current);
      synth.current?.dispose();
      synth.current = null;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // scrub the chart like a theremin
  const scrub = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvas.current;
    if (!c || rec.current) return;
    const r = c.getBoundingClientRect();
    const t = clamp((e.clientX - r.left - 40) / (r.width - 50), 0, 1);
    latest.current.ensureSynth();
    latest.current.move(t, true);
    latest.current.scrubNote(t);
  };

  // readouts for the panel
  const ref = heat ? heat.meta.ref[String(years[yearA])] : 0;
  const stats = useMemo(() => {
    if (!samples || !heat) return null;
    const a = samples.v[yearA];
    const ok = a.map((v, i) => (v === null ? null : { v, i })).filter((x): x is { v: number; i: number } => x !== null);
    if (!ok.length) return null;
    const hot = ok.reduce((m, x) => (x.v > m.v ? x : m));
    const cold = ok.reduce((m, x) => (x.v < m.v ? x : m));
    const mean = (arr: (number | null)[]) => {
      const z = arr.filter((v): v is number => v !== null);
      return z.length ? z.reduce((p, q) => p + q, 0) / z.length : null;
    };
    const mA = mean(a);
    const mB = yearB !== null ? mean(samples.v[yearB]) : null;
    return { hot, cold, hotKm: samples.dist[hot.i], coldKm: samples.dist[cold.i], mA, mB, length: samples.dist[samples.dist.length - 1] };
  }, [samples, heat, yearA, yearB]);
  const nowA = sampleAt(tRef.current, yearA);

  const seg = (on: boolean) => (on ? 'on' : '');
  return (
    <>
      {heat?.meta.synthetic && (
        <div style={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 4, pointerEvents: 'none', background: '#b3261e', color: '#fff', padding: '6px 14px', borderRadius: 6, fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap' }}>
          DEMO DATA · synthetic, not measured · load your Landsat export to make it real
        </div>
      )}

      <div className="legend wide" style={{ width: 380, maxWidth: 380 }}>
        <h4>Hear the heat</h4>
        <p className="muted" style={{ margin: '0 0 6px' }}>
          Land surface temperature as pitch. Press play and a note travels along the line: hotter ground sounds higher and brighter. A steady drone holds the temperature of the countryside, so the gap between the two notes is the urban heat island.
        </p>
        {error && (
          <p className="warn">
            Data missing. Run <code>python pipeline/11_heat.py</code> to create <code>public/data/day11-heat.json</code>.
          </p>
        )}
        {!heat && !error && <p className="muted">Loading…</p>}

        {heat && (
          <>
            <div style={{ display: 'flex', gap: 8, margin: '8px 0 4px' }}>
              <button
                disabled={recording}
                onClick={() => (playing ? stop() : play())}
                style={{ flex: 1, padding: '10px 12px', fontSize: 15, fontWeight: 700, borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', cursor: recording ? 'default' : 'pointer', opacity: recording ? 0.5 : 1 }}
                aria-label={playing ? 'Pause the sound' : 'Play the sound'}
              >
                {playing ? '❚❚  Pause' : '▶  Play the line'}
              </button>
              <button
                disabled={recording}
                onClick={() => {
                  stop();
                  latest.current.move(0, false);
                }}
                style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid var(--line)', background: 'transparent', color: 'inherit', cursor: recording ? 'default' : 'pointer', opacity: recording ? 0.5 : 1 }}
                aria-label="Back to the start"
              >
                ⏮
              </button>
              <button
                onClick={recording ? stopRecording : startRecording}
                style={{ padding: '10px 12px', fontSize: 13, fontWeight: 600, borderRadius: 8, border: 'none', background: recording ? '#9b2226' : '#e5e7eb', color: recording ? '#fff' : '#111827', cursor: 'pointer', whiteSpace: 'nowrap' }}
                aria-label={recording ? 'Stop recording and save the video' : 'Record the line as a video with sound'}
              >
                {recording ? '■ Stop & save' : '● Record'}
              </button>
            </div>
            <p className="muted" style={{ margin: '0 0 6px', fontSize: 11.5 }}>
              Space plays and pauses. Click the map to hear one spot. Drag across the chart below to scrub by hand. Use headphones for the two-year comparison. Record plays the line once and saves a video with the sound.
            </p>

            <p className="sub">Line across the city</p>
            <div className="seg">
              {PRESETS.map((p) => (
                <button key={p.id} className={seg(preset === p.id)} disabled={recording} onClick={() => setPreset(p.id)} title={p.desc}>
                  {p.label}
                </button>
              ))}
              <button className={seg(preset === 'custom' || !!drawing)} disabled={recording} onClick={() => (drawing ? setDrawing(null) : (stop(), setDrawing([])))}>
                {drawing ? (drawing.length === 0 ? 'Click start…' : 'Click end…') : custom ? 'Redraw mine' : 'Draw mine'}
              </button>
            </div>

            <p className="sub">Year you hear (left ear in a comparison)</p>
            <div className="seg">
              {years.map((y, i) => (
                <button key={y} className={seg(yearA === i)} disabled={recording} onClick={() => setYearA(i)}>
                  {y}
                </button>
              ))}
            </div>
            <p className="sub">Compare with (right ear)</p>
            <div className="seg">
              <button className={seg(yearB === null)} disabled={recording} onClick={() => setYearB(null)}>
                None
              </button>
              {years.map((y, i) => (
                <button key={y} className={seg(yearB === i)} disabled={i === yearA || recording} onClick={() => setYearB(i)} style={i === yearA ? { opacity: 0.35 } : undefined}>
                  {y}
                </button>
              ))}
            </div>

            <p className="sub">Map shows</p>
            <div className="seg">
              <button className={seg(metric === 'lst')} disabled={recording} onClick={() => setMetric('lst')}>
                Surface temperature
              </button>
              <button className={seg(metric === 'uhi')} disabled={recording} onClick={() => setMetric('uhi')}>
                Degrees above rural
              </button>
            </div>
            <div style={{ height: 10, borderRadius: 3, margin: '8px 0 2px', background: ramp(metric === 'lst' ? LST_STOPS : UHI_STOPS), border: '1px solid rgba(0,0,0,.2)' }} />
            <div className="muted" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
              {(metric === 'lst' ? [25, 33, 41, 45] : [-4, 0, 5, 11]).map((v) => (
                <span key={v}>{metric === 'lst' ? `${v} °C` : `${v > 0 ? '+' : ''}${v} °C`}</span>
              ))}
            </div>

            <p className="sub">Sound</p>
            <label className="legend-row" style={{ display: 'block' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Volume</span>
                <strong>{volume}%</strong>
              </div>
              <input className="range" type="range" min={0} max={100} value={volume} onChange={(e) => setVolume(Number(e.target.value))} aria-label="Volume" />
            </label>
            <label className="legend-row" style={{ display: 'block' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Time to cross the line</span>
                <strong>{seconds} s</strong>
              </div>
              <input className="range" type="range" min={8} max={40} step={2} value={seconds} disabled={recording} onChange={(e) => setSeconds(Number(e.target.value))} aria-label="Seconds to cross the line" />
            </label>
            <p className="muted" style={{ margin: '8px 0 3px' }}>
              Musical scale
            </p>
            <div className="seg">
              <button className={seg(scale === 'pmaj')} onClick={() => setScale('pmaj')} title="Bright: A C# E F# B">
                Major pentatonic
              </button>
              <button className={seg(scale === 'pmin')} onClick={() => setScale('pmin')} title="Darker: A C D E G">
                Minor pentatonic
              </button>
              <button className={seg(scale === 'glide')} onClick={() => setScale('glide')} title="A continuous tone that slides">
                Free glide
              </button>
            </div>
            {[
              ['Rural reference chord (hear the gap)', drone, setDrone],
              ['Loop', loop, setLoop],
            ].map(([label, val, set]) => (
              <label key={label as string} className="legend-row">
                <input type="checkbox" checked={val as boolean} onChange={() => (set as (f: (x: boolean) => boolean) => void)((x) => !x)} />
                <span style={{ flex: 1 }}>{label as string}</span>
              </label>
            ))}

            <p className="sub">On this line ({yearA >= 0 ? years[yearA] : ''})</p>
            {stats ? (
              <div className="kv">
                <span>Length</span>
                <span>{stats.length.toFixed(1)} km</span>
                <span>Hottest ground</span>
                <span>
                  {stats.hot.v.toFixed(1)} °C at {stats.hotKm.toFixed(1)} km
                </span>
                <span>Above the rural reference</span>
                <span>+{(stats.hot.v - ref).toFixed(1)} °C</span>
                <span>Coolest ground</span>
                <span>
                  {stats.cold.v.toFixed(1)} °C at {stats.coldKm.toFixed(1)} km
                </span>
                <span>Rural reference (the drone)</span>
                <span>
                  {ref.toFixed(1)} °C · {noteName(pitch(ref, scale))}
                </span>
                {yearB !== null && stats.mA !== null && stats.mB !== null && (
                  <>
                    <span>
                      Average {years[yearB]} minus {years[yearA]}
                    </span>
                    <span>
                      {stats.mB - stats.mA >= 0 ? '+' : ''}
                      {(stats.mB - stats.mA).toFixed(1)} °C
                    </span>
                  </>
                )}
                {nowA !== null && (
                  <>
                    <span>Now sounding</span>
                    <span>
                      {nowA.toFixed(1)} °C · {noteName(pitch(nowA, scale))}
                    </span>
                  </>
                )}
              </div>
            ) : (
              <p className="muted">No data on this line.</p>
            )}
            {probe && (
              <p className="muted" style={{ margin: '6px 0 0' }}>
                Last spot you clicked: {probe.t.toFixed(1)} °C ({probe.t - ref >= 0 ? '+' : ''}
                {(probe.t - ref).toFixed(1)} above rural) · {noteName(pitch(probe.t, scale))}
              </p>
            )}

            <details>
              <summary>How to read the sound</summary>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                <li>Melody: every quarter second the ground temperature under the dot plays one note. The notes come from an A pentatonic scale, so any run of them sounds consonant. Higher notes are hotter ground.</li>
                <li>Height: 28 °C is A3 (220 Hz) and every 6 °C is one octave up, so 34 °C is A4 and 40 °C is A5. With the free glide setting the pitch slides continuously instead.</li>
                <li>Brightness and warmth: hotter ground sounds brighter, louder and slightly detuned. More than 6 °C above the countryside adds a bright octave on top.</li>
                <li>Chord: a quiet two-note chord holds the rural reference temperature. A melody note an octave above its lower note means the ground is 6 °C hotter than the countryside.</li>
                <li>Held notes breathe: a flat stretch of ground repeats its note only on the strong beats, so long hot or cool plains sound calm and a changing street pattern sounds busy.</li>
                <li>Comparing years: {years[yearA]} plays in the left ear on the beat, {yearB !== null ? years[yearB] : 'the other year'} in the right ear on the off-beat, so the two lines weave together. Without a comparison, the sound pans with the east-west position on the map.</li>
                <li>Gaps (cloud, no data) go silent.</li>
              </ul>
            </details>

            <details>
              <summary>Data and limits</summary>
              <p className="muted" style={{ margin: '6px 0 4px' }}>
                {heat.meta.source} Season: {heat.meta.season}. Cells: {grid} m. Cells are shown as squares, and values between cell centres are estimated by weighting the nearest cells.
              </p>
              <p className="muted" style={{ margin: '0 0 4px' }}>
                Rural reference by year: {heat.meta.ref_method.join('; ')}.
              </p>
              <p className="muted" style={{ margin: 0 }}>
                Surface temperature is how hot the ground and roofs are at the satellite's pass (about mid-morning), not the air temperature people feel, and it is a dry-season composite. Gaps and cloud edges are possible. The sound is synthesized: no recordings were used.
              </p>
              <p className="muted" style={{ margin: '6px 0 0' }}>
                City boundary: OpenStreetMap contributors (ODbL).
              </p>
            </details>
          </>
        )}
      </div>

      {/* profile chart, like a score under the map */}
      {heat && (
        <div style={{ position: 'absolute', left: window.innerWidth > 900 ? 410 : 12, right: 12, bottom: 34, height: 150, zIndex: 3, background: 'rgba(255,255,255,.95)', borderRadius: 8, boxShadow: '0 2px 10px rgba(0,0,0,.3)', padding: 4, color: '#1d2a2e' }}>
          <div style={{ position: 'absolute', top: 4, right: 12, fontSize: 11.5, display: 'flex', gap: 12 }}>
            <span style={{ color: COL_A, fontWeight: 700 }}>● {years[yearA]}</span>
            {yearB !== null && <span style={{ color: COL_B, fontWeight: 700 }}>● {years[yearB]}</span>}
          </div>
          <canvas
            ref={canvas}
            style={{ width: '100%', height: '100%', touchAction: 'none', cursor: 'ew-resize', display: 'block' }}
            role="img"
            aria-label="Temperature along the line. Drag to scrub and hear it."
            onPointerDown={(e) => {
              if (rec.current) return;
              drag.current = true;
              (e.target as HTMLElement).setPointerCapture(e.pointerId);
              stop();
              scrub(e);
            }}
            onPointerMove={(e) => drag.current && scrub(e)}
            onPointerUp={() => {
              drag.current = false;
              synth.current?.hush();
            }}
          />
        </div>
      )}
    </>
  );
}