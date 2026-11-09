#!/usr/bin/env python3
"""Day 9 data: the outline of the Caraga region, from OpenStreetMap (via Nominatim).

    python pipeline/09_caraga_boundary.py

Output: public/data/caraga-boundary.geojson   (one Polygon or MultiPolygon Feature)
It is used to clip and dim the Day 9 picture to the region, and to list only towns that lie inside it.
OpenStreetMap's outline is not an official boundary. Licence: OpenStreetMap contributors, ODbL.
"""
import json
import urllib.parse
import urllib.request
from datetime import date

from common import DATA, UA

NOMINATIM = "https://nominatim.openstreetmap.org/search"


def bbox_area(geom: dict) -> float:
    """Area of the bounding box in square degrees: only used to tell the big region from a small place of the same name."""
    polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
    pts = [p for poly in polys for p in poly[0]]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return (max(xs) - min(xs)) * (max(ys) - min(ys))


def pick_region(features: list[dict]) -> dict | None:
    """There is also a municipality called Caraga (in Davao Oriental), so take the largest polygon named Caraga."""
    cands = [
        f
        for f in features
        if f.get("geometry", {}).get("type") in ("Polygon", "MultiPolygon")
        and f.get("properties", {}).get("osm_type") == "relation"
        and "caraga" in (f["properties"].get("display_name", "") + f["properties"].get("name", "")).lower()
    ]
    return max(cands, key=lambda f: bbox_area(f["geometry"]), default=None)


def main() -> None:
    params = urllib.parse.urlencode(
        {
            "q": "Caraga, Philippines",
            "format": "geojson",
            "polygon_geojson": 1,
            "polygon_threshold": 0.001,  # about 100 m simplification: keeps the file small for a whole region
            "limit": 10,
        }
    )
    req = urllib.request.Request(f"{NOMINATIM}?{params}", headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r:
        result = json.load(r)
    f = pick_region(result.get("features", []))
    if not f:
        raise SystemExit("No polygon found for the Caraga region. Check the Nominatim response.")
    p = f["properties"]
    print(f"Boundary: {p.get('display_name')}  (relation {p.get('osm_id')})")
    f["properties"] = {
        "name": "Caraga",
        "osm_relation": p["osm_id"],
        "source": "OpenStreetMap contributors (ODbL) via Nominatim",
        "fetched": date.today().isoformat(),
    }
    DATA.mkdir(parents=True, exist_ok=True)
    out = DATA / "caraga-boundary.geojson"
    out.write_text(json.dumps(f, separators=(",", ":")))
    print(f"Wrote {out} ({out.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
