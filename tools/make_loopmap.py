#!/usr/bin/env python3
"""Generate Loop City — peta internal Gee-FunDriving yang gampang diadaptasi.

Ring jalan besar (rounded rectangle) + jalan cross (biar ada simpang lampu)
+ bangunan + area hijau. Output: maps/loop_city.json (format sama dgn OSM).

Atur parameter di bawah, lalu:
  python tools/make_loopmap.py
"""
import json
import math
import os
import random

# ---- PARAMETER (silakan diubah-ubah) ----
RX, RY = 900.0, 550.0        # radius ring (meter)
CORNER = 220.0               # radius sudut membulat
STEP = 22.0                  # jarak antar node di ring (meter)
RING_W = 18                  # lebar jalan ring
CROSS_W = 14                 # lebar jalan cross
CROSS_XS = (-450.0, 450.0)   # posisi jalan cross vertikal
CROSS_Y = 0.0                # posisi jalan cross horizontal
OVERSHOOT = 280.0            # seberapa jauh cross menembus keluar ring
BLDG_CELL = 70.0             # grid bangunan
BLDG_W, BLDG_H = 26.0, 38.0
BLDG_SKIP = 0.25             # peluang bangunan dilompati
CLEAR = 22.0                 # jarak aman bangunan dari jalan
SEED = 7
# ------------------------------------------


def ring_nodes():
    """Ring rounded-rectangle: node tiap ~STEP meter. return (ids, pts)."""
    def arc_pts(cx, cy, a0, a1, r):
        n = max(2, int(abs(a1 - a0) * r / STEP))
        return [(cx + r * math.cos(a0 + (a1 - a0) * i / n),
                 cy + r * math.sin(a0 + (a1 - a0) * i / n)) for i in range(n + 1)]
    pts = []
    pts += arc_pts(RX - CORNER, RY - CORNER, -math.pi / 2, 0, CORNER)      # NE
    pts += arc_pts(RX - CORNER, -RY + CORNER, 0, math.pi / 2, CORNER)      # SE
    pts += arc_pts(-RX + CORNER, -RY + CORNER, math.pi / 2, math.pi, CORNER)  # SW
    pts += arc_pts(-RX + CORNER, RY - CORNER, math.pi, 3 * math.pi / 2, CORNER)  # NW
    # sambung sisi lurus: antar arc sudah urut, tinggal apit
    nodes = {}
    for i, (x, y) in enumerate(pts):
        nodes[1000 + i] = (round(x, 1), round(y, 1))
    return nodes


def seg_dist(px, py, ax, ay, bx, by):
    abx, aby = bx - ax, by - ay
    ab2 = abx * abx + aby * aby + 1e-6
    t = max(0.0, min(1.0, ((px - ax) * abx + (py - ay) * aby) / ab2))
    return math.hypot(px - (ax + abx * t), py - (ay + aby * t))


def main():
    random.seed(SEED)
    nodes = ring_nodes()
    ring_ids = sorted(nodes)
    roads = []

    def add_road(rid, name, width, kind, ids):
        roads.append({"id": rid, "name": name, "width": width,
                      "kind": kind, "points": ids})

    add_road(1, "Jalan Loop Raya", RING_W, "primary", ring_ids + [ring_ids[0]])

    # cross streets: sambung node ring terdekat ke tiap posisi cross
    nid = 5000
    cross_specs = []
    for cx in CROSS_XS:
        top = min((n for n in ring_ids if nodes[n][1] > 0),
                  key=lambda n: abs(nodes[n][0] - cx))
        bot = min((n for n in ring_ids if nodes[n][1] < 0),
                  key=lambda n: abs(nodes[n][0] - cx))
        tx, ty = nodes[top]
        bx, by = nodes[bot]
        n_top = (nid := nid + 1, nodes.__setitem__(nid, (round(tx, 1), round(ty - OVERSHOOT, 1))))[0]
        n_bot = (nid := nid + 1, nodes.__setitem__(nid, (round(bx, 1), round(by + OVERSHOOT, 1))))[0]
        cross_specs.append(("Jalan Cross " + ("Barat" if cx < 0 else "Timur"),
                            [n_top, top, bot, n_bot]))
    # cross horizontal lewat node ring terjauh kiri & kanan
    left = min(ring_ids, key=lambda n: nodes[n][0])
    right = max(ring_ids, key=lambda n: nodes[n][0])
    lx, ly = nodes[left]
    rx_, ry_ = nodes[right]
    n_l = (nid := nid + 1, nodes.__setitem__(nid, (round(lx - OVERSHOOT, 1), round(ly, 1))))[0]
    n_r = (nid := nid + 1, nodes.__setitem__(nid, (round(rx_ + OVERSHOOT, 1), round(ry_, 1))))[0]
    cross_specs.append(("Jalan Cross Tengah", [n_l, left, right, n_r]))

    for i, (name, ids) in enumerate(cross_specs):
        add_road(10 + i, name, CROSS_W, "secondary", ids)

    # bangunan: grid, jauhkan dari jalan
    segs = []
    for r in roads:
        for a, b in zip(r["points"], r["points"][1:]):
            segs.append((nodes[a], nodes[b]))
    buildings = []
    minx = min(p[0] for p in nodes.values()) - 150
    maxx = max(p[0] for p in nodes.values()) + 150
    miny = min(p[1] for p in nodes.values()) - 150
    maxy = max(p[1] for p in nodes.values()) + 150
    gy = miny
    row = 0
    while gy < maxy:
        gx = minx + (BLDG_CELL / 2 if row % 2 else 0)
        while gx < maxx:
            if random.random() > BLDG_SKIP:
                cx_, cy_ = gx + BLDG_W / 2, gy + BLDG_H / 2
                d = min(seg_dist(cx_, cy_, *a, *b) for a, b in segs)
                if d > CLEAR + max(BLDG_W, BLDG_H) / 2:
                    w = BLDG_W * random.uniform(0.7, 1.1)
                    h = BLDG_H * random.uniform(0.7, 1.1)
                    buildings.append([[round(cx_ - w / 2, 1), round(cy_ - h / 2, 1)],
                                      [round(cx_ + w / 2, 1), round(cy_ - h / 2, 1)],
                                      [round(cx_ + w / 2, 1), round(cy_ + h / 2, 1)],
                                      [round(cx_ - w / 2, 1), round(cy_ + h / 2, 1)]])
            gx += BLDG_CELL
        gy += BLDG_CELL
        row += 1

    # area: taman + kolam di dalam ring
    areas = [
        {"k": "green", "pts": [[-360, -260], [-120, -260], [-120, -80], [-360, -80]]},
        {"k": "water", "pts": [[150, -220], [330, -220], [330, -60], [150, -60]]},
    ]

    world = {
        "meta": {"name": "Loop City (peta internal)", "source": "generated",
                 "bbox": [0, 0, 0, 0]},
        "nodes": {str(k): v for k, v in nodes.items()},
        "roads": roads,
        "buildings": buildings,
        "areas": areas,
    }
    os.makedirs("maps", exist_ok=True)
    with open("maps/loop_city.json", "w") as f:
        json.dump(world, f)
    n_inter = sum(1 for r in roads for _ in r["points"])  # info kasar
    print(f"OK: {len(nodes)} nodes, {len(roads)} roads, {len(buildings)} buildings "
          f"-> maps/loop_city.json ({os.path.getsize('maps/loop_city.json')} bytes)")


if __name__ == "__main__":
    main()
