#!/usr/bin/env python3
"""Day 9 data: how built-up Butuan City was in each of 10 years (1975 to 2020), from the GHSL.

    pip install rasterio numpy
    python pipeline/09_ghsl_built.py      (run 01_osm_facilities.py first, for the city boundary)

Source: GHS-BUILT-S R2023A, built-up surface per ~100 m (3 arc-second) cell, in 5-year steps.
It downloads the one 10 x 10 degree tile that covers the city for each year (a few MB to a few tens of MB each,
cached in pipeline/_cache) and crops it to the city.
Output: public/data/day09-built.png   8-bit greyscale. The 10 years are stacked top to bottom, each w x h pixels.
                                      Pixel value = built-up share of the cell (0 to 255 = 0 to 100%).
        public/data/day09-built.json  bbox, grid size, years and attribution
Years before the satellite era of each region are interpolated or extrapolated by GHSL, so treat the early years as estimates.
Licence: CC BY 4.0, European Commission, Joint Research Centre (JRC).
"""
import json
import math
import shutil
import struct
import sys
import urllib.request
import zipfile
import zlib
from datetime import date
from pathlib import Path

import numpy as np

from common import DATA, UA, butuan_bbox

YEARS = list(range(1975, 2021, 5))
URL = (
    "https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/GHS_BUILT_S_GLOBE_R2023A/"
    "GHS_BUILT_S_E{y}_GLOBE_R2023A_4326_3ss/V1-0/tiles/GHS_BUILT_S_E{y}_GLOBE_R2023A_4326_3ss_V1_0_{tile}.zip"
)
CACHE = Path(__file__).resolve().parent / "_cache"
CELL_DEG = 1 / 1200  # 3 arc-seconds
ATTRIBUTION = "GHS-BUILT-S R2023A, European Commission, Joint Research Centre (JRC), CC BY 4.0"


def tile_name(lat: float, lng: float) -> str:
    """The GHSL 3ss grid is 10 x 10 degree tiles: rows count down from 90N, columns count east from 180W (R9_C31 covers 0-10N, 120-130E)."""
    return f"R{math.floor((90 - lat) / 10) + 1}_C{math.floor((lng + 180) / 10) + 1}"


def tiles_for(s: float, w: float, n: float, e: float) -> list[str]:
    return sorted({tile_name(la, lo) for la in (s, n) for lo in (w, e)})


def fetch_tif(year: int, tile: str) -> Path:
    """Download (once) and unzip the GeoTIFF for one year and tile."""
    CACHE.mkdir(exist_ok=True)
    out = CACHE / f"built_{year}_{tile}.tif"
    if out.exists():
        return out
    zpath = CACHE / f"built_{year}_{tile}.zip"
    url = URL.format(y=year, tile=tile)
    print(f"  downloading {year} {tile} ...", flush=True)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=300) as r, open(zpath, "wb") as f:
        shutil.copyfileobj(r, f)
    with zipfile.ZipFile(zpath) as z:
        names = [m for m in z.namelist() if m.lower().endswith(".tif")]
        if not names:
            sys.exit(f"No .tif found in {zpath.name}")
        with z.open(names[0]) as src, open(out, "wb") as dst:
            shutil.copyfileobj(src, dst)
    zpath.unlink()
    return out


def built_share(arr: np.ndarray, north: float, nodata) -> np.ndarray:
    """Convert built-up surface (m2 per cell) to the share of the cell, 0 to 1."""
    a = arr.astype(np.float32)
    if nodata is not None:
        a[arr == nodata] = 0
    a[a < 0] = 0
    h = a.shape[0]
    lat = north - (np.arange(h) + 0.5) * CELL_DEG
    cell_m2 = (CELL_DEG * 111320) * (CELL_DEG * 111320 * np.cos(np.radians(lat)))
    return np.clip(a / cell_m2[:, None], 0, 1)


def write_png_gray(path, img: np.ndarray) -> None:
    h, w = img.shape
    raw = b"".join(b"\x00" + img[j].tobytes() for j in range(h))

    def chunk(t: bytes, d: bytes) -> bytes:
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def read_year(tifs: list[Path], bounds) -> tuple[np.ndarray, float, float]:
    import rasterio
    from rasterio.merge import merge

    dss = [rasterio.open(p) for p in tifs]
    try:
        arr, tf = merge(dss, bounds=bounds, res=CELL_DEG, nodata=dss[0].nodata)
        nodata = dss[0].nodata
    finally:
        for d in dss:
            d.close()
    return arr[0], tf.c, tf.f, nodata


def main() -> None:
    s, w, n, e = butuan_bbox(0.01)
    tiles = tiles_for(s, w, n, e)
    print("Tiles:", ", ".join(tiles))
    layers, west, north = [], None, None
    for y in YEARS:
        tifs = [fetch_tif(y, t) for t in tiles]
        arr, west, north, nodata = read_year(tifs, (w, s, e, n))
        layers.append(np.rint(built_share(arr, north, nodata) * 255).astype(np.uint8))
    h, wd = layers[0].shape
    DATA.mkdir(parents=True, exist_ok=True)
    write_png_gray(DATA / "day09-built.png", np.vstack(layers))
    (DATA / "day09-built.json").write_text(
        json.dumps(
            {
                "bbox": [west, north - h * CELL_DEG, west + wd * CELL_DEG, north],
                "w": wd,
                "h": h,
                "cell_deg": CELL_DEG,
                "years": YEARS,
                "layout": "stacked top to bottom, one h-row block per year",
                "source": "GHS-BUILT-S R2023A (CC BY 4.0)",
                "attribution": ATTRIBUTION,
                "fetched": date.today().isoformat(),
            }
        )
    )
    tot = [float(l.mean()) / 255 * 100 for l in layers]
    print(f"Wrote {wd} x {h} cells x {len(YEARS)} years. Mean built-up share of the box: {tot[0]:.2f}% in {YEARS[0]} to {tot[-1]:.2f}% in {YEARS[-1]}.")


if __name__ == "__main__":
    main()
