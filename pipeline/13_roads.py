#!/usr/bin/env python3
"""Day 13, Interactions: do new buildings appear along roads?

Builds public/data/day13-roads.json, day13-roads.png and day13-roads.geojson from
  - the Day 9 Butuan built-up grid (public/data/day09-built.json + .png, ~100 m cells, 1975 to 2020)
  - OpenStreetMap roads (downloaded once and cached in data/raw)
  - the Butuan boundary (public/data/butuan-boundary.geojson)

For every grid cell it records, in one RGBA pixel (alpha is always 255):
  R  the "first built" epoch: index into `years` of the first epoch the cell was at least 15% built over
     (same rule as Day 9). 255 = never built by the last epoch, 254 = outside the Butuan boundary.
  G  distance to the nearest MAIN road (motorway, trunk, primary, secondary), in steps of 20 m (255 = 5.1 km or more)
  B  distance to the nearest road of ANY kind (adds tertiary, unclassified, residential, living street), in steps of 10 m (255 = 2.55 km or more)

The roads are today's OSM roads: OSM has no complete road history for 1975 to 2020, so the page says so.

Needs: numpy, pillow, pyproj, shapely>=2.

Usage:
  python pipeline/13_roads.py                  download all roads (resumes), stop if some tiles fail
  python pipeline/13_roads.py --allow-partial  download, and if some tiles still fail build from what was saved
  python pipeline/13_roads.py --use-partial    no download at all: build from the saved partial file
  python pipeline/13_roads.py --refresh        throw the cache away and download everything again

A partial build is marked "partial": true in day13-roads.json, with the missing tiles listed.
Cells inside a missing tile get distances that are too large, so treat them as unreliable.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

# A PostgreSQL/PostGIS install can leave PROJ_LIB or PROJ_DATA pointing at an older proj.db. Drop them for this run.
for _v in ('PROJ_LIB', 'PROJ_DATA', 'GDAL_DATA'):
    os.environ.pop(_v, None)

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'public' / 'data'
RAW = ROOT / 'data' / 'raw'
BUILT_META = DATA / 'day09-built.json'
BUILT_PNG = DATA / 'day09-built.png'
BOUNDARY = DATA / 'butuan-boundary.geojson'
CACHE = RAW / 'day13_osm_roads.json'
PARTIAL = RAW / 'day13_osm_roads.partial.json'
OUT_META = DATA / 'day13-roads.json'
OUT_PNG = DATA / 'day13-roads.png'
OUT_GEO = DATA / 'day13-roads.geojson'

ERA_T = 0.15  # a cell counts as built once 15% of it is built over (as in Day 9)
MAIN = {'motorway', 'trunk', 'primary', 'secondary'}
LOCAL = {'tertiary', 'unclassified', 'residential', 'living_street'}
MARGIN_DEG = 0.03  # roads just outside the boundary still count for distances
TILE_DEG = 0.3  # keep at 0.3 so tiles already saved in the partial file are still recognised
MAX_SPLIT_DEPTH = 3
UNIT_MAIN_M = 20
UNIT_ALL_M = 10
MIRRORS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
]


class QueryError(Exception):
    """The server rejected the query itself (HTTP 400). Retrying or splitting will not help."""


def overpass(query, label, rounds=3):
    """Try each public Overpass instance with backoff before giving up."""
    last_error = None
    for rnd in range(rounds):
        # Rotate the starting mirror so repeated runs do not overload one endpoint.
        mirrors = MIRRORS[rnd % len(MIRRORS):] + MIRRORS[:rnd % len(MIRRORS)]
        for url in mirrors:
            try:
                req = urllib.request.Request(
                    url,
                    data=urllib.parse.urlencode({'data': query}).encode('utf-8'),
                    headers={
                        'User-Agent': 'Butuan-Day13-MapChallenge/1.2 (road-data download)',
                        'Accept': 'application/json',
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                )
                with urllib.request.urlopen(req, timeout=180) as response:
                    payload = json.loads(response.read())
                    if 'elements' not in payload:
                        raise ValueError('Overpass response has no elements array')
                    return payload
            except urllib.error.HTTPError as exc:
                if exc.code == 400:
                    detail = ''
                    try:
                        detail = exc.read().decode('utf-8', 'replace')[:300]
                    except Exception:
                        pass
                    raise QueryError(f'{label}: {url.split("/")[2]} rejected the query (HTTP 400). {detail}') from exc
                last_error = exc
                print(f'  {label}: {url.split("/")[2]} failed ({exc})')
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError, ValueError) as exc:
                last_error = exc
                print(f'  {label}: {url.split("/")[2]} failed ({exc})')
        if rnd < rounds - 1:
            delay = min(60, 10 * (2 ** rnd))
            print(f'  {label}: all mirrors failed; waiting {delay}s before retry {rnd + 2}/{rounds}...')
            time.sleep(delay)

    raise RuntimeError(f'{label}: all Overpass mirrors failed after {rounds} rounds: {last_error}')


def load_boundary():
    if not BOUNDARY.exists():
        print(f'!! {BOUNDARY.name} not found: every cell in the Day 9 grid will count as inside')
        return None
    from shapely.geometry import shape
    from shapely.ops import unary_union

    gj = json.loads(BOUNDARY.read_text())
    items = gj['features'] if gj.get('type') == 'FeatureCollection' else [gj]
    return unary_union([shape(f['geometry'] if 'geometry' in f else f) for f in items if f])


def tile_key(tile):
    s_, w_, n_, e_ = tile
    return f'{s_:.6f},{w_:.6f},{n_:.6f},{e_:.6f}'


def make_tiles(bounds):
    west, south, east, north = bounds
    tiles = []
    for y0 in np.arange(south, north, TILE_DEG):
        for x0 in np.arange(west, east, TILE_DEG):
            tiles.append((
                float(y0), float(x0),
                min(float(y0) + TILE_DEG, north),
                min(float(x0) + TILE_DEG, east),
            ))
    return tiles


def load_partial():
    """-> (seen elements by id, done tile keys, split tile keys). Empty if no usable file."""
    if not PARTIAL.exists():
        return {}, set(), set()
    try:
        saved = json.loads(PARTIAL.read_text())
        return (
            {el['id']: el for el in saved.get('elements', [])},
            set(saved.get('done', [])),
            set(saved.get('split', [])),
        )
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        print(f'Partial cache is unreadable ({exc}); ignoring it.')
        return {}, set(), set()


def fetch_roads(bounds, refresh, use_partial):
    """Returns (osm dict, list of missing tiles as (south, west, north, east))."""
    RAW.mkdir(parents=True, exist_ok=True)
    tiles = make_tiles(bounds)

    if CACHE.exists() and not refresh and not use_partial:
        print(f'Using cached roads: {CACHE}')
        return json.loads(CACHE.read_text()), []

    if refresh:
        PARTIAL.unlink(missing_ok=True)

    seen, done, split = load_partial()

    if use_partial:
        if not seen:
            sys.exit(f'--use-partial needs {PARTIAL.name}, but it is missing or empty. Run without it first.')
        # A top-level tile is missing if it is not done and was never split into children.
        # Split tiles are handled through their own (smaller) children, which we cannot
        # list without re-deriving them, so re-derive them here.
        missing = []

        def collect(tile, depth=0):
            key = tile_key(tile)
            if key in done:
                return
            if key in split and depth < MAX_SPLIT_DEPTH:
                s_, w_, n_, e_ = tile
                mid_lat, mid_lon = (s_ + n_) / 2, (w_ + e_) / 2
                for child in (
                    (s_, w_, mid_lat, mid_lon), (s_, mid_lon, mid_lat, e_),
                    (mid_lat, w_, n_, mid_lon), (mid_lat, mid_lon, n_, e_),
                ):
                    collect(child, depth + 1)
            else:
                missing.append(tile)

        for tile in tiles:
            collect(tile)
        print(f'Using saved partial roads: {len(seen)} unique roads, {len(missing)} missing tile(s).')
        return {'elements': list(seen.values())}, missing

    if seen:
        print(f'Resuming: {len(done)} completed tiles; {len(seen)} unique roads already saved.')

    kinds = '|'.join(sorted(MAIN | LOCAL))
    print(f'Asking Overpass for roads in {len(tiles)} initial tiles...')

    def save_progress():
        # Write atomically so an interrupted run cannot corrupt the resume file.
        temp = PARTIAL.with_suffix('.tmp')
        temp.write_text(json.dumps({
            'done': sorted(done),
            'split': sorted(split),
            'elements': list(seen.values()),
        }))
        temp.replace(PARTIAL)

    def download_tile(tile, label, depth=0):
        """Returns the list of leaf tiles that could not be downloaded."""
        key = tile_key(tile)
        if key in done:
            return []

        s_, w_, n_, e_ = tile
        query = (
            '[out:json][timeout:180];\n'
            f'way["highway"~"^({kinds})(_link)?$"]'
            f'({s_:.7f},{w_:.7f},{n_:.7f},{e_:.7f});\n'
            'out geom;'
        )

        try:
            osm = overpass(query, label, rounds=3 if depth == 0 else 2)
        except RuntimeError as exc:
            if depth >= MAX_SPLIT_DEPTH:
                print(f'  {label}: could not download even after subdivision: {exc}')
                return [tile]
            # A large tile can overwhelm the public instances. Split it into four smaller requests.
            split.add(key)
            mid_lat, mid_lon = (s_ + n_) / 2, (w_ + e_) / 2
            children = [
                (s_, w_, mid_lat, mid_lon),
                (s_, mid_lon, mid_lat, e_),
                (mid_lat, w_, n_, mid_lon),
                (mid_lat, mid_lon, n_, e_),
            ]
            print(f'  {label}: splitting into 4 smaller tiles (level {depth + 1})...')
            failed_here = []
            for child_no, child in enumerate(children, 1):
                failed_here += download_tile(child, f'{label}.{child_no}', depth + 1)
            if not failed_here:
                done.add(key)  # parent complete only when all four children succeeded
            save_progress()
            return failed_here

        elements = osm.get('elements', [])
        for element in elements:
            seen[element['id']] = element
        done.add(key)
        save_progress()
        print(f'  {label}: {len(elements)} roads ({len(seen)} unique total)')
        time.sleep(2.0)
        return []

    missing = []
    try:
        for n, tile in enumerate(tiles, 1):
            missing += download_tile(tile, f'tile {n}/{len(tiles)}')
    except QueryError as exc:
        sys.exit(f'The Overpass query itself was rejected, so this will not fix itself: {exc}')

    if not missing:
        temp_cache = CACHE.with_suffix('.tmp')
        temp_cache.write_text(json.dumps({'elements': list(seen.values())}))
        temp_cache.replace(CACHE)
        PARTIAL.unlink(missing_ok=True)
        print(f'Road download complete: {len(seen)} unique OSM road ways cached.')
    else:
        print(f'Road download incomplete: {len(seen)} roads saved, {len(missing)} tile(s) missing.')
    return {'elements': list(seen.values())}, missing


def to_lines(osm):
    """[(kind, [(lon, lat), ...])] with kind 'main' or 'local'."""
    lines = []
    for el in osm.get('elements', []):
        hw = el.get('tags', {}).get('highway', '').replace('_link', '')
        geom = el.get('geometry')
        if not geom or len(geom) < 2:
            continue
        kind = 'main' if hw in MAIN else 'local' if hw in LOCAL else None
        if kind:
            lines.append((kind, [(g['lon'], g['lat']) for g in geom]))
    return lines


def nearest_m(lines, lon, lat):
    """Distance in metres from each point to the nearest of the given lines (UTM 51N is accurate enough around Butuan)."""
    import shapely
    from pyproj import Transformer
    from shapely import STRtree
    from shapely.geometry import LineString

    if not lines:
        return np.full(len(lon), np.inf)
    tr = Transformer.from_crs('EPSG:4326', 'EPSG:32651', always_xy=True)
    geoms = []
    for coords in lines:
        xs, ys = tr.transform([c[0] for c in coords], [c[1] for c in coords])
        geoms.append(LineString(list(zip(xs, ys))))
    tree = STRtree(geoms)
    x, y = tr.transform(lon, lat)
    idx, d = tree.query_nearest(shapely.points(x, y), return_distance=True, all_matches=False)
    return d[np.argsort(idx[0])]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--refresh', action='store_true', help='download the OSM roads again from scratch')
    ap.add_argument('--allow-partial', action='store_true',
                    help='if some tiles cannot be downloaded, build the output from the roads that were saved')
    ap.add_argument('--use-partial', action='store_true',
                    help='do not download anything: build the output from the saved partial file')
    args = ap.parse_args()
    allow_partial = args.allow_partial or args.use_partial
    RAW.mkdir(parents=True, exist_ok=True)

    if not BUILT_META.exists() or not BUILT_PNG.exists():
        sys.exit('Run pipeline/09_ghsl_built.py first (the Day 9 Butuan built-up data).')
    meta = json.loads(BUILT_META.read_text())
    w, h, cd, years = meta['w'], meta['h'], meta['cell_deg'], meta['years']
    west, south, east, north = meta['bbox']
    T = len(years)

    flat = np.asarray(Image.open(BUILT_PNG).convert('RGBA'))[..., 0].reshape(-1)
    frac = flat[: T * w * h].reshape(T, h, w).astype('float32') / 255.0

    # first epoch each cell counts as built (255 = never)
    built = frac >= ERA_T
    era = np.where(built.any(axis=0), built.argmax(axis=0), 255).astype('uint8')

    rows, cols = np.mgrid[0:h, 0:w]
    lon = (west + (cols + 0.5) * cd).ravel()
    lat = (north - (rows + 0.5) * cd).ravel()

    boundary = load_boundary()
    if boundary is not None:
        import shapely

        shapely.prepare(boundary)
        inside = shapely.contains_xy(boundary, lon, lat)
        bw, bs, be, bn = boundary.bounds
    else:
        inside = np.ones(len(lon), dtype=bool)
        bw, bs, be, bn = west, south, east, north
    print(f'{int(inside.sum())} of {len(inside)} cells are inside the boundary')

    osm, missing = fetch_roads(
        (bw - MARGIN_DEG, bs - MARGIN_DEG, be + MARGIN_DEG, bn + MARGIN_DEG),
        args.refresh, args.use_partial,
    )

    partial = bool(missing)
    if partial and not allow_partial:
        sys.exit(
            f'{len(missing)} tile(s) are still missing. Run again later to resume the download, '
            'or add --allow-partial to build from the roads saved so far.'
        )

    lines = to_lines(osm)
    main_lines = [c for k, c in lines if k == 'main']
    all_lines = [c for _, c in lines]
    print(f'{len(main_lines)} main roads, {len(all_lines) - len(main_lines)} local roads')
    if not main_lines:
        sys.exit('No main roads found: check the download.')

    if partial:
        affected = np.zeros(len(lon), dtype=bool)
        for s_, w_, n_, e_ in missing:
            affected |= (lat >= s_) & (lat <= n_) & (lon >= w_) & (lon <= e_)
        n_aff = int((affected & inside).sum())
        print(f'!! PARTIAL BUILD: {len(missing)} tile(s) missing; {n_aff} of {int(inside.sum())} '
              f'boundary cells ({100 * n_aff / max(1, int(inside.sum())):.1f}%) lie in them.')
        print('   Distances there are too large because the roads are not loaded. Re-run later without --use-partial to finish.')

    dm = np.full(len(lon), 255, dtype='uint8')
    da = np.full(len(lon), 255, dtype='uint8')
    sel = np.flatnonzero(inside)
    dm[sel] = np.minimum(255, np.round(nearest_m(main_lines, lon[sel], lat[sel]) / UNIT_MAIN_M)).astype('uint8')
    da[sel] = np.minimum(255, np.round(nearest_m(all_lines, lon[sel], lat[sel]) / UNIT_ALL_M)).astype('uint8')

    r = era.ravel().copy()
    r[~inside] = 254
    rgba = np.stack([r, dm, da, np.full(len(r), 255, dtype='uint8')], axis=1).reshape(h, w, 4)
    Image.fromarray(rgba, 'RGBA').save(OUT_PNG, optimize=True)

    feats = [{'type': 'Feature', 'properties': {'k': k},
              'geometry': {'type': 'LineString', 'coordinates': [[round(x, 5), round(y, 5)] for x, y in c]}}
             for k, c in lines]
    OUT_GEO.write_text(json.dumps({'type': 'FeatureCollection', 'features': feats}, separators=(',', ':')))

    out_meta = {
        'w': w, 'h': h, 'bbox': meta['bbox'], 'cell_deg': cd, 'years': years, 'era_threshold': ERA_T,
        'unit_main_m': UNIT_MAIN_M, 'unit_all_m': UNIT_ALL_M,
        'attribution': 'Built-up: GHS-BUILT-S R2023A, European Commission, JRC (CC BY 4.0). Roads: OpenStreetMap contributors (ODbL), as mapped today.',
        'partial': partial,
    }
    if partial:
        # [west, south, east, north] boxes where roads are missing
        out_meta['missing_tiles'] = [[round(w_, 5), round(s_, 5), round(e_, 5), round(n_, 5)] for s_, w_, n_, e_ in missing]
    OUT_META.write_text(json.dumps(out_meta, separators=(',', ':')))

    grown = int(((era > 0) & (era < 254) & inside.reshape(h, w)).sum())
    print(f'wrote {OUT_PNG.name}, {OUT_GEO.name}, {OUT_META.name}  ({grown} cells were first built after {years[0]})'
          + ('  [PARTIAL]' if partial else ''))


if __name__ == '__main__':
    main()