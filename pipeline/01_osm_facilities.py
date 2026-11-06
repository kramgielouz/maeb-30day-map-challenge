#!/usr/bin/env python3
"""Day 1 data: critical facilities in Butuan City from OpenStreetMap (Overpass API).

Run once locally (not from the deployed app), then commit the output:
    python pipeline/01_osm_facilities.py

Output: public/data/day01-facilities.geojson
Licence: OpenStreetMap contributors, ODbL. Keep the attribution in the app footer.
"""
import json
import pathlib
import sys
import urllib.parse
import urllib.request
from datetime import date

# Rough bounding box around Butuan City: south, west, north, east.
# TODO: replace with the official barangay boundary (HDX COD-AB) once Day 3 data is in.
BBOX = (8.75, 125.30, 9.15, 125.75)
OVERPASS = "https://overpass-api.de/api/interpreter"
OUT = pathlib.Path(__file__).resolve().parent.parent / "public" / "data" / "day01-facilities.geojson"

QUERY = f"""
[out:json][timeout:60];
(
  nwr["amenity"="hospital"]({BBOX[0]},{BBOX[1]},{BBOX[2]},{BBOX[3]});
  nwr["amenity"="clinic"]({BBOX[0]},{BBOX[1]},{BBOX[2]},{BBOX[3]});
  nwr["healthcare"="centre"]({BBOX[0]},{BBOX[1]},{BBOX[2]},{BBOX[3]});
  nwr["amenity"="school"]({BBOX[0]},{BBOX[1]},{BBOX[2]},{BBOX[3]});
  nwr["amenity"="fire_station"]({BBOX[0]},{BBOX[1]},{BBOX[2]},{BBOX[3]});
  nwr["amenity"="police"]({BBOX[0]},{BBOX[1]},{BBOX[2]},{BBOX[3]});
);
out center tags;
"""


def kind_of(tags: dict) -> str | None:
    a = tags.get("amenity")
    if a in ("hospital", "school", "fire_station", "police"):
        return a
    if a == "clinic" or tags.get("healthcare") == "centre":
        return "clinic"
    return None


def main() -> int:
    req = urllib.request.Request(
        OVERPASS,
        data=urllib.parse.urlencode({"data": QUERY}).encode(),
        headers={"User-Agent": "butuan-unfolded-30daymapchallenge/0.1"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        data = json.load(r)

    features = []
    for el in data.get("elements", []):
        tags = el.get("tags", {})
        kind = kind_of(tags)
        if not kind:
            continue
        lon = el.get("lon") or el.get("center", {}).get("lon")
        lat = el.get("lat") or el.get("center", {}).get("lat")
        if lon is None or lat is None:
            continue
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": {"osm_id": f"{el['type']}/{el['id']}", "kind": kind, "name": tags.get("name", "")},
            }
        )

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "metadata": {"source": "OpenStreetMap contributors (ODbL)", "fetched": date.today().isoformat(), "bbox": BBOX},
                "features": features,
            }
        )
    )
    print(f"Wrote {len(features)} features to {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
