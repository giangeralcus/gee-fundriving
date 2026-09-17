#!/usr/bin/env python3
"""
Gee-FunDriving — sim nyetir 2D top-down.

MODE:
1. Sirkuit (default)     : track oval, brain rule-based System-One loop.
2. Peta OSM (--map FILE) : peta jalan asli (mis. Puri Indah dari OSM),
                           mobil ikut rute jalan pakai waypoint-following,
                           kamera mengikuti mobil. [W] pan, zoom [-/+] ; [R] reset.

Headless: rekam MP4.
"""
import json
import math
import os
import random
import subprocess
import sys

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
                         (RX - ROAD_W / 2) * 2, (RY - ROAD_W / 2) * 2))
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
class OSMWorld:
    """Peta jalan dari OSM: graf node/way + rute waypoint buat mobil."""

    def __init__(self, path):
        with open(path) as f:
            d = json.load(f)
        self.meta = d["meta"]
        self.nodes = {int(k): tuple(v) for k, v in d["nodes"].items()}
        # adjacency
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
                # simpan half-width minimal per node pair utk collision
                self._wmin(a, b, wd)
        self.halfw = {}
        xs = [p[0] for p in self.nodes.values()]
        ys = [p[1] for p in self.nodes.values()]
        self.minx, self.maxx = min(xs), max(xs)
        self.miny, self.maxy = min(ys), max(ys)

    def _wmin(self, a, b, wd):
        k = (min(a, b), max(a, b))
        if k not in self.halfw or wd < self.halfw[k]:
            self.halfw[k] = wd

    def seg_halfw(self, a, b):
        return self.halfw.get((min(a, b), max(a, b)), 5.0)

    def nearest_node(self, x, y):
        best, bd = None, 1e18
        for nid, (nx, ny) in self.nodes.items():
            d = (nx - x) ** 2 + (ny - y) ** 2
            if d < bd:
                best, bd = nid, d
        return best

    # --- route: BFS sederhana node start -> goal (bobot = jarak euclid) ---
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
        """Titik lookahead di sepanjang rute."""
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
        # advance waypoint: maju kalau sudah dekat (< 28m) atau sudah lewat
        w = self.world
        while self.wp_i < len(self.route) - 1:
            tgt = w.nodes[self.route[self.wp_i]]
            if math.hypot(self.x - tgt[0], self.y - tgt[1]) < 28:
                self.wp_i += 1
            else:
                break
        tgt = w.nodes[self.route[self.wp_i]]
        # sudut ke target vs heading sekarang
        desired = math.degrees(math.atan2(tgt[1] - self.y, tgt[0] - self.x))
        heading_err = (desired - self.heading + 180) % 360 - 180
        # lateral error: jarak ke segmen rute aktif
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
        return {
            "lateral": lateral, "halfw": hw,
            "heading_err": heading_err,
            "speed_norm": self.speed / self.MAXV,
            "wp": tgt, "cx": cx, "cy": cy,
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
    """Steering: proporsional heading error ke waypoint (sign benar:
    err positif = target di kiri arah mobil => belok kiri (negatif)).
    Perlambat saat heading error besar."""
    he = state["heading_err"]
    steer = max(-1.0, min(1.0, he / 40.0))
    sharp = abs(he)
    if sharp > 90:
        thr, brk = 0.0, 1.0   # hampir balik arah: rem + putar di tempat
    elif sharp > 45:
        thr, brk = 0.25, 0.0
    elif sharp > 20:
        thr, brk = 0.6, 0.0
    else:
        thr, brk = 1.0, 0.0
    return steer, thr, brk, {"he": he, "lat": state["lateral"]}


def largest_component(world):
    """Return set node dari connected component terbesar."""
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


def draw_map(surf, world, car, cam, state, dec, stats):
    surf.fill((30, 32, 38))
    # latar blok kota sederhana: gambar semua road
    z = cam.zoom
    lw = max(1, int(2))
    for rid, name in list(world.way_name.items())[:0]:
        pass
    # gambar jalan: iterate adjacency pairs (pakai halfw utk width)
    drawn = set()
    for a, nbrs in world.adj.items():
        ax, ay = cam.apply(*world.nodes[a])
        if not (-80 < ax < W + 80 and -80 < ay < H + 80):
            continue
        for b in nbrs:
            k = (min(a, b), max(a, b))
            if k in drawn:
                continue
            drawn.add(k)
            bx, by = cam.apply(*world.nodes[b])
            hw = world.seg_halfw(a, b) * z
            pygame.draw.line(surf, (70, 74, 86), (ax, ay), (bx, by), max(2, int(hw * 2)))
    # rute
    if len(car.route) > 1:
        pts = [cam.apply(*world.nodes[n]) for n in car.route[:: max(1, len(car.route) // 400)]]
        pygame.draw.lines(surf, (70, 130, 220), False, pts, 2)
    # waypoint aktif
    wp = cam.apply(*state["wp"])
    pygame.draw.circle(surf, (240, 200, 80), (int(wp[0]), int(wp[1])), 5)
    # mobil
    cx, cy = cam.apply(car.x, car.y)
    a = math.radians(car.heading)
    pts = [(cx + dx * math.cos(a) * z - dy * math.sin(a) * z,
            cy + dx * math.sin(a) * z + dy * math.cos(a) * z)
           for dx, dy in ((CAR_LEN / 2, 0), (-CAR_LEN / 2, CAR_W / 2), (-CAR_LEN / 2, -CAR_W / 2))]
    col = (80, 220, 120) if not car.finished else (90, 160, 255)
    pygame.draw.polygon(surf, col, pts)
    hud(surf, [
        f"Gee-FunDriving | {world.meta['name']}",
        f"speed {car.speed:.1f}  alive {car.alive_time // FPS}s  wp {car.wp_i}/{len(car.route)}",
        f"he {dec.get('he', 0):.0f}  lat {dec.get('lat', 0):.0f}m  {stats}",
    ])


# ---------------------------------------------------------------- driver ----
def main():
    args = sys.argv[1:]
    headless = "--headless" in args
    seconds = 45
    if "--seconds" in args:
        seconds = int(args[args.index("--seconds") + 1])
    mapfile = None
    if "--map" in args:
        mapfile = args[args.index("--map") + 1]

    outdir = os.path.expanduser("~/gee-fundriving")
    os.makedirs(outdir, exist_ok=True)

    if headless:
        os.environ["SDL_VIDEODRIVER"] = "dummy"
    pygame.init()
    surf = pygame.Surface((W, H)) if headless else pygame.display.set_mode((W, H))
    if not headless:
        pygame.display.set_caption("Gee-FunDriving")
    clock = pygame.time.Clock()

    frames_dir = os.path.join(outdir, "frames")
    if headless:
        os.makedirs(frames_dir, exist_ok=True)
        for f in os.listdir(frames_dir):
            os.remove(os.path.join(frames_dir, f))

    cam = Camera()
    if mapfile:
        world = OSMWorld(mapfile)
        # spawn/goal: ambil node terbesar-degree di barat & timur dari komponen
        # terbesar (graf OSM kadang punya pulau terpisah -> BFS fail)
        comp = largest_component(world)
        start = min(comp, key=lambda n: world.nodes[n][0])
        sx, sy = world.nodes[start]
        goal = max(comp, key=lambda n: (world.nodes[n][0] - sx) ** 2 + (world.nodes[n][1] - sy) ** 2)
        route = world.route(start, goal)
        if len(route) < 2:
            print("rute gak ketemu — coba bbox lain")
            sys.exit(1)
        car = MapCar(world, start, route)
        print(f"route: {len(route)} nodes, {sum(1 for _ in route)} wp | start {start} goal {goal}",
              file=sys.stderr)
        mode = "map"
        cam.x, cam.y = car.x, car.y
    else:
        world = None
        car = CircuitCar()
        mode = "circuit"

    total = FPS * seconds
    for fi in range(total):
        if mode == "circuit":
            state = car.sense()
            steer, thr, brk, dec = brain_decide(state)
            car.step(steer, thr, brk)
            if not car.frame_alive:
                car.reset()
            draw_circuit(surf, car, state, dec, "")
        else:
            state = car.sense()
            steer, thr, brk, dec = map_brain(state)
            car.step(steer, thr, brk)
            cam.follow(car.x, car.y)
            draw_map(surf, world, car, cam, state, dec,
                     f"finished={car.finished}")
            if car.finished and headless:
                break
        if headless and fi % 2 == 0:
            pygame.image.save(surf, os.path.join(frames_dir, f"f{fi:05d}.png"))
        if not headless:
            for ev in pygame.event.get():
                if ev.type == pygame.QUIT:
                    pygame.quit()
                    return
            pygame.event.pump()
            pygame.display.flip()
            clock.tick(FPS)
    pygame.quit()

    if headless:
        mp4 = os.path.join(outdir, "gee_fundriving_demo.mp4")
        subprocess.run([
            "ffmpeg", "-y", "-loglevel", "error", "-f", "image2",
            "-pattern_type", "glob", "-i", os.path.join(frames_dir, "f*.png"),
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", mp4,
        ], check=True)
        print("VIDEO_OK", mp4)
    if mode == "map":
        print(f"selesai: wp {car.wp_i}/{len(car.route)} finished={car.finished} alive {car.alive_time // FPS}s")
    else:
        print(f"selesai: laps {car.laps:.2f}")


if __name__ == "__main__":
    main()
