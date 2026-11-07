#!/usr/bin/env python3
"""Day 3 data: barangay boundaries (OSM admin_level=10) inside Butuan City.

    python pipeline/03_osm_barangays.py      (run 01_osm_facilities.py first)

Output: public/data/barangays.geojson  (Polygon/MultiPolygon, properties: name, osm_id, pop)
Also writes public/data/barangays-dropped.json: every relation that was fetched but not kept, with the reason.
"""
import json
from collections import Counter

from common import DATA, butuan_bbox, overpass, ring_contains, write_geojson

EXPECTED = 86
KEEP_FRACTION = 0.3  # share of the largest ring's vertices that must fall inside the city polygon


def stitch(ways):
    """Join way fragments end-to-end into closed rings. Returns (closed_rings, leftover_open_chains)."""
    segs = [w[:] for w in ways if len(w) > 1]
    rings, open_chains = [], []
    while segs:
        ring = segs.pop()
        changed = True
        while changed and ring[0] != ring[-1]:
            changed = False
            for i, s in enumerate(segs):
                if s[0] == ring[-1]:
                    ring = ring + s[1:]
                elif s[-1] == ring[-1]:
                    ring = ring + s[::-1][1:]
                elif s[-1] == ring[0]:
                    ring = s[:-1] + ring
                elif s[0] == ring[0]:
                    ring = s[::-1][:-1] + ring
                else:
                    continue
                segs.pop(i)
                changed = True
                break
        if ring[0] == ring[-1] and len(ring) >= 4:
            rings.append(ring)
        else:
            open_chains.append(ring)
    return rings, open_chains


def load_city():
    """Read the city boundary ONCE and precompute each polygon's bbox (the old in_city re-read the file per point)."""
    g = json.loads((DATA / "butuan-boundary.geojson").read_text())["geometry"]
    polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
    out = []
    for p in polys:
        xs = [c[0] for c in p[0]]
        ys = [c[1] for c in p[0]]
        out.append((min(xs), min(ys), max(xs), max(ys), p))
    return out


def make_in_city(city):
    def in_city(pt):
        x, y = pt
        for x0, y0, x1, y1, p in city:
            if x0 <= x <= x1 and y0 <= y <= y1 and ring_contains(pt, p[0]) and not any(ring_contains(pt, h) for h in p[1:]):
                return True
        return False
    return in_city


def sample(ring, k=60):
    step = max(1, len(ring) // k)
    return ring[::step]


def main() -> None:
    s, w, n, e = butuan_bbox()
    q = f"""
[out:json][timeout:150];
rel["boundary"="administrative"]["admin_level"~"^(9|10)$"]({s},{w},{n},{e});
out geom tags;
"""
    data = overpass(q, timeout=200)
    elements = data.get("elements", [])
    if data.get("remark"):  # Overpass reports timeouts/out-of-memory here with HTTP 200 and an empty or partial result
        print("  OVERPASS REMARK:", data["remark"])
    print(f"Overpass returned {len(elements)} relations for bbox {s:.3f},{w:.3f},{n:.3f},{e:.3f}")
    print("  admin_level counts:", dict(Counter(el.get("tags", {}).get("admin_level") for el in elements)))

    city = load_city()
    in_city = make_in_city(city)
    print(f"  city boundary: {len(city)} polygon(s), bbox of first = {city[0][:4]}")

    feats, dropped = [], []
    for el in elements:
        tags = el.get("tags", {})
        name = tags.get("name", "")
        outer, inner = [], []
        for m in el.get("members", []):
            if m.get("type") != "way" or not m.get("geometry"):
                continue
            pts = [(p["lon"], p["lat"]) for p in m["geometry"] if p]
            (inner if m.get("role") == "inner" else outer).append(pts)
        outers, open_outer = stitch(outer)
        if not outers:
            dropped.append({"id": el["id"], "name": name, "reason": "no closed outer ring", "open_chains": len(open_outer), "outer_ways": len(outer)})
            continue
        biggest = max(outers, key=len)
        pts = sample(biggest)
        frac = sum(in_city(p) for p in pts) / len(pts)
        if frac < KEEP_FRACTION:
            dropped.append({"id": el["id"], "name": name, "reason": "outside city", "fraction_inside": round(frac, 2)})
            continue
        holes, _ = stitch(inner)
        polys = []
        for o in outers:
            hs = [h for h in holes if ring_contains(h[0], o)]
            polys.append([[list(p) for p in o]] + [[list(p) for p in h] for h in hs])
        pop = tags.get("population", "").replace(",", "").strip()
        feats.append(
            {
                "type": "Feature",
                "geometry": {"type": "MultiPolygon", "coordinates": polys},
                "properties": {"osm_id": f"relation/{el['id']}", "name": name, "pop": int(pop) if pop.isdigit() else None},
            }
        )
    feats.sort(key=lambda f: f["properties"]["name"])
    write_geojson("barangays.geojson", feats, "OpenStreetMap contributors (ODbL)")
    (DATA / "barangays-dropped.json").write_text(json.dumps(dropped, indent=1))
    print(f"Kept {len(feats)}, dropped {len(dropped)} (see public/data/barangays-dropped.json). Butuan has {EXPECTED}.")
    print("  drop reasons:", dict(Counter(d["reason"] for d in dropped)))


if __name__ == "__main__":
    main()