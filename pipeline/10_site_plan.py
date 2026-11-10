#!/usr/bin/env python3
"""Day 10 data: a conceptual Site Development Plan for Butuan City, generated from the city boundary alone.

    pip install shapely numpy            (Day 10 only)
    python pipeline/10_site_plan.py

Input : public/data/butuan-boundary.geojson   (OpenStreetMap, ODbL, the file the other days use)
Output: public/data/day10-plan.geojson        (one FeatureCollection: zones, blocks, roads, transit, stations,
                                               greenways, projects, hubs, labels, plus `legend` and `stats`)

This is the "built by prompt" part: the planning brief, the land-use classes, the street grid and the numbers
were all written by an AI assistant from one prompt (see PROMPT below). Nothing here is surveyed. Where the plan
touches real places (downtown, Bancasi Airport) it uses their approximate coordinates and says so. Every
number in `stats` is either measured from the generated geometry or labelled as an assumption.

The run is deterministic: no random numbers are used, so the same boundary gives the same plan.
Licence of the boundary: OpenStreetMap contributors, ODbL.
"""
from __future__ import annotations

import json
import math
import pathlib
from datetime import date

import numpy as np
import shapely
from shapely import affinity
from shapely.geometry import LineString, MultiLineString, MultiPolygon, Point, Polygon, box, mapping, shape
from shapely.ops import unary_union

ROOT = pathlib.Path(__file__).resolve().parent.parent
BOUNDARY = ROOT / "public" / "data" / "butuan-boundary.geojson"
OUT = ROOT / "public" / "data" / "day10-plan.geojson"

PROMPT = (
    "You are an expert urban planner, design/reimagine the city using the butuan-boundary.geojson, into a "
    "progressive, self sustaining and world-class city. Create a \"Site Development Plan\"-like map of the city"
)

# ----------------------------------------------------------------------------------------------------------
# Local metric frame: metres east / north of downtown. Good to a few metres over a 35 km city.
# ----------------------------------------------------------------------------------------------------------
LON0, LAT0 = 125.5406, 8.9475
KX = 111320.0 * math.cos(math.radians(LAT0))
KY = 110950.0


def xy(lon: float, lat: float) -> tuple[float, float]:
    return ((lon - LON0) * KX, (lat - LAT0) * KY)


def ll(x: float, y: float) -> tuple[float, float]:
    return (x / KX + LON0, y / KY + LAT0)


def pt(lon: float, lat: float) -> Point:
    return Point(*xy(lon, lat))


def to_ll(g):
    return shapely.transform(g, lambda c: np.column_stack([c[:, 0] / KX + LON0, c[:, 1] / KY + LAT0]))


def rnd(g, nd: int = 5):
    return shapely.transform(g, lambda c: np.round(c, nd))


# ----------------------------------------------------------------------------------------------------------
# Land-use classes. This table is written into the output, so the web page has exactly one source of truth.
# ----------------------------------------------------------------------------------------------------------
# key, group, label, colour, pattern, density (persons per hectare of block land, assumption), description
LEGEND = [
    ("cbd", "Urban", "Central business & civic core", "#d6504a", None, 220, "Mid- and high-rise offices, city hall, courts, convention centre. Ground floors open to the street, no surface parking."),
    ("mixed", "Urban", "Mixed-use transit corridor", "#f09a45", None, 160, "Homes above shops and services within a 5-minute walk of a station. Reduced parking, wide sidewalks."),
    ("res_med", "Urban", "Residential, medium density", "#f6d46a", None, 110, "Walk-up and mid-rise housing around a neighbourhood hub. Mixed tenure, including social housing."),
    ("res_low", "Urban", "Residential, low density", "#fbf0b8", None, 45, "Detached and row houses with gardens on the edge of the urban area. Raised plinths, rainwater tanks."),
    ("inst", "Urban", "Neighbourhood hub (school, clinic, market)", "#4f7fd1", None, 0, "One per 1 km square: elementary school, health centre, public market, evacuation shelter."),
    ("campus", "Urban", "University & medical campus", "#86a9e6", None, 0, "Research university, teaching hospital and student housing, linked to the east transit line."),
    ("innov", "Economy", "Innovation & light industry", "#a186cf", None, 0, "Agri-tech labs, makers' workshops, clean manufacturing, data centre on the renewable grid."),
    ("agro", "Economy", "Agro-industrial & food hub", "#a6b35a", None, 0, "Rice, coconut and fruit processing, cold chain, wholesale market. Waste heat feeds the biogas plant."),
    ("logistics", "Economy", "Airport & logistics", "#9ca3aa", None, 0, "Existing airport kept and extended, air cargo, maintenance, and a rail-ready freight yard."),
    ("heritage", "Urban", "Heritage & culture", "#d98bab", None, 0, "Balangay heritage quarter: museum, archaeology park, boat-building workshops, riverside walks."),
    ("park", "Green & blue", "Parks, greenways & sports", "#68bb68", None, 0, "Shaded greenways, sports fields and playgrounds. Most homes are within a 5-minute walk of a park."),
    ("urbanfarm", "Green & blue", "Urban farms & community gardens", "#bddf8f", None, 0, "Neighbourhood farms and food forests that feed the local market."),
    ("blue", "Green & blue", "River corridor & retention wetlands", "#7cc6e8", "waves", 0, "Floodway kept free of buildings, ponds and wetlands that hold storm water and cool the city."),
    ("solar", "Utilities", "Solar farm & battery storage", "#e8c320", "cross", 0, "Ground-mounted solar on land that is not prime farmland. Rooftop solar is required on every new roof."),
    ("circular", "Utilities", "Circular-economy park", "#8d7052", None, 0, "Materials recovery, composting, biogas from waste and sludge, wastewater reuse."),
    ("agri", "Rural", "Farm belt (food security)", "#dfeab6", "hatch", 0, "Rice, corn and vegetables kept as farmland. A ring of food around the city."),
    ("forest", "Rural", "Watershed forest (protected)", "#33805a", "dots", 0, "Upland forest that protects the water supply and slows floods. Reforested, no new building."),
    ("coastal", "Rural", "Coastal wetland & mangrove (protected)", "#58b8aa", "waves", 0, "Mangrove and tidal marsh on the bay. A natural flood and storm-surge barrier."),
]
LU = {k: dict(key=k, group=g, label=l, color=c, pattern=p, density=d, desc=ds) for k, g, l, c, p, d, ds in LEGEND}

# ----------------------------------------------------------------------------------------------------------
# Design parameters
# ----------------------------------------------------------------------------------------------------------
GRID_ANGLE = 14.0  # degrees the street grid is turned, so it is not simply north-south
PITCH = 260.0  # block pitch in metres
SUPER = 4  # blocks per superblock side: 4 x 260 = 1,040 m, so no home is more than ~700 m from its hub
LOCAL_ST = 7.0  # half the width of a local street
COLLECTOR_EXTRA = 11.0  # extra setback beside a collector
SETBACK = 300.0  # urban land stays this far inside the city boundary
SOLAR_MWP_PER_HA = 0.7  # assumption, for the stats only

NODES = {  # name: (lon, lat, urban radius in m)
    "cbd": (125.5406, 8.9475, 4300),  # downtown Butuan
    "air": (125.4788, 8.9515, 2700),  # Bancasi Airport, approximate
    "wf": (125.505, 8.986, 2300),  # bay waterfront town
    "ne": (125.622, 8.973, 2500),  # innovation park
    "east": (125.622, 8.926, 2400),  # east town and sports city
    "south": (125.565, 8.836, 2700),  # south agro-industrial town
}


def catmull(points: list[tuple[float, float]], n: int = 14) -> LineString:
    """Smooth curve through the given points (uniform Catmull-Rom)."""
    p = [points[0]] + list(points) + [points[-1]]
    out: list[tuple[float, float]] = []
    for i in range(1, len(p) - 2):
        p0, p1, p2, p3 = (np.array(p[i + k]) for k in (-1, 0, 1, 2))
        for t in np.linspace(0, 1, n, endpoint=False):
            out.append(tuple(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3)))
    out.append(tuple(points[-1]))
    return LineString(out)


def curve_ll(coords: list[tuple[float, float]], n: int = 14) -> LineString:
    return catmull([xy(*c) for c in coords], n)


def ellipse(cx: float, cy: float, a: float, b: float, deg: float = 0.0) -> Polygon:
    e = affinity.scale(Point(cx, cy).buffer(1, 48), a, b)
    return affinity.rotate(e, deg, origin=(cx, cy))


def parts(g, kind=Polygon) -> list:
    if g.is_empty:
        return []
    if isinstance(g, kind):
        return [g]
    return [p for p in getattr(g, "geoms", []) if isinstance(p, kind)]


def biggest(g) -> Polygon | None:
    ps = parts(g)
    return max(ps, key=lambda p: p.area) if ps else None


def main() -> None:
    gj = json.loads(BOUNDARY.read_text())
    geom = gj["geometry"] if gj.get("type") == "Feature" else gj
    B = to_xy_geom(shape(geom))
    B_in = B.buffer(-SETBACK)
    city_ha = B.area / 1e4

    # --- the urban growth boundary: a core, five town centres and the corridors that join them ------------
    P = {k: Point(*xy(v[0], v[1])) for k, v in NODES.items()}
    shapes = [P[k].buffer(v[2], 64) for k, v in NODES.items()]
    for k in NODES:
        if k != "cbd":
            shapes.append(LineString([P["cbd"], P[k]]).buffer(1100, cap_style=1))
    # tidal land on the bay: kept wild, with a soft edge rather than a ruled line
    shore = curve_ll([(125.40, 9.012), (125.5, 9.004), (125.56, 9.008), (125.64, 8.999), (125.78, 9.006)])
    coast_mask = Polygon(list(shore.coords) + [(shore.coords[-1][0], 1e5), (shore.coords[0][0], 1e5)])
    north_cut = box(-1e5, -1e5, 1e5, 1e5).difference(coast_mask)
    ugb = unary_union(shapes).intersection(B_in).intersection(north_cut)
    ugb = ugb.buffer(450, 32).buffer(-900, 32).buffer(450, 32).intersection(B_in)
    ugb = biggest(ugb) or ugb
    ugb_ha = ugb.area / 1e4

    # --- special districts (reserved land) ---------------------------------------------------------------
    airport = ellipse(*P["air"].coords[0], 2100, 760, 10)
    airport_band = airport.buffer(950)
    campus_a = Point(*xy(125.588, 8.958)).buffer(1300, 48)
    campus_b = Point(*xy(125.563, 8.9255)).buffer(720, 48)
    innov_ne = P["ne"].buffer(1500, 48)
    innov_extra = Point(*xy(125.505, 8.915)).buffer(900, 48)  # clean-industry pocket on the west side
    agro_s = P["south"].buffer(1150, 48)
    heritage = Point(*xy(125.5345, 8.9615)).buffer(650, 48)
    sports = Point(*xy(125.6, 8.926)).buffer(520, 48)

    # --- greenways, river corridor, retention ponds ------------------------------------------------------
    river = curve_ll([(125.527, 9.0), (125.536, 8.979), (125.5465, 8.957), (125.5495, 8.935), (125.547, 8.912), (125.554, 8.885), (125.566, 8.86), (125.573, 8.83), (125.585, 8.8)])
    wedge_nw = curve_ll([(125.505, 8.975), (125.516, 8.96), (125.5275, 8.949), (125.5345, 8.945)])
    wedge_se = curve_ll([(125.55, 8.935), (125.575, 8.915), (125.6, 8.9), (125.63, 8.885), (125.665, 8.87)])
    wedge_sw = curve_ll([(125.527, 8.935), (125.51, 8.91), (125.497, 8.885), (125.495, 8.855), (125.5, 8.82)])
    wedge_ne = curve_ll([(125.56, 8.965), (125.585, 8.98), (125.605, 8.99)])
    greenways = [(river, 240, "Agusan River corridor"), (wedge_nw, 170, "Bay green wedge"), (wedge_se, 190, "South-east green wedge"), (wedge_sw, 190, "South-west green wedge"), (wedge_ne, 150, "North-east green wedge")]
    green_polys = [c.buffer(w, 16) for c, w, _ in greenways]
    ponds = []
    for line, spacing, off in ((river, 2300, 0), (wedge_se, 2600, 300), (wedge_sw, 2600, 300), (wedge_nw, 2200, 100)):
        d = spacing * 0.6
        while d < line.length - 400:
            p = line.interpolate(d)
            ponds.append(ellipse(p.x, p.y, 430, 230, math.degrees(math.atan2(*(np.array(line.interpolate(d + 20).coords[0]) - np.array(p.coords[0]))[::-1]))))
            d += spacing
    green_all = unary_union(green_polys)
    ponds_all = unary_union(ponds)

    # --- transit and roads --------------------------------------------------------------------------------
    c0 = (P["cbd"].x, P["cbd"].y)
    l1 = curve_ll([(125.4788, 8.9515), (125.505, 8.952), (125.5406, 8.9475), (125.575, 8.951), (125.6, 8.942), (125.622, 8.926)])
    l2 = curve_ll([(125.505, 8.986), (125.52, 8.966), (125.5406, 8.9475), (125.5535, 8.915), (125.5565, 8.88), (125.565, 8.836)])
    l3 = curve_ll([(125.5406, 8.9475), (125.575, 8.962), (125.6, 8.972), (125.622, 8.973)])
    transit = [("L1", "East–West line", "#d6313b", l1), ("L2", "North–South line", "#1769c4", l2), ("L3", "North-east line", "#7a3fb0", l3)]
    # central ring road with a gentle wobble, plus a loop road around each town
    ring_pts = []
    for a in np.linspace(0, 2 * math.pi, 120, endpoint=False):
        r = 3750 + 260 * math.sin(3 * a + 1.0) + 140 * math.sin(5 * a)
        ring_pts.append((c0[0] + r * math.cos(a), c0[1] + r * math.sin(a)))
    ring = LineString(ring_pts + [ring_pts[0]])
    transit.append(("L4", "Orbital bus line (on the loop road)", "#1b9a59", ring))
    transit_union = unary_union([t[3] for t in transit])
    loops = []
    for k in ("air", "wf", "ne", "east", "south"):
        loops.append(P[k].buffer(1750, 48).exterior)
    spur = curve_ll([(125.5406, 8.9475), (125.51, 8.9615), (125.4788, 8.9515)])  # second connection to the airport
    arterial_lines = [("Butuan Loop Road", "ring", ring)] + [("Town loop road", "arterial", ln) for ln in loops] + [("Airport link", "arterial", spur)]

    regional = []
    for k, (tx, ty) in {"air": xy(125.40, 8.95), "wf": xy(125.47, 9.04), "ne": xy(125.76, 9.0), "east": xy(125.76, 8.9), "south": xy(125.58, 8.70)}.items():
        ln = LineString([(P[k].x, P[k].y), (tx, ty)]).intersection(B_in)
        for seg in parts(ln, LineString) or ([ln] if isinstance(ln, LineString) else []):
            regional.append(("Regional connector", "regional", seg))

    # --- street grid -------------------------------------------------------------------------------------
    rot = -GRID_ANGLE
    ugb_r = affinity.rotate(ugb, rot, origin=(0, 0))
    minx, miny, maxx, maxy = ugb_r.bounds
    i0, i1 = int(math.floor(minx / PITCH)), int(math.ceil(maxx / PITCH))
    j0, j1 = int(math.floor(miny / PITCH)), int(math.ceil(maxy / PITCH))
    art_poly = unary_union([t[3].buffer(30) for t in transit] + [a[2].buffer(22) for a in arterial_lines] + [spur.buffer(22)])

    cells = {}
    for i in range(i0, i1):
        for j in range(j0, j1):
            cell_r = box(i * PITCH, j * PITCH, (i + 1) * PITCH, (j + 1) * PITCH)
            c_xy = affinity.rotate(cell_r.centroid, GRID_ANGLE, origin=(0, 0))
            if not ugb.contains(c_xy):
                continue
            il, ir = LOCAL_ST + (COLLECTOR_EXTRA if i % SUPER == 0 else 0), LOCAL_ST + (COLLECTOR_EXTRA if (i + 1) % SUPER == 0 else 0)
            jb, jt = LOCAL_ST + (COLLECTOR_EXTRA if j % SUPER == 0 else 0), LOCAL_ST + (COLLECTOR_EXTRA if (j + 1) % SUPER == 0 else 0)
            blk = affinity.rotate(box(i * PITCH + il, j * PITCH + jb, (i + 1) * PITCH - ir, (j + 1) * PITCH - jt), GRID_ANGLE, origin=(0, 0))
            blk = blk.intersection(ugb)
            if blk.is_empty or blk.area < 0.35 * (PITCH - 2 * LOCAL_ST) ** 2:
                continue
            cells[(i, j)] = {"geom": blk, "c": c_xy}

    # arterials and transit cut through the blocks
    for key, c in cells.items():
        g = c["geom"]
        if g.intersects(art_poly):
            g = g.difference(art_poly)
        big = biggest(g)
        c["geom"] = big if big is not None and big.area > 5000 else None
    cells = {k: v for k, v in cells.items() if v["geom"] is not None}

    # --- classify blocks ----------------------------------------------------------------------------------
    for (i, j), c in cells.items():
        p = c["c"]
        d_cbd = p.distance(P["cbd"])
        d_node = min(p.distance(P[k]) for k in NODES if k != "cbd")
        lu = None
        if airport.contains(p):
            lu = "logistics"
        elif campus_a.contains(p) or campus_b.contains(p):
            lu = "campus"
        elif innov_ne.contains(p) or innov_extra.contains(p) or airport_band.contains(p):
            lu = "innov"
        elif agro_s.contains(p):
            lu = "agro"
        elif heritage.contains(p):
            lu = "heritage"
        elif sports.contains(p):
            lu = "park"
        elif ponds_all.contains(p):
            lu = "blue"
        elif green_all.contains(p):
            lu = "park"
        elif d_cbd < 1150:
            lu = "cbd"
        elif transit_union.distance(p) < 420 or d_node < 650:
            lu = "mixed"
        elif d_cbd < 6500 or d_node < 1500:
            lu = "res_med"
        else:
            lu = "res_low"
        c["lu"] = lu
        c["super"] = (i // SUPER, j // SUPER)

    # one hub, one park (and in low-density areas one urban farm) per superblock
    by_super: dict[tuple[int, int], dict[tuple[int, int], dict]] = {}
    for (i, j), c in cells.items():
        by_super.setdefault(c["super"], {})[(i % SUPER, j % SUPER)] = c
    resid = {"res_med", "res_low", "mixed"}
    for sb, members in by_super.items():
        free = lambda order: [members[o] for o in order if o in members and members[o]["lu"] in resid]  # noqa: E731
        hub = free([(1, 1), (2, 1), (1, 2), (2, 2), (1, 0), (2, 0), (0, 1), (3, 1), (1, 3), (2, 3), (0, 2), (3, 2)])
        if hub:
            hub[0]["lu"] = "inst"
            hub[0]["hub"] = True
        pk = free([(2, 2), (1, 2), (2, 1), (1, 1), (2, 3), (3, 2), (0, 2), (2, 0)])
        if pk:
            pk[0]["lu"] = "park"
        low = [m for m in members.values() if m["lu"] == "res_low"]
        if len(low) >= 4:
            farm = free([(3, 3), (0, 3), (3, 0), (0, 0)])
            if farm and farm[0]["lu"] == "res_low":
                farm[0]["lu"] = "urbanfarm"

    # --- macro zones outside the blocks -------------------------------------------------------------------
    streets_land = ugb  # the whole urban area is the block layer
    outside = B.difference(ugb)
    coastal = B.intersection(coast_mask)
    east_edge = curve_ll([(125.632, 8.992), (125.618, 8.952), (125.633, 8.915), (125.612, 8.885), (125.622, 8.85), (125.605, 8.8)])
    south_edge = curve_ll([(125.42, 8.808), (125.47, 8.797), (125.52, 8.808), (125.575, 8.795), (125.63, 8.804), (125.78, 8.79)])
    east_mask = Polygon(list(east_edge.coords) + [(1e5, east_edge.coords[-1][1]), (1e5, east_edge.coords[0][1])])
    south_mask = Polygon(list(south_edge.coords) + [(south_edge.coords[-1][0], -1e5), (south_edge.coords[0][0], -1e5)])
    upland = B.intersection(unary_union([east_mask, south_mask]))
    circular = ellipse(*xy(125.492, 8.848), 1150, 800, -20).intersection(B_in)
    solar_sites = [
        ("Solar farm A", ellipse(*xy(125.478, 8.905), 1500, 800, 8)),
        ("Solar farm B", ellipse(*xy(125.608, 8.862), 1300, 800, -12)),
        ("Solar farm C", ellipse(*xy(125.677, 8.987), 1000, 520, 0)),
    ]
    solar = [(n, g.intersection(B_in).difference(ugb)) for n, g in solar_sites]
    solar_all = unary_union([g for _, g in solar])
    reserved = unary_union([coastal, circular, solar_all])
    forest = upland.difference(ugb.buffer(1000)).difference(reserved)
    farm = outside.difference(forest).difference(reserved)
    rural_green = green_all.difference(ugb).intersection(B).difference(coastal)
    rural_pond = ponds_all.difference(ugb).intersection(B).difference(coastal)
    zones = [
        ("coastal", coastal.difference(ugb)),
        ("forest", forest),
        ("agri", farm.difference(rural_green).difference(rural_pond)),
        ("circular", circular),
        ("solar", solar_all),
        ("park", rural_green.difference(coastal)),
        ("blue", rural_pond),
    ]

    # --- hubs, stations, projects --------------------------------------------------------------------------
    features: list[dict] = []

    def add(g, **props):
        g = to_ll(g.simplify(1.0)) if not isinstance(g, Point) else to_ll(g)
        g = rnd(g)
        if g.is_empty:
            return
        features.append({"type": "Feature", "properties": props, "geometry": mapping(g)})

    add(B, kind="boundary", name="Butuan City boundary")
    for lu, g in zones:
        for p in parts(g):
            if p.area > 3000:
                add(p.simplify(15), kind="zone", lu=lu)

    # blocks: merge nothing, keep each parcel for the detailed view
    class_ha: dict[str, float] = {}
    for (i, j), c in sorted(cells.items()):
        g = c["geom"]
        class_ha[c["lu"]] = class_ha.get(c["lu"], 0) + g.area / 1e4
        add(g, kind="block", lu=c["lu"])
    for lu, g in zones:
        class_ha[lu] = class_ha.get(lu, 0) + g.area / 1e4

    # roads
    km = lambda g: g.length / 1000  # noqa: E731
    road_km: dict[str, float] = {"ring": 0, "arterial": 0, "regional": 0, "collector": 0}
    for name, cls, ln in arterial_lines + regional:
        seg = ln.intersection(B_in) if cls != "ring" else ln
        for s in parts(seg, LineString):
            add(s, kind="road", cls=cls, name=name)
            road_km[cls] += km(s)
    # collectors: every SUPER-th grid line, clipped to the urban area and to the blocks' side of the arterials
    col_lines = []
    for i in range(i0, i1 + 1):
        if i % SUPER == 0:
            col_lines.append(affinity.rotate(LineString([(i * PITCH, j0 * PITCH), (i * PITCH, j1 * PITCH)]), GRID_ANGLE, origin=(0, 0)))
    for j in range(j0, j1 + 1):
        if j % SUPER == 0:
            col_lines.append(affinity.rotate(LineString([(i0 * PITCH, j * PITCH), (i1 * PITCH, j * PITCH)]), GRID_ANGLE, origin=(0, 0)))
    coll = unary_union(col_lines).intersection(ugb.buffer(-120)).difference(art_poly)
    for s in parts(coll, LineString):
        if s.length > 150:
            add(s, kind="road", cls="collector", name="Collector street")
            road_km["collector"] += km(s)

    # transit lines and stations (every ~850 m, and one at each end)
    stations = []
    for code, name, color, ln in transit:
        add(ln, kind="transit", line=code, name=name, color=color)
        n = max(2, int(round(ln.length / 850)))
        for s in range(n + 1):
            p = ln.interpolate(ln.length * s / n)
            stations.append((code, s + 1, p, color))
    st_pts = []
    for code, idx, p, color in stations:
        near_cbd = p.distance(P["cbd"]) < 250
        if near_cbd and any(sp.distance(p) < 300 for _, _, sp, _ in st_pts if sp is not p):
            if code != "L1":
                continue
        st_pts.append((code, idx, p, color))
        add(p, kind="station", line=code, name=f"{code}-{idx:02d}", color=color, hub=bool(near_cbd))
    n_stations = len(st_pts)

    # greenway and river centre lines
    add(river, kind="river", name="Agusan River corridor (concept alignment, align to survey)")
    for g_line, _, nm in greenways[1:]:
        add(g_line, kind="greenway", name=nm)

    # airport
    add(LineString([(P["air"].x - 1050 * math.cos(math.radians(10)), P["air"].y - 1050 * math.sin(math.radians(10))), (P["air"].x + 1050 * math.cos(math.radians(10)), P["air"].y + 1050 * math.sin(math.radians(10)))]).buffer(32, cap_style=2), kind="airport", name="Runway (existing airport, concept)")

    # neighbourhood hubs
    hubs = [c for c in cells.values() if c.get("hub")]
    for h in hubs:
        add(h["geom"].representative_point(), kind="hub", name="Neighbourhood hub")

    # --- projects (numbered key) ----------------------------------------------------------------------------
    def spot(lon, lat):
        return Point(*xy(lon, lat))

    PROJECTS = [
        ("Butuan Central", "Civic core", P["cbd"], "City hall, courts, convention centre and the main transit interchange, rebuilt around a car-free civic plaza on the river. The one place where L1, L2 and L3 meet."),
        ("Agusan Riverpark", "Flood & park", spot(125.5495, 8.935), "A wide river corridor kept free of buildings, with terraces, ponds and cycle paths. It carries floods through the city instead of fighting them. Alignment is conceptual and must be fitted to the surveyed river."),
        ("Balangay Heritage Quarter", "Heritage", Point(*heritage.centroid.coords[0]), "Museum, archaeology park and boat-building workshops that keep the city's balangay story alive, with river walks to the centre."),
        ("Bancasi Aerotropolis", "Airport & logistics", P["air"], "The existing airport kept and extended, with air cargo, maintenance and an innovation band beside it. Rail-ready freight yard."),
        ("Caraga Education & Research City", "University", Point(*campus_a.centroid.coords[0]), "University campus, research institutes and student housing on the east line (L1)."),
        ("Medical City", "Health", Point(*campus_b.centroid.coords[0]), "Tertiary and teaching hospital, rehabilitation and elder care, close to the centre and on the river line (L2)."),
        ("Agri-Tech Innovation Park", "Innovation", P["ne"], "Labs and pilot plants for rice, coconut and aquaculture technology, next to the farm belt it serves."),
        ("Bay Waterfront Town", "Waterfront", P["wf"], "A walkable town facing the bay, with a mangrove boardwalk, fish landing and tourism. Raised, with the mangrove belt as its sea defence."),
        ("East Town & Sports City", "Town centre", Point(*sports.centroid.coords[0]), "Stadium, aquatic centre and sports fields at the end of L1, ringed by mixed-use housing."),
        ("South Agro-Industrial Town", "Food hub", P["south"], "Processing, cold storage and wholesale market that turn the farm belt's harvest into products. Waste heat and waste go to the circular park."),
        ("Circular-Economy Park", "Utilities", Point(*circular.centroid.coords[0]), "Sorting and recycling, composting, biogas from organic waste and sludge, and treated wastewater for farms and parks. Sited away from homes."),
        ("Solar Farm A", "Energy", Point(*solar[0][1].centroid.coords[0]), "Ground-mounted solar with battery storage on non-prime land. The grid is a set of local microgrids that can island in a storm."),
        ("Solar Farm B", "Energy", Point(*solar[1][1].centroid.coords[0]), "Second solar and storage site, placed far from the first so one storm cannot take out both."),
        ("Solar Farm C", "Energy", Point(*solar[2][1].centroid.coords[0]), "Third solar and storage site in the north-east."),
        ("Watershed Forest Reserve", "Protected", Point(*forest.representative_point().coords[0]), "Upland forest kept and restored to protect water supply, slow floods and hold carbon."),
        ("Coastal Wetland & Mangrove Reserve", "Protected", Point(*coastal.representative_point().coords[0]), "The bay shore left to mangrove and tidal marsh, the city's natural flood and storm-surge barrier."),
    ]
    for n, (name, cat, p, desc) in enumerate(PROJECTS, 1):
        add(p, kind="poi", num=n, name=name, cat=cat, desc=desc)

    # --- labels ----------------------------------------------------------------------------------------------
    def label(text, p, rank=2, italic=False):
        add(p, kind="label", name=text, rank=rank, italic=italic)

    label("BUTUAN CENTRAL", Point(P["cbd"].x, P["cbd"].y - 520), 1)
    label("Bancasi Aerotropolis", Point(P["air"].x, P["air"].y - 1300), 2)
    label("Bay Waterfront Town", Point(P["wf"].x, P["wf"].y + 650), 2)
    label("Agri-Tech Innovation Park", Point(P["ne"].x, P["ne"].y + 1500), 2)
    label("East Town & Sports City", Point(P["east"].x, P["east"].y - 700), 2)
    label("South Agro-Industrial Town", Point(P["south"].x, P["south"].y - 1300), 2)
    label("Education & Research City", Point(campus_a.centroid.x, campus_a.centroid.y + 1250), 3)
    label("Medical City", Point(campus_b.centroid.x, campus_b.centroid.y - 820), 3)
    label("Balangay Heritage Quarter", Point(heritage.centroid.x - 150, heritage.centroid.y + 800), 3)
    label("Circular-Economy Park", Point(circular.centroid.x, circular.centroid.y - 1000), 3)
    for nm, g in solar:
        label(nm, Point(g.centroid.x, g.centroid.y - 950), 3)
    label("WATERSHED FOREST RESERVE", Point(*forest.representative_point().coords[0]), 1, True)
    label("FARM BELT · FOOD SECURITY", Point(*xy(125.49, 8.90)), 1, True)
    label("FARM BELT · FOOD SECURITY", Point(*xy(125.665, 8.97)), 1, True)
    label("COASTAL WETLAND & MANGROVE RESERVE", Point(*coastal.representative_point().coords[0]), 1, True)
    label("Agusan River corridor", Point(*river.interpolate(river.length * 0.7).coords[0]), 3, True)

    # --- measurements ----------------------------------------------------------------------------------------
    def ha(*keys):
        return sum(class_ha.get(k, 0) for k in keys)

    block_ha = sum(c["geom"].area for c in cells.values()) / 1e4
    cap = sum(class_ha.get(k, 0) * LU[k]["density"] for k in LU)
    resid_blocks = [c for c in cells.values() if c["lu"] in ("cbd", "mixed", "res_med", "res_low")]
    hub_pts = [h["c"] for h in hubs]
    st_geo = [p for _, _, p, _ in st_pts]
    park_pts = [c["c"] for c in cells.values() if c["lu"] in ("park", "blue", "urbanfarm")]
    within = lambda pts, r, blocks: (sum(1 for b in blocks if min(b["c"].distance(q) for q in pts) <= r) / max(1, len(blocks)))  # noqa: E731
    stats = {
        "city_ha": round(city_ha),
        "urban_ha": round(ugb_ha),
        "urban_pct": round(100 * ugb_ha / city_ha, 1),
        "blocks": len(cells),
        "hubs": len(hubs),
        "stations": n_stations,
        "transit_km": round(sum(km(t[3]) for t in transit), 1),
        "ring_km": round(road_km["ring"], 1),
        "arterial_km": round(road_km["arterial"] + road_km["regional"], 1),
        "collector_km": round(road_km["collector"], 1),
        "green_urban_pct": round(100 * ha("park", "blue", "urbanfarm") / max(1, block_ha), 1),
        "protected_pct": round(100 * ha("forest", "coastal") / city_ha, 1),
        "farm_pct": round(100 * ha("agri") / city_ha, 1),
        "walk_hub_pct": round(100 * within(hub_pts, 800, resid_blocks), 1),
        "walk_station_pct": round(100 * within(st_geo, 800, resid_blocks), 1),
        "walk_park_pct": round(100 * within(park_pts, 400, resid_blocks), 1),
        "solar_ha": round(ha("solar")),
        "solar_mwp": round(ha("solar") * SOLAR_MWP_PER_HA),
        "capacity_persons": int(round(cap, -3)),
        "assumptions": [
            "Walk distances are straight lines from block centres, not routed paths.",
            f"Solar yield is assumed at {SOLAR_MWP_PER_HA} MWp per hectare.",
            "Population is the capacity at assumed gross densities per hectare of block land (see legend), not a forecast.",
            "Land-use classes outside the urban area are conceptual. Check them against terrain, flood and soil data before use.",
        ],
        "class_ha": {k: round(v) for k, v in class_ha.items()},
    }

    out = {
        "type": "FeatureCollection",
        "features": features,
        "meta": {
            "title": "Butuan 2050 · Site Development Plan (concept)",
            "prompt": PROMPT,
            "generated": date.today().isoformat(),
            "source": "City boundary: OpenStreetMap contributors (ODbL). Plan: generated by script, not surveyed.",
        },
        "legend": [dict(LU[k]) for k in LU],
        "stats": stats,
    }
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.2f} MB, {len(features)} features)")
    for k, v in stats.items():
        if k not in ("assumptions", "class_ha"):
            print(f"  {k:>18}: {v}")
    print("  class_ha:", stats["class_ha"])


def to_xy_geom(g):
    return shapely.transform(g, lambda c: np.column_stack([(c[:, 0] - LON0) * KX, (c[:, 1] - LAT0) * KY]))


if __name__ == "__main__":
    main()
