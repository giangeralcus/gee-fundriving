#!/usr/bin/env python3
"""
Gee-MiniDrive CCTV Watchdog v2 — quad-view auto refresher.

Logika:
1. Screencap layar Waydroid (quad grid Mi Home).
2. Untuk tiap tile (2x2), hitung "liveness":
   - blur score  : varian Laplacian rendah = blur/still image
   - motion score: beda pixel vs frame sebelumnya (video = motion)
3. Tile blur/frozen -> tap play button-nya (koordinat tetap per quad slot).
4. Log + kirim ringkasan.

Jalankan via cron tiap 2 menit:
  * /2 * * * *  python3 /home/bakasang/cctv-emulator/watchdog2.py
"""
import os
import subprocess
import sys
import time

import pygame  # hanya utk Surfaces? tidak perlu — pakai PIL
from PIL import Image, ImageFilter

HOME = os.path.expanduser("~")
SS_TMP = "/tmp/wd2_screen.png"
LOG = os.path.join(HOME, "cctv-emulator", "watchdog2.log")
BASE = os.path.join(HOME, "cctv-emulator", "wd2_state")

# Ukuran screencap quad = 1664x1262 (override). Tile 2x2 dari vision 832x631
# dikali 2: kolom x=126 & 1058, baris y=174 & 726, tile 846x508.
# Kolom kanan kepotong layar (1664) -> right dipakai min(x, 1664).
TILES = {
    "topleft":     {"img": (126, 174, 972, 682),   "play": (566, 428)},
    "topright":    {"img": (1058, 174, 1664, 682), "play": (1494, 428)},
    "bottomleft":  {"img": (126, 726, 972, 1234),  "play": (566, 980)},
    "bottomright": {"img": (1058, 726, 1664, 1234),"play": (1494, 980)},
}

BLUR_THRESHOLD = 55.0     # laplacian var di bawah ini = blur
MOTION_THRESHOLD = 0.35   # % pixel berubah; video live biasanya > 1%
PREV_FRAME = os.path.join(BASE, "prev_full.png")


def sh(cmd, timeout=30):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True,
                          timeout=timeout)


def screencap():
    subprocess.run(
        "sudo waydroid shell screencap /sdcard/wd2.png", shell=True,
        capture_output=True, timeout=25)
    subprocess.run(
        f"sudo cp {HOME}/.local/share/waydroid/data/media/0/wd2.png {SS_TMP} && "
        f"sudo chmod 644 {SS_TMP}", shell=True, capture_output=True, timeout=10)
    return os.path.exists(SS_TMP)


def laplacian_var(im):
    g = im.convert("L").filter(ImageFilter.GaussianBlur(1))
    lap = g.filter(ImageFilter.Kernel((3, 3),
                   [0, 1, 0, 1, -4, 1, 0, 1, 0], scale=1))
    hist = lap.histogram()
    n = sum(hist)
    mean = sum(i * c for i, c in enumerate(hist)) / n
    var = sum(((i - mean) ** 2) * c for i, c in enumerate(hist)) / n
    return var


def motion_pct(im_a, im_b):
    """% pixel yang berubah signifikan antar 2 gambar (ukuran sama)."""
    a = im_a.convert("L").resize((160, 120))
    b = im_b.convert("L").resize((160, 120))
    pa, pb = a.load(), b.load()
    changed = 0
    for y in range(120):
        for x in range(160):
            if abs(pa[x, y] - pb[x, y]) > 12:
                changed += 1
    return changed / (160 * 120) * 100


def tap(x, y):
    subprocess.run(f"sudo waydroid shell -- input tap {x} {y}",
                   shell=True, capture_output=True, timeout=15)


def log(msg):
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    print(line)
    with open(LOG, "a") as f:
        f.write(line + "\n")


def main():
    os.makedirs(BASE, exist_ok=True)
    if not screencap():
        log("ERROR: screencap gagal")
        sys.exit(1)

    full = Image.open(SS_TMP)
    # early exit: kalau bukan quad grid (misal Clock/home terbuka), balikkan Mi Home
    # deteksi sederhana: tile topleft harus ada gambar (bukan hitam pekat)
    tl = full.crop(TILES["topleft"]["img"])
    ext = tl.convert("L").getextrema()
    if ext[1] - ext[0] < 20:
        log("bukan quad grid (layar lain) — buka ulang Mi Home cameras")
        sh("sudo waydroid shell -- am force-stop com.android.deskclock")
        sh("sudo waydroid shell -- am start -n "
           "com.xiaomi.smarthome/.pad.MainActivity")
        time.sleep(8)
        sh("sudo waydroid shell -- input tap 220 1014")
        sys.exit(0)

    prev = Image.open(PREV_FRAME) if os.path.exists(PREV_FRAME) else None
    actions = []
    for name, cfg in TILES.items():
        tile = full.crop(cfg["img"])
        blur = laplacian_var(tile)
        mot = motion_pct(tile, prev.crop(cfg["img"])) if prev else 99.0
        dead = blur < BLUR_THRESHOLD and mot < MOTION_THRESHOLD
        status = f"blur={blur:6.1f} motion={mot:5.2f}% -> {'REFRESH' if dead else 'ok'}"
        log(f"{name:12s} {status}")
        if dead:
            tap(*cfg["play"])
            actions.append(name)
            time.sleep(6)
    if prev is not None:
        full.save(PREV_FRAME)
    else:
        full.save(PREV_FRAME)
    if actions:
        log(f"re-played: {', '.join(actions)}")
        # screenshot pasca aksi utk audit
        time.sleep(8)
        screencap()
        sh(f"cp {SS_TMP} {BASE}/after_action.png")
    else:
        log("semua tile sehat ✓")


if __name__ == "__main__":
    main()
