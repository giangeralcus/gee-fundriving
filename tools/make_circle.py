#!/usr/bin/env python3
"""Generator peta sirkuit lingkar (skala 1:1, meter) buat mode
penyempurnaan satu kendaraan: satu jalan melingkar tanpa simpang &
lampu — murni presisi lajur di tikungan panjang.

Pakai: python tools/make_circle.py   -> maps/circle.json
"""
import json
import math
import os
import random

R = 350          # radius lingkaran (m)
N = 48           # jumlah titik (7.5 derajat per titik — halus buat pure pursuit)
WIDTH = 12       # lebar jalan: 2 lajur per arah
OUT = os.path.join("maps", "circle.json")

random.seed(7)

nodes = {}
ids = []
for i in range(N):
    ang = 2 * math.pi * i / N
    nodes[i] = [round(R * math.cos(ang), 1), round(R * math.sin(ang), 1)]
    ids.append(i)

# jalan melingkar: polyline tertutup (titik pertama diulang di akhir)
roads = [{
    "id": "ring",
    "name": "Lingkar Sirkuit",
    "width": WIDTH,
    "kind": "residential",
    "points": ids + [ids[0]],
}]

# taman di tengah lingkaran
green = [[round((R - 20) * math.cos(2 * math.pi * i / 48), 1),
          round((R - 20) * math.sin(2 * math.pi * i / 48), 1)] for i in range(48)]
areas = [{"k": "green", "pts": green}]

# deretan bangunan di luar lingkaran (dekorasi skyline)
buildings = []
for k in range(14):
    ang = 2 * math.pi * k / 14 + 0.2
    cx, cy = 445 * math.cos(ang), 445 * math.sin(ang)
    w = random.uniform(16, 30)
    h = random.uniform(16, 30)
    buildings.append([
        [round(cx - w / 2, 1), round(cy - h / 2, 1)],
        [round(cx + w / 2, 1), round(cy - h / 2, 1)],
        [round(cx + w / 2, 1), round(cy + h / 2, 1)],
        [round(cx - w / 2, 1), round(cy + h / 2, 1)],
    ])

data = {
    "meta": {
        "name": "Sirkuit Lingkar",
        "bbox": [-620, -620, 620, 620],
        # lingkaran halus: DP eps besar bakal motong jadi 12 sudut kaku —
        # eps kecil biar rute tetap mulus & profil kurva gak ngerem palsu
        "simplifyEps": 1.0,
    },
    "nodes": {str(k): v for k, v in nodes.items()},
    "roads": roads,
    "buildings": buildings,
    "areas": areas,
}

os.makedirs("maps", exist_ok=True)
with open(OUT, "w") as f:
    json.dump(data, f)
print(f"OK: {len(nodes)} node, {len(buildings)} bangunan -> {OUT} "
      f"({os.path.getsize(OUT)} bytes), keliling {2 * math.pi * R:.0f} m")
