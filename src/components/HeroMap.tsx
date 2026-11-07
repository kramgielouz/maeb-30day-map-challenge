import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { BASE_STYLE, BUTUAN_CENTER } from '../core/BaseMap';
import { reducedMotion } from './motion';

const HOME_VIEW = { center: BUTUAN_CENTER, zoom: 14.7, pitch: 62 };
const ORBIT_DEG_PER_MS = 0.004; // 4 degrees a second: one lap every 90 s

/**
 * Full-bleed pitched map behind the hero. Orbits Butuan until the visitor touches it.
 * Page scroll is never hijacked: wheel zoom is off, drag / pinch / double-click still work.
 */
export default function HeroMap() {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const orbit = useRef(false);
  const [orbiting, setOrbiting] = useState(() => !reducedMotion());
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    orbit.current = orbiting;
  }, [orbiting]);

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;

    // Fresh element per mount (same trick as BaseMap) so StrictMode's double mount cannot collide.
    const el = document.createElement('div');
    el.style.cssText = 'position:absolute;inset:0';
    parent.appendChild(el);

    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: el,
        style: BASE_STYLE,
        center: HOME_VIEW.center,
        zoom: HOME_VIEW.zoom,
        pitch: HOME_VIEW.pitch,
        bearing: -20,
        maxPitch: 75,
        scrollZoom: false,
        attributionControl: { compact: true },
      });
    } catch {
      // No WebGL: the hero falls back to its gradient.
      el.remove();
      setFailed(true);
      return;
    }
    mapRef.current = map;

    // Keep the city clear of the text: right of centre on wide screens, upper part on phones.
    const pad = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      map.setPadding(
        w > 900
          ? { top: 0, right: 0, bottom: 0, left: Math.round(w * 0.3) }
          : { top: 0, right: 0, bottom: Math.round(h * 0.38), left: 0 },
      );
    };
    pad();
    window.addEventListener('resize', pad);

    const pin = document.createElement('div');
    pin.className = 'h-pin';
    new maplibregl.Marker({ element: pin }).setLngLat(BUTUAN_CENTER).addTo(map);

    map.on('load', () => {
      // 3D buildings from whatever vector source the basemap style uses. Failure here is cosmetic only.
      try {
        const style = map.getStyle();
        const entry = Object.entries(style.sources ?? {}).find(([, s]) => (s as { type?: string }).type === 'vector');
        if (!entry) return;
        const firstLabel = (style.layers ?? []).find((l) => l.type === 'symbol')?.id;
        const layer = {
          id: 'hero-buildings',
          type: 'fill-extrusion',
          source: entry[0],
          'source-layer': 'building',
          minzoom: 13,
          paint: {
            // short buildings teal, tall ones amber
            'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 6], 0, '#2dd4bf', 40, '#fbbf24'],
            'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 6],
            'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
            'fill-extrusion-opacity': 0.92,
          },
        };
        // typed loosely on purpose: nested expression arrays do not narrow to the style-spec types
        map.addLayer(layer as never, firstLabel);
      } catch {
        /* keep the flat map */
      }
    });

    const stop = () => setOrbiting(false);
    map.on('mousedown', stop);
    map.on('touchstart', stop);

    // Only spend frames while the hero is on screen.
    let visible = true;
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
    });
    io.observe(parent);

    let raf = 0;
    let last = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(t - last, 64);
      last = t;
      if (!orbit.current || !visible || map.isMoving()) return;
      map.setBearing((map.getBearing() + dt * ORBIT_DEG_PER_MS) % 360);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      window.removeEventListener('resize', pad);
      mapRef.current = null;
      map.remove();
      el.remove();
    };
  }, []);

  const recenter = () => mapRef.current?.easeTo({ ...HOME_VIEW, duration: 1400 });

  return (
    <>
      <div className={failed ? 'h-map fail' : 'h-map'} ref={host} role="region" aria-label="Interactive 3D map of Butuan City" />
      {!failed && (
        <div className="h-ctl">
          <span className="h-hint">Drag to look around</span>
          <button type="button" onClick={() => setOrbiting((o) => !o)} aria-pressed={orbiting}>
            {orbiting ? 'Pause orbit' : 'Orbit'}
          </button>
          <button type="button" onClick={recenter}>
            Recenter
          </button>
        </div>
      )}
    </>
  );
}
