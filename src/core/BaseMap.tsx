import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { registerPMTiles } from './pmtiles';

registerPMTiles();

// Butuan City centre (lng, lat)
export const BUTUAN_CENTER: [number, number] = [125.5406, 8.9475];

// OpenFreeMap needs no API key. Swap for a Protomaps PMTiles style later if you want full self-hosting.
export const BASE_STYLE = 'https://tiles.openfreemap.org/styles/positron';

// Where the city boundary used on every map comes from (pipeline/01_osm_facilities.py).
const BOUNDARY_ATTRIBUTION = 'City boundary: OpenStreetMap contributors (ODbL), via Nominatim';

interface Props {
  children?: (map: maplibregl.Map) => React.ReactNode;
}

export default function BaseMap({ children }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<maplibregl.Map | null>(null);

  useEffect(() => {
    const host = container.current;
    if (!host) return;

    // A fresh element per mount, so a map that is still being torn down can never touch the new one.
    const el = document.createElement('div');
    el.style.cssText = 'position:absolute;inset:0';
    host.appendChild(el);

    let disposed = false;

    const q = new URLSearchParams(window.location.search);
    const lng = parseFloat(q.get('lng') ?? '');
    const lat = parseFloat(q.get('lat') ?? '');
    const z = parseFloat(q.get('z') ?? '');

    const m = new maplibregl.Map({
      container: el,
      style: BASE_STYLE,
      center: Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : BUTUAN_CENTER,
      zoom: Number.isFinite(z) ? z : 11,
      attributionControl: { compact: true, customAttribution: BOUNDARY_ATTRIBUTION },
    });
    m.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    // The side panel can collapse, so the map has to follow its container, not only the window.
    // resize() clears the canvas, so redraw() straight after, in the same frame, to avoid a blank flash.
    const ro = new ResizeObserver(() => {
      if (disposed) return;
      m.resize();
      m.redraw();
    });
    ro.observe(host);

    // Keep the map position in the URL so every view is shareable.
    // Pass the existing history state through: React Router keeps its bookkeeping there.
    const sync = () => {
      if (disposed) return; // never write a closed map's position onto another page's URL
      const c = m.getCenter();
      const p = new URLSearchParams(window.location.search);
      p.set('lng', c.lng.toFixed(4));
      p.set('lat', c.lat.toFixed(4));
      p.set('z', m.getZoom().toFixed(2));
      window.history.replaceState(window.history.state, '', `${window.location.pathname}?${p.toString()}`);
    };
    m.on('moveend', sync);

    m.on('load', () => {
      if (!disposed) setMap(m);
    });

    return () => {
      disposed = true;
      ro.disconnect();
      m.off('moveend', sync);
      setMap(null);
      // React runs a parent's cleanup before its children's. The day components still need a live map
      // to remove their layers, so destroy the map on the next tick, after they are done.
      setTimeout(() => {
        m.remove();
        el.remove();
      }, 0);
    };
  }, []);

  return (
    <div className="map-wrap">
      <div ref={container} className="map" />
      {map && children?.(map)}
      <div className="boundary-note">
        <div>Basemap: OpenFreeMap, OpenMapTiles, © OpenStreetMap contributors.</div>
        <div>
          City boundary: OpenStreetMap (relation via Nominatim, ODbL), taken from online data. For illustration only, not an official or legal boundary.
        </div>
      </div>
    </div>
  );
}