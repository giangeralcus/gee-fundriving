#!/usr/bin/env python3
"""Fetch jalan-jalan daerah Puri Indah (Jakarta Barat) dari OpenStreetMap
via Overpass API, lalu konversi ke map format Gee-MiniDrive (JSON).

Output: maps/puri_indah.json berisi:
- nodes: {id: (x, y)}  — koordinat meter (lokal, origin di bbox corner)
- roads: [{id, points:[node ids], width, name}]
- spawn: node id start
"""
import json
import math
import sys
import urllib.parse
import urllib.request

# bbox Puri Indah + sekitarnya (Kembangan, Jakarta Barat)
LAT0, LON0 = -6.1950, 106.7350   # south, west
LAT1, LON1 = -6.1800, 106.7550   # north, east

QUERY = f"""[out:json][timeout:90];
(
  way({LAT0},{LON0},{LAT1},{LON1})["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|service)$"];
);
(._;>;);
out body qt;"""


def fetch():
    url = "https://overpass-api.de/api/interpreter"
    data = urllib.parse.urlencode({"data": QUERY}).encode()
    req = urllib.request.Request(url, data=data, headers={"User-Agent": "GeeMiniDrive/1.0"})
    with urllib.request.urlopen(req, timeout=90) as r:
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


def main():
    print("fetch OSM...", file=sys.stderr)
    data = fetch()
    nodes = {}
    roads = []
    for el in data["elements"]:
        if el["type"] == "node":
            x, y = latlon_to_xy(el["lat"], el["lon"])
            nodes[el["id"]] = (x, y)
    for el in data["elements"]:
        if el["type"] != "way":
            continue
        tags = el.get("tags", {})
        hw = tags.get("highway", "residential")
        pts = [n for n in el.get("nodes", []) if n in nodes]
        if len(pts) < 2:
            continue
        roads.append({
            "id": el["id"],
            "name": tags.get("name", f"way-{el['id']}"),
            "width": HIGHWAY_WIDTH.get(hw, 10),
            "kind": hw,
            "points": pts,
        })
    world = {
        "meta": {
            "name": "Puri Indah, Jakarta Barat",
            "source": "OpenStreetMap (ODbL)",
            "bbox": [LON0, LAT0, LON1, LAT1],
        },
        "nodes": {str(k): v for k, v in nodes.items()},
        "roads": roads,
    }
    import os
    os.makedirs("maps", exist_ok=True)
    with open("maps/puri_indah.json", "w") as f:
        json.dump(world, f)
    print(f"OK: {len(nodes)} nodes, {len(roads)} roads -> maps/puri_indah.json")
    # extent
    xs = [p[0] for p in nodes.values()]
    ys = [p[1] for p in nodes.values()]
    if xs:
        print(f"extent: {max(xs)-min(xs):.0f}m x {max(ys)-min(ys):.0f}m")


if __name__ == "__main__":
    main()
