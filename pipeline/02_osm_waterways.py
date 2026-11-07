#!/usr/bin/env python3
"""Day 2 data: waterways in Butuan City from OpenStreetMap.

    python pipeline/02_osm_waterways.py      (run 01_osm_facilities.py first)

Output: public/data/day02-waterways.geojson  (LineStrings: waterway = river | canal | stream | drain)
OSM draws waterway ways in the direction of flow, which the app uses for the flow animation.
Licence: OpenStreetMap contributors, ODbL.
"""
from common import butuan_bbox, in_city, overpass, write_geojson

CLASS = {"river": "river", "canal": "canal", "stream": "stream", "drain": "drain", "ditch": "drain"}


def main() -> None:
    s, w, n, e = butuan_bbox()
    q = f"""
[out:json][timeout:90];
way["waterway"~"^(river|canal|stream|drain|ditch)$"]({s},{w},{n},{e});
out geom tags;
"""
    data = overpass(q, timeout=120)
    feats = []
    for el in data.get("elements", []):
        geom = el.get("geometry") or []
        if len(geom) < 2 or not any(in_city(p["lon"], p["lat"]) for p in geom):
            continue  # skip waterways that never enter the city (the app clips the rest)
        tags = el.get("tags", {})
        feats.append(
            {
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": [[p["lon"], p["lat"]] for p in geom]},
                "properties": {
                    "osm_id": f"way/{el['id']}",
                    "waterway": CLASS[tags["waterway"]],
                    "name": tags.get("name", ""),
                },
            }
        )
    write_geojson("day02-waterways.geojson", feats, "OpenStreetMap contributors (ODbL)")


if __name__ == "__main__":
    main()
