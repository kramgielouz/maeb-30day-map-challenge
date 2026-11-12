#!/usr/bin/env python3
"""Day 12, Power: build public/data/day12-power.json and day12-grid.geojson.

For every ~460 m cell of the Caraga grid (the same grid as Day 9) it records
  - how built-up the cell is (GHSL, final year, from day09-caraga-built.png)
  - how far it is from the nearest power line or substation (OpenStreetMap)
  - night-light radiance per year (VIIRS, from gee/day12_viirs_export.js)

Needs: numpy, pillow, pyproj, shapely>=2, rasterio (only for real lights).
Without data/raw/day12_viirs.tif it writes clearly flagged SYNTHETIC lights, so the page can be tried.

  python pipeline/12_power.py            # downloads OSM power data once, then caches it
  python pipeline/12_power.py --refresh  # download the OSM data again
  python pipeline/12_power.py --area butuan  # only Butuan City: a few tiles, and only cells inside its boundary

Only tiles that touch the boundary are downloaded, and only cells inside it are kept.
"""
import argparse
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

# A PostgreSQL/PostGIS install can leave PROJ_LIB or PROJ_DATA pointing at its own, older proj.db, which breaks rasterio
# ("proj.db contains DATABASE.LAYOUT.VERSION.MINOR = 2 whereas a number >= 6 is expected"). Drop them for this run
# so rasterio and pyproj use the copy that ships inside their own packages. Nothing is changed outside this script.
for _v in ('PROJ_LIB', 'PROJ_DATA', 'GDAL_DATA'):
    os.environ.pop(_v, None)

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'public' / 'data'
RAW = ROOT / 'data' / 'raw'
BUILT_META = DATA / 'day09-caraga-built.json'
BUILT_PNG = DATA / 'day09-caraga-built.png'
LIGHTS_TIF = RAW / 'day12_viirs.tif'
BOUNDARIES = {'caraga': DATA / 'caraga-boundary.geojson', 'butuan': DATA / 'butuan-boundary.geojson'}
OUT = DATA / 'day12-power.json'
GRID_OUT = DATA / 'day12-grid.geojson'

LIGHT_YEARS = [2014, 2017, 2020, 2022]  # one band each in the export
BUILT_MIN = 0.05  # keep cells at least 5% built over
OVERPASS = 'https://overpass-api.de/api/interpreter'


MIRRORS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
]
TILE_DEG = 0.6  # the area is fetched in tiles of about this size: one huge query often fails with 502/504
EDGE_DEG = 0.05  # lines just outside the boundary still count for distances, so tiles reach this far past it


def overpass(query, label, rounds=2):
    """POST one query, trying each mirror in turn. Returns None if every mirror fails, so one bad tile cannot stop the run."""
    for rnd in range(rounds):
        for url in MIRRORS:
            try:
                req = urllib.request.Request(url, data=urllib.parse.urlencode({'data': query}).encode(), headers={'User-Agent': 'map-challenge-day12'})
                with urllib.request.urlopen(req, timeout=90) as r:
                    return json.loads(r.read())
            except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as e:
                print(f'  {label}: {url.split("/")[2]} failed ({e})')
        if rnd < rounds - 1:
            print(f'  {label}: all mirrors failed, waiting 8 s')
            time.sleep(8)
    return None


def load_boundary(path):
    """The boundary as one shapely geometry, or None if the file is missing."""
    if not path.exists():
        print(f'!! {path.name} not found: using the whole bounding box instead of the boundary')
        return None
    from shapely.geometry import shape
    from shapely.ops import unary_union

    gj = json.loads(path.read_text())
    items = gj['features'] if gj.get('type') == 'FeatureCollection' else [gj]
    return unary_union([shape(f['geometry'] if 'geometry' in f else f) for f in items if f])


def fetch_osm(bbox, refresh, boundary, cache, tile_deg=TILE_DEG, minor=True):
    if cache.exists() and not refresh:
        return json.loads(cache.read_text())
    RAW.mkdir(parents=True, exist_ok=True)  # data/raw is created if it does not exist yet
    partial = cache.with_name(cache.stem + '.partial.json')  # progress is saved after every tile, so a failed run can resume
    if refresh and partial.exists():
        partial.unlink()
    from shapely.geometry import box

    west, south, east, north = boundary.bounds if boundary is not None else bbox
    reach = boundary.buffer(EDGE_DEG) if boundary is not None else None
    tiles = []  # (south, west, north, east)
    for y0 in np.arange(south, north, tile_deg):
        for x0 in np.arange(west, east, tile_deg):
            t = (float(y0), float(x0), min(float(y0) + tile_deg, north), min(float(x0) + tile_deg, east))
            if reach is None or reach.intersects(box(t[1], t[0], t[3], t[2])):
                tiles.append(t)  # tiles over open sea or other regions are skipped
    total = len(tiles)
    seen = {}
    done = set()
    failed = []
    if partial.exists():
        saved = json.loads(partial.read_text())
        done = set(saved['done'])
        seen = {(el['type'], el['id']): el for el in saved['elements']}
        print(f'Resuming: {len(done)} tiles were already downloaded.')
    print(f'Asking Overpass for power lines, substations and plants in {total} tiles that touch the boundary...')
    for n, (s_, w_, n_, e_) in enumerate(tiles, 1):
        key = f'{s_:.4f},{w_:.4f},{n_:.4f},{e_:.4f}'
        if key in done:
            continue
        kinds = 'line|minor_line|cable' if minor else 'line'
        q = f"""[out:json][timeout:80];
(
  way["power"~"^({kinds})$"]({s_},{w_},{n_},{e_});
  way["power"~"^(substation|plant)$"]({s_},{w_},{n_},{e_});
  node["power"~"^(substation|plant)$"]({s_},{w_},{n_},{e_});
);
out geom;"""
        osm = overpass(q, f'tile {n}/{total}')
        if osm is None:
            failed.append(n)
            print(f'  tile {n}/{total}: skipped for now (servers busy). It is retried on the next run.')
            continue
        for el in osm.get('elements', []):
            seen[(el['type'], el['id'])] = el  # a line crossing a tile edge arrives twice: keep one
        done.add(key)
        partial.write_text(json.dumps({'done': sorted(done), 'elements': list(seen.values())}))
        print(f'  tile {n}/{total}: {len(osm.get("elements", []))} features ({len(seen)} so far)')
        time.sleep(1.5)  # be gentle with the public servers
    out = {'elements': list(seen.values())}
    if failed:
        print(f'\n!! {len(failed)} of {total} tiles could not be downloaded (tiles {failed}). Carrying on with what we have;')
        print('   run the script again later to fetch the missing tiles (finished tiles are not downloaded twice).\n')
        return out
    RAW.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(out))
    if partial.exists():
        partial.unlink()
    return out


def osm_to_features(osm):
    feats = []
    for el in osm.get('elements', []):
        tags = el.get('tags', {})
        p = tags.get('power')
        props = {'name': tags.get('name', '')}
        if el['type'] == 'way' and el.get('geometry'):
            coords = [[g['lon'], g['lat']] for g in el['geometry']]
            if p in ('line', 'minor_line', 'cable') and len(coords) >= 2:
                feats.append({'type': 'Feature', 'properties': {**props, 'k': 'line' if p == 'line' else 'minor'}, 'geometry': {'type': 'LineString', 'coordinates': coords}})
            elif p in ('substation', 'plant'):
                cx = sum(c[0] for c in coords) / len(coords)
                cy = sum(c[1] for c in coords) / len(coords)
                feats.append({'type': 'Feature', 'properties': {**props, 'k': p}, 'geometry': {'type': 'Point', 'coordinates': [cx, cy]}})
        elif el['type'] == 'node' and p in ('substation', 'plant'):
            feats.append({'type': 'Feature', 'properties': {**props, 'k': p}, 'geometry': {'type': 'Point', 'coordinates': [el['lon'], el['lat']]}})
    return feats


def distances_km(feats, lon, lat):
    """Distance from each (lon, lat) to the nearest line or substation/plant, in km."""
    import shapely
    from pyproj import Transformer
    from shapely import STRtree
    from shapely.geometry import LineString, Point

    tr = Transformer.from_crs('EPSG:4326', 'EPSG:32651', always_xy=True)  # UTM 51N, fine across Caraga for distances
    geoms = []
    for f in feats:
        g = f['geometry']
        if g['type'] == 'LineString':
            xs, ys = tr.transform([c[0] for c in g['coordinates']], [c[1] for c in g['coordinates']])
            geoms.append(LineString(list(zip(xs, ys))))
        else:
            x, y = tr.transform(*g['coordinates'])
            geoms.append(Point(x, y))
    if not geoms:
        sys.exit('No power features found in OSM for this area.')
    tree = STRtree(geoms)
    x, y = tr.transform(lon, lat)
    idx, d = tree.query_nearest(shapely.points(x, y), return_distance=True, all_matches=False)
    d = d[np.argsort(idx[0])]
    return d / 1000.0


def read_lights(west, north, cd, w, h):
    import rasterio
    from rasterio.transform import from_origin
    from rasterio.warp import Resampling, reproject

    out = []
    with rasterio.open(LIGHTS_TIF) as src:
        if src.count != len(LIGHT_YEARS):
            sys.exit(f'{LIGHTS_TIF} has {src.count} bands but LIGHT_YEARS has {len(LIGHT_YEARS)}.')
        dst_t = from_origin(west, north, cd, cd)
        for b in range(1, src.count + 1):
            dst = np.full((h, w), np.nan, dtype='float32')
            reproject(source=rasterio.band(src, b), destination=dst, dst_transform=dst_t, dst_crs='EPSG:4326',
                      resampling=Resampling.average, src_nodata=src.nodata, dst_nodata=np.nan)
            out.append(np.nan_to_num(dst, nan=0.0))
    return out


def synthetic_lights(built, dist):
    rng = np.random.default_rng(12)
    core = built ** 1.4
    growth = np.linspace(0.8, 1.4, len(LIGHT_YEARS))
    dark = (rng.random(built.shape) < 0.25) & (dist > 2)
    return [np.where(dark, 0.0, 45 * core * np.exp(-dist / 5) * g * (0.6 + 0.8 * rng.random(built.shape))) for g in growth]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--refresh', action='store_true', help='download the OSM power data again')
    ap.add_argument('--no-minor', dest='minor', action='store_false', help='skip minor lines and cables: much lighter and faster, but only transmission lines count for the distance')
    ap.add_argument('--tile', type=float, default=TILE_DEG, help='tile size in degrees for the OSM download (default 0.6)')
    ap.add_argument('--area', choices=['caraga', 'butuan'], default='caraga', help='clip to this boundary (default: the Caraga region)')
    args = ap.parse_args()
    RAW.mkdir(parents=True, exist_ok=True)

    if not BUILT_META.exists() or not BUILT_PNG.exists():
        sys.exit('Run pipeline/09_ghsl_built.py --only caraga first (Day 9 built-up data).')
    meta = json.loads(BUILT_META.read_text())
    w, h, cd = meta['w'], meta['h'], meta['cell_deg']
    west, south, east, north = meta['bbox']
    nyears = len(meta['years'])

    flat = np.asarray(Image.open(BUILT_PNG).convert('RGBA'))[..., 0].reshape(-1)
    built = flat[(nyears - 1) * w * h: nyears * w * h].reshape(h, w).astype('float32') / 255.0

    boundary = load_boundary(BOUNDARIES[args.area])
    feats = osm_to_features(fetch_osm(meta['bbox'], args.refresh, boundary, RAW / f'day12_osm_power_{args.area}{"" if args.minor else "_major"}.json', args.tile, args.minor))
    print(f'{sum(f["geometry"]["type"] == "LineString" for f in feats)} lines, {sum(f["geometry"]["type"] == "Point" for f in feats)} substations/plants')
    GRID_OUT.write_text(json.dumps({'type': 'FeatureCollection', 'features': feats}, separators=(',', ':')))

    keep = np.argwhere(built >= BUILT_MIN)  # (row, col)
    rows, cols = keep[:, 0], keep[:, 1]
    lon = west + (cols + 0.5) * cd
    lat = north - (rows + 0.5) * cd
    if boundary is not None:  # keep only the cells whose centre is inside the boundary
        import shapely

        shapely.prepare(boundary)
        inside = shapely.contains_xy(boundary, lon, lat)
        rows, cols, lon, lat = rows[inside], cols[inside], lon[inside], lat[inside]
        print(f'{len(rows)} built-up cells inside the {args.area} boundary')
    dist = distances_km(feats, lon, lat)
    b = built[rows, cols]

    synthetic = not LIGHTS_TIF.exists()
    if synthetic:
        print('!! No night-light export found: writing SYNTHETIC demo lights. Run gee/day12_viirs_export.js and save data/raw/day12_viirs.tif')
        lights = [a for a in synthetic_lights(b, dist)]
    else:
        lights = [a[rows, cols] for a in read_lights(west, north, cd, w, h)]

    pts = []
    for i in range(len(b)):
        pts.append([round(float(lon[i]), 5), round(float(lat[i]), 5), round(float(b[i]), 2), round(float(dist[i]), 2)] + [round(float(l[i]), 2) for l in lights])

    out = {
        'meta': {
            'synthetic': synthetic,
            'years': LIGHT_YEARS,
            'built_year': meta['years'][-1],
            'bbox': meta['bbox'],
            'cell_deg': cd,
            'attribution': 'Night lights: VIIRS DNB annual composites, Earth Observation Group, Payne Institute, Colorado School of Mines (CC BY 4.0). Built-up: GHS-BUILT-S R2023A, JRC (CC BY 4.0). Power lines: OpenStreetMap contributors (ODbL).',
        },
        'pts': pts,
    }
    OUT.write_text(json.dumps(out, separators=(',', ':')))
    print(f'wrote {OUT} ({len(pts)} cells) and {GRID_OUT}')


if __name__ == '__main__':
    main()