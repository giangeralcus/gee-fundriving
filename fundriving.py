#!/usr/bin/env python3
"""
Gee-FunDriving — sim nyetir 2D top-down.

MODE:
1. Sirkuit (default)     : track oval, brain rule-based System-One loop.
2. Peta OSM (--map FILE) : dunia kota nyata (jalan per-tipe, bangunan, area
                           hijau/air, lampu lalu lintas, mobil AI, nama jalan)
                           + mode misi: antar sampai tujuan, dinilai vs rute
                           terpendek. Kamera ikut mobil.
                           Koordinat bisa diatur: --start "lat,lon"
                           --goal "lat,lon" --heading derajat.
                           Keys: [ESC] keluar, [-][=] zoom, [R] misi baru,
                           [F] assistant ON/OFF (autopilot vs kemudi sendiri
                           WASD/arrow).

Headless: rekam MP4 (butuh ffmpeg). Mulai langsung nyetir sendiri: --manual.
Windowed tanpa argumen: main menu START / SETTINGS / ABOUT / EXIT — setelan
(mode, peta, fps render) tersimpan di ~/gee-fundriving/settings.json; ESC di
game balik ke menu.
"""
import json
import math
import os
import random
import shutil
import subprocess
import sys
from collections import OrderedDict

import pygame

W, H = 960, 540
FPS = 60              # tick fisika simulasi (Hz) — semua konstanta tuning diikat ke sini
RENDER_FPS = 30       # render + input + rekam video (fps)
RENDER_EVERY = FPS // RENDER_FPS   # fisika jalan tiap tick, render tiap N tick
SETTINGS_PATH = os.path.join(os.path.expanduser("~"), "gee-fundriving", "settings.json")


def set_render_fps(n):
    """Ubah fps render dari menu SETTINGS (fisika tetap FPS)."""
    global RENDER_FPS, RENDER_EVERY
    RENDER_FPS = n if n in (30, 60) else 30
    RENDER_EVERY = max(1, FPS // RENDER_FPS)

# ---------------------------------------------------------------- sirkuit ---
ROAD_W = 140.0
CAR_LEN, CAR_W = 34, 18
SENSOR_LEN = 130.0
MAX_SPEED = 3.4
ACCEL = 0.06
BRAKE = 0.18
TURN_RATE = 3.2

CX, CY = W // 2, H // 2
RX, RY = W // 2 - 110, H // 2 - 80


def track_center(t):
    return CX + RX * math.cos(2 * math.pi * t), CY + RY * math.sin(2 * math.pi * t)


def nearest_center(x, y):
    best_t, best_d = 0.0, 1e9
    for i in range(256):
        t = i / 256
        px, py = track_center(t)
        d = math.hypot(px - x, py - y)
        if d < best_d:
            best_t, best_d = t, d
    return best_t, best_d


def cast(x, y, ang_deg, max_len):
    ang = math.radians(ang_deg)
    d = 0.0
    while d < max_len:
        d += 6.0
        px, py = x + math.cos(ang) * d, y + math.sin(ang) * d
        _, dc = nearest_center(px, py)
        if dc > ROAD_W / 2:
            return d
    return max_len


def brain_decide(state):
    front_risk = 1.0 - min(state["f"], SENSOR_LEN) / SENSOR_LEN
    gap_l, gap_r = state["fl"], state["fr"]
    if front_risk > 0.55 or gap_l < 40 or gap_r < 40:
        steer_choice = 1.0 if gap_r > gap_l else -1.0
        conf = min(1.0, abs(gap_r - gap_l) / 80 + 0.5)
    else:
        steer_choice = max(-1.0, min(1.0, -state["heading_err"] * 2.5 - state["lateral"] / 70))
        conf = 1.0 - min(abs(state["lateral"]) / (ROAD_W / 2), 1.0) * 0.5
    if front_risk > 0.6:
        thr, brk = 0.0, 1.0
    elif front_risk > 0.35:
        thr, brk = 0.35, 0.0
    else:
        thr, brk = 1.0, 0.0
    steer = max(-1.0, min(1.0, steer_choice * (0.6 + 0.4 * conf)))
    return steer, thr, brk, {"front_risk": front_risk, "steer": (steer, conf)}


class CircuitCar:
    def __init__(self):
        self.reset()

    def reset(self):
        self.t = 0.0
        self.x, self.y = track_center(0.0)
        self.heading = -90.0
        self.speed = 0.0
        self.laps = 0.0
        self.last_t = 0.0
        self.frame_alive = True
        self.alive_time = 0

    def sense(self):
        f = cast(self.x, self.y, self.heading, SENSOR_LEN)
        fl = cast(self.x, self.y, self.heading - 35, SENSOR_LEN)
        fr = cast(self.x, self.y, self.heading + 35, SENSOR_LEN)
        t, dc = nearest_center(self.x, self.y)
        eps = 0.002
        x1, y1 = track_center((t - eps) % 1.0)
        x2, y2 = track_center((t + eps) % 1.0)
        tangent = math.degrees(math.atan2(y2 - y1, x2 - x1))
        heading_err = (self.heading - tangent + 180) % 360 - 180
        if self.last_t > 0.9 and t < 0.1:
            self.laps += 1
        self.last_t = t
        return {"f": f, "fl": fl, "fr": fr, "l": SENSOR_LEN, "r": SENSOR_LEN,
                "lateral": dc - ROAD_W / 2, "heading_err": heading_err,
                "speed_norm": self.speed / MAX_SPEED, "t": t}

    def step(self, steer, thr, brk):
        turn = steer * TURN_RATE * (0.35 + 0.65 * self.speed / MAX_SPEED)
        self.heading = (self.heading + turn) % 360
        if brk > 0:
            self.speed = max(0.0, self.speed - BRAKE)
        elif thr > 0:
            self.speed = min(MAX_SPEED, self.speed + ACCEL * thr)
        self.a = math.radians(self.heading)
        self.x += math.cos(self.a) * self.speed
        self.y += math.sin(self.a) * self.speed
        self.alive_time += 1
        _, dc = nearest_center(self.x, self.y)
        self.frame_alive = dc <= ROAD_W / 2 + 2


def draw_circuit(surf, car, state, dec, stats):
    surf.fill((24, 26, 32))
    pygame.draw.ellipse(surf, (52, 56, 66),
                        (CX - RX - ROAD_W / 2, CY - RY - ROAD_W / 2,
                         (RX + ROAD_W / 2) * 2, (RY + ROAD_W / 2) * 2))
    pygame.draw.ellipse(surf, (24, 26, 32),
                        (CX - RX + ROAD_W / 2, CY - RY + ROAD_W / 2,
                         (RX - ROAD_W / 2) * 2, (RY + ROAD_W / 2) * 2))
    for i in range(0, 64, 2):
        x, y = track_center(i / 64)
        pygame.draw.circle(surf, (90, 94, 104), (int(x), int(y)), 2)
    for off, ln in ((0, state["f"]), (-35, state["fl"]), (35, state["fr"])):
        a = math.radians(car.heading + off)
        col = (200, 80, 80) if ln < 45 else (120, 160, 220)
        pygame.draw.line(surf, col, (car.x, car.y),
                         (car.x + math.cos(a) * ln, car.y + math.sin(a) * ln), 1)
    a = math.radians(car.heading)
    pts = [(car.x + dx * math.cos(a) - dy * math.sin(a),
            car.y + dx * math.sin(a) + dy * math.cos(a))
           for dx, dy in ((CAR_LEN / 2, 0), (-CAR_LEN / 2, CAR_W / 2), (-CAR_LEN / 2, -CAR_W / 2))]
    pygame.draw.polygon(surf, (80, 220, 120) if car.frame_alive else (220, 80, 80), pts)
    hud(surf, [f"speed {car.speed:.1f} laps {car.laps:.2f}",
               f"risk {dec.get('front_risk', 0):.2f} steer {dec.get('steer', (0, 0))[0]:+.2f}",
               stats])


def hud(surf, lines):
    try:
        font = pygame.font.SysFont("dejavusansmono", 14)
        for i, ln in enumerate(lines):
            surf.blit(font.render(ln, True, (220, 220, 220)), (10, 8 + i * 18))
    except Exception:
        pass


# ---------------------------------------------------------------- OSM map ---
CELL = 500

def simplify(points, eps=12.0):
    """Douglas-Peucker: raut poliline rute — bunuh zigzag antar lajur
    ganda & nilai-niali node yang kepadatan, sisakan bentuk jalan."""
    if len(points) < 3:
        return list(points)
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        i0, i1 = stack.pop()
        if i1 <= i0 + 1:
            continue
        ax, ay = points[i0]
        bx, by = points[i1]
        dx, dy = bx - ax, by - ay
        n = math.hypot(dx, dy) + 1e-9
        best, bi = -1.0, -1
        for i in range(i0 + 1, i1):
            px, py = points[i]
            d = abs((px - ax) * dy - (py - ay) * dx) / n
            if d > best:
                best, bi = d, i
        if best > eps:
            keep[bi] = True
            stack.append((i0, bi))
            stack.append((bi, i1))
    return [p for p, k in zip(points, keep) if k]


  # ukuran sel spatial grid (meter) biar render gak terjerat peta raksasa


class OSMWorld:
    """Dunia dari OSM: graf jalan + bangunan + area + rute A* buat mobil.
    width_scale: pengali lebar jalan logis (bikin nurut jalan lebih gampang)."""

    def __init__(self, path, width_scale=1.0):
        with open(path) as f:
            d = json.load(f)
        self.meta = d["meta"]
        self.width_scale = width_scale
        self.nodes = {int(k): tuple(v) for k, v in d["nodes"].items()}
        self.adj = {}
        self.halfw = {}
        self.way_name = {}
        for r in d["roads"]:
            pts = r["points"]
            self.way_name[r["id"]] = r.get("name", "")
            wd = r.get("width", 10) / 2 * width_scale
            for a, b in zip(pts, pts[1:]):
                self.adj.setdefault(a, set()).add(b)
                self.adj.setdefault(b, set()).add(a)
                self._wmin(a, b, wd)
        xs = [p[0] for p in self.nodes.values()]
        ys = [p[1] for p in self.nodes.values()]
        self.minx, self.maxx = min(xs), max(xs)
        self.miny, self.maxy = min(ys), max(ys)
        self._build_segments(d)
        self._build_polys(d)
        self._build_named_segs(d)
        self._build_grids()

    def _build_grids(self):
        """Spatial grid: index elemen per sel 500m biar culling murah."""
        self.seg_grid = {}
        for i, (ax, ay, bx, by, _wd, _kind, _k) in enumerate(self.segs):
            for cx in range(int(min(ax, bx) // CELL), int(max(ax, bx) // CELL) + 1):
                for cy in range(int(min(ay, by) // CELL), int(max(ay, by) // CELL) + 1):
                    self.seg_grid.setdefault((cx, cy), []).append(i)
        self.bldg_grid = {}
        for i, (bb, _pts) in enumerate(self.buildings):
            for cx in range(int(bb[0] // CELL), int(bb[2] // CELL) + 1):
                for cy in range(int(bb[1] // CELL), int(bb[3] // CELL) + 1):
                    self.bldg_grid.setdefault((cx, cy), []).append(i)
        self.area_grid = {}
        for i, (bb, _pts, _k) in enumerate(self.areas):
            for cx in range(int(bb[0] // CELL), int(bb[2] // CELL) + 1):
                for cy in range(int(bb[1] // CELL), int(bb[3] // CELL) + 1):
                    self.area_grid.setdefault((cx, cy), []).append(i)

    def _wmin(self, a, b, wd):
        k = (min(a, b), max(a, b))
        if k not in self.halfw or wd < self.halfw[k]:
            self.halfw[k] = wd

    def seg_halfw(self, a, b):
        return self.halfw.get((min(a, b), max(a, b)), 5.0)

    def _build_segments(self, d):
        """Precompute segmen jalan utk render cepat: (ax,ay,bx,by,hw,kind)."""
        kind_by_road = {r["id"]: r.get("kind", "residential") for r in d["roads"]}
        self.segs = []
        seen = set()
        for r in d["roads"]:
            pts = r["points"]
            wd = r.get("width", 10) / 2 * self.width_scale
            kind = r.get("kind", "residential")
            for a, b in zip(pts, pts[1:]):
                k = (min(a, b), max(a, b))
                if k in seen:
                    continue
                seen.add(k)
                ax, ay = self.nodes[a]
                bx, by = self.nodes[b]
                self.segs.append((ax, ay, bx, by, wd, kind, k))
        self.seg_kind = kind_by_road

    def _build_polys(self, d):
        """Bangunan & area: (bbox, pts) biar gampang di-cull kamera."""
        def bbox(pts):
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            return (min(xs), min(ys), max(xs), max(ys))
        self.buildings = []
        for pts in d.get("buildings", []):
            if len(pts) >= 3:
                self.buildings.append((bbox(pts), pts))
        self.areas = []
        for a in d.get("areas", []):
            pts = a.get("pts", [])
            if len(pts) >= 3:
                self.areas.append((bbox(pts), pts, a.get("k", "green")))

    def _build_named_segs(self, d):
        """Segmen bernama utk label nama jalan: (ax,ay,bx,by,name)."""
        self.named_segs = []
        seen = set()
        for r in d.get("roads", []):
            nm = r.get("name", "")
            if not nm:
                continue
            pts = r["points"]
            for a, b in zip(pts, pts[1:]):
                k = (min(a, b), max(a, b))
                if k in seen:
                    continue
                seen.add(k)
                ax, ay = self.nodes[a]
                bx, by = self.nodes[b]
                self.named_segs.append((ax, ay, bx, by, nm))

    def nearest_node(self, x, y, subset=None):
        best, bd = None, 1e18
        src = subset if subset is not None else self.nodes
        for nid in src:
            nx, ny = self.nodes[nid]
            d = (nx - x) ** 2 + (ny - y) ** 2
            if d < bd:
                best, bd = nid, d
        return best

    def route(self, start, goal):
        import heapq
        dist = {start: 0.0}
        prev = {}
        pq = [(0.0, start)]
        while pq:
            d0, u = heapq.heappop(pq)
            if u == goal:
                break
            if d0 > dist.get(u, 1e18):
                continue
            for v in self.adj.get(u, ()):
                ux, uy = self.nodes[u]
                vx, vy = self.nodes[v]
                nd = d0 + math.hypot(vx - ux, vy - uy)
                if nd < dist.get(v, 1e18):
                    dist[v] = nd
                    prev[v] = u
                    heapq.heappush(pq, (nd, v))
        if goal not in dist:
            return []
        path = [goal]
        while path[-1] != start:
            path.append(prev[path[-1]])
        return list(reversed(path))


class Signals:
    """Lampu lalu lintas di simpang NYATA (bukan parkir kompleks): derajat >= 4
    dan minimal satu segmen penghubung berkelas jalan besar. Fase bergantian
    sumbu horizontal (0) / vertikal (1). Hanya digambar dekat mobil."""

    CYCLE = 420  # frame per fase (7s @60fps)
    DRAW_RADIUS = 420.0
    MAJOR = {"motorway", "trunk", "primary", "secondary", "tertiary", "residential"}

    def __init__(self, world, comp):
        self.world = world
        cand = set()
        for ax, ay, bx, by, _wd, kind, (a, b) in world.segs:
            if kind not in self.MAJOR:
                continue
            if a in comp and len(world.adj.get(a, ())) >= 4:
                cand.add(a)
            if b in comp and len(world.adj.get(b, ())) >= 4:
                cand.add(b)
        self.nodes = cand
        self.node_list = sorted(self.nodes)
        self.pos = [world.nodes[n] for n in self.node_list]
        self.frame = 0

    def nodes_at(self, i):
        return self.node_list[i]

    def axis_of(self, ax, ay, bx, by):
        return 0 if abs(bx - ax) >= abs(by - ay) else 1

    def green(self, node, axis):
        if node not in self.nodes:
            return True
        return (self.frame // self.CYCLE) % 2 == axis

    def update(self):
        self.frame += 1

    def draw(self, surf, cam, car_pos=None):
        z = cam.zoom
        for n, (wx, wy) in zip(self.node_list, self.pos):
            if car_pos is not None:
                if (wx - car_pos[0]) ** 2 + (wy - car_pos[1]) ** 2 > self.DRAW_RADIUS ** 2:
                    continue
            nx, ny = cam.apply(wx, wy)
            if not (-20 < nx < W + 20 and -20 < ny < H + 20):
                continue
            ph = (self.frame // self.CYCLE) % 2
            pygame.draw.circle(surf, (230, 80, 80) if ph == 0 else (90, 220, 110), (int(nx), int(ny)), 3)
            pygame.draw.circle(surf, (90, 220, 110) if ph == 0 else (230, 80, 80),
                               (int(nx) + 5, int(ny)), 3)


class Traffic:
    """Mobil AI: jalan random-walk di graf, lane kanan, hormati lampu merah."""

    def __init__(self, world, comp, avoid_xy, n=16):
        self.world = world
        self.cars = []
        self.comp = list(comp)
        segs = list(world.halfw.keys())
        random.shuffle(segs)
        for k in segs:
            if len(self.cars) >= n:
                break
            a, b = k
            if a not in comp or b not in comp:
                continue
            ax, ay = world.nodes[a]
            if math.hypot(ax - avoid_xy[0], ay - avoid_xy[1]) < 180:
                continue
            self.cars.append(self._mk(a, b))
        self._lane(world)

    def _mk(self, a, b):
        w = self.world
        ax, ay = w.nodes[a]
        bx, by = w.nodes[b]
        L = max(math.hypot(bx - ax, by - ay), 1.0)
        t = random.uniform(0.05, 0.95)
        ang = math.atan2(by - ay, bx - ax)
        return {"a": a, "b": b, "t": t, "L": L,
                "x": ax + (bx - ax) * t, "y": ay + (by - ay) * t,
                "heading": math.degrees(ang),
                "base": random.uniform(2.2, 3.3), "speed": 0.0}

    def _lane(self, w):
        for c in self.cars:
            self._apply_lane(c, w)

    def _apply_lane(self, c, w):
        ax, ay = w.nodes[c["a"]]
        bx, by = w.nodes[c["b"]]
        dx, dy = bx - ax, by - ay
        L = c["L"]
        off = w.seg_halfw(c["a"], c["b"]) * 0.55
        px, py = -dy / L, dx / L   # kanan arah jalan (y-down)
        c["x"] += px * off
        c["y"] += py * off

    def _next_edge(self, c):
        w = self.world
        b = c["b"]
        nbrs = list(w.adj.get(b, ()))
        if len(nbrs) > 1:
            nbrs = [v for v in nbrs if v != c["a"]] or nbrs
        nb = random.choice(nbrs)
        nc = self._mk(b, nb)
        nc["base"] = c["base"]
        return nc

    def update(self, signals, hero=None):
        w = self.world
        # indeks leader per segmen terarah
        on_edge = {}
        for i, c in enumerate(self.cars):
            on_edge.setdefault((c["a"], c["b"]), []).append((c["t"], i))
        for lst in on_edge.values():
            lst.sort()
        for i, c in enumerate(self.cars):
            # cari leader di segmen sama
            tgt_speed = c["base"]
            # deteksi HERO sebagai rintangan di depan (searah & dekat)
            if hero is not None:
                hx_, hy_ = math.cos(math.radians(c["heading"])), math.sin(math.radians(c["heading"]))
                dxh, dyh = hero[0] - c["x"], hero[1] - c["y"]
                fwdh = dxh * hx_ + dyh * hy_
                if 0 < fwdh < 32 and abs(-dxh * hy_ + dyh * hx_) < 6:
                    tgt_speed = 0.0
            for t_other, j in on_edge.get((c["a"], c["b"]), ()):
                if j != i and t_other > c["t"]:
                    gap = (t_other - c["t"]) * c["L"]
                    if gap < 30:
                        tgt_speed = 0.0
                        break
            # lampu merah di node tujuan
            if c["b"] in signals.nodes:
                dist_node = (1.0 - c["t"]) * c["L"]
                ax, ay = w.nodes[c["a"]]
                bx, by = w.nodes[c["b"]]
                axis = signals.axis_of(ax, ay, bx, by)
                if 8 < dist_node < 34 and not signals.green(c["b"], axis):
                    tgt_speed = 0.0
            c["speed"] = tgt_speed
            c["t"] += c["speed"] / c["L"]
            if c["t"] >= 1.0:
                nc = self._next_edge(c)
                c["a"], c["b"], c["t"], c["L"] = nc["a"], nc["b"], 0.0, nc["L"]
                ax, ay = w.nodes[c["a"]]
                bx, by = w.nodes[c["b"]]
                c["heading"] = math.degrees(math.atan2(by - ay, bx - ax))
            ax, ay = w.nodes[c["a"]]
            bx, by = w.nodes[c["b"]]
            t = c["t"]
            px, py = ax + (bx - ax) * t, ay + (by - ay) * t
            L = c["L"]
            off = w.seg_halfw(c["a"], c["b"]) * 0.55
            dx, dy = bx - ax, by - ay
            c["x"], c["y"] = px + (-dy / L) * off, py + (dx / L) * off

    def draw(self, surf, cam):
        z = cam.zoom
        for c in self.cars:
            sx, sy = cam.apply(c["x"], c["y"])
            if not (-40 < sx < W + 40 and -40 < sy < H + 40):
                continue
            a = math.radians(c["heading"])
            pts = [(sx + dx * math.cos(a) * z - dy * math.sin(a) * z,
                    sy + dx * math.sin(a) * z + dy * math.cos(a) * z)
                   for dx, dy in ((11, 0), (-9, 6), (-9, -6))]
            pygame.draw.polygon(surf, (235, 165, 75), pts)


class Mission:
    """Misi antar: tujuan acak 500-2600m, skor = (terpendek/driven)*1000
    - 40/lampu merah - 25/tabrakan."""

    def __init__(self, world, comp, from_node):
        self.world = world
        self.comp = comp
        self.n = 0
        self.score = 0
        self.reds = 0
        self.crashes = 0
        self.recovers = 0
        self.red_cd = {}
        self.goal = None
        self.route_len = 0.0
        self.driven = 0.0
        self.done = False
        self.from_node = from_node

    def route_len_of(self, pts):
        return sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:]))

    def new(self, from_node, car):
        w = self.world
        fx, fy = w.nodes[from_node]
        pool = random.sample(sorted(self.comp), min(500, len(self.comp)))
        cands = [n for n in pool
                 if 500 < math.hypot(w.nodes[n][0] - fx, w.nodes[n][1] - fy) < 2600]
        random.shuffle(cands)
        for goal in cands[:12]:
            r = w.route(from_node, goal)
            if len(r) >= 4:
                pts = simplify([w.nodes[n] for n in r], eps=12.0)
                if len(pts) >= 3:
                    self._set(goal, pts, car)
                    return True
        return False

    def new_fixed(self, from_node, goal_node, car):
        """Misi dengan tujuan eksplisit (mis. koordinat Taman Palem)."""
        r = self.world.route(from_node, goal_node)
        if len(r) < 2:
            return False
        pts = simplify([self.world.nodes[n] for n in r], eps=12.0)
        self._set(goal_node, pts, car)
        return True

    def _set(self, goal, pts, car):
        self.goal = goal
        self.route_len = self.route_len_of(pts)
        self.driven = 0.0
        self.reds = 0
        self.crashes = 0
        self.recovers = 0
        self.done = False
        self.red_cd = {}
        car.route = pts
        car.wp_i = 0
        car.finished = False
        car._init_heading()

    def complete(self, car):
        base = round(self.route_len / max(self.driven, 1.0) * 1000)
        pts = max(50, base - 40 * self.reds - 25 * self.crashes)
        self.score += pts
        self.n += 1
        self.done = True
        return pts


class MapCar:
    """Mobil di peta OSM — PURE PURSUIT:
    progres rute dihitung dari proyeksi posisi ke segmen rute aktif
    (bukan radius lingkaran), steering menuju titik lookahead DI ATAS
    rute. Mobil gak bisa "melahap" waypoint dari jalan sebelah."""

    MAXV = 4.2          # px/frame (~ 40 km/h pada scale)
    ACC = 0.05
    LOOKAHEAD_BASE = 16  # lookahead dinamis: 16 + 6*speed (motong tikungan minim)
    LOOKAHEAD_GAIN = 6.0
    CAPTURE = 12.0      # radius capture kecil (toleransi ujung rute)
    LANE_OFF = 3.5      # geser kanan: mobil jalan di lajur kanan, bukan tengah

    def _lookahead(self):
        return self.LOOKAHEAD_BASE + self.LOOKAHEAD_GAIN * self.speed

    def __init__(self, world, start_node, route):
        self.world = world
        self.route = route
        self.wp_i = 0        # indeks segmen progres (car di segmen wp_i -> wp_i+1)
        x, y = world.nodes[start_node]
        self.x, self.y = float(x), float(y)
        self.heading = 0.0
        self.speed = 0.0
        self.crashes = 0
        self.alive_time = 0
        self.finished = False
        self._init_heading()

    def _init_heading(self):
        wp = self._lookpoint(0.0)
        self.heading = math.degrees(math.atan2(wp[1] - self.y, wp[0] - self.x))

    def _project(self):
        """Proyeksi posisi mobil ke segmen aktif. return (t, cx, cy, dist)."""
        w = self.world
        ax, ay = self.route[self.wp_i]
        bx, by = self.route[self.wp_i + 1]
        abx, aby = bx - ax, by - ay
        ab2 = abx * abx + aby * aby + 1e-6
        tt = max(0.0, min(1.0, ((self.x - ax) * abx + (self.y - ay) * aby) / ab2))
        cx, cy = ax + abx * tt, ay + aby * tt
        return tt, cx, cy, math.hypot(self.x - cx, self.y - cy)

    def _lookpoint(self, t_proj=0.0):
        """Titik lookahead: DI ATAS rute, sejauh target dari proyeksi.
        Kalau segmen aktif lebih panjang dari target -> titik ada di
        segmen yang sama (JANGAN lompat ke goal!)."""
        i = self.wp_i
        ax, ay = self.route[i]
        bx, by = self.route[i + 1]
        seglen = math.hypot(bx - ax, by - ay) + 1e-6
        px = ax + (bx - ax) * t_proj
        py = ay + (by - ay) * t_proj
        target = self._lookahead()
        acc = math.hypot(bx - px, by - py)  # sisa segmen aktif
        if acc >= target:
            ux, uy = (bx - ax) / seglen, (by - ay) / seglen
            return px + ux * target, py + uy * target
        rem = target - acc
        while i + 2 < len(self.route) and rem > 1e-6:
            i += 1
            nx, ny = self.route[i + 1]
            seg = math.hypot(nx - bx, ny - by)
            if rem <= seg:
                f = rem / max(seg, 1e-6)
                return bx + (nx - bx) * f, by + (ny - by) * f
            rem -= seg
            bx, by = nx, ny
        return self.route[-1]

    def sense(self):
        w = self.world
        # 1. progresi: maju selama proyeksi UDAH lewat ujung segmen
        while self.wp_i < len(self.route) - 2 and self._project()[0] >= 1.0:
            self.wp_i += 1
        t, cx, cy, dist = self._project()
        # 2. capture radius kecil: nempel waypoint -> maju (toleransi tikungan)
        while self.wp_i < len(self.route) - 2:
            wpn = self.route[self.wp_i + 1]
            if math.hypot(self.x - wpn[0], self.y - wpn[1]) < self.CAPTURE:
                self.wp_i += 1
                t, cx, cy, dist = self._project()
            else:
                break
        tgt = self.route[min(self.wp_i + 1, len(self.route) - 1)]
        # 3. PURE PURSUIT: arahkan ke titik lookahead DI ATAS rute
        look = self._lookpoint(t)
        # geser kanan (lajur kanan): rotasi +90 derajat pada vektor car->look
        dxl, dyl = look[0] - self.x, look[1] - self.y
        ll = math.hypot(dxl, dyl) + 1e-6
        look = (look[0] + (-dyl / ll) * self.LANE_OFF,
                look[1] + (dxl / ll) * self.LANE_OFF)
        desired = math.degrees(math.atan2(look[1] - self.y, look[0] - self.x))
        heading_err = (desired - self.heading + 180) % 360 - 180
        hw = w.seg_halfw(self.route[self.wp_i], self.route[self.wp_i + 1])
        # 4. curvature: sudut belokan menunggu di depan (bobot jarak)
        curv = 0.0
        acc_d = 0.0
        i = self.wp_i
        while i + 2 < len(self.route) and acc_d < 120:
            ax, ay = self.route[i]
            bx, by = self.route[i + 1]
            cxn, cyn = self.route[i + 2]
            d1x, d1y = bx - ax, by - ay
            d2x, d2y = cxn - bx, cyn - by
            n1 = math.hypot(d1x, d1y) + 1e-6
            n2 = math.hypot(d2x, d2y) + 1e-6
            dot = max(-1.0, min(1.0, (d1x * d2x + d1y * d2y) / (n1 * n2)))
            ang = math.degrees(math.acos(dot))
            wgt = 0.45 + 0.55 * (1.0 - acc_d / 120.0)
            curv = max(curv, ang * wgt)
            acc_d += n1
            i += 1
        return {
            "lateral": dist, "halfw": hw,
            "heading_err": heading_err,
            "speed_norm": self.speed / self.MAXV,
            "wp": tgt, "cx": cx, "cy": cy,
            "curv": curv,
        }

    def step(self, steer, thr, brk):
        turn = steer * 3.4 * (0.45 + 0.55 * self.speed / self.MAXV)
        self.heading = (self.heading + turn) % 360
        if brk > 0:
            self.speed = max(0.0, self.speed - 0.15)
        elif thr > 0:
            self.speed = min(self.MAXV, self.speed + self.ACC * thr)
        a = math.radians(self.heading)
        self.x += math.cos(a) * self.speed
        self.y += math.sin(a) * self.speed
        self.alive_time += 1
        if self.wp_i >= len(self.route) - 2:
            d = self.route[-1]
            if math.hypot(self.x - d[0], self.y - d[1]) < 12:
                self.finished = True


def map_brain(state):
    """Brain v2: steering proporsional + ANTISIPASI tikungan (slow-in,
    fast-out: rem sebelum tikungan berdasar curvature depan) + ACC (jaga
    jarak dari mobil depan kalau ada state['ahead_gap'])."""
    he = state["heading_err"]
    curv = state.get("curv", 0.0)
    gap = state.get("ahead_gap")
    steer = max(-1.0, min(1.0, he / 40.0))
    sharp = abs(he)
    # antisipasi tikungan: makin tajam, makin pagi ngerem (agresif biar gak motong)
    if curv > 50:
        thr, brk = 0.0, 0.9
    elif curv > 30:
        thr, brk = 0.25, 0.0
    elif curv > 15:
        thr, brk = 0.65, 0.0
    else:
        thr, brk = 1.0, 0.0
    # heading error tajam tetap menang
    if sharp > 90:
        thr, brk = 0.0, 1.0
    elif sharp > 45:
        thr, brk = min(thr, 0.25), 0.0
    elif sharp > 20:
        thr = min(thr, 0.6)
    # ACC: mobil depan deket -> rem proporsional (jangan tibrung dari belakang)
    acc = ""
    if gap is not None:
        if gap < 10:
            thr, brk = 0.0, 1.0
            acc = "REM!"
        elif gap < 20:
            thr, brk = 0.0, 0.7
            acc = "REM!"
        elif gap < 35:
            thr, brk = 0.0, 0.0
            acc = "ikut"
        elif gap < 60:
            thr = min(thr, 0.35)
            acc = "geser"
    # ANTI-STALL: nol speed + gak ada rintangan -> jangan deadlock di rem
    if state.get("speed_norm", 0) < 0.05 and gap is None and brk > 0:
        thr, brk = 0.35, 0.0
    return steer, thr, brk, {"he": he, "lat": state["lateral"], "acc": acc}


def driver_controls(pressed):
    """Kemudi manual: WASD / arrow keys. Return (steer, thr, brk).
    Dipanggil tiap tick fisika pas mode manual (assistant OFF)."""
    steer = (1.0 if pressed[pygame.K_RIGHT] or pressed[pygame.K_d] else 0.0) - \
            (1.0 if pressed[pygame.K_LEFT] or pressed[pygame.K_a] else 0.0)
    thr = 1.0 if pressed[pygame.K_UP] or pressed[pygame.K_w] else 0.0
    brk = 1.0 if pressed[pygame.K_DOWN] or pressed[pygame.K_s] else 0.0
    return steer, thr, brk


# ------------------------------------------------------------- brain v4 ----
# Arsitektur ala JevPilot (github.com/standardagents/jevpilot): sampling
# kandidat maneuver -> rollout proyeksi fisika -> tag (on-road, tabrak,
# merah) -> filter + skor lokal -> pilih satu. Maneuver (offset lajur +
# target speed) dieksekusi antar keputusan ~4 Hz. Hook LLM: build_request()
# merangkum state jadi tabel ringkas; set JEV_API_URL biar model eksternal
# yang milih kandidat (balas {"choice": "v3"}), gagal/tak ada -> skor lokal.

PLANNER_EVERY = 15          # keputusan tiap 15 frame (4 Hz, ala decisionInterval)
ROLLOUT_STEPS = 90          # horizon 1.5 detik @60fps
CAND_SPEEDS = (1.0, 0.75, 0.5, 0.25)   # fraksi MAXV
CAND_OFFSETS = (-3.0, 0.0, 2.0)        # meter; positif = ke kanan rute
IMMINENT_S = 0.5            # kontak < 0.5 detik = imminent (gak layak)
OFF_ROAD_M = 11.0           # > ini dari segmen jalan = off-road (halfw + margin)
STOP_BUF = 8.0              # buffer aman di belakang lead / garis berhenti (m)
BRAKE_V4 = 0.15             # decel rollout, sama dgn MapCar.step


def route_arc(route):
    """Panjang kumulatif rute buat lookup goal-point O(log n)."""
    cum = [0.0]
    for a, b in zip(route, route[1:]):
        cum.append(cum[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    return cum


def route_point_at(route, cum, s):
    """Posisi + arah (derajat) di sepanjang rute pada jarak s meter arc."""
    s = max(0.0, min(s, cum[-1]))
    lo, hi = 0, len(cum) - 1
    while lo < hi - 1:
        mid = (lo + hi) // 2
        if cum[mid] <= s:
            lo = mid
        else:
            hi = mid
    ax, ay = route[lo]
    bx, by = route[lo + 1]
    f = (s - cum[lo]) / (cum[lo + 1] - cum[lo] + 1e-6)
    return (ax + (bx - ax) * f, ay + (by - ay) * f,
            math.degrees(math.atan2(by - ay, bx - ax)))


def dist_to_road(world, x, y):
    """Jarak posisi ke segmen jalan terdekat (grid 3x3 cell sekitar)."""
    cx, cy = int(x // CELL), int(y // CELL)
    best = 1e9
    for gx in (cx - 1, cx, cx + 1):
        for gy in (cy - 1, cy, cy + 1):
            for i in world.seg_grid.get((gx, gy), ()):
                ax, ay, bx, by = world.segs[i][:4]
                abx, aby = bx - ax, by - ay
                tt = max(0.0, min(1.0, ((x - ax) * abx + (y - ay) * aby)
                                  / (abx * abx + aby * aby + 1e-6)))
                d = math.hypot(x - ax - abx * tt, y - ay - aby * tt)
                if d < best:
                    best = d
    return best


def remote_decide(request):
    """Hook brain eksternal (roadmap: Jev API asli). Endpoint kompatibel:
    POST JSON request -> balas {"choice": "v5"} / {"choice": "stop"}.
    Gak diset / gagal / timeout -> balik None, scorer lokal yang mutusin."""
    url = os.environ.get("JEV_API_URL")
    if not url:
        return None
    try:
        import urllib.request
        req = urllib.request.Request(
            url, data=json.dumps(request).encode(),
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=2.0) as r:
            return json.loads(r.read().decode())
    except Exception:
        return None


class Planner:
    """Brain v4 map mode: candidate sampling + scorer lokal, eksekusi
    maneuver antar keputusan (planner milih, pure pursuit nunjukin jalan)."""

    def __init__(self, world, signals, traffic):
        self.world = world
        self.signals = signals
        self.traffic = traffic
        self.route = None
        self.cum = None
        self.man = (0.0, 1.0)      # maneuver terpilih (offset m, fraksi MAXV)
        self.man_name = "Lurus"
        self.src = "lokal"
        self.cand_dbg = []          # endpoint kandidat buat debug render
        self.frame = -999           # paksa putusan di frame pertama
        self.s = 0.0

    def _sync_route(self, car):
        if self.route is not car.route:
            self.route = car.route
            self.cum = route_arc(car.route)
            self.frame = -999       # misi baru -> putusan ulang segera

    def _hero_arc(self, car):
        """Posisi hero di sepanjang rute (meter arc), dari proyeksi MapCar."""
        t, _cx, _cy, _d = car._project()
        return self.cum[car.wp_i] + t * (self.cum[car.wp_i + 1] - self.cum[car.wp_i])

    def _red_ahead(self, car):
        """Lampu merah di koridor depan: (jarak plane m, sisa merah frame)."""
        fx, fy = math.cos(math.radians(car.heading)), math.sin(math.radians(car.heading))
        best = None
        for j, (lx, ly) in enumerate(self.signals.pos):
            dx, dy = lx - car.x, ly - car.y
            fwd = dx * fx + dy * fy
            if not (4 < fwd < 90) or abs(-dx * fy + dy * fx) > 13:
                continue
            axis = 0 if abs(fx) >= abs(fy) else 1
            if not self.signals.green(self.signals.nodes_at(j), axis):
                rem = self.signals.CYCLE - (self.signals.frame % self.signals.CYCLE)
                if best is None or fwd < best[0]:
                    best = (fwd, rem)
        return best

    def _rollout(self, car, s0, off, sf, preds, red, gap=None, curv=0.0):
        """Proyeksi satu maneuver: ghost disimulasi dgn fisika MapCar persis
        (mirror MapCar.step biar prediksi = eksekusi), lalu dinilai."""
        tgt_v = sf * car.MAXV
        # cap kurva: tikungan tajam = pelan (continuation dari antisipasi v3).
        # Lantai 0.15 = creep: pure pursuit butuh gerak buat belok, jangan
        # pernah nol persis di depan tikungan (deadlock)
        tgt_v = min(tgt_v, car.MAXV * max(0.15, min(1.0, 1.25 - curv / 40.0)))
        gx, gy, ghd, v = car.x, car.y, car.heading, car.speed
        trav = 0.0
        offroad = checked = 0
        pred_tau = None
        crossed_red = False
        for i in range(ROLLOUT_STEPS):
            # cap kecepatan biar mampu berhenti sebelum lead / garis merah
            # (ala maneuverVelocity stop_at_line jevpilot: sqrt(2*decel*room))
            tgt_eff = tgt_v
            if gap is not None:
                room = gap - trav - STOP_BUF
                tgt_eff = min(tgt_eff,
                              math.sqrt(2 * BRAKE_V4 * room) if room > 0 else 0.0)
            if red is not None:
                room = red[0] - trav - 3.0
                tgt_eff = min(tgt_eff,
                              math.sqrt(2 * BRAKE_V4 * room) if room > 0 else 0.0)
            # pure pursuit ke titik lookahead di rute + offset lajur
            px, py, tang = route_point_at(
                self.route, self.cum, s0 + trav + car._lookahead())
            tx = px - math.sin(math.radians(tang)) * (car.LANE_OFF + off)
            ty = py + math.cos(math.radians(tang)) * (car.LANE_OFF + off)
            he = (math.degrees(math.atan2(ty - gy, tx - gx)) - ghd + 180) % 360 - 180
            steer = max(-1.0, min(1.0, he / 40.0))
            ghd = (ghd + steer * 3.4 * (0.45 + 0.55 * v / car.MAXV)) % 360
            if v > tgt_eff + 0.05:
                v = max(0.0, v - BRAKE_V4)
            elif v < tgt_eff - 0.05:
                v = min(car.MAXV, v + 0.05)
            a = math.radians(ghd)
            gx += math.cos(a) * v
            gy += math.sin(a) * v
            trav += v
            if i % 5:
                continue
            # tiap 5 frame: cek off-road + kontak vs AI + nyebrang merah
            checked += 1
            if dist_to_road(self.world, gx, gy) > OFF_ROAD_M:
                offroad += 1
            tau = i / FPS
            if pred_tau is None:
                # kontak dinilai di frame ghost (box depan, ala deteksi tabrak
                # asli) — bukan radius, biar lawan arah di lajur sebelah gak
                # ke-flag
                ca, sa = math.cos(a), math.sin(a)
                for (cx0, cy0, cvx, cvy) in preds:
                    dxo, dyo = cx0 + cvx * tau - gx, cy0 + cvy * tau - gy
                    f = dxo * ca + dyo * sa
                    l = -dxo * sa + dyo * ca
                    if -6.0 < f < 9.0 and abs(l) < 5.5:
                        pred_tau = tau
                        break
            if red is not None and red[1] - i > 0 and trav > red[0] and v > 0.4:
                crossed_red = True
        end = route_point_at(self.route, self.cum, s0 + trav)
        tx = end[0] - math.sin(math.radians(end[2])) * (car.LANE_OFF + off)
        ty = end[1] + math.cos(math.radians(end[2])) * (car.LANE_OFF + off)
        lane_err = math.hypot(gx - tx, gy - ty)
        he_end = (end[2] - ghd + 180) % 360 - 180
        return {"off": off, "sf": sf, "ex": gx, "ey": gy,
                "prog": trav, "lane_err": lane_err, "he": he_end,
                "speed_end": v, "off_frac": offroad / max(checked, 1),
                "pred_tau": pred_tau,
                "imminent": pred_tau is not None and pred_tau < IMMINENT_S,
                "predicted": pred_tau is not None,
                "red": crossed_red,
                "name": "Rem" if sf == 0 else
                        f"{'Kiri' if off < -1 else 'Kanan' if off > 1 else 'Lurus'} {sf:.2f}x"}

    def decide(self, car, state):
        self.s = self._hero_arc(car)
        # prediksi AI 1.5 detik: gerak lurus kecepatan konstan
        preds = []
        for tc in self.traffic.cars:
            a = math.radians(tc["heading"])
            preds.append((tc["x"], tc["y"], math.cos(a) * tc["speed"],
                          math.sin(a) * tc["speed"]))
        red = self._red_ahead(car)
        gap = state.get("ahead_gap")
        curv = state.get("curv", 0.0)
        cands = [self._rollout(car, self.s, off, sf, preds, red, gap, curv)
                 for sf in CAND_SPEEDS for off in CAND_OFFSETS]
        for c in cands:
            # skor: maju selo, tapi error lajur/arah & risiko bayar mahal
            c["score"] = (c["prog"] - 2.0 * c["lane_err"] - 0.03 * abs(c["he"])
                          + 0.5 * c["speed_end"]
                          - 40.0 * c["off_frac"]
                          - (900.0 if c["imminent"] else 0.0)
                          - (800.0 + 60.0 / max(0.2, c["pred_tau"] or 1.5)
                             if c["predicted"] else 0.0)
                          - 300.0 * c["red"])
            # ala movingCandidates jevpilot: kandidat berkontak / keluar jalan
            # gak masuk moving set
            c["eligible"] = not c["predicted"] and c["off_frac"] <= 0.1
        stop = self._rollout(car, self.s, 0.0, 0.0, preds, red, gap, curv)
        stop["score"] = -100.0 - 0.3 * car.speed   # rem itu pilihan terakhir
        required = (gap is not None and gap < 12) or (red is not None and red[0] < 35)
        pool = [c for c in cands if c["eligible"]] or cands   # darurat: least-bad
        if required:
            pool = pool + [stop]
        best = max(pool, key=lambda c: c["score"])
        # hook model eksternal: boleh timpa pilihan scorer lokal
        self.src = "lokal"
        resp = remote_decide(self.build_request(car, state, cands, stop, red))
        if resp and isinstance(resp.get("choice"), str):
            ch = resp["choice"]
            pick = None
            if ch == "stop":
                pick = stop if any(c is stop for c in pool) else None
            elif ch.startswith("v") and ch[1:].isdigit():
                k = int(ch[1:])
                if 0 <= k < len(cands) and any(c is cands[k] for c in pool):
                    pick = cands[k]
            if pick is not None:
                best = pick
                self.src = resp.get("src", "jev")
        self.man = (best["off"], best["sf"])
        self.man_name = best["name"]
        self.cand_dbg = [(c["ex"], c["ey"], c["eligible"], c is best)
                         for c in cands] + [(stop["ex"], stop["ey"], True, stop is best)]

    def drive(self, car, state, fi):
        """Tiap frame: eksekusi maneuver terpilih; tiap PLANNER_EVERY frame
        putuskan maneuver baru."""
        self._sync_route(car)
        self.s = self._hero_arc(car)
        if fi - self.frame >= PLANNER_EVERY:
            self.frame = fi
            self.decide(car, state)
        off, sf = self.man
        # steering: pure pursuit ke titik lookahead + offset lajur terpilih
        px, py, tang = route_point_at(self.route, self.cum, self.s + car._lookahead())
        gx = px - math.sin(math.radians(tang)) * (car.LANE_OFF + off)
        gy = py + math.cos(math.radians(tang)) * (car.LANE_OFF + off)
        he = (math.degrees(math.atan2(gy - car.y, gx - car.x)) - car.heading + 180) % 360 - 180
        steer = max(-1.0, min(1.0, he / 40.0))
        # speed: target maneuver, di-cap kurva (mirror rollout biar eksekusi
        # = prediksi); ACC jadi lapisan kedua (planner cuma dari snapshot 4 Hz,
        # gap berubah tiap frame)
        tgt_v = sf * car.MAXV
        tgt_v = min(tgt_v, car.MAXV * max(0.15, min(1.0, 1.25 - state.get("curv", 0.0) / 40.0)))
        gap = state.get("ahead_gap")
        acc = ""
        if gap is not None and gap < 10:
            thr, brk, acc = 0.0, 1.0, "REM!"
        elif gap is not None and gap < 20:
            thr, brk, acc = 0.0, 0.7, "REM!"
        elif car.speed < tgt_v - 0.05:
            thr, brk = 1.0, 0.0
        elif car.speed > tgt_v + 0.1:
            thr, brk = 0.0, min(1.0, (car.speed - tgt_v) / 1.0)
        else:
            thr, brk = 0.0, 0.0
        if gap is not None and 20 <= gap < 35:
            thr, acc = 0.0, "ikut"
        elif gap is not None and 35 <= gap < 60:
            thr, acc = min(thr, 0.35), "geser"
        # anti-stall: nol speed tanpa rintangan -> kasi gas biar gak mati
        # mesin di depan tikungan / habis putusan rem
        if car.speed < 0.05 and gap is None and tgt_v > 0.2:
            thr, brk = 0.35, 0.0
        return steer, thr, brk, {"he": he, "lat": state["lateral"], "acc": acc,
                                 "man": self.man_name, "src": self.src}

    def build_request(self, car, state, cands, stop, red):
        """State ringkas stateless ala prepareJevRequest: konteks + tabel
        kandidat. Buat hook JEV_API_URL (dan debugging payload)."""
        cands_tbl = {f"v{i}": {
            "name": c["name"], "off_m": c["off"], "speed_factor": c["sf"],
            "progress_m": round(c["prog"], 1),
            "lane_error_m": round(c["lane_err"], 1),
            "end_speed": round(c["speed_end"], 2),
            "on_road": c["off_frac"] <= 0.1,
            "collision_in_s": round(c["pred_tau"], 2) if c["pred_tau"] else None,
            "crosses_red": c["red"],
        } for i, c in enumerate(cands)}
        cands_tbl["stop"] = {
            "name": "Rem", "off_m": 0.0, "speed_factor": 0.0,
            "progress_m": round(stop["prog"], 1),
            "lane_error_m": round(stop["lane_err"], 1),
            "end_speed": 0.0, "on_road": True,
            "collision_in_s": None, "crosses_red": False,
        }
        return {
            "speed": round(car.speed, 2),
            "limit": car.MAXV,
            "lane_offset": round(car.LANE_OFF + self.man[0], 1),
            "red_ahead_m": round(red[0], 1) if red else None,
            "red_remaining_s": round(red[1] / FPS, 1) if red else None,
            "lead_gap_m": state.get("ahead_gap"),
            "destination_m": round(self.cum[-1] - self.s, 1),
            "questions": {"vector": "pilih id kandidat fastest useful progress"},
            "candidates": cands_tbl,
        }

def largest_component(world):
    best = set()
    seen = set()
    for n0 in world.adj:
        if n0 in seen:
            continue
        comp = {n0}
        stack = [n0]
        while stack:
            u = stack.pop()
            for v in world.adj.get(u, ()):
                if v not in comp:
                    comp.add(v)
                    stack.append(v)
        seen |= comp
        if len(comp) > len(best):
            best = comp
    return best


class Camera:
    def __init__(self):
        self.x = 0.0
        self.y = 0.0
        self.zoom = 0.7

    def apply(self, x, y):
        return ((x - self.x) * self.zoom + W / 2,
                (y - self.y) * self.zoom + H / 2)

    def follow(self, x, y, lerp=0.12):
        self.x += (x - self.x) * lerp
        self.y += (y - self.y) * lerp


# ---- render dunia berlapis -------------------------------------------------
COL_BG = (26, 28, 34)
COL_GREEN = (44, 60, 46)
COL_WATER = (36, 52, 80)
COL_BLDG = (42, 45, 54)
COL_BLDG_EDGE = (54, 58, 68)
COL_CASING = (52, 55, 64)
COL_ROAD = (88, 92, 104)
COL_ROAD_MAJOR = (100, 104, 118)
COL_ROUTE = (80, 140, 230)
COL_ROUTE_CASE = (28, 58, 118)


class WorldTiles:
    """Chunk cache: layer statis kota (area+bangunan+jalan) dirender per tile
    500m sekali, tiap frame tinggal blit. Bikin peta raksasa tetap 60fps."""

    def __init__(self, world, res=1.5, max_tiles=48):
        self.world = world
        self.res = res          # piksel per meter di tile
        self.max_tiles = max_tiles
        self.tiles = OrderedDict()
        self.scaled = OrderedDict()   # (gx,gy,zoom) -> versi ter-scale (zoom jarang berubah)

    def _render(self, gx, gy):
        w = self.world
        size = int(CELL * self.res)
        s = pygame.Surface((size, size))
        s.fill(COL_BG)
        wx, wy = gx * CELL, gy * CELL

        def tf(p):
            return ((p[0] - wx) * self.res, (p[1] - wy) * self.res)
        for i in w.area_grid.get((gx, gy), ()):  
            _bb, pts, kind = w.areas[i]
            pygame.draw.polygon(s, COL_WATER if kind == "water" else COL_GREEN,
                                [tf(p) for p in pts])
        for i in w.bldg_grid.get((gx, gy), ()):  
            p = [tf(pt) for pt in w.buildings[i][1]]
            pygame.draw.polygon(s, COL_BLDG, p)
            pygame.draw.polygon(s, COL_BLDG_EDGE, p, 1)
        for i in w.seg_grid.get((gx, gy), ()):  
            ax, ay, bx, by, wd, kind, _k = w.segs[i]
            a, b = tf((ax, ay)), tf((bx, by))
            hw = wd * self.res
            pygame.draw.line(s, COL_CASING, a, b, max(2, int(hw * 2 + 2)))
            col = COL_ROAD_MAJOR if wd >= 7.5 else COL_ROAD
            pygame.draw.line(s, col, a, b, max(1, int(hw * 2)))
        return s

    def get(self, gx, gy):
        key = (gx, gy)
        if key in self.tiles:
            self.tiles.move_to_end(key)
            return self.tiles[key]
        t = self._render(gx, gy)
        self.tiles[key] = t
        while len(self.tiles) > self.max_tiles:
            self.tiles.popitem(last=False)
        return t

    def draw(self, surf, cam):
        z = cam.zoom
        zb = round(z, 2)
        vw, vh = W / z / 2 + CELL, H / z / 2 + CELL
        x0, y0 = cam.x - vw, cam.y - vh
        x1, y1 = cam.x + vw, cam.y + vh
        w_px, h_px = int(CELL * z) + 1, int(CELL * z) + 1
        for gx in range(int(x0 // CELL), int(x1 // CELL) + 1):
            for gy in range(int(y0 // CELL), int(y1 // CELL) + 1):
                if gx < 0 or gy < 0:
                    continue
                skey = (gx, gy, zb)
                img = self.scaled.get(skey)
                if img is None:
                    img = pygame.transform.scale(self.get(gx, gy), (w_px, h_px))
                    self.scaled[skey] = img
                    while len(self.scaled) > 96:
                        self.scaled.popitem(last=False)
                surf.blit(img, ((gx * CELL - x0) * z, (gy * CELL - y0) * z))


def draw_world(surf, world, cam, tiles):
    surf.fill(COL_BG)
    tiles.draw(surf, cam)


def draw_street_name(surf, world, cam, car, cached):
    """Nama jalan terdekat (<=60m) digambar di dekat mobil. cache tiap 15 frame."""
    age, name = cached
    if age == 0:
        best, bd = "", 60.0
        for ax, ay, bx, by, nm in world.named_segs:
            abx, aby = bx - ax, by - ay
            apx, apy = car.x - ax, car.y - ay
            ab2 = abx * abx + aby * aby + 1e-6
            tt = max(0.0, min(1.0, (apx * abx + apy * aby) / ab2))
            cx, cy = ax + abx * tt, ay + aby * tt
            d = math.hypot(car.x - cx, car.y - cy)
            if d < bd:
                best, bd = nm, d
        name = best or name
    sx, sy = cam.apply(car.x, car.y)
    try:
        font = pygame.font.SysFont("dejavusansbold", 13)
        label = font.render(name, True, (235, 235, 235))
        pad = 6
        r = label.get_rect()
        bg = pygame.Rect(int(sx) - r.w // 2 - pad, int(sy) - 38, r.w + pad * 2, r.h + 4)
        pygame.draw.rect(surf, (20, 22, 28), bg, border_radius=4)
        surf.blit(label, (bg.x + pad, bg.y + 2))
    except Exception:
        pass
    return name


def draw_map(surf, world, car, cam, state, dec, stats, traffic, signals, mission,
             name_cache, tiles, planner=None):
    draw_world(surf, world, cam, tiles)
    # rute (casing + garis)
    if len(car.route) > 1:
        step = max(1, len(car.route) // 400)
        pts = [cam.apply(*p) for p in car.route[::step]]
        pygame.draw.lines(surf, COL_ROUTE_CASE, False, pts, 6)
        pygame.draw.lines(surf, COL_ROUTE, False, pts, 3)
    # waypoint aktif
    wp = cam.apply(*state["wp"])
    pygame.draw.circle(surf, (240, 200, 80), (int(wp[0]), int(wp[1])), 5)
    signals.draw(surf, cam, (car.x, car.y))
    traffic.draw(surf, cam)
    # target misi (denyut)
    if mission.goal is not None:
        gx, gy = cam.apply(*world.nodes[mission.goal])
        t = pygame.time.get_ticks() / 1000.0
        r = 8 + int(3 * math.sin(t * 4))
        pygame.draw.circle(surf, (255, 120, 200), (int(gx), int(gy)), r, 2)
        pygame.draw.circle(surf, (255, 120, 200), (int(gx), int(gy)), 2)
    # mobil hero
    cx, cy = cam.apply(car.x, car.y)
    a = math.radians(car.heading)
    z = cam.zoom
    # endpoint kandidat planner (ala Candidates view jevpilot): biru = terpilih,
    # cyan = layak, merah redup = kefilter
    if planner is not None:
        for ex, ey, ok, chosen in planner.cand_dbg:
            sx, sy = cam.apply(ex, ey)
            if chosen:
                pygame.draw.line(surf, (120, 190, 255), (cx, cy), (sx, sy), 2)
                pygame.draw.circle(surf, (120, 190, 255), (int(sx), int(sy)), 4)
            else:
                pygame.draw.circle(surf, (150, 220, 220) if ok else (150, 90, 90),
                                   (int(sx), int(sy)), 2)
    pts = [(cx + dx * math.cos(a) * z - dy * math.sin(a) * z,
            cy + dx * math.sin(a) * z + dy * math.cos(a) * z)
           for dx, dy in ((CAR_LEN / 2, 0), (-CAR_LEN / 2, CAR_W / 2), (-CAR_LEN / 2, -CAR_W / 2))]
    col = (80, 220, 120) if not car.finished else (90, 160, 255)
    pygame.draw.polygon(surf, col, pts)
    pygame.draw.circle(surf, (255, 255, 255), (int(cx), int(cy)), max(10, int(17 * z)), 2)
    # nama jalan
    name = draw_street_name(surf, world, cam, car, name_cache)
    # HUD
    gdist = 0
    if mission.goal is not None:
        gx, gy = world.nodes[mission.goal]
        gdist = math.hypot(car.x - gx, car.y - gy)
    hud(surf, [
        f"Gee-FunDriving | {world.meta['name']} | {dec.get('mode', '')}",
        f"speed {car.speed:.1f}  alive {car.alive_time // FPS}s  wp {car.wp_i}/{len(car.route)}",
        f"he {dec.get('he', 0):.0f}  lat {dec.get('lat', 0):.0f}m  {dec.get('acc', '')} {name}".replace("  ", " "),
        f"misi #{mission.n + 1} -> {gdist:.0f}m | skor {mission.score} | merah {mission.reds} tabrak {mission.crashes}",
        (f"man {dec.get('man', '-')} [{dec.get('src', '')}]" if planner is not None else ""),
    ] + ([stats] if stats else []))


# ---------------------------------------------------------------- driver ----
def ll2xy(meta, lat, lon):
    """lat/lon -> meter lokal, konsisten dgn proj fetch_osm (origin bbox corner)."""
    lon0, lat0, lon1, lat1 = meta["bbox"]
    x = math.radians(lon - lon0) * 6378137.0 * math.cos(math.radians((lat0 + lat1) / 2))
    y = math.radians(lat1 - lat) * 6378137.0
    return x, y


def parse_ll(s):
    a, b = s.split(",")
    return float(a), float(b)


def run_map(mapfile, headless, seconds, surf, clock, outdir,
            start_coord=None, goal_coord=None, heading=None, record=True,
            width_scale=1.35, brain="v4", auto_start=True):
    frames_dir = os.path.join(outdir, "frames")
    if headless:
        os.makedirs(frames_dir, exist_ok=True)
        for f in os.listdir(frames_dir):
            os.remove(os.path.join(frames_dir, f))
    world = OSMWorld(mapfile, width_scale=width_scale)
    comp = largest_component(world)
    if start_coord:
        sxm, sym = ll2xy(world.meta, *start_coord)
        start = world.nearest_node(sxm, sym, comp)
    else:
        start = min(comp, key=lambda n: world.nodes[n][0])
    sx, sy = world.nodes[start]
    goal = max(comp, key=lambda n: (world.nodes[n][0] - sx) ** 2 + (world.nodes[n][1] - sy) ** 2)
    route = world.route(start, goal)
    if len(route) < 2:
        print("rute gak ketemu — coba bbox lain")
        sys.exit(1)
    car = MapCar(world, start, simplify([world.nodes[n] for n in route], eps=12.0))
    if heading is not None:
        car.heading = heading % 360.0
    signals = Signals(world, comp)
    total_len = sum(math.hypot(s[2] - s[0], s[3] - s[1]) for s in world.segs)
    n_ai = max(6, min(16, int(total_len / 700)))
    traffic = Traffic(world, comp, (sx, sy), n=n_ai)
    planner = Planner(world, signals, traffic) if brain == "v4" else None
    mission = Mission(world, comp, start)
    first_ok = False
    if goal_coord:
        gxm, gym = ll2xy(world.meta, *goal_coord)
        goal_node = world.nearest_node(gxm, gym, comp)
        first_ok = mission.new_fixed(start, goal_node, car)
        if first_ok:
            print(f"misi eksplisit: {start} -> {goal_node}", file=sys.stderr)
    if not first_ok:
        mission.new(start, car)
    print(f"route: {len(route)} wp | lampu {len(signals.nodes)} | mobil AI {len(traffic.cars)}",
          file=sys.stderr)
    cam = Camera()
    cam.x, cam.y = car.x, car.y
    tiles = WorldTiles(world)
    name_cache = [0, ""]
    # timer cuma buat headless/benchmark; windowed tanpa --seconds = main santai tanpa batas
    total = FPS * seconds if seconds is not None else 1 << 30
    crash_cd = 0
    zoom = cam.zoom
    off_frames = 0
    frames = 0
    saved = 0

    def purge_near(radius=130.0):
        """Buang mobil AI sekitar hero (buat respawn misi biar gak nempel)."""
        for j, tc in enumerate(traffic.cars):
            if math.hypot(tc["x"] - car.x, tc["y"] - car.y) < radius:
                cand = [c2 for c2 in traffic.cars
                        if math.hypot(c2["x"] - car.x, c2["y"] - car.y) > radius + 150]
                if cand:
                    traffic.cars[j] = dict(random.choice(cand))

    stall_frames = 0
    man_steer = 0.0
    auto = auto_start or headless  # headless gak ada sopir -> assistant wajib ON
    hard_stall = 0
    for fi in range(total):
        state = car.sense()
        # safety-net: keluar jalur > 35m -> snap balik ke rute (cuma mode assistant;
        # kalau lagi nyetir sendiri, bebas eksplor — nggak di-snap)
        if auto and state["lateral"] > 35 and not car.finished:
            car.x, car.y = state["cx"], state["cy"]
            car.speed *= 0.4
            mission.recovers += 1
        # ACC: mobil AI SEARAH di koridor depan (lawan arah bukan rintangan)
        hdir = math.radians(car.heading)
        fx_, fy_ = math.cos(hdir), math.sin(hdir)
        gap = None
        for tc in traffic.cars:
            dx_, dy_ = tc["x"] - car.x, tc["y"] - car.y
            fwd = dx_ * fx_ + dy_ * fy_
            if 0 < fwd < 55:
                lat = abs(-dx_ * fy_ + dy_ * fx_)
                if lat < 11 and (gap is None or fwd < gap):
                    tc_fwd = (math.cos(math.radians(tc["heading"])) * fx_
                              + math.sin(math.radians(tc["heading"])) * fy_)
                    if tc_fwd > 0.25 or tc["speed"] < 0.1:
                        gap = fwd
        state["ahead_gap"] = gap
        if planner is not None:
            steer, thr, brk, dec = planner.drive(car, state, fi)
        else:
            steer, thr, brk, dec = map_brain(state)
        dec["mode"] = "ASSISTANT [F]" if auto else "MANUAL [F]"
        # berhenti di lampu merah: lampu terdekat di koridor depan
        si_best, sd_best = -1, 1e9
        for j, (lx, ly) in enumerate(signals.pos):
            dx_, dy_ = lx - car.x, ly - car.y
            fwd = dx_ * fx_ + dy_ * fy_
            if 6 < fwd < 42:
                latt = abs(-dx_ * fy_ + dy_ * fx_)
                if latt < 13 and fwd < sd_best:
                    sd_best, si_best = fwd, j
        if si_best >= 0:
            axis = 0 if abs(math.cos(math.radians(car.heading))) >= abs(math.sin(math.radians(car.heading))) else 1
            if not signals.green(signals.nodes_at(si_best), axis):
                if auto:  # manual: kamu yang mutusin — nyabrang = denda
                    thr, brk = 0.0, 1.0
                # nyabrang merah: nempel lampu + masih merah + gerak
                if sd_best < 9 and car.speed > 1.0:
                    last = mission.red_cd.get(si_best, -9999)
                    if fi - last > 240:
                        mission.reds += 1
                        mission.red_cd[si_best] = fi
        if not auto:
            # KENDALIIN SENDIRI: keyboard menang atas brain. Kemudi di-lerp ke
            # target (pola baku controller keyboard) biar gak snap-kiri/snap-kanan.
            mst, thr, brk = driver_controls(pygame.key.get_pressed())
            man_steer += (mst - man_steer) * 0.25
            steer, thr, brk = man_steer, thr, brk
            dec = {"mode": "MANUAL [F]", "he": state["heading_err"],
                   "lat": state["lateral"], "acc": "kemudi kamu"}
        car.step(steer, thr, brk)
        mission.driven += car.speed
        # deadlock breaker: berhenti total + rintangan nempel -> pindahkan rintangan
        # (assistant only; kalau manual, berhenti = pilihan kamu)
        if car.speed < 0.15 and auto and state["ahead_gap"] is not None and state["ahead_gap"] < 15:
            stall_frames += 1
        else:
            stall_frames = 0
        # tier 2: diam total 8 detik apa pun gapnya = deadlock beneran
        # (standoff lawan arah; siklus lampu cuma 7 detik, jadi aman)
        if car.speed < 0.15:
            hard_stall += 1
        else:
            hard_stall = 0
        if stall_frames > 240 or hard_stall > 480:
            stall_frames = 0
            hard_stall = 0
            best_j, best_d = -1, 70.0
            for j, tc in enumerate(traffic.cars):
                d = math.hypot(tc["x"] - car.x, tc["y"] - car.y)
                if d < best_d:
                    best_j, best_d = j, d
            if best_j >= 0:
                cand = [c2 for c2 in traffic.cars
                        if math.hypot(c2["x"] - car.x, c2["y"] - car.y) > 400]
                if cand:
                    traffic.cars[best_j] = dict(random.choice(cand))
        signals.update()
        traffic.update(signals, hero=(car.x, car.y))
        # tabrakan hero vs mobil AI
        if crash_cd > 0:
            crash_cd -= 1
        else:
            for j, tc in enumerate(traffic.cars):
                dx_, dy_ = tc["x"] - car.x, tc["y"] - car.y
                fwd = dx_ * fx_ + dy_ * fy_
                lat = abs(-dx_ * fy_ + dy_ * fx_)
                # tabrak beneran: hampir sejajar (satu lajur) & berimpit
                if lat < 4.5 and -6 < fwd < 9:
                    mission.crashes += 1
                    car.speed *= 0.3
                    old = traffic.cars[j]
                    cand = [c2 for c2 in traffic.cars
                            if math.hypot(c2["x"] - car.x, c2["y"] - car.y) > 400]
                    if cand:
                        repl = random.choice(cand)
                        traffic.cars[j] = dict(repl)
                        traffic.cars[traffic.cars.index(repl)] = old
                    crash_cd = 45
                    break
        cam.follow(car.x, car.y)
        cam.zoom = zoom
        if state["lateral"] > state["halfw"] + 4:
            off_frames += 1
        frames = fi + 1
        draw_map(surf, world, car, cam, state, dec, f"{clock.get_fps():.0f} fps",
                 traffic, signals, mission, name_cache, tiles, planner)
        # misi selesai -> skor + misi baru
        if car.finished:
            pts = mission.complete(car)
            print(f"misi #{mission.n} selesai +{pts} (skor {mission.score}) "
                  f"merah {mission.reds} tabrak {mission.crashes}", file=sys.stderr)
            if headless:
                break
            near = world.nearest_node(car.x, car.y, comp)
            if not mission.new(near, car):
                print("gak ada tujuan baru — selesai", file=sys.stderr)
                break
            purge_near()
        # render + input + rekam tiap RENDER_EVERY tick -> 30fps (fisika tetap 60Hz)
        if fi % RENDER_EVERY == 0:
            name_cache[0] = (name_cache[0] + 1) % 15
            draw_map(surf, world, car, cam, state, dec, f"{clock.get_fps():.0f} fps",
                     traffic, signals, mission, name_cache, tiles)
            if headless:
                pygame.image.save(surf, os.path.join(frames_dir, f"f{saved:05d}.png"))
                saved += 1
            else:
                for ev in pygame.event.get():
                    if ev.type == pygame.QUIT:
                        return "quit"
                    if ev.type == pygame.KEYDOWN:
                        if ev.key == pygame.K_ESCAPE:
                            return "quit"
                        if ev.key in (pygame.K_EQUALS, pygame.K_PLUS, pygame.K_KP_PLUS):
                            zoom = min(1.6, zoom * 1.15)
                        if ev.key in (pygame.K_MINUS, pygame.K_KP_MINUS):
                            zoom = max(0.25, zoom / 1.15)
                        if ev.key == pygame.K_r:
                            near = world.nearest_node(car.x, car.y, comp)
                            mission.new(near, car)
                        if ev.key == pygame.K_f:
                            auto = not auto
                            man_steer = 0.0  # jangan bawa bekas kemudi pas serah/ambil alih
                pygame.event.pump()
                pygame.display.flip()
                clock.tick(RENDER_FPS)
    if headless and record and shutil.which("ffmpeg"):
        mp4 = os.path.join(outdir, "gee_fundriving_demo.mp4")
        # urutan gambar (%05d), bukan glob — build ffmpeg Windows gak dukung glob
        subprocess.run([
            "ffmpeg", "-y", "-loglevel", "error", "-f", "image2",
            "-framerate", str(RENDER_FPS),
            "-i", os.path.join(frames_dir, "f%05d.png"),
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", mp4,
        ], check=True)
        print("VIDEO_OK", mp4)
    print(f"skor akhir {mission.score} | misi selesai {mission.n} | "
          f"merah {mission.reds} tabrak {mission.crashes} | keluar jalur {mission.recovers} | "
          f"offroad {100 * off_frames / max(frames, 1):.1f}%")
    return {"selesai": car.finished, "detik_sim": car.alive_time // FPS,
            "jarak_rute_m": round(mission.route_len), "tempuh_m": round(mission.driven),
            "skor": mission.score, "merah": mission.reds, "tabrak": mission.crashes,
            "keluar_jalur": mission.recovers,
            "offroad_pct": round(100 * off_frames / max(frames, 1), 1)}


def run_circuit(headless, seconds, surf, clock, auto_start=True):
    car = CircuitCar()
    auto = auto_start or headless  # headless gak ada sopir -> assistant wajib ON
    man_steer = 0.0
    # timer cuma buat headless/benchmark; windowed tanpa --seconds = main santai tanpa batas
    total = FPS * seconds if seconds is not None else 1 << 30
    for fi in range(total):
        state = car.sense()
        steer, thr, brk, dec = brain_decide(state)
        if not auto:
            mst, thr, brk = driver_controls(pygame.key.get_pressed())
            man_steer += (mst - man_steer) * 0.25
            steer, thr, brk = man_steer, thr, brk
            dec = {"front_risk": 0.0, "steer": (steer, 1.0)}
        car.step(steer, thr, brk)
        # keluar track: assistant auto-reset; manual = balikin sendiri
        if auto and not car.frame_alive:
            car.reset()
        if fi % RENDER_EVERY == 0:
            stats = "mode ASSISTANT [F]" if auto else "mode MANUAL [F]"
            draw_circuit(surf, car, state, dec, stats)
            if not headless:
                for ev in pygame.event.get():
                    if ev.type == pygame.QUIT:
                        return
                    if ev.type == pygame.KEYDOWN:
                        if ev.key == pygame.K_f:
                            auto = not auto
                            man_steer = 0.0
                        elif ev.key == pygame.K_ESCAPE:
                            return  # balik ke main menu
                pygame.event.pump()
                pygame.display.flip()
                clock.tick(RENDER_FPS)
    print(f"selesai: laps {car.laps:.2f}")


def load_settings():
    """Setelan tersimpan di ~/gee-fundriving/settings.json (mode, peta, fps render)."""
    try:
        with open(SETTINGS_PATH, encoding="utf-8") as f:
            s = json.load(f)
    except Exception:
        s = {}
    st = {
        "mode": s.get("mode") if s.get("mode") in ("assistant", "manual") else "assistant",
        "map": s.get("map") if s.get("map") in ("loop", "circuit", "osm") else "loop",
        "fps": s.get("fps") if s.get("fps") in (30, 60) else 30,
    }
    if st["map"] == "osm" and not os.path.exists(os.path.join("maps", "puri_cengkareng.json")):
        st["map"] = "loop"
    return st


def save_settings(st):
    try:
        os.makedirs(os.path.dirname(SETTINGS_PATH), exist_ok=True)
        with open(SETTINGS_PATH, "w", encoding="utf-8") as f:
            json.dump(st, f)
    except Exception:
        pass


def resolve_map(mkey):
    """Kunci setelan peta -> path file (None = mode sirkuit), fallback aman."""
    if mkey == "circuit":
        return None
    if mkey == "osm" and os.path.exists(os.path.join("maps", "puri_cengkareng.json")):
        return os.path.join("maps", "puri_cengkareng.json")
    return os.path.join("maps", "loop_city.json")


def _osm_available():
    return os.path.exists(os.path.join("maps", "puri_cengkareng.json"))


def settings_screen(surf, clock, settings):
    """Layar SETTINGS: mode, peta, fps render. Ubah nilai = langsung disimpan.
    ↑↓ pilih baris, ←→/ENTER ganti nilai, ESC/kembali balik ke menu."""
    big = pygame.font.SysFont("dejavusansbold", 40)
    font = pygame.font.SysFont("dejavusansmono", 18)
    small = pygame.font.SysFont("dejavusansmono", 14)

    def rows():
        mode_opts = [("ASSISTANT", "assistant"), ("KENDALI SENDIRI", "manual")]
        map_opts = [("LOOP CITY", "loop"), ("SIRKUIT", "circuit")]
        if _osm_available():
            map_opts.append(("PETA OSM", "osm"))
        return [
            ("MODE", settings["mode"], mode_opts),
            ("PETA", settings["map"], map_opts),
            ("RENDER FPS", settings["fps"], [30, 60]),
        ]

    def val_label(cur, choices):
        for c in choices:
            key = c[1] if isinstance(c, tuple) else c
            if key == cur:
                return c[0] if isinstance(c, tuple) else str(c)
        return str(cur)

    sel = 0
    while True:
        rs = rows()
        for ev in pygame.event.get():
            if ev.type == pygame.QUIT:
                return
            if ev.type == pygame.KEYDOWN:
                if ev.key == pygame.K_ESCAPE:
                    return
                if ev.key in (pygame.K_UP, pygame.K_w):
                    sel = (sel - 1) % (len(rs) + 1)
                elif ev.key in (pygame.K_DOWN, pygame.K_s):
                    sel = (sel + 1) % (len(rs) + 1)
                elif ev.key in (pygame.K_LEFT, pygame.K_RIGHT, pygame.K_RETURN,
                                pygame.K_KP_ENTER, pygame.K_SPACE):
                    if sel >= len(rs):
                        return  # baris KEMBALI
                    label, cur, choices = rs[sel]
                    keys = [c[1] if isinstance(c, tuple) else c for c in choices]
                    idx = keys.index(cur) if cur in keys else 0
                    step = -1 if ev.key == pygame.K_LEFT else 1
                    newval = keys[(idx + step) % len(keys)]
                    settings[{"MODE": "mode", "PETA": "map",
                              "RENDER FPS": "fps"}[label]] = newval
                    if label == "RENDER FPS":
                        set_render_fps(newval)
                    save_settings(settings)
        surf.fill((24, 26, 32))
        t = big.render("SETTINGS", True, (240, 240, 240))
        surf.blit(t, (W // 2 - t.get_width() // 2, 56))
        y = 150
        for i, (label, cur, choices) in enumerate(rs):
            on = i == sel
            if on:
                pygame.draw.rect(surf, (34, 42, 50),
                                 (W // 2 - 300, y - 5, 600, 30), border_radius=6)
            col = (120, 220, 140) if on else (150, 155, 170)
            mark = "> " if on else "   "
            surf.blit(font.render(mark + label, True, col), (W // 2 - 290, y))
            disp = ("< " + val_label(cur, choices) + " >") if on else val_label(cur, choices)
            surf.blit(font.render(disp, True, col), (W // 2 + 40, y))
            y += 36
        if sel >= len(rs):
            pygame.draw.rect(surf, (34, 42, 50),
                             (W // 2 - 120, y - 5, 240, 30), border_radius=6)
        surf.blit(font.render(("> " if sel >= len(rs) else "   ") + "KEMBALI",
                              True, (120, 220, 140) if sel >= len(rs) else (150, 155, 170)),
                  (W // 2 - 110, y))
        foot = small.render("←→/ENTER ganti nilai    ↑↓ pilih    ESC kembali",
                            True, (120, 125, 140))
        surf.blit(foot, (W // 2 - foot.get_width() // 2, H - 34))
        pygame.display.flip()
        clock.tick(RENDER_FPS)


def about_screen(surf, clock):
    """Layar ABOUT. ESC/ENTER/klik tutup balik ke menu."""
    big = pygame.font.SysFont("dejavusansbold", 40)
    font = pygame.font.SysFont("dejavusansmono", 16)
    lines = [
        ("Gee-FunDriving", (240, 240, 240)),
        ("", None),
        ("Sim nyetir 2D top-down: 1 mobil autonomous dengan", None),
        ("System-One decision loop — tiap tick dia memutuskan", None),
        ("(typed), bukan ngobrol bahasa natural.", None),
        ("", None),
        ("Terinspirasi demo \"rebuilt Tesla FSD with Jev\"", None),
        ("(TypeSafe AI). Peta Loop City buatan + OSM asli.", None),
        ("", None),
        ("KONTROL", (120, 220, 140)),
        ("  F          assistant ON/OFF (ambil alih / serah kemudi)", None),
        ("  WASD/panah gas, rem, belok (pas kendali sendiri)", None),
        ("  R misi baru   [-][=] zoom   ESC keluar ke menu", None),
        ("", None),
        ("Python + pygame · OpenStreetMap · ffmpeg", (120, 125, 140)),
    ]
    while True:
        for ev in pygame.event.get():
            if ev.type in (pygame.QUIT,):
                return
            if ev.type == pygame.KEYDOWN and ev.key in (pygame.K_ESCAPE, pygame.K_RETURN,
                                                        pygame.K_KP_ENTER, pygame.K_SPACE):
                return
        surf.fill((24, 26, 32))
        y = 40
        for txt, col in lines:
            f = big if txt == "Gee-FunDriving" else font
            c = col if col else (200, 205, 215)
            surf.blit(f.render(txt, True, c), (120, y))
            y += 26 if f is font else 52
        foot = font.render("ESC kembali", True, (120, 125, 140))
        surf.blit(foot, (W // 2 - foot.get_width() // 2, H - 34))
        pygame.display.flip()
        clock.tick(RENDER_FPS)


def main_menu(surf, clock, settings):
    """Menu utama: START / SETTINGS / ABOUT / EXIT.
    START -> {'mapfile', 'auto_start'}; EXIT/ESC -> None.
    SETTINGS & ABOUT ditangani di sini, balik ke menu lagi."""
    big = pygame.font.SysFont("dejavusansbold", 46)
    font = pygame.font.SysFont("dejavusansmono", 18)
    small = pygame.font.SysFont("dejavusansmono", 14)
    logo = None
    logo_path = os.path.join("assets", "logo-both.png")
    if os.path.exists(logo_path):
        try:
            img = pygame.image.load(logo_path).convert_alpha()
            ratio = 400.0 / img.get_width()
            logo = pygame.transform.smoothscale(img, (400, int(img.get_height() * ratio)))
        except Exception:
            logo = None

    sel = 0
    while True:
        mode_lbl = "ASSISTANT" if settings["mode"] == "assistant" else "KENDALI SENDIRI"
        map_lbl = {"loop": "LOOP CITY", "circuit": "SIRKUIT", "osm": "PETA OSM"}[settings["map"]]
        items = [("START  —  {} · {}".format(mode_lbl, map_lbl), "start"),
                 ("SETTINGS", "settings"),
                 ("ABOUT", "about"),
                 ("EXIT", "exit")]
        for ev in pygame.event.get():
            if ev.type == pygame.QUIT:
                return None
            if ev.type == pygame.KEYDOWN:
                if ev.key == pygame.K_ESCAPE:
                    return None
                if ev.key in (pygame.K_UP, pygame.K_w):
                    sel = (sel - 1) % len(items)
                elif ev.key in (pygame.K_DOWN, pygame.K_s):
                    sel = (sel + 1) % len(items)
                elif ev.key in (pygame.K_RETURN, pygame.K_KP_ENTER, pygame.K_SPACE):
                    act = items[sel][1]
                    if act == "start":
                        return {"mapfile": resolve_map(settings["map"]),
                                "auto_start": settings["mode"] == "assistant"}
                    if act == "settings":
                        settings_screen(surf, clock, settings)
                    elif act == "about":
                        about_screen(surf, clock)
                    else:
                        return None

        surf.fill((24, 26, 32))
        top = 26
        if logo:
            surf.blit(logo, (W // 2 - logo.get_width() // 2, top))
            top += logo.get_height() + 14
        else:
            t = big.render("Gee-FunDriving", True, (240, 240, 240))
            surf.blit(t, (W // 2 - t.get_width() // 2, top))
            top += t.get_height() + 16
        y = top + 10
        for i, (label, _act) in enumerate(items):
            on = i == sel
            if on:
                pygame.draw.rect(surf, (34, 42, 50),
                                 (W // 2 - 340, y - 5, 680, 28), border_radius=6)
            txt = ("> " if on else "   ") + label
            surf.blit(font.render(txt, True, (120, 220, 140) if on else (150, 155, 170)),
                      (W // 2 - 330, y))
            y += 32
        foot = small.render("W/S atau panah: pilih    ENTER: pilih    ESC: keluar",
                            True, (120, 125, 140))
        surf.blit(foot, (W // 2 - foot.get_width() // 2, H - 34))
        pygame.display.flip()
        clock.tick(RENDER_FPS)


def main():
    args = sys.argv[1:]
    headless = "--headless" in args
    auto_start = "--manual" not in args
    seconds = 45
    if "--seconds" in args:
        seconds = int(args[args.index("--seconds") + 1])
    elif not headless:
        seconds = None  # main santai di windowed: tanpa timer
    mapfile = None
    if "--map" in args:
        mapfile = args[args.index("--map") + 1]
        if mapfile == "loop":
            mapfile = os.path.join("maps", "loop_city.json")
    start_coord = parse_ll(args[args.index("--start") + 1]) if "--start" in args else None
    goal_coord = parse_ll(args[args.index("--goal") + 1]) if "--goal" in args else None
    heading = float(args[args.index("--heading") + 1]) if "--heading" in args else None
    brain = args[args.index("--brain") + 1] if "--brain" in args else "v4"
    if "--route" in args:
        a, b = args[args.index("--route") + 1], args[args.index("--route") + 2]
        mapdir = os.path.dirname(mapfile) if mapfile else "maps"
        with open(os.path.join(mapdir, "poi.json"), encoding="utf-8") as f:
            poi = json.load(f)
        start_coord = (poi[a]["lat"], poi[a]["lon"])
        goal_coord = (poi[b]["lat"], poi[b]["lon"])
        print(f"rute patokan: {poi[a].get('name', a)} -> {poi[b].get('name', b)}", file=sys.stderr)

    outdir = os.path.expanduser("~/gee-fundriving")
    os.makedirs(outdir, exist_ok=True)

    if headless:
        os.environ["SDL_VIDEODRIVER"] = "dummy"
    pygame.init()
    if not headless:
        surf = pygame.display.set_mode((W, H))
        pygame.display.set_caption("Gee-FunDriving")
    else:
        surf = pygame.Surface((W, H))
    clock = pygame.time.Clock()

    # main menu: cuma buat run santai windowed (bukan --headless / --map / rute).
    # ESC di game balik ke sini — menu terus tampil sampai user EXIT.
    if not headless and mapfile is None and "--route" not in args and "--start" not in args:
        settings = load_settings()
        if "--manual" in args:
            settings["mode"] = "manual"  # override CLI sesi ini, tanpa nulis file
        set_render_fps(settings["fps"])
        while True:
            picked = main_menu(surf, clock, settings)
            if picked is None:
                break
            pygame.event.clear()  # jangan sampai tombol menu bocor ke in-game
            if picked["mapfile"] is None:
                run_circuit(False, None, surf, clock, auto_start=picked["auto_start"])
            else:
                run_map(picked["mapfile"], False, None, surf, clock, outdir,
                        auto_start=picked["auto_start"])
        pygame.quit()
        return

    if mapfile:
        run_map(mapfile, headless, seconds, surf, clock, outdir,
                start_coord, goal_coord, heading, brain=brain, auto_start=auto_start)
        pygame.quit()
    else:
        run_circuit(headless, seconds, surf, clock, auto_start=auto_start)
        pygame.quit()


if __name__ == "__main__":
    main()
