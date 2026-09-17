#!/usr/bin/env python3
"""
Gee-MiniDrive — sim nyetir 2D top-down ala demo FSD/Jev.

Konsep "System One decision loop":
- Tiap tick, mobil mengukur STATE (jarak sensor 5 arah + sudut vs tengah jalan + kecepatan)
- Brain (pluggable) memutuskan: steer [-1..1], throttle [0..1], brake [0..1]
- Tabrak dinding/obstacle = reset + catat statistik

Brain default: rule-based calibrated decisions (mengimitasi pola Jev:
banyak pertanyaan kecil -> keputusan typed, tanpa bahasa natural).

Headless mode: render offscreen + rekam MP4 (buat kirim ke Telegram).
"""
import math
import os
import random
import subprocess
import sys

import pygame

W, H = 960, 540
FPS = 60
ROAD_W = 140.0          # lebar jalan (px)
CAR_LEN, CAR_W = 34, 18
SENSOR_LEN = 130.0
MAX_SPEED = 3.4
ACCEL = 0.06
BRAKE = 0.18
TURN_RATE = 3.2         # deg per tick pada speed penuh

# ---------- Track: sirkuit rounded-rectangle tertutup ----------
CX, CY = W // 2, H // 2
RX, RY = W // 2 - 110, H // 2 - 80   # radius ellipse track


def track_center(t: float):
    """Posisi titik tengah jalan pada param t (0..1)."""
    return CX + RX * math.cos(2 * math.pi * t), CY + RY * math.sin(2 * math.pi * t)


def nearest_center(x: float, y: float):
    """Cari t terdekat (coarse scan + refine) + jarak ke center line."""
    best_t, best_d = 0.0, 1e9
    for i in range(256):
        t = i / 256
        px, py = track_center(t)
        d = math.hypot(px - x, py - y)
        if d < best_d:
            best_t, best_d = t, d
    return best_t, best_d


# ---------- Sensors ----------
def cast(x, y, ang_deg, max_len):
    """Ray march kasar: jarak sampai keluar jalan (di luar ellipse ring)."""
    ang = math.radians(ang_deg)
    step = 6.0
    d = 0.0
    while d < max_len:
        d += step
        px, py = x + math.cos(ang) * d, y + math.sin(ang) * d
        _, dc = nearest_center(px, py)
        if dc > ROAD_W / 2:
            return d
    return max_len


# ---------- Brain: System-One style calibrated rules ----------
def brain_decide(state):
    """
    state: dict dengan 5 sensor (f, fl, fr, l, r), offset lateral, heading_err,
    speed_norm. Return (steer, throttle, brake, debug) — keputusan typed.
    Implementasi mengikuti pola Jev: pertanyaan-pertanyaan kecil paralel,
    tiap jawaban punya 'confidence'; kombinasi lewat aturan sederhana.
    """
    decisions = {}

    # Q1: apakah dinding depan dekat? (Noul-style yes/no + confidence)
    front_risk = 1.0 - min(state["f"], SENSOR_LEN) / SENSOR_LEN
    decisions["front_risk"] = front_risk

    # Q2: arah belok (Choice-style) — pilih sisi yang lebih lapang
    steer_choice = 0.0
    conf = 0.5
    gap_l, gap_r = state["fl"], state["fr"]
    if front_risk > 0.55 or gap_l < 40 or gap_r < 40:
        # bahaya depan: belok ke sisi lebih lapang
        steer_choice = 1.0 if gap_r > gap_l else -1.0
        conf = min(1.0, abs(gap_r - gap_l) / 80 + 0.5)
    else:
        # koridor lapang: kejar center line
        steer_choice = max(-1.0, min(1.0, -state["heading_err"] * 2.5 - state["lateral"] / 70))
        conf = 1.0 - min(abs(state["lateral"]) / (ROAD_W / 2), 1.0) * 0.5
    decisions["steer"] = (steer_choice, conf)

    # Q3: throttle (Score-style rubric)
    if front_risk > 0.6:
        thr, brk = 0.0, 1.0
    elif front_risk > 0.35:
        thr, brk = 0.35, 0.0
    else:
        thr, brk = 1.0, 0.0
    decisions["throttle"] = thr
    decisions["brake"] = brk

    steer = max(-1.0, min(1.0, steer_choice * (0.6 + 0.4 * conf)))
    return steer, thr, brk, decisions


# ---------- Car ----------
class Car:
    def __init__(self):
        self.reset()

    def reset(self):
        self.t = 0.0
        x, y = track_center(0.0)
        self.x, self.y = x, y
        # arah awal = tangen ellipse di t=0 (ke arah -y untuk perjalanan ccw)
        self.heading = -90.0
        self.speed = 0.0
        self.laps = 0.0
        self.last_t = 0.0
        self.crashes = 0
        self.alive_time = 0
        self.frame_alive = True

    def sense(self):
        f = cast(self.x, self.y, self.heading, SENSOR_LEN)
        fl = cast(self.x, self.y, self.heading - 35, SENSOR_LEN)
        fr = cast(self.x, self.y, self.heading + 35, SENSOR_LEN)
        l = cast(self.x, self.y, self.heading - 80, SENSOR_LEN * 0.7)
        r = cast(self.x, self.y, self.heading + 80, SENSOR_LEN * 0.7)
        t, dc = nearest_center(self.x, self.y)
        lateral = dc - ROAD_W / 2  # >0 berarti mepet/di luar kanan
        # heading error: proyeksi arah mobil ke tangen track
        eps = 0.002
        x1, y1 = track_center((t - eps) % 1.0)
        x2, y2 = track_center((t + eps) % 1.0)
        tangent = math.degrees(math.atan2(y2 - y1, x2 - x1))
        heading_err = (self.heading - tangent + 180) % 360 - 180
        # lap progress
        if self.last_t > 0.9 and t < 0.1:
            self.laps += 1
        self.last_t = t
        return {
            "f": f, "fl": fl, "fr": fr, "l": l, "r": r,
            "lateral": lateral, "heading_err": heading_err,
            "speed_norm": self.speed / MAX_SPEED, "t": t,
        }

    def step(self, steer, thr, brk):
        turn = steer * TURN_RATE * (0.35 + 0.65 * self.speed / MAX_SPEED)
        self.heading = (self.heading + turn) % 360
        if brk > 0:
            self.speed = max(0.0, self.speed - BRAKE)
        elif thr > 0:
            self.speed = min(MAX_SPEED, self.speed + ACCEL * thr)
        else:
            self.speed = max(0.0, self.speed - 0.02)
        a = math.radians(self.heading)
        self.x += math.cos(a) * self.speed
        self.y += math.sin(a) * self.speed
        self.alive_time += 1
        _, dc = nearest_center(self.x, self.y)
        if dc > ROAD_W / 2 + 2:
            self.frame_alive = False


# ---------- Render ----------
def draw(scene_surf, car, state, decisions, gen_stats):
    scene_surf.fill((24, 26, 32))
    # track ring: gambar ellipse tebal
    pygame.draw.ellipse(scene_surf, (52, 56, 66),
                        (CX - RX - ROAD_W / 2, CY - RY - ROAD_W / 2,
                         (RX + ROAD_W / 2) * 2, (RY + ROAD_W / 2) * 2))
    pygame.draw.ellipse(scene_surf, (24, 26, 32),
                        (CX - RX + ROAD_W / 2, CY - RY + ROAD_W / 2,
                         (RX - ROAD_W / 2) * 2, (RY - ROAD_W / 2) * 2))
    # garis tengah putus2
    for i in range(0, 64):
        t = i / 64
        x, y = track_center(t)
        pygame.draw.circle(scene_surf, (90, 94, 104), (int(x), int(y)), 2)

    # sensor rays
    for off, ln in ((0, state["f"]), (-35, state["fl"]), (35, state["fr"]),
                    (-80, state["l"] * 0.7), (80, state["r"] * 0.7)):
        a = math.radians(car.heading + off)
        col = (200, 80, 80) if ln < 45 else (120, 160, 220)
        pygame.draw.line(scene_surf, col, (car.x, car.y),
                         (car.x + math.cos(a) * ln, car.y + math.sin(a) * ln), 1)

    # mobil
    a = math.radians(car.heading)
    pts = []
    for dx, dy in ((CAR_LEN / 2, 0), (-CAR_LEN / 2, CAR_W / 2),
                   (-CAR_LEN / 2, -CAR_W / 2)):
        px = car.x + dx * math.cos(a) - dy * math.sin(a)
        py = car.y + dx * math.sin(a) + dy * math.cos(a)
        pts.append((px, py))
    color = (80, 220, 120) if car.frame_alive else (220, 80, 80)
    pygame.draw.polygon(scene_surf, color, pts)

    # HUD teks kecil (pakai font default)
    try:
        font = pygame.font.SysFont("dejavusansmono", 14)
        lines = [
            f"speed {car.speed:4.1f}  laps {car.laps:.2f}  alive {car.alive_time//FPS}s",
            f"risk {decisions.get('front_risk',0):.2f}  steer {decisions.get('steer',(0,0))[0]:+.2f} (conf {decisions.get('steer',(0,0))[1]:.2f})",
            gen_stats,
        ]
        for i, ln in enumerate(lines):
            scene_surf.blit(font.render(ln, True, (220, 220, 220)), (10, 8 + i * 18))
    except Exception:
        pass


def main():
    headless = "--headless" in sys.argv
    seconds = 45
    for i, a in enumerate(sys.argv):
        if a == "--seconds":
            seconds = int(sys.argv[i + 1])
    outdir = os.path.expanduser("~/gee-minidrive")
    os.makedirs(outdir, exist_ok=True)

    if headless:
        os.environ["SDL_VIDEODRIVER"] = "dummy"
    pygame.init()
    surf = pygame.Surface((W, H)) if headless else pygame.display.set_mode((W, H))
    if not headless:
        pygame.display.set_caption("Gee-MiniDrive")
    clock = pygame.time.Clock()

    car = Car()
    frames_dir = os.path.join(outdir, "frames")
    if headless:
        os.makedirs(frames_dir, exist_ok=True)
        for f in os.listdir(frames_dir):
            os.remove(os.path.join(frames_dir, f))

    total = FPS * seconds
    best_alive = 0
    for fi in range(total):
        state = car.sense()
        steer, thr, brk, dec = brain_decide(state)
        car.step(steer, thr, brk)
        if not car.frame_alive:
            best_alive = max(best_alive, car.alive_time)
            car.reset()
        gen = f"best alive {best_alive//FPS}s  crashes {car.crashes}"
        draw(surf, car, state, dec, gen)
        if headless and fi % 2 == 0:  # 30fps video
            pygame.image.save(surf, os.path.join(frames_dir, f"f{fi:05d}.png"))
        if not headless:
            pygame.event.pump()
            pygame.display.flip()
            clock.tick(FPS)
            for ev in pygame.event.get():
                if ev.type == pygame.QUIT:
                    pygame.quit()
                    return
    pygame.quit()

    if headless:
        mp4 = os.path.join(outdir, "gee_minidrive_demo.mp4")
        subprocess.run([
            "ffmpeg", "-y", "-loglevel", "error", "-framerate", "30",
            "-i", os.path.join(frames_dir, "f%05d.png"),
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", mp4,
        ], check=True)
        print("VIDEO_OK", mp4)
    print(f"selesai: best alive {best_alive}s, laps terakhir {car.laps:.2f}")


if __name__ == "__main__":
    main()
