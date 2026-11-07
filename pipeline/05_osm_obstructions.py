#!/usr/bin/env python3
"""Day 5 data: a 30 m raster of what blocks the view on the ground (buildings and woodland), from OpenStreetMap.

    python pipeline/05_osm_obstructions.py      (run 01_osm_facilities.py first)

Output: public/data/obstruction.png   8-bit greyscale, pixel value = obstruction height in metres (0 = open ground)
        public/data/obstruction.json  bounding box [west, south, east, north] and grid size
Heights: `height` tag, else `building:levels` x 3 m + 1 m, else 5 m for a building; woodland is a flat 12 m.
Licence: OpenStreetMap contributors, ODbL.
"""
import json
import math
import re
import struct
import zlib
from datetime import date

from common import DATA, butuan_bbox, overpass

CELL_M = 30
SPLIT = 3  # query the city as SPLIT x SPLIT tiles so Overpass does not time out
WOOD_H = 12.0
BUILDING_H = 5.0


def number(v: str | None) -> float | None:
    if not v:
        return None
    m = re.match(r"\s*(\d+(?:\.\d+)?)", v.replace(",", "."))
    return float(m.group(1)) if m else None


def height_of(tags: dict) -> float:
    if "building" in tags:
        h = number(tags.get("height")) or number(tags.get("building:height"))
        if h:
            return min(h, 255.0)
        lv = number(tags.get("building:levels"))
        return min(lv * 3 + 1, 255.0) if lv else BUILDING_H
    return WOOD_H


def rings_of(el: dict) -> list[list[tuple[float, float]]]:
    """Polygon rings (lon, lat) of a way or of the outer members of a relation."""
    if el["type"] == "way":
        g = el.get("geometry") or []
        return [[(p["lon"], p["lat"]) for p in g]] if len(g) >= 3 else []
    out = []
    for m in el.get("members", []):
        g = m.get("geometry") or []
        if m.get("role") == "outer" and len(g) >= 3:
            out.append([(p["lon"], p["lat"]) for p in g])
    return out


class Grid:
    def __init__(self, bbox: tuple[float, float, float, float]):
        s, w, n, e = bbox
        self.w0, self.n0 = w, n
        lat0 = (s + n) / 2
        self.dlat = CELL_M / 111320
        self.dlng = CELL_M / (111320 * math.cos(math.radians(lat0)))
        self.W = math.ceil((e - w) / self.dlng)
        self.H = math.ceil((n - s) / self.dlat)
        self.east = w + self.W * self.dlng
        self.south = n - self.H * self.dlat
        self.cells = bytearray(self.W * self.H)

    def put(self, i: int, j: int, h: int) -> None:
        if 0 <= i < self.W and 0 <= j < self.H:
            k = j * self.W + i
            if h > self.cells[k]:
                self.cells[k] = h

    def fill(self, ring: list[tuple[float, float]], height: float) -> None:
        h = max(1, min(255, round(height)))
        pts = [((x - self.w0) / self.dlng, (self.n0 - y) / self.dlat) for x, y in ring]
        ys = [p[1] for p in pts]
        j0, j1 = max(0, math.floor(min(ys))), min(self.H - 1, math.floor(max(ys)))
        hit = False
        for j in range(j0, j1 + 1):
            yc = j + 0.5
            xs = []
            for a in range(len(pts)):
                (xa, ya), (xb, yb) = pts[a], pts[(a + 1) % len(pts)]
                if (ya > yc) != (yb > yc):
                    xs.append(xa + (yc - ya) * (xb - xa) / (yb - ya))
            xs.sort()
            for a in range(0, len(xs) - 1, 2):
                for i in range(math.ceil(xs[a] - 0.5), math.floor(xs[a + 1] - 0.5) + 1):
                    self.put(i, j, h)
                    hit = True
        if not hit:  # smaller than one cell: mark the cell it sits in
            self.put(int(sum(p[0] for p in pts) / len(pts)), int(sum(ys) / len(ys)), h)


def write_png(path, w: int, h: int, cells: bytearray) -> None:
    raw = b"".join(b"\x00" + bytes(cells[j * w : (j + 1) * w]) for j in range(h))

    def chunk(t: bytes, d: bytes) -> bytes:
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def main() -> None:
    s, w, n, e = butuan_bbox(0.02)  # a little extra so views from the edge still see neighbours
    grid = Grid((s, w, n, e))
    print(f"Grid {grid.W} x {grid.H} cells of {CELL_M} m")
    dy, dx = (n - s) / SPLIT, (e - w) / SPLIT
    n_poly = 0
    for a in range(SPLIT):
        for b in range(SPLIT):
            box = f"({s + a * dy},{w + b * dx},{s + (a + 1) * dy},{w + (b + 1) * dx})"
            print(f"Tile {a * SPLIT + b + 1}/{SPLIT * SPLIT}")
            q = f"""
[out:json][timeout:180];
(
  way["building"]{box};
  way["natural"="wood"]{box};
  way["landuse"="forest"]{box};
  relation["natural"="wood"]{box};
  relation["landuse"="forest"]{box};
);
out geom;
"""
            for el in overpass(q, timeout=240).get("elements", []):
                tags = el.get("tags", {})
                if tags.get("building") == "no":
                    continue
                for ring in rings_of(el):
                    grid.fill(ring, height_of(tags))
                    n_poly += 1
    DATA.mkdir(parents=True, exist_ok=True)
    write_png(DATA / "obstruction.png", grid.W, grid.H, grid.cells)
    covered = sum(1 for v in grid.cells if v)
    (DATA / "obstruction.json").write_text(
        json.dumps(
            {
                "bbox": [grid.w0, grid.south, grid.east, grid.n0],
                "w": grid.W,
                "h": grid.H,
                "cell_m": CELL_M,
                "source": "OpenStreetMap contributors (ODbL): building and woodland polygons",
                "fetched": date.today().isoformat(),
            }
        )
    )
    print(f"Rasterised {n_poly} polygons; {covered / len(grid.cells):.1%} of cells hold an obstruction.")


if __name__ == "__main__":
    main()
