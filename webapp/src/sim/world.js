// Dunia dari OSM / loop city: graf jalan + bangunan + area + A* buat rute.
// Port setia dari OSMWorld di fundriving.py — satuan meter lokal, y ke selatan.

export const CELL = 500; // ukuran sel spatial grid biar render/cari gak terjerat peta raksasa

const key2 = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);

export class World {
  constructor(data, widthScale = 1.35) {
    this.meta = data.meta;
    this.widthScale = widthScale;
    this.nodes = new Map();
    for (const [k, v] of Object.entries(data.nodes)) this.nodes.set(Number(k), v);
    this.adj = new Map();
    this.halfw = new Map();
    this.wayName = new Map();
    for (const r of data.roads) {
      this.wayName.set(r.id, r.name || "");
      const wd = (r.width || 10) / 2 * widthScale;
      const pts = r.points;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        if (!this.adj.has(a)) this.adj.set(a, new Set());
        if (!this.adj.has(b)) this.adj.set(b, new Set());
        this.adj.get(a).add(b);
        this.adj.get(b).add(a);
        this._wmin(a, b, wd);
      }
    }
    let minx = 1e18, miny = 1e18, maxx = -1e18, maxy = -1e18;
    for (const [x, y] of this.nodes.values()) {
      if (x < minx) minx = x;
      if (y < miny) miny = y;
      if (x > maxx) maxx = x;
      if (y > maxy) maxy = y;
    }
    this.minx = minx; this.maxx = maxx; this.miny = miny; this.maxy = maxy;
    this._buildSegments(data);
    this._buildPolys(data);
    this._buildNamedSegs(data);
    this._buildGrids();
  }

  _wmin(a, b, wd) {
    const k = key2(a, b);
    if (!this.halfw.has(k) || wd < this.halfw.get(k)) this.halfw.set(k, wd);
  }

  segHalfw(a, b) {
    return this.halfw.get(key2(a, b)) ?? 5.0;
  }

  // lebar (halfwidth) segmen jalan terdekat dari posisi — dipakai lajur
  // dinamis & ambang off-road. PENTING: segHalfw(a,b) butuh node id;
  // rute mobil berisi koordinat, jadi lebar diambil dari segmen terdekat.
  nearestSegW(x, y) {
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    let best = 1e9, bwd = 7.5;
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const cell = this.segGrid.get(`${gx},${gy}`);
        if (!cell) continue;
        for (const i of cell) {
          const s = this.segs[i];
          const abx = s.bx - s.ax, aby = s.by - s.ay;
          const tt = Math.max(0, Math.min(1, ((x - s.ax) * abx + (y - s.ay) * aby)
            / (abx * abx + aby * aby + 1e-6)));
          const d = Math.hypot(x - s.ax - abx * tt, y - s.ay - aby * tt);
          if (d < best) { best = d; bwd = s.wd; }
        }
      }
    }
    return bwd;
  }

  _buildSegments(data) {
    // segmen unik per pasangan node: {ax,ay,bx,by,wd,kind,a,b} — dipakai
    // render, dist-to-road, dan lampu lalu lintas
    this.segs = [];
    const seen = new Set();
    for (const r of data.roads) {
      const pts = r.points;
      const wd = (r.width || 10) / 2 * this.widthScale;
      const kind = r.kind || "residential";
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const k = key2(a, b);
        if (seen.has(k)) continue;
        seen.add(k);
        const [ax, ay] = this.nodes.get(a);
        const [bx, by] = this.nodes.get(b);
        this.segs.push({ ax, ay, bx, by, wd, kind, a, b });
      }
    }
  }

  _buildPolys(data) {
    const bbox = (pts) => {
      let minx = 1e18, miny = 1e18, maxx = -1e18, maxy = -1e18;
      for (const [x, y] of pts) {
        if (x < minx) minx = x;
        if (y < miny) miny = y;
        if (x > maxx) maxx = x;
        if (y > maxy) maxy = y;
      }
      return [minx, miny, maxx, maxy];
    };
    this.buildings = [];
    for (const pts of data.buildings || []) {
      if (pts.length >= 3) this.buildings.push({ bbox: bbox(pts), pts });
    }
    this.areas = [];
    for (const a of data.areas || []) {
      const pts = a.pts || [];
      if (pts.length >= 3) this.areas.push({ bbox: bbox(pts), pts, kind: a.k || "green" });
    }
  }

  _buildNamedSegs(data) {
    this.namedSegs = [];
    const seen = new Set();
    for (const r of data.roads) {
      const nm = r.name || "";
      if (!nm) continue;
      const pts = r.points;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const k = key2(a, b);
        if (seen.has(k)) continue;
        seen.add(k);
        const [ax, ay] = this.nodes.get(a);
        const [bx, by] = this.nodes.get(b);
        this.namedSegs.push({ ax, ay, bx, by, name: nm });
      }
    }
  }

  _buildGrids() {
    const cellsOf = (x0, y0, x1, y1) => {
      const out = [];
      for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++)
        for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++)
          out.push([cx, cy]);
      return out;
    };
    this.segGrid = new Map();
    this.segs.forEach((s, i) => {
      for (const [cx, cy] of cellsOf(Math.min(s.ax, s.bx), Math.min(s.ay, s.by),
                                    Math.max(s.ax, s.bx), Math.max(s.ay, s.by))) {
        const k = `${cx},${cy}`;
        if (!this.segGrid.has(k)) this.segGrid.set(k, []);
        this.segGrid.get(k).push(i);
      }
    });
    const gridPolys = (arr, getBbox) => {
      const g = new Map();
      arr.forEach((it, i) => {
        const [x0, y0, x1, y1] = getBbox(it);
        for (const [cx, cy] of cellsOf(x0, y0, x1, y1)) {
          const k = `${cx},${cy}`;
          if (!g.has(k)) g.set(k, []);
          g.get(k).push(i);
        }
      });
      return g;
    };
    this.bldgGrid = gridPolys(this.buildings, (b) => b.bbox);
    this.areaGrid = gridPolys(this.areas, (a) => a.bbox);
  }

  nearestNode(x, y, subset = null) {
    let best = null, bd = 1e18;
    for (const nid of subset ?? this.nodes.keys()) {
      const [nx, ny] = this.nodes.get(nid);
      const d = (nx - x) ** 2 + (ny - y) ** 2;
      if (d < bd) { best = nid; bd = d; }
    }
    return best;
  }

  // Dijkstra (sama dgn Python, heapq -> binary heap kecil)
  route(start, goal) {
    const dist = new Map([[start, 0]]);
    const prev = new Map();
    const heap = new MinHeap();
    heap.push(0, start);
    while (heap.size) {
      const [d0, u] = heap.pop();
      if (u === goal) break;
      if (d0 > (dist.get(u) ?? 1e18)) continue;
      const [ux, uy] = this.nodes.get(u);
      for (const v of this.adj.get(u) ?? []) {
        const [vx, vy] = this.nodes.get(v);
        const nd = d0 + Math.hypot(vx - ux, vy - uy);
        if (nd < (dist.get(v) ?? 1e18)) {
          dist.set(v, nd);
          prev.set(v, u);
          heap.push(nd, v);
        }
      }
    }
    if (!dist.has(goal)) return [];
    const path = [goal];
    while (path[path.length - 1] !== start) path.push(prev.get(path[path.length - 1]));
    return path.reverse();
  }
}

class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(d, n) {
    const a = this.a;
    a.push([d, n]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

// Panjang kumulatif poliline (dipakai rute mobil, planner, dan profil kurva)
export function routeArc(route) {
  const cum = [0.0];
  for (let i = 0; i < route.length - 1; i++) {
    const [ax, ay] = route[i], [bx, by] = route[i + 1];
    cum.push(cum[cum.length - 1] + Math.hypot(bx - ax, by - ay));
  }
  return cum;
}

// Profil kecepatan tikungan skala 1:1 (ala routeSpeedLimit jevpilot):
// tajam (>55°) 3.5 m/s, sedang (>25°) 6.5 m/s — dilepas dengan jarak
// pengereman comfort 3 m/s² sebelum tikungan.
export function routeCaps(route, cum) {
  const caps = [];
  for (let k = 1; k < route.length - 1; k++) {
    const a = route[k - 1], b = route[k], c = route[k + 1];
    const d1x = b[0] - a[0], d1y = b[1] - a[1];
    const d2x = c[0] - b[0], d2y = c[1] - b[1];
    const ang = Math.abs(Math.atan2(d1x * d2y - d1y * d2x,
      d1x * d2x + d1y * d2y) * 180 / Math.PI);
    if (ang > 25) caps.push({ s: cum[k], vc: ang > 55 ? 3.5 : 6.5 });
  }
  return caps;
}

export function capAtV(caps, s) {
  let v = Infinity;
  for (const c of caps || []) {
    const d = c.s - s;
    if (d < -6) continue;   // udah lewat — lepas
    v = Math.min(v, d > 0 ? Math.sqrt(c.vc * c.vc + 2 * 3 * Math.max(0, d - 3)) : c.vc);
  }
  return v;
}

export function largestComponent(world) {  let best = new Set();
  const seen = new Set();
  for (const n0 of world.adj.keys()) {
    if (seen.has(n0)) continue;
    const comp = new Set([n0]);
    const stack = [n0];
    while (stack.length) {
      const u = stack.pop();
      for (const v of world.adj.get(u) ?? []) {
        if (!comp.has(v)) { comp.add(v); stack.push(v); }
      }
    }
    for (const c of comp) seen.add(c);
    if (comp.size > best.size) best = comp;
  }
  return best;
}

// Douglas-Peucker: raut poliline rute — bunuh zigzag antar lajur ganda &
// node yang kepadatan, sisakan bentuk jalan.
export function simplify(points, eps = 12.0) {
  if (points.length < 3) return [...points];
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    if (i1 <= i0 + 1) continue;
    const [ax, ay] = points[i0];
    const [bx, by] = points[i1];
    const dx = bx - ax, dy = by - ay;
    const n = Math.hypot(dx, dy) + 1e-9;
    let bestD = -1, bi = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const [px, py] = points[i];
      const d = Math.abs((px - ax) * dy - (py - ay) * dx) / n;
      if (d > bestD) { bestD = d; bi = i; }
    }
    if (bestD > eps) {
      keep[bi] = true;
      stack.push([i0, bi], [bi, i1]);
    }
  }
  return points.filter((_, i) => keep[i]);
}
