#!/usr/bin/env python3
"""Benchmark patokan: Green Sedayu Mall <-> Puri Indah Mall (dua arah).

Jalankan sim headless, catat metrik ke docs/benchmark/history.jsonl,
lalu tampilkan tabel learning curve dari semua riwayat run.

Pakai:
  python tools/benchmark.py                 # dua arah, 240 detik sim/arah
  python tools/benchmark.py --seconds 120   # lebih singkat
"""
import argparse
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pygame  # noqa: E402

import fundriving as fd  # noqa: E402

W, H = 960, 540
MAPFILE = (os.path.join("maps", "puri_cengkareng.json")
           if os.path.exists(os.path.join("maps", "puri_cengkareng.json"))
           else os.path.join("maps", "loop_city.json"))
POIFILE = os.path.join("maps", "poi.json")
IS_LOOP = "loop_city" in MAPFILE
HIST = os.path.join("docs", "benchmark", "history.jsonl")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=int, default=240)
    ap.add_argument("--brain", default="v4", help="v4 (planner) atau v3 (pure pursuit)")
    args = ap.parse_args()

    os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
    pygame.init()
    if IS_LOOP:
        gs = pi_ = None  # loop city: misi acak, tanpa POI
    else:
        with open(POIFILE, encoding="utf-8") as f:
            poi = json.load(f)
        gs, pi_ = poi["green-sedayu"], poi["puri-indah"]

    results = []
    if IS_LOOP:
        arahs = [("Loop City (misi acak)", None, None)]
    else:
        arahs = [(f"{gs['name']} -> {pi_['name']}", gs, pi_),
                 (f"{pi_['name']} -> {gs['name']}", pi_, gs)]
    for label, a, b in arahs:
        print(f"=== {label} ===", file=sys.stderr)
        surf = pygame.Surface((W, H))
        clock = pygame.time.Clock()
        out = os.path.expanduser("~/gee-fundriving")
        if IS_LOOP:
            r = fd.run_map(MAPFILE, True, args.seconds, surf, clock, out,
                           record=False, brain=args.brain)
        else:
            r = fd.run_map(MAPFILE, True, args.seconds, surf, clock, out,
                           start_coord=(a["lat"], a["lon"]),
                           goal_coord=(b["lat"], b["lon"]),
                           record=False, brain=args.brain)
        r["arah"] = label
        r["versi"] = f"{args.brain}-planner" if args.brain == "v4" else "v3-purepursuit"
        results.append(r)

    os.makedirs(os.path.dirname(HIST), exist_ok=True)
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    with open(HIST, "a", encoding="utf-8") as f:
        for r in results:
            f.write(json.dumps({"ts": ts, **r}, ensure_ascii=False) + "\n")

    # tabel learning curve
    print("\n=== LEARNING CURVE (semua riwayat) ===")
    print(f"{'waktu':<17}{'arah':<44}{'selesai':<8}{'skor':<6}{'merah':<6}{'tabrak':<7}{'off%':<6}")
    if os.path.exists(HIST):
        for line in open(HIST, encoding="utf-8"):
            d = json.loads(line)
            print(f"{d['ts']:<17}{d['arah'][:42]:<44}"
                  f"{('OK' if d.get('selesai') else '-'): <8}"
                  f"{d.get('skor', 0):<6}{d.get('merah', 0):<6}"
                  f"{d.get('tabrak', 0):<7}{d.get('offroad_pct', 0):<6}")


if __name__ == "__main__":
    main()
