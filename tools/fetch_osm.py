#!/usr/bin/env python3
"""Fetch jalan + bangunan + area hijau/air daerah Puri Indah (Jakarta Barat)
dari OpenStreetMap via Overpass API, konversi ke map format Gee-FunDriving.

Output JSON:
- nodes: {id: (x, y)}    — meter (lokal, origin di bbox corner, utara ke atas)
- roads: [{id, points:[node ids], width, kind, name}]
- buildings: [[[x,y],...], ...]           — poligon bangunan (meter)
- areas: [{k: green|water, pts:[[x,y],...]}, ...]
"""
import json
import math
import sys
import urllib.parse
import urllib.request

# bbox Puri Indah + sekitarnya (Kembangan, Jakarta Barat)
LAT0, LON0 = -6.1950, 106.7350   # south, west
LAT1, LON1 = -6.1800, 106.7550   # north, east

QUERY = f"""[out:json][timeout:120];
(
  way({LAT0},{LON0},{LAT1},{LON1})["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|service)$"];
  way({LAT0},{LON0},{LAT1},{LON1})["building"];
  way({LAT0},{LON0},{LAT1},{LON1})["leisure"~"^(park|garden|pitch|playground|golf_course)$"];
  way({LAT0},{LON0},{LAT1},{LON1})["landuse"~"^(grass|forest|meadow|recreation_ground|cemetery)$"];
  way({LAT0},{LON0},{LAT1},{LON1})["natural"~"^(water|wood|riverbank)$"];
);
(._;>;);
out body qt;"""


def fetch():
    url = "https://overpass-api.de/api/interpreter"
    data = urllib.parse.urlencode({"data": QUERY}).encode()
    req = urllib.request.Request(url, data=data, headers={"User-Agent": "GeeFunDriving/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def latlon_to_xy(lat, lon):
    """Equirectangular proj ke meter, origin = (LAT1/LON0), y dibalik biar utara ke atas."""
    mx = math.radians(lon - LON0) * 6378137.0 * math.cos(math.radians((LAT0 + LAT1) / 2))
    my = math.radians(LAT1 - lat) * 6378137.0
    return round(mx, 1), round(my, 1)


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
    print("fetch OSM (jalan + bangunan + area)...", file=sys.stderr)
    data = fetch()
    nodes = {}
    roads, buildings, areas = [], [], []
    for el in data["elements"]:
        if el["type"] == "node":
            nodes[el["id"]] = latlon_to_xy(el["lat"], el["lon"])
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
        # poligon: bangunan / area (pakai koordinat langsung)
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
        "meta": {
            "name": "Puri Indah, Jakarta Barat",
            "source": "OpenStreetMap (ODbL)",
            "bbox": [LON0, LAT0, LON1, LAT1],
        },
        "nodes": {str(k): v for k, v in nodes.items()},
        "roads": roads,
        "buildings": buildings,
        "areas": areas,
    }
    import os
    os.makedirs("maps", exist_ok=True)
    with open("maps/puri_indah.json", "w") as f:
        json.dump(world, f)
    print(f"OK: {len(nodes)} nodes, {len(roads)} roads, "
          f"{len(buildings)} buildings, {len(areas)} areas -> maps/puri_indah.json")
    xs = [p[0] for p in nodes.values()]
    ys = [p[1] for p in nodes.values()]
    if xs:
        print(f"extent: {max(xs)-min(xs):.0f}m x {max(ys)-min(ys):.0f}m")


if __name__ == "__main__":
    main()
