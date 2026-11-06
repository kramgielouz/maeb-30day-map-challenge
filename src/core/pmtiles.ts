import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';

// Register once so any day can use sources like "pmtiles://https://.../buildings.pmtiles"
let registered = false;
export function registerPMTiles() {
  if (registered) return;
  const protocol = new Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);
  registered = true;
}
