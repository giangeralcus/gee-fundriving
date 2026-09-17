"use strict";
/* Gee-FunDriving — versi web (port dari fundriving.py, Loop City).
 * Fisika 60Hz fixed-step, render 30/60fps, menu START/SETTINGS/ABOUT/EXIT.
 * Jalan offline: buka index.html langsung (peta di-embed di map_loop_city.js). */

const W = 960, H = 540;
const FPS = 60;                    // tick fisika (Hz) — sama kayak desktop
let RENDER_FPS = 30, RENDER_EVERY = 2;

const CAR_LEN = 34, CAR_W = 18;
const CELL = 500;

// palet (identik desktop)
const COL_BG = "#1a1c22", COL_GREEN = "#2c3c2e", COL_WATER = "#243450";
const COL_BLDG = "#2a2d36", COL_BLDG_EDGE = "#363a44";
const COL_CASING = "#343740", COL_ROAD = "#585c68", COL_ROAD_MAJOR = "#646876";
const COL_ROUTE = "#508ce6", COL_ROUTE_CASE = "#1c3a76";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const hyp = (dx, dy) => Math.sqrt(dx * dx + dy * dy);
const rad = d => d * Math.PI / 180;

// ---------------------------------------------------------------- dunia ----
class World {
  constructor(data, widthScale = 1.35) {
    const d = data;
    this.name = d.meta.name;
    this.widthScale = widthScale;
    this.nodes = new Map();
    for (const k in d.nodes) this.nodes.set(+k, d.nodes[k]);
    this.adj = new Map();          // id -> Set(id)
    this.halfw = new Map();        // "min|max" -> half width
    this.wayName = new Map();
    for (const r of d.roads) {
      this.wayName.set(r.id, r.name || "");
      const wd = (r.width || 10) / 2 * widthScale;
      const pts = r.points;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        if (!this.adj.has(a)) this.adj.set(a, new Set());
        if (!this.adj.has(b)) this.adj.set(b, new Set());
        this.adj.get(a).add(b);
        this.adj.get(b).add(a);
        const k = Math.min(a, b) + "|" + Math.max(a, b);
        if (!this.halfw.has(k) || wd < this.halfw.get(k)) this.halfw.set(k, wd);
      }
    }
    // segmen render: [ax,ay,bx,by,hw,kind]
    this.segs = [];
    const seen = new Set();
    for (const r of d.roads) {
      const wd = (r.width || 10) / 2 * widthScale;
      const kind = r.kind || "residential";
      const pts = r.points;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const k = Math.min(a, b) + "|" + Math.max(a, b);
        if (seen.has(k)) continue;
        seen.add(k);
        const [ax, ay] = this.nodes.get(a), [bx, by] = this.nodes.get(b);
        this.segs.push([ax, ay, bx, by, wd, kind]);
      }
    }
    this.buildings = (d.buildings || []).filter(p => p.length >= 3);
    this.areas = (d.areas || []).filter(a => (a.pts || []).length >= 3);
    // segmen bernama buat label nama jalan
    this.namedSegs = [];
    const seen2 = new Set();
    for (const r of d.roads) {
      const nm = r.name || "";
      if (!nm) continue;
      const pts = r.points;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const k = Math.min(a, b) + "|" + Math.max(a, b);
        if (seen2.has(k)) continue;
        seen2.add(k);
        const [ax, ay] = this.nodes.get(a), [bx, by] = this.nodes.get(b);
        this.namedSegs.push([ax, ay, bx, by, nm]);
      }
    }
    this.totalLen = this.segs.reduce((s, g) => s + hyp(g[2] - g[0], g[3] - g[1]), 0);
  }

  segHalfw(a, b) {
    const v = this.halfw.get(Math.min(a, b) + "|" + Math.max(a, b));
    return v === undefined ? 5.0 : v;
  }

  nearestNode(x, y, subset) {
    let best = null, bd = Infinity;
    for (const nid of (subset || this.nodes.keys())) {
      const [nx, ny] = this.nodes.get(nid);
      const d = (nx - x) ** 2 + (ny - y) ** 2;
      if (d < bd) { best = nid; bd = d; }
    }
    return best;
  }

  route(start, goal) {  // Dijkstra (graf kecil, cukup)
    const dist = new Map([[start, 0]]);
    const prev = new Map();
    const pq = [[0, start]];
    while (pq.length) {
      pq.sort((a, b) => a[0] - b[0]);          // graf 70 node — sort cukup
      const [d0, u] = pq.shift();
      if (u === goal) break;
      if (d0 > (dist.get(u) ?? Infinity)) continue;
      for (const v of (this.adj.get(u) || [])) {
        const [ux, uy] = this.nodes.get(u), [vx, vy] = this.nodes.get(v);
        const nd = d0 + hyp(vx - ux, vy - uy);
        if (nd < (dist.get(v) ?? Infinity)) {
          dist.set(v, nd); prev.set(v, u); pq.push([nd, v]);
        }
      }
    }
    if (!dist.has(goal)) return [];
    const path = [goal];
    while (path[path.length - 1] !== start) path.push(prev.get(path[path.length - 1]));
    return path.reverse();
  }
}

function largestComponent(world) {
  let best = new Set(), seen = new Set();
  for (const n0 of world.adj.keys()) {
    if (seen.has(n0)) continue;
    const comp = new Set([n0]), stack = [n0];
    while (stack.length) {
      const u = stack.pop();
      for (const v of (world.adj.get(u) || [])) {
        if (!comp.has(v)) { comp.add(v); stack.push(v); }
      }
    }
    for (const c of comp) seen.add(c);
    if (comp.size > best.size) best = comp;
  }
  return best;
}

function simplify(points, eps = 12.0) {  // Douglas-Peucker
  if (points.length < 3) return points.slice();
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    if (i1 <= i0 + 1) continue;
    const [ax, ay] = points[i0], [bx, by] = points[i1];
    const dx = bx - ax, dy = by - ay;
    const n = hyp(dx, dy) + 1e-9;
    let best = -1, bi = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const [px, py] = points[i];
      const d = Math.abs((px - ax) * dy - (py - ay) * dx) / n;
      if (d > best) { best = d; bi = i; }
    }
    if (best > eps) {
      keep[bi] = true;
      stack.push([i0, bi], [bi, i1]);
    }
  }
  return points.filter((_p, i) => keep[i]);
}

// --------------------------------------------------------------- lampu ----
class Signals {
  static CYCLE = 420;   // frame per fase (7s @60fps)
  static DRAW_RADIUS = 420;
  static MAJOR = new Set(["motorway", "trunk", "primary", "secondary", "tertiary", "residential"]);

  constructor(_world, _comp) {
    // nodeList/pos/nodeSet diisi Game._signalsEdgeIds() (butuh graf + comp)
    this.nodeList = [];
    this.pos = [];
    this.nodeSet = new Set();
    this.frame = 0;
  }

  axisOf(ax, ay, bx, by) { return Math.abs(bx - ax) >= Math.abs(by - ay) ? 0 : 1; }
  green(node, axis) {
    if (!this.nodeSet.has(node)) return true;
    return Math.floor(this.frame / Signals.CYCLE) % 2 === axis;
  }
  update() { this.frame++; }
}

// ------------------------------------------------------------ traffic ----
class Traffic {
  constructor(world, comp, avoidXy, n = 16) {
    this.world = world;
    this.comp = comp;
    this.cars = [];
    const segs = [...world.halfw.keys()];
    for (let i = segs.length - 1; i > 0; i--) {   // shuffle
      const j = Math.floor(Math.random() * (i + 1));
      [segs[i], segs[j]] = [segs[j], segs[i]];
    }
    for (const k of segs) {
      if (this.cars.length >= n) break;
      const [a, b] = k.split("|").map(Number);
      if (!comp.has(a) || !comp.has(b)) continue;
      const [ax, ay] = world.nodes.get(a);
      if (hyp(ax - avoidXy[0], ay - avoidXy[1]) < 180) continue;
      this.cars.push(this._mk(a, b));
    }
  }

  _mk(a, b) {
    const w = this.world;
    const [ax, ay] = w.nodes.get(a), [bx, by] = w.nodes.get(b);
    const L = Math.max(hyp(bx - ax, by - ay), 1.0);
    const t = 0.05 + Math.random() * 0.9;
    const ang = Math.atan2(by - ay, bx - ax);
    return { a, b, t, L, x: ax + (bx - ax) * t, y: ay + (by - ay) * t,
             heading: ang * 180 / Math.PI, base: 2.2 + Math.random() * 1.1, speed: 0 };
  }

  _nextEdge(c) {
    const w = this.world;
    const b = c.b;
    let nbrs = [...(w.adj.get(b) || [])];
    if (nbrs.length > 1) {
      const f = nbrs.filter(v => v !== c.a);
      if (f.length) nbrs = f;
    }
    const nc = this._mk(b, nbrs[Math.floor(Math.random() * nbrs.length)]);
    nc.base = c.base;
    return nc;
  }

  update(signals, hero) {
    const w = this.world;
    const onEdge = new Map();
    this.cars.forEach((c, i) => {
      const k = c.a + ">" + c.b;
      if (!onEdge.has(k)) onEdge.set(k, []);
      onEdge.get(k).push([c.t, i]);
    });
    for (const lst of onEdge.values()) lst.sort((x, y) => x[0] - y[0]);
    this.cars.forEach((c, i) => {
      let tgt = c.base;
      if (hero) {
        const hx = Math.cos(rad(c.heading)), hy = Math.sin(rad(c.heading));
        const dxh = hero[0] - c.x, dyh = hero[1] - c.y;
        const fwdh = dxh * hx + dyh * hy;
        if (0 < fwdh && fwdh < 32 && Math.abs(-dxh * hy + dyh * hx) < 6) tgt = 0;
      }
      for (const [tO, j] of (onEdge.get(c.a + ">" + c.b) || [])) {
        if (j !== i && tO > c.t) {
          if ((tO - c.t) * c.L < 30) { tgt = 0; break; }
        }
      }
      if (signals.nodeSet.has(c.b)) {
        const distNode = (1.0 - c.t) * c.L;
        const [ax, ay] = w.nodes.get(c.a), [bx, by] = w.nodes.get(c.b);
        const axis = signals.axisOf(ax, ay, bx, by);
        if (8 < distNode && distNode < 34 && !signals.green(c.b, axis)) tgt = 0;
      }
      c.speed = tgt;
      c.t += c.speed / c.L;
      if (c.t >= 1.0) {
        const nc = this._nextEdge(c);
        c.a = nc.a; c.b = nc.b; c.t = 0; c.L = nc.L;
        const [ax, ay] = w.nodes.get(c.a), [bx, by] = w.nodes.get(c.b);
        c.heading = Math.atan2(by - ay, bx - ax) * 180 / Math.PI;
      }
      const [ax, ay] = w.nodes.get(c.a), [bx, by] = w.nodes.get(c.b);
      const L = c.L, off = w.segHalfw(c.a, c.b) * 0.55;
      const dx = bx - ax, dy = by - ay;
      const px = ax + (bx - ax) * c.t, py = ay + (by - ay) * c.t;
      c.x = px + (-dy / L) * off;
      c.y = py + (dx / L) * off;
    });
  }
}

// --------------------------------------------------------------- misi ----
class Mission {
  constructor(world, comp, fromNode) {
    this.world = world; this.comp = comp;
    this.n = 0; this.score = 0; this.reds = 0; this.crashes = 0; this.recovers = 0;
    this.redCd = {}; this.goal = null; this.routeLen = 0; this.driven = 0;
  }

  routeLenOf(pts) {
    let s = 0;
    for (let i = 0; i < pts.length - 1; i++) s += hyp(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    return s;
  }

  new(fromNode, car) {
    const w = this.world;
    const [fx, fy] = w.nodes.get(fromNode);
    const ids = [...this.comp].sort((a, b) => a - b);
    for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
    const pool = ids.slice(0, Math.min(500, ids.length));
    const cands = pool.filter(n => {
      const [nx, ny] = w.nodes.get(n);
      const d = hyp(nx - fx, ny - fy);
      return d > 500 && d < 2600;
    });
    for (let i = cands.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [cands[i], cands[j]] = [cands[j], cands[i]]; }
    for (const goal of cands.slice(0, 12)) {
      const r = w.route(fromNode, goal);
      if (r.length >= 4) {
        const pts = simplify(r.map(n => w.nodes.get(n)), 12.0);
        if (pts.length >= 3) { this._set(goal, pts, car); return true; }
      }
    }
    return false;
  }

  _set(goal, pts, car) {
    this.goal = goal;
    this.routeLen = this.routeLenOf(pts);
    this.driven = 0; this.reds = 0; this.crashes = 0; this.recovers = 0;
    this.redCd = {};
    car.route = pts; car.wpI = 0; car.finished = false;
    car.initHeading();
  }

  complete() {
    const base = Math.round(this.routeLen / Math.max(this.driven, 1.0) * 1000);
    const pts = Math.max(50, base - 40 * this.reds - 25 * this.crashes);
    this.score += pts; this.n += 1;
    return pts;
  }
}

// --------------------------------------------------------------- mobil ----
class MapCar {
  static MAXV = 4.2; static ACC = 0.05;
  static LOOKAHEAD_BASE = 16; static LOOKAHEAD_GAIN = 6.0;
  static CAPTURE = 12.0; static LANE_OFF = 3.5;

  constructor(world, startNode, route) {
    this.world = world;
    this.route = route;
    this.wpI = 0;
    const [x, y] = world.nodes.get(startNode);
    this.x = x; this.y = y;
    this.speed = 0; this.finished = false; this.aliveTime = 0;
    this.initHeading();
  }

  lookahead() { return MapCar.LOOKAHEAD_BASE + MapCar.LOOKAHEAD_GAIN * this.speed; }

  initHeading() {
    const wp = this.lookPoint(0);
    this.heading = Math.atan2(wp[1] - this.y, wp[0] - this.x) * 180 / Math.PI;
  }

  project() {
    const a = this.route[this.wpI], b = this.route[this.wpI + 1];
    const abx = b[0] - a[0], aby = b[1] - a[1];
    const ab2 = abx * abx + aby * aby + 1e-6;
    const t = clamp(((this.x - a[0]) * abx + (this.y - a[1]) * aby) / ab2, 0, 1);
    const cx = a[0] + abx * t, cy = a[1] + aby * t;
    return [t, cx, cy, hyp(this.x - cx, this.y - cy)];
  }

  lookPoint(tProj) {
    let i = this.wpI;
    const a = this.route[i], b = this.route[i + 1];
    const seglen = hyp(b[0] - a[0], b[1] - a[1]) + 1e-6;
    const px = a[0] + (b[0] - a[0]) * tProj, py = a[1] + (b[1] - a[1]) * tProj;
    const target = this.lookahead();
    let acc = hyp(b[0] - px, b[1] - py);
    if (acc >= target) {
      const ux = (b[0] - a[0]) / seglen, uy = (b[1] - a[1]) / seglen;
      return [px + ux * target, py + uy * target];
    }
    let rem = target - acc, bx = b[0], by = b[1];
    while (i + 2 < this.route.length && rem > 1e-6) {
      i++;
      const [nx, ny] = this.route[i + 1];
      const seg = hyp(nx - bx, ny - by);
      if (rem <= seg) {
        const f = rem / Math.max(seg, 1e-6);
        return [bx + (nx - bx) * f, by + (ny - by) * f];
      }
      rem -= seg; bx = nx; by = ny;
    }
    return this.route[this.route.length - 1];
  }

  sense() {
    const w = this.world;
    while (this.wpI < this.route.length - 2 && this.project()[0] >= 1.0) this.wpI++;
    let [t, cx, cy, dist] = this.project();
    while (this.wpI < this.route.length - 2) {
      const wpn = this.route[this.wpI + 1];
      if (hyp(this.x - wpn[0], this.y - wpn[1]) < MapCar.CAPTURE) {
        this.wpI++;
        [t, cx, cy, dist] = this.project();
      } else break;
    }
    const tgt = this.route[Math.min(this.wpI + 1, this.route.length - 1)];
    let look = this.lookPoint(t);
    const dxl = look[0] - this.x, dyl = look[1] - this.y;
    const ll = hyp(dxl, dyl) + 1e-6;
    look = [look[0] + (-dyl / ll) * MapCar.LANE_OFF, look[1] + (dxl / ll) * MapCar.LANE_OFF];
    const desired = Math.atan2(look[1] - this.y, look[0] - this.x) * 180 / Math.PI;
    const headingErr = (desired - this.heading + 180) % 360 - 180;
    const hw = w.segHalfw(this.route[this.wpI], this.route[this.wpI + 1]);
    let curv = 0, accD = 0, i = this.wpI;
    while (i + 2 < this.route.length && accD < 120) {
      const [ax, ay] = this.route[i], [bx, by] = this.route[i + 1], [cxn, cyn] = this.route[i + 2];
      const d1x = bx - ax, d1y = by - ay, d2x = cxn - bx, d2y = cyn - by;
      const n1 = hyp(d1x, d1y) + 1e-6, n2 = hyp(d2x, d2y) + 1e-6;
      const dot = clamp((d1x * d2x + d1y * d2y) / (n1 * n2), -1, 1);
      const ang = Math.acos(dot) * 180 / Math.PI;
      const wgt = 0.45 + 0.55 * (1.0 - accD / 120.0);
      curv = Math.max(curv, ang * wgt);
      accD += n1; i++;
    }
    return { lateral: dist, halfw: hw, headingErr, speedNorm: this.speed / MapCar.MAXV,
             wp: tgt, cx, cy, curv };
  }

  step(steer, thr, brk) {
    const turn = steer * 3.4 * (0.45 + 0.55 * this.speed / MapCar.MAXV);
    this.heading = (this.heading + turn) % 360;
    if (brk > 0) this.speed = Math.max(0.0, this.speed - 0.15);
    else if (thr > 0) this.speed = Math.min(MapCar.MAXV, this.speed + MapCar.ACC * thr);
    const a = rad(this.heading);
    this.x += Math.cos(a) * this.speed;
    this.y += Math.sin(a) * this.speed;
    this.aliveTime++;
    if (this.wpI >= this.route.length - 2) {
      const d = this.route[this.route.length - 1];
      if (hyp(this.x - d[0], this.y - d[1]) < 12) this.finished = true;
    }
  }
}

function mapBrain(state) {
  const he = state.headingErr, curv = state.curv, gap = state.aheadGap;
  let steer = clamp(he / 40.0, -1, 1);
  let thr, brk, acc = "";
  const sharp = Math.abs(he);
  if (curv > 50) { thr = 0.0; brk = 0.9; }
  else if (curv > 30) { thr = 0.25; brk = 0.0; }
  else if (curv > 15) { thr = 0.65; brk = 0.0; }
  else { thr = 1.0; brk = 0.0; }
  if (sharp > 90) { thr = 0.0; brk = 1.0; }
  else if (sharp > 45) { thr = Math.min(thr, 0.25); brk = 0.0; }
  else if (sharp > 20) thr = Math.min(thr, 0.6);
  if (gap !== undefined && gap !== null) {
    if (gap < 10) { thr = 0.0; brk = 1.0; acc = "REM!"; }
    else if (gap < 20) { thr = 0.0; brk = 0.7; acc = "REM!"; }
    else if (gap < 35) { thr = 0.0; brk = 0.0; acc = "ikut"; }
    else if (gap < 60) { thr = Math.min(thr, 0.35); acc = "geser"; }
  }
  if ((state.speedNorm || 0) < 0.05 && (gap === undefined || gap === null) && brk > 0) { thr = 0.35; brk = 0.0; }
  return { steer, thr, brk, dec: { he, lat: state.lateral, acc } };
}

function driverControls(pressed) {
  const st = ((pressed.ArrowRight || pressed.KeyD) ? 1 : 0) -
             ((pressed.ArrowLeft || pressed.KeyA) ? 1 : 0);
  const thr = (pressed.ArrowUp || pressed.KeyW) ? 1 : 0;
  const brk = (pressed.ArrowDown || pressed.KeyS) ? 1 : 0;
  return { steer: st, thr, brk };
}

// --------------------------------------------------------------- kamera ----
class Camera {
  constructor() { this.x = 0; this.y = 0; this.zoom = 0.7; }
  apply(x, y) { return [(x - this.x) * this.zoom + W / 2, (y - this.y) * this.zoom + H / 2]; }
  follow(x, y, lerp = 0.12) { this.x += (x - this.x) * lerp; this.y += (y - this.y) * lerp; }
}

// --------------------------------------------------- jam simulasi (TC-1) ----
/* Jam fisika 60Hz yang TAHAN THROTTLE: rAF dimatikan Chromium pas tab/pane
 * gak dirender (occluded) → game keliatan beku. Solusi baku: tick simulasi
 * dikirim Web Worker (timer worker gak kena throttling), rAF cuma render.
 * Kalau Worker gak tersedia (mis. file:// tertentu), fallback ke akumulator
 * rAF seperti semula. */
class SimClock {
  constructor(onTick) {
    this.onTick = onTick;
    this.stopped = false;
    this.acc = 0;
    this.last = performance.now();
    this.rafId = null;
    try {
      const src =
        "let id=null;onmessage=e=>{" +
        "if(e.data==='start'&&!id){id=setInterval(()=>postMessage(1)," + Math.round(1000 / FPS) + ")}" +
        "else if(e.data==='stop'&&id){clearInterval(id);id=null}}";
      this.worker = new Worker(URL.createObjectURL(new Blob([src], { type: "application/javascript" })));
      this.worker.onmessage = () => { if (!this.stopped) this.onTick(); };
      this.worker.postMessage("start");
    } catch (_e) {
      this.worker = null;
    }
    if (!this.worker) {
      const loop = (t) => {
        if (this.stopped) return;
        let dt = (t - this.last) / 1000;
        this.last = t;
        if (dt > 0.1) dt = 0.1;
        this.acc += dt;
        while (this.acc >= 1 / FPS) { this.onTick(); this.acc -= 1 / FPS; }
        this.rafId = requestAnimationFrame(loop);
      };
      this.rafId = requestAnimationFrame(loop);
    }
  }

  stop() {
    this.stopped = true;
    if (this.worker) {
      this.worker.postMessage("stop");
      this.worker.terminate();
    } else if (this.rafId) {
      cancelAnimationFrame(this.rafId);
    }
  }
}

// ---------------------------------------------------------------- game ----
class Game {
  constructor(canvas, settings, onBackToMenu) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.settings = settings;
    this.onBackToMenu = onBackToMenu;
    this.keys = {};
    this.nameCache = [0, ""];

    this.world = new World(LOOP_CITY, 1.35);
    this.comp = largestComponent(this.world);
    const comp = this.comp;
    let start = null, sx = Infinity;
    for (const n of comp) { const [x] = this.world.nodes.get(n); if (x < sx) { sx = x; start = n; } }
    this.start = start;
    const [sx0, sy0] = this.world.nodes.get(start);
    let goal = null, bd = -1;
    for (const n of comp) {
      const [x, y] = this.world.nodes.get(n);
      const d = (x - sx0) ** 2 + (y - sy0) ** 2;
      if (d > bd) { bd = d; goal = n; }
    }
    const route = this.world.route(start, goal);
    this.car = new MapCar(this.world, start, simplify(route.map(n => this.world.nodes.get(n)), 12.0));
    this.signals = new Signals(this.world, comp);
    this._signalsEdgeIds();   // pasangkan segmen -> id node buat deteksi simpang
    const nAi = Math.max(6, Math.min(16, Math.floor(this.world.totalLen / 700)));
    this.traffic = new Traffic(this.world, comp, [sx0, sy0], nAi);
    this.mission = new Mission(this.world, comp, start);
    if (!this.mission.new(start, this.car)) throw new Error("misi awal gak jadi");

    this.cam = new Camera();
    this.cam.x = this.car.x; this.cam.y = this.car.y;
    this.zoom = this.cam.zoom;
    this.auto = settings.mode !== "manual";
    this.manSteer = 0;
    this.crashCd = 0; this.stallFrames = 0; this.offFrames = 0; this.frames = 0;
    this.tickCount = 0; this.needRender = true; this.over = false;

    this._keydown = e => this.onKey(e, true);
    this._keyup = e => { this.keys[e.code] = false; };
    if (typeof window !== "undefined") {
      window.addEventListener("keydown", this._keydown);
      window.addEventListener("keyup", this._keyup);
    }
  }

  _signalsEdgeIds() {
    // simpang nyata: derajat >= 4 di segmen kelas besar (paritas desktop)
    const cand = new Set();
    for (const [ax, ay, bx, by, _wd, kind] of this.world.segs) {
      if (!Signals.MAJOR.has(kind)) continue;
      const pair = this._findEdge(ax, ay, bx, by);
      if (!pair) continue;
      const [a, b] = pair;
      if (this.comp.has(a) && (this.world.adj.get(a)?.size || 0) >= 4) cand.add(a);
      if (this.comp.has(b) && (this.world.adj.get(b)?.size || 0) >= 4) cand.add(b);
    }
    this.signals.nodeList = [...cand].sort((x, y) => x - y);
    this.signals.pos = this.signals.nodeList.map(n => this.world.nodes.get(n));
    this.signals.nodeSet = new Set(this.signals.nodeList);
  }

  _edgeCache() {
    if (this._edges) return this._edges;
    this._edges = [];
    const seen = new Set();
    for (const [a, nbrs] of this.world.adj) {
      for (const b of nbrs) {
        const k = Math.min(a, b) + "|" + Math.max(a, b);
        if (seen.has(k)) continue;
        seen.add(k);
        this._edges.push([a, b]);
      }
    }
    return this._edges;
  }

  _findEdge(ax, ay, bx, by) {
    for (const [a, b] of this._edgeCache()) {
      const [nx1, ny1] = this.world.nodes.get(a), [nx2, ny2] = this.world.nodes.get(b);
      if (((nx1 === ax && ny1 === ay && nx2 === bx && ny2 === by) ||
           (nx1 === bx && ny1 === by && nx2 === ax && ny2 === ay))) return [a, b];
    }
    return null;
  }

  dispose() {
    if (typeof window !== "undefined") {
      window.removeEventListener("keydown", this._keydown);
      window.removeEventListener("keyup", this._keyup);
    }
  }

  onKey(e, down) {
    this.keys[e.code] = down;
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) e.preventDefault();
    if (!down) return;
    if (e.code === "Escape") { this.dispose(); this.onBackToMenu(); return; }
    if (e.code === "KeyF") { this.auto = !this.auto; this.manSteer = 0; }
    if (e.code === "Equal" || e.code === "NumpadAdd") this.zoom = Math.min(1.6, this.zoom * 1.15);
    if (e.code === "Minus" || e.code === "NumpadSubtract") this.zoom = Math.max(0.25, this.zoom / 1.15);
    if (e.code === "KeyR") {
      const near = this.world.nearestNode(this.car.x, this.car.y, this.comp);
      this.mission.new(near, this.car);
    }
  }

  simTick() {
    const car = this.car, mission = this.mission;
    const state = car.sense();
    if (this.auto && state.lateral > 35 && !car.finished) {
      car.x = state.cx; car.y = state.cy; car.speed *= 0.4; mission.recovers++;
    }
    // ACC: mobil AI searah di koridor depan
    const fx = Math.cos(rad(car.heading)), fy = Math.sin(rad(car.heading));
    let gap = null;
    for (const tc of this.traffic.cars) {
      const dx = tc.x - car.x, dy = tc.y - car.y;
      const fwd = dx * fx + dy * fy;
      if (0 < fwd && fwd < 55) {
        const lat = Math.abs(-dx * fy + dy * fx);
        if (lat < 11 && (gap === null || fwd < gap)) {
          const tcFwd = Math.cos(rad(tc.heading)) * fx + Math.sin(rad(tc.heading)) * fy;
          if (tcFwd > 0.25 || tc.speed < 0.1) gap = fwd;
        }
      }
    }
    state.aheadGap = gap;
    const brain = mapBrain(state);
    let { steer, thr, brk } = brain;
    let dec = { ...brain.dec, mode: this.auto ? "ASSISTANT [F]" : "MANUAL [F]" };
    // lampu merah
    let siBest = -1, sdBest = 1e9;
    this.signals.pos.forEach(([lx, ly], j) => {
      const dx = lx - car.x, dy = ly - car.y;
      const fwd = dx * fx + dy * fy;
      if (6 < fwd && fwd < 42) {
        const latt = Math.abs(-dx * fy + dy * fx);
        if (latt < 13 && fwd < sdBest) { sdBest = fwd; siBest = j; }
      }
    });
    if (siBest >= 0) {
      const axis = Math.abs(Math.cos(rad(car.heading))) >= Math.abs(Math.sin(rad(car.heading))) ? 0 : 1;
      if (!this.signals.green(this.signals.nodeList[siBest], axis)) {
        if (this.auto) { thr = 0.0; brk = 1.0; }
        if (sdBest < 9 && car.speed > 1.0) {
          const last = mission.redCd[siBest] ?? -9999;
          if (this.tickCount - last > 240) { mission.reds++; mission.redCd[siBest] = this.tickCount; }
        }
      }
    }
    if (!this.auto) {
      const m = driverControls(this.keys);
      this.manSteer += (m.steer - this.manSteer) * 0.25;
      steer = this.manSteer; thr = m.thr; brk = m.brk;
      dec = { mode: "MANUAL [F]", he: state.headingErr, lat: state.lateral, acc: "kemudi kamu" };
    }
    car.step(steer, thr, brk);
    mission.driven += car.speed;
    // deadlock breaker (assistant only) — ambang 36m biar macet renggang
    // (zona "ikut" ACC 20-35m) juga lolos; desktop pakai 15m
    if (car.speed < 0.15 && this.auto && state.aheadGap !== null && state.aheadGap < 36) this.stallFrames++;
    else this.stallFrames = 0;
    if (this.stallFrames > 240) {
      this.stallFrames = 0;
      let bestJ = -1, bestD = 70;
      this.traffic.cars.forEach((tc, j) => {
        const d = hyp(tc.x - car.x, tc.y - car.y);
        if (d < bestD) { bestJ = j; bestD = d; }
      });
      if (bestJ >= 0) {
        const cand = this.traffic.cars.filter(c2 => hyp(c2.x - car.x, c2.y - car.y) > 400);
        if (cand.length) this.traffic.cars[bestJ] = { ...cand[Math.floor(Math.random() * cand.length)] };
      }
    }
    this.signals.update();
    this.traffic.update(this.signals, [car.x, car.y]);
    if (this.crashCd > 0) this.crashCd--;
    else {
      for (let j = 0; j < this.traffic.cars.length; j++) {
        const tc = this.traffic.cars[j];
        const dx = tc.x - car.x, dy = tc.y - car.y;
        const fwd = dx * fx + dy * fy, lat = Math.abs(-dx * fy + dy * fx);
        if (lat < 4.5 && -6 < fwd && fwd < 9) {
          mission.crashes++; car.speed *= 0.3;
          const cand = this.traffic.cars.filter(c2 => hyp(c2.x - car.x, c2.y - car.y) > 400);
          if (cand.length) this.traffic.cars[j] = { ...cand[Math.floor(Math.random() * cand.length)] };
          this.crashCd = 45;
          break;
        }
      }
    }
    this.cam.follow(car.x, car.y);
    this.cam.zoom = this.zoom;
    this._dec = dec;
    if (state.lateral > state.halfw + 4) this.offFrames++;
    this.frames++;
    // misi selesai
    if (car.finished) {
      const pts = mission.complete();
      console.log(`misi #${mission.n} selesai +${pts} (skor ${mission.score}) merah ${mission.reds} tabrak ${mission.crashes}`);
      const near = this.world.nearestNode(car.x, car.y, this.comp);
      if (!this.mission.new(near, car)) { this.over = true; this.dispose(); this.onBackToMenu(); return; }
      this.purgeNear();
    }
    this.tickCount++;
    if (this.tickCount % RENDER_EVERY === 0) this.needRender = true;
  }

  purgeNear(radius = 130.0) {
    const car = this.car;
    for (let j = 0; j < this.traffic.cars.length; j++) {
      const tc = this.traffic.cars[j];
      if (hyp(tc.x - car.x, tc.y - car.y) < radius) {
        const cand = this.traffic.cars.filter(c2 => hyp(c2.x - car.x, c2.y - car.y) > radius + 150);
        if (cand.length) this.traffic.cars[j] = { ...cand[Math.floor(Math.random() * cand.length)] };
      }
    }
  }

  // ------------------------------------------------------------- render ----
  render() {
    const ctx = this.ctx, cam = this.cam, car = this.car, z = cam.zoom;
    ctx.fillStyle = COL_BG;
    ctx.fillRect(0, 0, W, H);
    // area hijau/air
    for (const a of this.world.areas) {
      ctx.fillStyle = a.k === "water" ? COL_WATER : COL_GREEN;
      this._poly(ctx, a.pts, cam);
      ctx.fill();
    }
    // bangunan
    for (const pts of this.world.buildings) {
      ctx.fillStyle = COL_BLDG;
      this._poly(ctx, pts, cam);
      ctx.fill();
      ctx.strokeStyle = COL_BLDG_EDGE;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    // jalan: casing dulu, lalu permukaan
    const visible = g => {
      const [sx, sy] = cam.apply(g[0], g[1]);
      return sx > -60 && sx < W + 60 && sy > -60 && sy < H + 60;
    };
    for (const pass of [0, 1]) {
      for (const [ax, ay, bx, by, wd, _kind] of this.world.segs) {
        const [x1, y1] = cam.apply(ax, ay), [x2, y2] = cam.apply(bx, by);
        if (x1 < -60 && x2 < -60 || x1 > W + 60 && x2 > W + 60 ||
            y1 < -60 && y2 < -60 || y1 > H + 60 && y2 > H + 60) continue;
        const hw = wd * z;
        ctx.lineCap = "round";
        if (pass === 0) {
          ctx.strokeStyle = COL_CASING;
          ctx.lineWidth = Math.max(2, hw * 2 + 2);
        } else {
          ctx.strokeStyle = wd >= 7.5 ? COL_ROAD_MAJOR : COL_ROAD;
          ctx.lineWidth = Math.max(1, hw * 2);
        }
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      }
    }
    // rute
    if (car.route.length > 1) {
      const step = Math.max(1, Math.floor(car.route.length / 400));
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      for (const [w, col] of [[6, COL_ROUTE_CASE], [3, COL_ROUTE]]) {
        ctx.strokeStyle = col; ctx.lineWidth = w;
        ctx.beginPath();
        car.route.forEach((p, i) => {
          if (i % step) return;
          const [sx, sy] = cam.apply(p[0], p[1]);
          i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
        });
        ctx.stroke();
      }
    }
    // waypoint aktif
    {
      const [wx, wy] = cam.apply(car.route[Math.min(car.wpI + 1, car.route.length - 1)]);
      ctx.fillStyle = "rgb(240,200,80)";
      ctx.beginPath(); ctx.arc(wx, wy, 5, 0, 7); ctx.fill();
    }
    // lampu (dekat mobil saja)
    const phase = Math.floor(this.signals.frame / Signals.CYCLE) % 2;
    for (const [wx2, wy2] of this.signals.pos) {
      if ((wx2 - car.x) ** 2 + (wy2 - car.y) ** 2 > Signals.DRAW_RADIUS ** 2) continue;
      const [nx, ny] = cam.apply(wx2, wy2);
      if (nx < -20 || nx > W + 20 || ny < -20 || ny > H + 20) continue;
      ctx.fillStyle = phase === 0 ? "#e65050" : "#5adc6e";
      ctx.beginPath(); ctx.arc(nx, ny, 3, 0, 7); ctx.fill();
      ctx.fillStyle = phase === 0 ? "#5adc6e" : "#e65050";
      ctx.beginPath(); ctx.arc(nx + 5, ny, 3, 0, 7); ctx.fill();
    }
    // mobil AI
    for (const c of this.traffic.cars) {
      const [sx, sy] = cam.apply(c.x, c.y);
      if (sx < -40 || sx > W + 40 || sy < -40 || sy > H + 40) continue;
      this._car(ctx, sx, sy, c.heading, z, "#eba54b");
    }
    // target misi (denyut)
    if (this.mission.goal !== null && this.mission.goal !== undefined) {
      const [gx, gy] = cam.apply(...this.world.nodes.get(this.mission.goal));
      const t = performance.now() / 1000;
      const r = 8 + 3 * Math.sin(t * 4);
      ctx.strokeStyle = "#ff78c8"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(gx, gy, r, 0, 7); ctx.stroke();
      ctx.fillStyle = "#ff78c8";
      ctx.beginPath(); ctx.arc(gx, gy, 2, 0, 7); ctx.fill();
    }
    // mobil hero
    {
      const [cx, cy] = cam.apply(car.x, car.y);
      this._car(ctx, cx, cy, car.heading, z, this.car.finished ? "#5aa0ff" : "#50dc78");
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, cy, Math.max(10, 17 * z), 0, 7); ctx.stroke();
    }
    // nama jalan (cache 15 render)
    const name = this.streetName();
    // HUD
    const dec = this._dec || { mode: "", he: 0, lat: 0, acc: "" };
    const gdist = this.mission.goal !== null && this.mission.goal !== undefined
      ? hyp(car.x - this.world.nodes.get(this.mission.goal)[0], car.y - this.world.nodes.get(this.mission.goal)[1]) : 0;
    const lines = [
      `Gee-FunDriving | ${this.world.name} | ${dec.mode || ""}`,
      `speed ${car.speed.toFixed(1)}  alive ${Math.floor(car.aliveTime / FPS)}s  wp ${car.wpI}/${car.route.length}`,
      (`he ${dec.he.toFixed(0)}  lat ${dec.lat.toFixed(0)}m  ${dec.acc}  ${name}`).replace(/  +/g, " "),
      `misi #${this.mission.n + 1} -> ${gdist.toFixed(0)}m | skor ${this.mission.score} | merah ${this.mission.reds} tabrak ${this.mission.crashes}`,
      `${this.fps.toFixed(0)} fps`,
    ];
    this._hud(ctx, lines);
  }

  streetName() {
    const [age, prev] = this.nameCache;
    let name = prev;
    if (age === 0) {
      let best = "", bd = 60.0;
      for (const [ax, ay, bx, by, nm] of this.world.namedSegs) {
        const abx = bx - ax, aby = by - ay;
        const apx = this.car.x - ax, apy = this.car.y - ay;
        const ab2 = abx * abx + aby * aby + 1e-6;
        const t = clamp((apx * abx + apy * aby) / ab2, 0, 1);
        const d = hyp(this.car.x - (ax + abx * t), this.car.y - (ay + aby * t));
        if (d < bd) { best = nm; bd = d; }
      }
      if (best) name = best;
    }
    this.nameCache[0] = (age + 1) % 15;
    return name;
  }

  _car(ctx, sx, sy, headingDeg, z, color) {
    const a = rad(headingDeg);
    const pts = [[CAR_LEN / 2, 0], [-CAR_LEN / 2, CAR_W / 2], [-CAR_LEN / 2, -CAR_W / 2]];
    ctx.fillStyle = color;
    ctx.beginPath();
    pts.forEach(([dx, dy], i) => {
      const x = sx + dx * Math.cos(a) * z - dy * Math.sin(a) * z;
      const y = sy + dx * Math.sin(a) * z + dy * Math.cos(a) * z;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.closePath(); ctx.fill();
  }

  _poly(ctx, pts, cam) {
    ctx.beginPath();
    pts.forEach((p, i) => {
      const [sx, sy] = cam.apply(p[0], p[1]);
      i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
    });
    ctx.closePath();
  }

  _hud(ctx, lines) {
    ctx.font = "13px 'DejaVu Sans Mono', Consolas, monospace";
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(6, 4, 620, lines.length * 18 + 8);
    ctx.fillStyle = "#dcdcdc";
    lines.forEach((ln, i) => ctx.fillText(ln, 10, 20 + i * 18));
  }
}

// ------------------------------------------------- menu / settings / about --
const DEFAULT_SETTINGS = { mode: "assistant", fps: 30 };

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem("gfd-settings") || "{}");
    return {
      mode: s.mode === "manual" ? "manual" : "assistant",
      fps: s.fps === 60 ? 60 : 30,
    };
  } catch (_e) { return { ...DEFAULT_SETTINGS }; }
}

function saveSettings(st) {
  try { localStorage.setItem("gfd-settings", JSON.stringify(st)); } catch (_e) { /* ignore */ }
}

class MenuApp {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.settings = loadSettings();
    setRenderFps(this.settings.fps);
    this.state = "menu";        // menu | settings | about | bye
    this.sel = 0;
    this.selSettings = 0;
    this.logo = null;
    this.itemsRects = [];
    this._logo = null;
    const img = new Image();
    img.onload = () => { this.logo = img; if (this.state === "menu") this.needRender = true; };
    img.src = "../assets/logo-both.png";

    this._keydown = e => this.onKey(e);
    window.addEventListener("keydown", this._keydown);
    this._click = e => this.onClick(e);
    canvas.addEventListener("click", this._click);
    this.needRender = true;
    this.clock = null;
    this._raf = t => this.frame(t);
    requestAnimationFrame(this._raf);
  }

  onKey(e) {
    if (["ArrowUp", "ArrowDown", "Space"].includes(e.code)) e.preventDefault();
    if (!e.repeat || true) { /* biarkan repeat buat navigasi */ }
    const k = e.code;
    if (this.state === "menu") {
      if (k === "Escape") this.state = "bye";
      else if (k === "ArrowUp" || k === "KeyW") this.sel = (this.sel + 3) % 4;
      else if (k === "ArrowDown" || k === "KeyS") this.sel = (this.sel + 1) % 4;
      else if (k === "Enter" || k === "NumpadEnter" || k === "Space") this.activate(this.sel);
      this.needRender = true;
    } else if (this.state === "settings") {
      const rows = 3;
      if (k === "Escape") this.state = "menu";
      else if (k === "ArrowUp" || k === "KeyW") this.selSettings = (this.selSettings + rows) % (rows + 1);
      else if (k === "ArrowDown" || k === "KeyS") this.selSettings = (this.selSettings + 1) % (rows + 1);
      else if (k === "ArrowLeft" || k === "ArrowRight" || k === "Enter" || k === "NumpadEnter" || k === "Space") {
        this.cycleSetting(this.selSettings, k === "ArrowLeft" ? -1 : 1);
      }
      this.needRender = true;
    } else if (this.state === "about") {
      if (k === "Escape" || k === "Enter" || k === "Space") this.state = "menu";
      this.needRender = true;
    } else if (this.state === "bye") {
      if (k === "Enter" || k === "Space") { this.state = "menu"; }
      this.needRender = true;
    }
  }

  onClick(e) {
    const r = this.canvas.getBoundingClientRect();
    const mx = (e.clientX - r.left) * (W / r.width);
    const my = (e.clientY - r.top) * (H / r.height);
    for (const [x, y, w2, h2, act] of this.itemsRects) {
      if (mx >= x && mx <= x + w2 && my >= y && my <= y + h2) {
        if (this.state === "menu") this.activate(act);
        else if (this.state === "settings") {
          if (act === "back") this.state = "menu";
          else this.cycleSetting(act, 1);
        }
        this.needRender = true;
        return;
      }
    }
    if (this.state === "about" || this.state === "bye") { this.state = "menu"; this.needRender = true; }
  }

  activate(sel) {
    const act = ["start", "settings", "about", "exit"][sel];
    if (act === "exit") this.state = "bye";
    else if (act === "settings") { this.state = "settings"; this.selSettings = 0; }
    else if (act === "about") this.state = "about";
    else if (act === "start") this.startGame();
  }

  cycleSetting(row, dir) {
    if (row === 0) this.settings.mode = this.settings.mode === "assistant" ? "manual" : "assistant";
    else if (row === 1) this.settings.fps = this.settings.fps === 30 ? 60 : 30;
    else return;
    setRenderFps(this.settings.fps);
    saveSettings(this.settings);
  }

  startGame() {
    this.state = "game";
    this.game = new Game(this.canvas, this.settings, () => {
      if (this.clock) { this.clock.stop(); this.clock = null; }
      this.game = null;
      this.state = "menu";
      this.needRender = true;
    });
    // TC-1: jam simulasi dari worker — tetap 60Hz walau tab gak dirender
    this.clock = new SimClock(() => {
      if (this.state !== "game" || !this.game) return;
      this.game.simTick();
      if (this.game.needRender) {
        this.game.needRender = false;
        this.game.fps = this.fpsVal(performance.now());
        this.game.render();
      }
    });
  }

  frame(t) {
    if (this.state !== "game" && this.needRender) {
      this.needRender = false;
      this.renderMenu();
    }
    requestAnimationFrame(this._raf);
  }

  fpsVal(t) {
    if (!this._fpsT) { this._fpsT = t; this._fpsN = 0; this._fpsV = 0; }
    this._fpsN++;
    if (t - this._fpsT >= 500) {
      this._fpsV = this._fpsN * 1000 / (t - this._fpsT);
      this._fpsT = t; this._fpsN = 0;
    }
    return this._fpsV;
  }

  renderMenu() {
    const ctx = this.ctx;
    ctx.fillStyle = "#181a20";
    ctx.fillRect(0, 0, W, H);
    this.itemsRects = [];
    if (this.state === "menu") {
      let top = 22;
      if (this.logo) {
        const lw = 400, lh = this.logo.height * (400 / this.logo.width);
        ctx.drawImage(this.logo, W / 2 - lw / 2, top, lw, lh);
        top += lh + 14;
      } else {
        ctx.font = "bold 46px 'DejaVu Sans', sans-serif";
        ctx.fillStyle = "#f0f0f0";
        ctx.textAlign = "center";
        ctx.fillText("Gee-FunDriving", W / 2, top + 46);
        ctx.textAlign = "left";
        top += 62;
      }
      const modeLbl = this.settings.mode === "assistant" ? "ASSISTANT" : "KENDALI SENDIRI";
      const items = [
        `START  —  ${modeLbl} · Loop City`,
        "SETTINGS",
        "ABOUT",
        "EXIT",
      ];
      let y = top + 12;
      ctx.font = "18px 'DejaVu Sans Mono', Consolas, monospace";
      items.forEach((label, i) => {
        const on = i === this.sel;
        if (on) {
          ctx.fillStyle = "#222a32";
          this._rr(ctx, W / 2 - 340, y - 5, 680, 28, 6);
          ctx.fill();
        }
        ctx.fillStyle = on ? "#78dc8c" : "#969baa";
        const txt = (on ? "> " : "   ") + label;
        ctx.fillText(txt, W / 2 - 330, y + 14);
        this.itemsRects.push([W / 2 - 340, y - 5, 680, 28, i]);
        y += 32;
      });
      ctx.font = "14px 'DejaVu Sans Mono', Consolas, monospace";
      ctx.fillStyle = "#787d8c";
      ctx.textAlign = "center";
      ctx.fillText("W/S atau panah / klik: pilih    ENTER: pilih    ESC: keluar", W / 2, H - 22);
      ctx.textAlign = "left";
    } else if (this.state === "settings") {
      ctx.font = "bold 40px 'DejaVu Sans', sans-serif";
      ctx.fillStyle = "#f0f0f0";
      ctx.textAlign = "center";
      ctx.fillText("SETTINGS", W / 2, 92);
      ctx.textAlign = "left";
      ctx.font = "18px 'DejaVu Sans Mono', Consolas, monospace";
      const rows = [
        ["MODE", this.settings.mode === "assistant" ? "ASSISTANT" : "KENDALI SENDIRI"],
        ["RENDER FPS", String(this.settings.fps)],
      ];
      let y = 150;
      rows.forEach(([label, val], i) => {
        const on = i === this.selSettings;
        if (on) {
          ctx.fillStyle = "#222a32";
          this._rr(ctx, W / 2 - 300, y - 5, 600, 30, 6);
          ctx.fill();
        }
        ctx.fillStyle = on ? "#78dc8c" : "#969baa";
        ctx.fillText((on ? "> " : "   ") + label, W / 2 - 290, y + 15);
        ctx.fillText(on ? `< ${val} >` : val, W / 2 + 40, y + 15);
        this.itemsRects.push([W / 2 - 300, y - 5, 600, 30, i]);
        y += 36;
      });
      const onBack = this.selSettings === rows.length;
      if (onBack) {
        ctx.fillStyle = "#222a32";
        this._rr(ctx, W / 2 - 120, y - 5, 240, 30, 6);
        ctx.fill();
      }
      ctx.fillStyle = onBack ? "#78dc8c" : "#969baa";
      ctx.fillText((onBack ? "> " : "   ") + "KEMBALI", W / 2 - 110, y + 15);
      this.itemsRects.push([W / 2 - 120, y - 5, 240, 30, "back"]);
      ctx.font = "14px 'DejaVu Sans Mono', Consolas, monospace";
      ctx.fillStyle = "#787d8c";
      ctx.textAlign = "center";
      ctx.fillText("←→/ENTER ganti nilai    ↑↓ pilih    ESC kembali", W / 2, H - 22);
      ctx.textAlign = "left";
    } else if (this.state === "about") {
      ctx.font = "bold 40px 'DejaVu Sans', sans-serif";
      ctx.fillStyle = "#f0f0f0";
      ctx.fillText("ABOUT", 120, 80);
      ctx.font = "16px 'DejaVu Sans Mono', Consolas, monospace";
      ctx.fillStyle = "#c8cdd7";
      const lines = [
        "Sim nyetir 2D top-down: 1 mobil autonomous dengan",
        "System-One decision loop — tiap tick dia memutuskan",
        "(typed), bukan ngobrol bahasa natural.",
        "",
        "Terinspirasi demo \"rebuilt Tesla FSD with Jev\" (TypeSafe AI).",
        "Versi web ini: Loop City, fisika 60Hz, render 30/60fps.",
        "",
        "KONTROL",
        "  F          assistant ON/OFF (ambil alih / serah kemudi)",
        "  WASD/panah gas, rem, belok (pas kendali sendiri)",
        "  R misi baru   [-][=] zoom   ESC balik ke menu",
        "",
        "Python + pygame versi asli · port JavaScript + Canvas",
      ];
      lines.forEach((ln, i) => {
        ctx.fillStyle = ln === "KONTROL" ? "#78dc8c" : "#c8cdd7";
        ctx.fillText(ln, 120, 130 + i * 24);
      });
      ctx.fillStyle = "#787d8c";
      ctx.textAlign = "center";
      ctx.fillText("ESC kembali", W / 2, H - 22);
      ctx.textAlign = "left";
    } else if (this.state === "bye") {
      ctx.textAlign = "center";
      ctx.font = "bold 34px 'DejaVu Sans', sans-serif";
      ctx.fillStyle = "#f0f0f0";
      ctx.fillText("Terima kasih udah main!", W / 2, H / 2 - 10);
      ctx.font = "16px 'DejaVu Sans Mono', Consolas, monospace";
      ctx.fillStyle = "#969baa";
      ctx.fillText("(tutup tab, atau ENTER buat balik ke menu)", W / 2, H / 2 + 24);
      ctx.textAlign = "left";
    }
  }

  _rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}

function setRenderFps(n) {
  RENDER_FPS = n === 60 ? 60 : 30;
  RENDER_EVERY = Math.max(1, Math.floor(FPS / RENDER_FPS));
}

// ---------------------------------------------------------------- boot ----
if (typeof document !== "undefined" && typeof window !== "undefined") {
  window.addEventListener("DOMContentLoaded", () => {
    window._menuApp = new MenuApp(document.getElementById("game"));
  });
}
