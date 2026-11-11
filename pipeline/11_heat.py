#!/usr/bin/env python3
"""Day 11 data: land surface temperature on a 500 m grid, for the "Hear the heat" chapter.

Standard library only.

    python pipeline/11_heat.py

Real data path
    1. Run gee/day11_lst_export.js in the Google Earth Engine Code Editor and start the export task.
    2. Save the CSV from Google Drive as public/data/day11-lst-export.csv
       (columns: lon, lat, lst_YYYY, ndvi_YYYY for each year; empty cells are allowed).
    3. Run this script. It keeps the cells inside public/data/butuan-boundary.geojson and writes public/data/day11-heat.json.

No CSV found
    The script writes a SYNTHETIC demo dataset instead, so the page can be tried before the export is done. It is
    generated from simple rules (a hot core, hot airport apron, cool river, forest and coast) and is flagged
    "synthetic" in the file. The page shows a banner whenever it is loaded. Do not publish the demo as a measurement.

Rural reference (for "above rural" / UHI)
    Mean LST of the cells whose NDVI is at least NDVI_REF in that year. Change NDVI_REF below to match your UHI project.
    If fewer than MIN_REF cells qualify (or there is no NDVI), the coolest 20% of cells are used instead and the file says so.
"""
from __future__ import annotations

import csv
import json
import math
import pathlib
from datetime import date

ROOT = pathlib.Path(__file__).resolve().parent.parent
BOUNDARY = ROOT / "public" / "data" / "butuan-boundary.geojson"
EXPORT = ROOT / "public" / "data" / "day11-lst-export.csv"
OUT = ROOT / "public" / "data" / "day11-heat.json"

YEARS = [2020, 2023, 2026]
GRID_M = 500
NDVI_REF = 0.55
MIN_REF = 20
SEASON = "Feb 1 to May 31"

LON0, LAT0 = 125.5406, 8.9475
KX = 111320.0 * math.cos(math.radians(LAT0))
KY = 110950.0


def rings(path: pathlib.Path) -> list[list[list[float]]]:
    gj = json.loads(path.read_text())
    g = gj["geometry"] if gj.get("type") == "Feature" else gj
    polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
    return [p[0] for p in polys]


def inside(x: float, y: float, rs: list[list[list[float]]]) -> bool:
    for ring in rs:
        ins = False
        j = len(ring) - 1
        for i in range(len(ring)):
            xi, yi = ring[i]
            xj, yj = ring[j]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                ins = not ins
            j = i
        if ins:
            return True
    return False


def num(v: str | None) -> float | None:
    if v is None or v.strip() == "":
        return None
    try:
        f = float(v)
    except ValueError:
        return None
    return f if math.isfinite(f) else None


def from_export(rs):
    pts, ndvi = [], []
    with EXPORT.open(newline="") as fh:
        rd = csv.DictReader(fh)
        for row in rd:
            lon, lat = num(row.get("lon")), num(row.get("lat"))
            if lon is None or lat is None or not inside(lon, lat, rs):
                continue
            lst = [num(row.get(f"lst_{y}")) for y in YEARS]
            nd = [num(row.get(f"ndvi_{y}")) for y in YEARS]
            if all(v is None for v in lst):
                continue
            pts.append([round(lon, 5), round(lat, 5)] + [None if v is None else round(v, 1) for v in lst])
            ndvi.append(nd)
    return pts, ndvi


def noise(a: float, b: float, k: int) -> float:
    return (math.sin(a * 12.9898 + b * 78.233 + k * 37.719) * 43758.5453) % 1.0 - 0.5


def synthetic(rs):
    """A demo surface. Made up from rules, not measured."""
    hot = [  # x km, y km (east, north of downtown), sigma km, peak degrees
        (0.0, 0.0, 2.3, 5.8),  # downtown
        (-6.8, 0.4, 1.3, 4.0),  # airport apron
        (8.2, -2.1, 1.5, 2.6),  # east town
        (2.3, -13.2, 1.5, 2.2),  # south town
        (-3.3, 4.3, 1.4, 2.0),  # waterfront town
        (7.2, 2.6, 1.6, 2.2),  # north-east
    ]
    river_x = lambda y: 0.6 + 0.2 * math.sin(y / 3.0)  # km east of downtown
    pts, ndvi = [], []
    ix0, ix1 = int(-12000 // GRID_M), int(24000 // GRID_M)
    iy0, iy1 = int(-24000 // GRID_M), int(13000 // GRID_M)
    for ix in range(ix0, ix1 + 1):
        for iy in range(iy0, iy1 + 1):
            x, y = ix * GRID_M, iy * GRID_M
            lon, lat = LON0 + x / KX, LAT0 + y / KY
            if not inside(lon, lat, rs):
                continue
            xk, yk = x / 1000, y / 1000
            urban = sum(p * math.exp(-((xk - hx) ** 2 + (yk - hy) ** 2) / (2 * s * s)) for hx, hy, s, p in hot)
            cool = 0.0
            cool += 2.2 * math.exp(-((xk - river_x(yk)) ** 2) / (2 * 0.35**2)) * (1 if yk < 3.5 else 0)  # river corridor
            cool += 3.6 * (1 / (1 + math.exp(-(xk - 10.0) / 0.9))) * (1 if yk < 3 else 0)  # eastern uplands
            cool += 3.2 * (1 / (1 + math.exp((yk + 18.5) / 0.9)))  # southern uplands
            cool += 1.8 * (1 / (1 + math.exp(-(yk - 8.5) / 0.6)))  # coast and marsh
            veg = max(0.0, min(0.9, 0.78 - urban * 0.09 + 0.07 * noise(x, y, 5)))
            row = [round(lon, 5), round(lat, 5)]
            nd = []
            for k, yr in enumerate(YEARS):
                grow = 1.0 + 0.07 * k
                warm = 0.55 * k
                t = 30.4 + warm + urban * grow - cool + 1.1 * noise(x, y, k + 1)
                if abs(noise(x, y, 9 + k)) > 0.485:  # a few cloudy cells
                    row.append(None)
                    nd.append(None)
                else:
                    row.append(round(t, 1))
                    nd.append(round(veg, 2))
            pts.append(row)
            ndvi.append(nd)
    return pts, ndvi


def reference(pts, ndvi):
    ref, notes = {}, []
    for k, yr in enumerate(YEARS):
        vals = [(p[2 + k], ndvi[i][k]) for i, p in enumerate(pts) if p[2 + k] is not None]
        veg = [t for t, n in vals if n is not None and n >= NDVI_REF]
        if len(veg) >= MIN_REF:
            ref[str(yr)] = round(sum(veg) / len(veg), 1)
            notes.append(f"{yr}: mean LST of {len(veg)} cells with NDVI >= {NDVI_REF}")
        else:
            cool = sorted(t for t, _ in vals)[: max(1, len(vals) // 5)]
            ref[str(yr)] = round(sum(cool) / len(cool), 1)
            notes.append(f"{yr}: coolest 20% of cells (too few cells with NDVI >= {NDVI_REF})")
    return ref, notes


def main() -> None:
    rs = rings(BOUNDARY)
    is_demo = not EXPORT.exists()
    pts, ndvi = synthetic(rs) if is_demo else from_export(rs)
    if not pts:
        raise SystemExit("No cells fell inside the city boundary. Check the CSV columns and the boundary file.")
    ref, notes = reference(pts, ndvi)
    meta = {
        "synthetic": is_demo,
        "years": YEARS,
        "season": SEASON,
        "grid_m": GRID_M,
        "ref": ref,
        "ref_method": notes,
        "generated": date.today().isoformat(),
        "source": (
            "SYNTHETIC DEMO: generated by pipeline/11_heat.py from simple rules, not measured."
            if is_demo
            else "Landsat 8/9 Collection 2 Level-2 (USGS), median composite per year, processed in Google Earth Engine"
        ),
    }
    OUT.write_text(json.dumps({"meta": meta, "pts": pts}, separators=(",", ":")))
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e3:.0f} kB): {len(pts)} cells, {'SYNTHETIC demo' if is_demo else 'real export'}")
    print("reference (rural) temperatures:", ref)


if __name__ == "__main__":
    main()
