import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { registerPMTiles } from './pmtiles';

registerPMTiles();

// Butuan City centre (lng, lat)
export const BUTUAN_CENTER: [number, number] = [125.5406, 8.9475];

// OpenFreeMap needs no API key. Swap for a Protomaps PMTiles style later if you want full self-hosting.
export const BASE_STYLE = 'https://tiles.openfreemap.org/styles/positron';

interface Props {
  children?: (map: maplibregl.Map) => React.ReactNode;
}

export default function BaseMap({ children }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<maplibregl.Map | null>(null);

  useEffect(() => {
    if (!container.current) return;
    const q = new URLSearchParams(window.location.search);
    const lng = parseFloat(q.get('lng') ?? '');
    const lat = parseFloat(q.get('lat') ?? '');
    const z = parseFloat(q.get('z') ?? '');

    const m = new maplibregl.Map({
      container: container.current,
      style: BASE_STYLE,
      center: Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : BUTUAN_CENTER,
      zoom: Number.isFinite(z) ? z : 11,
      attributionControl: { compact: true },
    });
    m.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    // Keep map position in the URL so every view is shareable
    const sync = () => {
      const c = m.getCenter();
      const p = new URLSearchParams(window.location.search);
      p.set('lng', c.lng.toFixed(4));
      p.set('lat', c.lat.toFixed(4));
      p.set('z', m.getZoom().toFixed(2));
      window.history.replaceState(null, '', `${window.location.pathname}?${p.toString()}`);
    };
    m.on('moveend', sync);

    m.on('load', () => setMap(m));
    return () => {
      m.remove();
      setMap(null);
    };
  }, []);

  return (
    <div className="map-wrap">
      <div ref={container} className="map" />
      {map && children?.(map)}
    </div>
  );
}
