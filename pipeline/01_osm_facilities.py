#!/usr/bin/env python3
"""Day 1 data: Butuan City boundary + critical facilities, both from OpenStreetMap.

Run once locally (not from the deployed app), then commit the output:
    python pipeline/01_osm_facilities.py

Outputs (in public/data/):
    butuan-boundary.geojson        city boundary polygon (Nominatim / OSM)
    day01-facilities.geojson       facilities inside that boundary (Overpass / OSM)

Needs only the Python standard library (3.10+).
Licence: OpenStreetMap contributors, ODbL. Keep the attribution in the app footer.
"""
import json
import pathlib
import sys
import time
import urllib.parse
import urllib.request
from datetime import date

UA = "butuan-unfolded-30daymapchallenge/0.1"
NOMINATIM = "https://nominatim.openstreetmap.org/search"
OVERPASS = "https://overpass-api.de/api/interpreter"
OUT_DIR = pathlib.Path(__file__).resolve().parent.parent / "public" / "data"


def fetch(url: str, data: bytes | None = None, timeout: int = 120) -> dict:
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def fetch_boundary() -> dict:
    """Return a GeoJSON Feature for the Butuan City administrative boundary."""
    params = urllib.parse.urlencode(
        {
            "q": "Butuan City, Philippines",
            "format": "geojson",
            "polygon_geojson": 1,
            "polygon_threshold": 0.0003,  # light simplification (~30 m) keeps the file small
            "limit": 5,
        }
    )
    result = fetch(f"{NOMINATIM}?{params}")
    for f in result.get("features", []):
        p = f.get("properties", {})
        if f["geometry"]["type"] in ("Polygon", "MultiPolygon") and p.get("osm_type") == "relation":
            print(f"Boundary: {p.get('display_name')}  (relation {p.get('osm_id')})")
            f["properties"] = {
                "name": "Butuan City",
                "osm_relation": p["osm_id"],
                "source": "OpenStreetMap contributors (ODbL) via Nominatim",
                "fetched": date.today().isoformat(),
            }
            return f
    raise RuntimeError("No polygon boundary found for Butuan City. Check the Nominatim response.")


def kind_of(tags: dict) -> str | None:
    a = tags.get("amenity")
    if a in ("hospital", "school", "fire_station", "police"):
        return a
    if a == "clinic" or tags.get("healthcare") == "centre":
        return "clinic"
    return None


def fetch_facilities(relation_id: int) -> list[dict]:
    area = 3600000000 + int(relation_id)  # Overpass area id for an OSM relation
    q = f"""
[out:json][timeout:60];
area({area})->.a;
(
  nwr["amenity"="hospital"](area.a);
  nwr["amenity"="clinic"](area.a);
  nwr["healthcare"="centre"](area.a);
  nwr["amenity"="school"](area.a);
  nwr["amenity"="fire_station"](area.a);
  nwr["amenity"="police"](area.a);
);
out center tags;
"""
    data = fetch(OVERPASS, urllib.parse.urlencode({"data": q}).encode())
    features = []
    for el in data.get("elements", []):
        tags = el.get("tags", {})
        kind = kind_of(tags)
        lon = el.get("lon") or el.get("center", {}).get("lon")
        lat = el.get("lat") or el.get("center", {}).get("lat")
        if not kind or lon is None or lat is None:
            continue
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": {"osm_id": f"{el['type']}/{el['id']}", "kind": kind, "name": tags.get("name", "")},
            }
        )
    return features


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    boundary = fetch_boundary()
    (OUT_DIR / "butuan-boundary.geojson").write_text(json.dumps(boundary))
    print(f"Wrote boundary to {OUT_DIR / 'butuan-boundary.geojson'}")

    time.sleep(2)  # be polite to the public servers
    features = fetch_facilities(boundary["properties"]["osm_relation"])
    (OUT_DIR / "day01-facilities.geojson").write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "metadata": {"source": "OpenStreetMap contributors (ODbL)", "fetched": date.today().isoformat()},
                "features": features,
            }
        )
    )
    print(f"Wrote {len(features)} facilities to {OUT_DIR / 'day01-facilities.geojson'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
