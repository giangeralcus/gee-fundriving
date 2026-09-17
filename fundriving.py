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
                           Keys: [ESC] keluar, [-][=] zoom, [R] misi baru.

Headless: rekam MP4 (butuh ffmpeg).
"""
import json
import math
import os
import random
import subprocess
import sys
from collections import OrderedDict

import pygame

W, H = 960, 540
FPS = 60

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
CELL = 500  # ukuran sel spatial grid (meter) biar render gak terjerat peta raksasa


class OSMWorld:
    """Dunia dari OSM: graf jalan + bangunan + area + rute A* buat mobil."""

    def __init__(self, path):
        with open(path) as f:
            d = json.load(f)
        self.meta = d["meta"]
        self.nodes = {int(k): tuple(v) for k, v in d["nodes"].items()}
        self.adj = {}
        self.halfw = {}
        self.way_name = {}
        for r in d["roads"]:
            pts = r["points"]
            self.way_name[r["id"]] = r.get("name", "")
            wd = r.get("width", 10) / 2
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
            wd = r.get("width", 10) / 2
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
    """Lampu lalu lintas di simpang (derajat >= 4). Fase bergantian
    sumbu horizontal (0) / vertikal (1)."""

    CYCLE = 420  # frame per fase (7s @60fps)

    def __init__(self, world, comp):
        self.world = world
        self.nodes = set()
        for n in comp:
            if len(world.adj.get(n, ())) >= 4:
                self.nodes.add(n)
        self.frame = 0

    def axis_of(self, ax, ay, bx, by):
        return 0 if abs(bx - ax) >= abs(by - ay) else 1

    def green(self, node, axis):
        if node not in self.nodes:
            return True
        return (self.frame // self.CYCLE) % 2 == axis

    def update(self):
        self.frame += 1

    def draw(self, surf, cam):
        z = cam.zoom
        for n in self.nodes:
            nx, ny = cam.apply(*self.world.nodes[n])
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
                "base": random.uniform(1.5, 2.6), "speed": 0.0}

    def _lane(self, w):
        for c in self.cars:
            self._apply_lane(c, w)

    def _apply_lane(self, c, w):
        ax, ay = w.nodes[c["a"]]
        bx, by = w.nodes[c["b"]]
        dx, dy = bx - ax, by - ay
        L = c["L"]
        off = w.seg_halfw(c["a"], c["b"]) * 0.45
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

    def update(self, signals):
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
            for t_other, j in on_edge.get((c["a"], c["b"]), ()):
                if j != i and t_other > c["t"]:
                    gap = (t_other - c["t"]) * c["L"]
                    if gap < 24:
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
            off = w.seg_halfw(c["a"], c["b"]) * 0.45
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
        self.red_cd = {}
        self.goal = None
        self.route_len = 0.0
        self.driven = 0.0
        self.done = False
        self.from_node = from_node

    def route_len_of(self, route):
        w = self.world
        return sum(math.hypot(w.nodes[b][0] - w.nodes[a][0], w.nodes[b][1] - w.nodes[a][1])
                   for a, b in zip(route, route[1:]))

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
                self._set(from_node, goal, r, car)
                return True
        return False

    def new_fixed(self, from_node, goal_node, car):
        """Misi dengan tujuan eksplisit (mis. koordinat Taman Palem)."""
        r = self.world.route(from_node, goal_node)
        if len(r) < 2:
            return False
        self._set(from_node, goal_node, r, car)
        return True

    def _set(self, from_node, goal, r, car):
        self.goal = goal
        self.route_len = self.route_len_of(r)
        self.driven = 0.0
        self.reds = 0
        self.crashes = 0
        self.done = False
        self.red_cd = {}
        car.route = r
        car.wp_i = 1
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
    """Mobil di peta OSM: follow rute node; steering PD ke waypoint aktif."""

    MAXV = 4.2          # px/frame (~ 40 km/h pada scale)
    ACC = 0.05
    LOOKAHEAD = 55.0    # jarak lookahead (px ~ meter)

    def __init__(self, world, start_node, route):
        self.world = world
        self.route = route
        self.wp_i = 0
        x, y = world.nodes[start_node]
        self.x, self.y = float(x), float(y)
        self.heading = 0.0
        self.speed = 0.0
        self.crashes = 0
        self.alive_time = 0
        self.finished = False
        self._init_heading()

    def _init_heading(self):
        wp = self._lookpoint()
        self.heading = math.degrees(math.atan2(wp[1] - self.y, wp[0] - self.x))

    def _lookpoint(self):
        w = self.world
        acc = 0.0
        i = max(0, self.wp_i - 1)
        px, py = w.nodes[self.route[i]]
        while i + 1 < len(self.route):
            nx, ny = w.nodes[self.route[i + 1]]
            seg = math.hypot(nx - px, ny - py)
            if acc + seg >= self.LOOKAHEAD:
                f = (self.LOOKAHEAD - acc) / max(seg, 1e-6)
                return px + (nx - px) * f, py + (ny - py) * f
            acc += seg
            px, py = nx, ny
            i += 1
        return w.nodes[self.route[-1]]

    def sense(self):
        w = self.world
        while self.wp_i < len(self.route) - 1:
            tgt = w.nodes[self.route[self.wp_i]]
            if math.hypot(self.x - tgt[0], self.y - tgt[1]) < 28:
                self.wp_i += 1
            else:
                break
        tgt = w.nodes[self.route[self.wp_i]]
        desired = math.degrees(math.atan2(tgt[1] - self.y, tgt[0] - self.x))
        heading_err = (desired - self.heading + 180) % 360 - 180
        seg_i = max(0, min(self.wp_i, len(self.route) - 2))
        ax, ay = w.nodes[self.route[seg_i]]
        bx, by = w.nodes[self.route[seg_i + 1]]
        abx, aby = bx - ax, by - ay
        apx, apy = self.x - ax, self.y - ay
        ab2 = abx * abx + aby * aby + 1e-6
        tt = max(0.0, min(1.0, (apx * abx + apy * aby) / ab2))
        cx, cy = ax + abx * tt, ay + aby * tt
        lateral = math.hypot(self.x - cx, self.y - cy)
        hw = w.seg_halfw(self.route[seg_i], self.route[seg_i + 1])
        # curvature: sudut belokan di depan (wp sekarang -> wp berikut)
        i2 = min(self.wp_i + 1, len(self.route) - 1)
        tgt2 = w.nodes[self.route[i2]]
        d1x, d1y = tgt[0] - self.x, tgt[1] - self.y
        d2x, d2y = tgt2[0] - tgt[0], tgt2[1] - tgt[1]
        n1 = math.hypot(d1x, d1y) + 1e-6
        n2 = math.hypot(d2x, d2y) + 1e-6
        dot = max(-1.0, min(1.0, (d1x * d2x + d1y * d2y) / (n1 * n2)))
        curv = math.degrees(math.acos(dot))
        return {
            "lateral": lateral, "halfw": hw,
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
        if self.wp_i >= len(self.route) - 1:
            d = self.world.nodes[self.route[-1]]
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
    # antisipasi tikungan: makin tajam, makin pagi ngerem
    if curv > 65:
        thr, brk = 0.0, 0.85
    elif curv > 40:
        thr, brk = 0.3, 0.0
    elif curv > 22:
        thr, brk = 0.7, 0.0
    else:
        thr, brk = 1.0, 0.0
    # heading error tajam tetap menang
    if sharp > 90:
        thr, brk = 0.0, 1.0
    elif sharp > 45:
        thr, brk = min(thr, 0.25), 0.0
    elif sharp > 20:
        thr = min(thr, 0.6)
    # ACC: mobil depan deket -> longgar gas / rem
    acc = ""
    if gap is not None:
        if gap < 12:
            thr, brk = 0.0, 1.0
            acc = "REM!"
        elif gap < 26:
            thr = 0.0
            acc = "ikut"
        elif gap < 45:
            thr = min(thr, 0.35)
            acc = "geser"
    return steer, thr, brk, {"he": he, "lat": state["lateral"], "acc": acc}


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
        self.zoom = 0.55

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


def draw_map(surf, world, car, cam, state, dec, stats, traffic, signals, mission, name_cache, tiles):
    draw_world(surf, world, cam, tiles)
    # rute (casing + garis)
    if len(car.route) > 1:
        step = max(1, len(car.route) // 400)
        pts = [cam.apply(*world.nodes[n]) for n in car.route[::step]]
        pygame.draw.lines(surf, COL_ROUTE_CASE, False, pts, 6)
        pygame.draw.lines(surf, COL_ROUTE, False, pts, 3)
    # waypoint aktif
    wp = cam.apply(*state["wp"])
    pygame.draw.circle(surf, (240, 200, 80), (int(wp[0]), int(wp[1])), 5)
    signals.draw(surf, cam)
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
    pts = [(cx + dx * math.cos(a) * z - dy * math.sin(a) * z,
            cy + dx * math.sin(a) * z + dy * math.cos(a) * z)
           for dx, dy in ((CAR_LEN / 2, 0), (-CAR_LEN / 2, CAR_W / 2), (-CAR_LEN / 2, -CAR_W / 2))]
    col = (80, 220, 120) if not car.finished else (90, 160, 255)
    pygame.draw.polygon(surf, col, pts)
    # nama jalan
    name = draw_street_name(surf, world, cam, car, name_cache)
    # HUD
    gdist = 0
    if mission.goal is not None:
        gx, gy = world.nodes[mission.goal]
        gdist = math.hypot(car.x - gx, car.y - gy)
    hud(surf, [
        f"Gee-FunDriving | {world.meta['name']}",
        f"speed {car.speed:.1f}  alive {car.alive_time // FPS}s  wp {car.wp_i}/{len(car.route)}",
        f"he {dec.get('he', 0):.0f}  lat {dec.get('lat', 0):.0f}m  {dec.get('acc', '')} {name}".replace("  ", " "),
        f"misi #{mission.n + 1} -> {gdist:.0f}m | skor {mission.score} | merah {mission.reds} tabrak {mission.crashes}",
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
            start_coord=None, goal_coord=None, heading=None):
    frames_dir = os.path.join(outdir, "frames")
    if headless:
        os.makedirs(frames_dir, exist_ok=True)
        for f in os.listdir(frames_dir):
            os.remove(os.path.join(frames_dir, f))
    world = OSMWorld(mapfile)
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
    car = MapCar(world, start, route)
    if heading is not None:
        car.heading = heading % 360.0
    signals = Signals(world, comp)
    traffic = Traffic(world, comp, (sx, sy))
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
    total = FPS * seconds
    crash_cd = 0
    zoom = cam.zoom
    for fi in range(total):
        state = car.sense()
        # ACC: cari mobil AI paling deket di koridor depan
        hdir = math.radians(car.heading)
        fx_, fy_ = math.cos(hdir), math.sin(hdir)
        gap = None
        for tc in traffic.cars:
            dx_, dy_ = tc["x"] - car.x, tc["y"] - car.y
            fwd = dx_ * fx_ + dy_ * fy_
            if 0 < fwd < 55:
                lat = abs(-dx_ * fy_ + dy_ * fx_)
                if lat < 11 and (gap is None or fwd < gap):
                    gap = fwd
        state["ahead_gap"] = gap
        steer, thr, brk, dec = map_brain(state)
        # berhenti di lampu merah: cek node tujuan aktif
        tgt = car.route[min(car.wp_i, len(car.route) - 1)]
        if tgt in signals.nodes:
            tx, ty = world.nodes[tgt]
            d = math.hypot(car.x - tx, car.y - ty)
            axis = 0 if abs(math.cos(math.radians(car.heading))) >= abs(math.sin(math.radians(car.heading))) else 1
            if 6 < d < 40 and not signals.green(tgt, axis):
                thr, brk = 0.0, 1.0
            # nyabrang merah: nempel node + masih merah + gerak
            if d < 9 and not signals.green(tgt, axis) and car.speed > 1.0:
                last = mission.red_cd.get(tgt, -9999)
                if fi - last > 240:
                    mission.reds += 1
                    mission.red_cd[tgt] = fi
        car.step(steer, thr, brk)
        mission.driven += car.speed
        signals.update()
        traffic.update(signals)
        # tabrakan hero vs mobil AI
        if crash_cd > 0:
            crash_cd -= 1
        else:
            for j, tc in enumerate(traffic.cars):
                if math.hypot(car.x - tc["x"], car.y - tc["y"]) < 15:
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
        name_cache[0] = (name_cache[0] + 1) % 15
        draw_map(surf, world, car, cam, state, dec, f"{clock.get_fps():.0f} fps",
                 traffic, signals, mission, name_cache, tiles)
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
        if headless and fi % 2 == 0:
            pygame.image.save(surf, os.path.join(frames_dir, f"f{fi:05d}.png"))
        if not headless:
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
            pygame.event.pump()
            pygame.display.flip()
            clock.tick(FPS)
    if headless:
        mp4 = os.path.join(outdir, "gee_fundriving_demo.mp4")
        subprocess.run([
            "ffmpeg", "-y", "-loglevel", "error", "-f", "image2",
            "-pattern_type", "glob", "-i", os.path.join(frames_dir, "f*.png"),
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", mp4,
        ], check=True)
        print("VIDEO_OK", mp4)
    print(f"skor akhir {mission.score} | misi selesai {mission.n} | "
          f"merah {mission.reds} tabrak {mission.crashes} | alive {car.alive_time // FPS}s")


def run_circuit(headless, seconds, surf, clock):
    car = CircuitCar()
    total = FPS * seconds
    for fi in range(total):
        state = car.sense()
        steer, thr, brk, dec = brain_decide(state)
        car.step(steer, thr, brk)
        if not car.frame_alive:
            car.reset()
        draw_circuit(surf, car, state, dec, "")
        if not headless:
            for ev in pygame.event.get():
                if ev.type == pygame.QUIT:
                    pygame.quit()
                    return
            pygame.event.pump()
            pygame.display.flip()
            clock.tick(FPS)
    pygame.quit()
    print(f"selesai: laps {car.laps:.2f}")


def main():
    args = sys.argv[1:]
    headless = "--headless" in args
    seconds = 45
    if "--seconds" in args:
        seconds = int(args[args.index("--seconds") + 1])
    mapfile = None
    if "--map" in args:
        mapfile = args[args.index("--map") + 1]
    start_coord = parse_ll(args[args.index("--start") + 1]) if "--start" in args else None
    goal_coord = parse_ll(args[args.index("--goal") + 1]) if "--goal" in args else None
    heading = float(args[args.index("--heading") + 1]) if "--heading" in args else None

    outdir = os.path.expanduser("~/gee-fundriving")
    os.makedirs(outdir, exist_ok=True)

    if headless:
        os.environ["SDL_VIDEODRIVER"] = "dummy"
    pygame.init()
    surf = pygame.Surface((W, H)) if headless else pygame.display.set_mode((W, H))
    if not headless:
        pygame.display.set_caption("Gee-FunDriving")
    clock = pygame.time.Clock()

    if mapfile:
        run_map(mapfile, headless, seconds, surf, clock, outdir,
                start_coord, goal_coord, heading)
        pygame.quit()
    else:
        run_circuit(headless, seconds, surf, clock)


if __name__ == "__main__":
    main()
