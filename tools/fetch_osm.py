#!/usr/bin/env python3
"""Fetch jalan + bangunan + area dari OpenStreetMap via Overpass API,
konversi ke map format Gee-FunDriving.

Pakai:
  python tools/fetch_osm.py                          # default: Puri Indah -> Cengkareng/Taman Palem
  python tools/fetch_osm.py --preset puri-indah      # area kecil (cepat)
  python tools/fetch_osm.py --bbox LAT0 LON0 LAT1 LON1 --name "Daerah X" --out maps/x.json

Output JSON:
- nodes: {id: (x, y)}    — meter (lokal, origin di bbox corner, utara ke atas)
- roads: [{id, points:[node ids], width, kind, name}]
- buildings: [[[x,y],...], ...]           — poligon bangunan (meter)
- areas: [{k: green|water, pts:[[x,y],...]}, ...]
"""
import argparse
import json
import math
import os
import sys
import urllib.parse
import urllib.request

PRESETS = {
    "puri-indah": {
        "bbox": (-6.1950, 106.7350, -6.1800, 106.7550),
        "name": "Puri Indah, Jakarta Barat",
        "out": "maps/puri_indah.json",
    },
    "puri-cengkareng": {
        "bbox": (-6.1960, 106.7060, -6.1460, 106.7590),
        "name": "Puri Indah - Cengkareng - Taman Palem, Jakarta Barat",
        "out": "maps/puri_cengkareng.json",
    },
}


def build_query(lat0, lon0, lat1, lon1):
    return f"""[out:json][timeout:300];
(
  way({lat0},{lon0},{lat1},{lon1})["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|service)$"];
  way({lat0},{lon0},{lat1},{lon1})["building"];
  way({lat0},{lon0},{lat1},{lon1})["leisure"~"^(park|garden|pitch|playground|golf_course)$"];
  way({lat0},{lon0},{lat1},{lon1})["landuse"~"^(grass|forest|meadow|recreation_ground|cemetery)$"];
  way({lat0},{lon0},{lat1},{lon1})["natural"~"^(water|wood|riverbank)$"];
);
(._;>;);
out body qt;"""


def fetch(query, timeout=300):
    url = "https://overpass-api.de/api/interpreter"
    data = urllib.parse.urlencode({"data": query}).encode()
    req = urllib.request.Request(url, data=data, headers={"User-Agent": "GeeFunDriving/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def make_proj(lat0, lon0, lat1, lon1):
    def latlon_to_xy(lat, lon):
        mx = math.radians(lon - lon0) * 6378137.0 * math.cos(math.radians((lat0 + lat1) / 2))
        my = math.radians(lat1 - lat) * 6378137.0
        return round(mx, 1), round(my, 1)
    return latlon_to_xy


HIGHWAY_WIDTH = {
    "motorway": 22, "trunk": 20, "primary": 18, "secondary": 16,
    "tertiary": 14, "residential": 11, "unclassified": 10,
    "living_street": 9, "service": 8,
}

GREEN = {"leisure": ("park", "garden", "pitch", "playground", "golf_course"),
         "landuse": ("grass", "forest", "meadow", "recreation_ground", "cemetery")}
WATER = {"natural": ("water", "riverbank")}


def area_kind(tags):
    for k, vals in GREEN.items():
        if tags.get(k) in vals:
            return "green"
    for k, vals in WATER.items():
        if tags.get(k) in vals:
            return "water"
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--preset", default="puri-cengkareng", choices=sorted(PRESETS))
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("LAT0", "LON0", "LAT1", "LON1"))
    ap.add_argument("--name", default=None)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    p = PRESETS[args.preset]
    lat0, lon0, lat1, lon1 = args.bbox if args.bbox else p["bbox"]
    name = args.name or p.get("name", "Area OSM")
    out = args.out or p.get("out", "maps/map.json")

    print(f"fetch OSM bbox=({lat0},{lon0},{lat1},{lon1}) -> {out}", file=sys.stderr)
    data = fetch(build_query(lat0, lon0, lat1, lon1))
    proj = make_proj(lat0, lon0, lat1, lon1)

    nodes = {}
    roads, buildings, areas = [], [], []
    for el in data["elements"]:
        if el["type"] == "node":
            nodes[el["id"]] = proj(el["lat"], el["lon"])
    for el in data["elements"]:
        if el["type"] != "way":
            continue
        tags = el.get("tags", {})
        node_ids = el.get("nodes", [])
        if "highway" in tags:
            pts = [n for n in node_ids if n in nodes]
            if len(pts) < 2:
                continue
            hw = tags["highway"]
            roads.append({
                "id": el["id"],
                "name": tags.get("name", f"way-{el['id']}"),
                "width": HIGHWAY_WIDTH.get(hw, 10),
                "kind": hw,
                "points": pts,
            })
            continue
        pts = [nodes[n] for n in node_ids if n in nodes]
        if len(pts) < 3:
            continue
        if "building" in tags:
            buildings.append(pts)
            continue
        k = area_kind(tags)
        if k:
            areas.append({"k": k, "pts": pts})
    world = {
        "meta": {"name": name, "source": "OpenStreetMap (ODbL)",
                 "bbox": [lon0, lat0, lon1, lat1]},
        "nodes": {str(k): v for k, v in nodes.items()},
        "roads": roads,
        "buildings": buildings,
        "areas": areas,
    }
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    with open(out, "w") as f:
        json.dump(world, f)
    print(f"OK: {len(nodes)} nodes, {len(roads)} roads, "
          f"{len(buildings)} buildings, {len(areas)} areas -> {out}")
    xs = [p2[0] for p2 in nodes.values()]
    ys = [p2[1] for p2 in nodes.values()]
    if xs:
        print(f"extent: {max(xs)-min(xs):.0f}m x {max(ys)-min(ys):.0f}m")


if __name__ == "__main__":
    main()
