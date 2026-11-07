"""Shared helpers for the pipeline scripts. Standard library only (Python 3.10+)."""
import json
import pathlib
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date

UA = "butuan-unfolded-30daymapchallenge/0.1"
DATA = pathlib.Path(__file__).resolve().parent.parent / "public" / "data"

# Tried in order; the next one is used if a server is busy or down.
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]


def overpass(query: str, retries: int = 2, timeout: int = 150) -> dict:
    """POST a query to the first Overpass server that answers. `timeout` is the socket timeout in seconds."""
    last: Exception | None = None
    for attempt in range(retries + 1):
        for url in OVERPASS_URLS:
            try:
                print(f"  asking {url.split('/')[2]} (can take a minute or two)...")
                req = urllib.request.Request(
                    url, data=urllib.parse.urlencode({"data": query}).encode(), headers={"User-Agent": UA}
                )
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    return json.load(r)
            except Exception as e:  # noqa: BLE001 - try the next mirror
                last = e
                print(f"  {url} failed: {e}")
        time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"All Overpass servers failed: {last}")


def _boundary() -> dict:
    p = DATA / "butuan-boundary.geojson"
    if not p.exists():
        raise SystemExit("Run `python pipeline/01_osm_facilities.py` first (it creates the boundary file).")
    return json.loads(p.read_text())


def _polys() -> list:
    g = _boundary()["geometry"]
    return [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]


def butuan_bbox(pad: float = 0.003) -> tuple[float, float, float, float]:
    """(south, west, north, east) of the city boundary. Bounding-box queries are far cheaper for Overpass than area queries."""
    xs = [p[0] for poly in _polys() for p in poly[0]]
    ys = [p[1] for poly in _polys() for p in poly[0]]
    return (min(ys) - pad, min(xs) - pad, max(ys) + pad, max(xs) + pad)


def ring_contains(pt: tuple, ring: list) -> bool:
    x, y = pt
    ins = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            ins = not ins
        j = i
    return ins


def in_city(lon: float, lat: float) -> bool:
    """True if the point lies inside the Butuan City boundary polygon."""
    return any(ring_contains((lon, lat), poly[0]) and not any(ring_contains((lon, lat), h) for h in poly[1:]) for poly in _polys())


def butuan_area_id() -> int:
    """Overpass area id of the Butuan City relation, read from the boundary written by 01_osm_facilities.py."""
    p = DATA / "butuan-boundary.geojson"
    if not p.exists():
        raise SystemExit("Run `python pipeline/01_osm_facilities.py` first (it creates the boundary file).")
    rel = json.loads(p.read_text())["properties"]["osm_relation"]
    return 3600000000 + int(rel)


def write_geojson(name: str, features: list[dict], source: str) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    out = DATA / name
    out.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "metadata": {"source": source, "fetched": date.today().isoformat()},
                "features": features,
            },
            separators=(",", ":"),
        )
    )
    print(f"Wrote {len(features)} features to {out} ({out.stat().st_size / 1024:.0f} KB)")
