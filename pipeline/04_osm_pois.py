#!/usr/bin/env python3
"""Day 4 data: points of interest in Butuan City from OpenStreetMap.

    python pipeline/04_osm_pois.py      (run 01_osm_facilities.py first)

Output: public/data/day04-pois.geojson  (Points: group = food | retail | health | education | finance | worship | government | lodging | other)
Licence: OpenStreetMap contributors, ODbL.
"""
from common import butuan_bbox, in_city, overpass, write_geojson

NOISE = "bench|waste_basket|parking|parking_space|parking_entrance|bicycle_parking|motorcycle_parking|shelter|toilets|drinking_water|post_box|vending_machine|waste_disposal|lounger|clock|fountain|recycling|bbq|grave_yard|hunting_stand|loading_dock|taxi|bus_station|bicycle_rental|charging_station|fuel"

GROUPS = {
    "food": {"restaurant", "cafe", "fast_food", "bar", "pub", "canteen", "food_court", "ice_cream", "biergarten"},
    "health": {"pharmacy", "clinic", "hospital", "dentist", "doctors", "veterinary", "healthcare"},
    "education": {"school", "college", "university", "kindergarten", "library", "language_school", "driving_school"},
    "finance": {"bank", "atm", "bureau_de_change", "money_transfer", "pawnbroker"},
    "worship": {"place_of_worship"},
    "government": {"townhall", "police", "fire_station", "courthouse", "community_centre", "public_building", "government"},
    "lodging": {"hotel", "guest_house", "hostel", "motel", "resort", "apartment"},
}


def group_of(tags: dict) -> tuple[str, str]:
    amenity = tags.get("amenity")
    if amenity:
        for g, s in GROUPS.items():
            if amenity in s:
                return g, amenity
        return "other", amenity
    if tags.get("shop"):
        return "retail", tags["shop"]
    t = tags.get("tourism")
    if t:
        return ("lodging" if t in GROUPS["lodging"] else "other"), t
    if tags.get("office") == "government":
        return "government", "office"
    return "other", "poi"


def main() -> None:
    s, w, n, e = butuan_bbox()
    box = f"({s},{w},{n},{e})"
    q = f"""
[out:json][timeout:120];
(
  nwr["amenity"]["amenity"!~"^({NOISE})$"]{box};
  nwr["shop"]{box};
  nwr["tourism"~"^(hotel|guest_house|hostel|motel|attraction|museum|resort|viewpoint)$"]{box};
  nwr["office"="government"]{box};
);
out center tags;
"""
    data = overpass(q, timeout=150)
    feats = []
    for el in data.get("elements", []):
        lon = el.get("lon") or el.get("center", {}).get("lon")
        lat = el.get("lat") or el.get("center", {}).get("lat")
        if lon is None or lat is None or not in_city(lon, lat):
            continue
        tags = el.get("tags", {})
        group, cat = group_of(tags)
        feats.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": {"osm_id": f"{el['type']}/{el['id']}", "group": group, "cat": cat, "name": tags.get("name", "")},
            }
        )
    write_geojson("day04-pois.geojson", feats, "OpenStreetMap contributors (ODbL)")


if __name__ == "__main__":
    main()
