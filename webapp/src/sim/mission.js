// Misi antar: tujuan acak 500-2600m, skor = (terpendek/tempuh)*1000
// - 40/lampu merah - 25/tabrakan. Port setia dari Mission di fundriving.py.

import { simplify } from "./world.js";

const shuffled = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

export class Mission {
  constructor(world, comp, fromNode) {
    this.world = world;
    this.comp = comp;
    this.n = 0;
    this.score = 0;
    this.reds = 0;
    this.crashes = 0;
    this.recovers = 0;
    this.redCd = new Map();
    this.goal = null;
    this.routeLen = 0.0;
    this.driven = 0.0;
    this.done = false;
    this.fromNode = fromNode;
  }

  routeLenOf(pts) {
    let s = 0;
    for (let i = 0; i < pts.length - 1; i++)
      s += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    return s;
  }

  new(fromNode, car) {
    const w = this.world;
    const [fx, fy] = w.nodes.get(fromNode);
    const pool = shuffled([...this.comp].sort((a, b) => a - b)).slice(0, Math.min(500, this.comp.size));
    const cands = shuffled(pool.filter((n) => {
      const [nx, ny] = w.nodes.get(n);
      return 500 < Math.hypot(nx - fx, ny - fy) && Math.hypot(nx - fx, ny - fy) < 2600;
    }));
    for (const goal of cands.slice(0, 12)) {
      const r = w.route(fromNode, goal);
      if (r.length >= 4) {
        const pts = simplify(r.map((n) => w.nodes.get(n)), w.meta.simplifyEps ?? 12.0);
        if (pts.length >= 3) {
          this._set(goal, pts, car);
          return true;
        }
      }
    }
    return false;
  }

  newFixed(fromNode, goalNode, car) {
    const r = this.world.route(fromNode, goalNode);
    if (r.length < 2) return false;
    const pts = simplify(r.map((n) => this.world.nodes.get(n)), this.world.meta.simplifyEps ?? 12.0);
    this._set(goalNode, pts, car);
    return true;
  }

  _set(goal, pts, car) {
    this.goal = goal;
    this.routeLen = this.routeLenOf(pts);
    this.driven = 0.0;
    this.reds = 0;
    this.crashes = 0;
    this.recovers = 0;
    this.done = false;
    this.redCd = new Map();
    car.route = pts;
    car.wpI = 0;
    car.finished = false;
    car.initHeading();
  }

  complete(car) {
    const base = Math.round(this.routeLen / Math.max(this.driven, 1.0) * 1000);
    const pts = Math.max(50, base - 40 * this.reds - 25 * this.crashes);
    this.score += pts;
    this.n += 1;
    this.done = true;
    return pts;
  }
}
