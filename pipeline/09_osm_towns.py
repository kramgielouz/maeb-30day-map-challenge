
#!/usr/bin/env python3
"""
Day 9 data: names and places of the cities and towns of Caraga,
from OpenStreetMap, to label the urban areas.

    python pipeline/09_osm_towns.py

Run 09_caraga_boundary.py first for an exact geographic filter.
Without it, province names are used.

Output:
    public/data/day09-towns.geojson

Points: name, place = city | town, population if tagged.

Licence: OpenStreetMap contributors, ODbL.
"""

import json

from common import DATA, overpass, ring_contains, write_geojson


PROVINCES = (
    "Agusan del Norte|Agusan del Sur|Surigao del Norte|"
    "Surigao del Sur|Dinagat Islands"
)

BBOX = (7.4, 124.9, 10.8, 126.9)


def run(q: str) -> list[dict]:
    """Execute an Overpass query and return its elements."""
    return overpass(q).get("elements", [])


def region_polys() -> list | None:
    """
    Get polygons of the Caraga outline written by
    09_caraga_boundary.py, or None if unavailable.
    """
    p = DATA / "caraga-boundary.geojson"

    if not p.exists():
        return None

    data = json.loads(p.read_text(encoding="utf-8"))
    g = data["geometry"]

    if g["type"] == "Polygon":
        return [g["coordinates"]]

    elif g["type"] == "MultiPolygon":
        return g["coordinates"]

    return None


def get_coordinates(el: dict) -> tuple[float, float] | None:
    """
    Extract longitude and latitude from an OSM element.

    Supports:
    - Nodes: lon, lat
    - Ways/Relations: center.lon, center.lat
    """
    if "lon" in el and "lat" in el:
        return float(el["lon"]), float(el["lat"])

    center = el.get("center")

    if center and "lon" in center and "lat" in center:
        return float(center["lon"]), float(center["lat"])

    return None


def inside(polys: list, lng: float, lat: float) -> bool:
    """Check whether a coordinate falls inside the Caraga boundary."""

    return any(
        ring_contains((lng, lat), poly[0])
        and not any(
            ring_contains((lng, lat), hole)
            for hole in poly[1:]
        )
        for poly in polys
    )


def main() -> None:

    polys = region_polys()

    if polys:

        # Calculate bounding box from the Caraga boundary.
        xs = [p[0] for poly in polys for p in poly[0]]
        ys = [p[1] for poly in polys for p in poly[0]]

        print("Using the Caraga outline to pick towns.")

        q = f"""
        [out:json][timeout:120];

        node["place"~"^(city|town)$"]
        ({min(ys)},{min(xs)},{max(ys)},{max(xs)});

        out body;
        """

        els = run(q)

        print(f"Retrieved {len(els)} OSM elements.")

        # Filter elements using actual coordinates.
        filtered = []

        for el in els:

            coords = get_coordinates(el)

            if coords is None:
                continue

            lng, lat = coords

            if inside(polys, lng, lat):
                filtered.append(el)

        els = filtered

        print(f"{len(els)} towns/cities found inside Caraga boundary.")

    else:

        print("Caraga boundary not found.")
        print("Using province administrative areas instead.")

        els = fetch_by_province()

    write(els)


def fetch_by_province() -> list[dict]:
    """Fetch city and town nodes using Caraga province boundaries."""

    q = f"""
    [out:json][timeout:120];

    area["boundary"="administrative"]
    ["name"~"^(Province of )?({PROVINCES})$"]->.caraga;

    node["place"~"^(city|town)$"](area.caraga);

    out body;
    """

    els = run(q)

    if not els:

        print(
            "No province areas found by name; "
            "falling back to the bounding box "
            "(labels may include places outside Caraga)."
        )

        els = run(f"""
        [out:json][timeout:120];

        node["place"~"^(city|town)$"]
        ({BBOX[0]},{BBOX[1]},{BBOX[2]},{BBOX[3]});

        out body;
        """)

    return els


def write(els: list[dict]) -> None:
    """Convert OSM elements into GeoJSON point features."""

    feats = []

    for el in els:

        t = el.get("tags", {})

        if not t.get("name"):
            continue

        coords = get_coordinates(el)

        if coords is None:
            continue

        lng, lat = coords

        # Extract population safely.
        try:
            population_text = str(t.get("population", "0"))
            pop = int(
                population_text.replace(",", "").split()[0]
            ) if population_text.strip() else 0

        except (ValueError, IndexError):
            pop = 0

        feats.append({
            "type": "Feature",
            "properties": {
                "name": t["name"],
                "place": t.get("place", "town"),
                "population": pop
            },
            "geometry": {
                "type": "Point",
                "coordinates": [
                    round(lng, 5),
                    round(lat, 5)
                ]
            }
        })

    print(f"Writing {len(feats)} named city/town features.")

    write_geojson(
        "day09-towns.geojson",
        feats,
        "OpenStreetMap contributors (ODbL), via Overpass"
    )

    print("Day 09 completed successfully.")


if __name__ == "__main__":
    main()
