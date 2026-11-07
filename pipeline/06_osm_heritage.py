#!/usr/bin/env python3
"""Day 6 data: heritage sites and museums in Butuan City from OpenStreetMap.

    python pipeline/06_osm_heritage.py      (run 01_osm_facilities.py first)

Output: public/data/day06-heritage.geojson  (Points: kind = archaeological | museum | monument | other)
Licence: OpenStreetMap contributors, ODbL.
"""
import re

from common import butuan_bbox, in_city, overpass, write_geojson

BALANGAY = re.compile(r"balang?hai|balangay|archaeolog", re.I)


def kind_of(tags: dict) -> tuple[str, str]:
    h = tags.get("historic")
    name = tags.get("name", "")
    if h == "archaeological_site" or BALANGAY.search(name):
        return "archaeological", h or "named for the balanghai"
    if tags.get("tourism") == "museum":
        return "museum", "museum"
    if h in {"monument", "memorial", "wayside_cross", "wayside_shrine", "cannon", "ship", "boundary_stone"}:
        return "monument", h
    return "other", h or "heritage"


def main() -> None:
    s, w, n, e = butuan_bbox()
    box = f"({s},{w},{n},{e})"
    q = f"""
[out:json][timeout:120];
(
  nwr["historic"]{box};
  nwr["tourism"="museum"]{box};
  nwr["name"~"balang?hai|balangay|archaeolog",i][!"place"][!"highway"]{box};
);
out center tags;
"""
    feats, seen = [], set()
    for el in overpass(q).get("elements", []):
        tags = el.get("tags", {})
        if not tags.get("name"):
            continue
        c = el.get("center") or {"lat": el.get("lat"), "lon": el.get("lon")}
        if c.get("lat") is None or not in_city(c["lon"], c["lat"]):
            continue
        key = (el["type"], el["id"])
        if key in seen:
            continue
        seen.add(key)
        kind, detail = kind_of(tags)
        feats.append(
            {
                "type": "Feature",
                "properties": {"name": tags["name"], "kind": kind, "detail": detail.replace("_", " "), "osm": f"{el['type']}/{el['id']}"},
                "geometry": {"type": "Point", "coordinates": [round(c["lon"], 6), round(c["lat"], 6)]},
            }
        )
    write_geojson("day06-heritage.geojson", feats, "OpenStreetMap contributors (ODbL), via Overpass")


if __name__ == "__main__":
    main()
