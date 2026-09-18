// Mobil AI: jalan random-walk di graf, lane kanan, hormati lampu merah.
// Port setia dari Traffic di fundriving.py.

export class Traffic {
  constructor(world, comp, avoidXy, n = 16) {
    this.world = world;
    this.cars = [];
    this.comp = [...comp];
    const segs = [...world.halfw.keys()];
    // shuffle ala Fisher-Yates (pengganti random.shuffle)
    for (let i = segs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [segs[i], segs[j]] = [segs[j], segs[i]];
    }
    for (const k of segs) {
      if (this.cars.length >= n) break;
      const [a, b] = k.split(":").map(Number);
      if (!comp.has(a) || !comp.has(b)) continue;
      const [ax, ay] = world.nodes.get(a);
      if (Math.hypot(ax - avoidXy[0], ay - avoidXy[1]) < 180) continue;
      this.cars.push(this._mk(a, b));
    }
  }

  _mk(a, b) {
    const w = this.world;
    const [ax, ay] = w.nodes.get(a);
    const [bx, by] = w.nodes.get(b);
    const L = Math.max(Math.hypot(bx - ax, by - ay), 1.0);
    const t = 0.05 + Math.random() * 0.9;
    const ang = Math.atan2(by - ay, bx - ax);
    return {
      a, b, t, L,
      x: ax + (bx - ax) * t,
      y: ay + (by - ay) * t,
      heading: (ang * 180) / Math.PI,
      base: 6 + Math.random() * 4,   // m/s, skala 1:1
      speed: 0.0,
    };
  }

  _nextEdge(c) {
    const w = this.world;
    const b = c.b;
    let nbrs = [...(w.adj.get(b) ?? [])];
    if (nbrs.length > 1) {
      const fwd = nbrs.filter((v) => v !== c.a);
      if (fwd.length) nbrs = fwd;
    }
    const nb = nbrs[Math.floor(Math.random() * nbrs.length)];
    const nc = this._mk(b, nb);
    nc.base = c.base;
    return nc;
  }

  update(signals, hero = null, dt = 1 / 60) {
    const w = this.world;
    // indeks leader per segmen terarah
    const onEdge = new Map();
    this.cars.forEach((c, i) => {
      const k = `${c.a}:${c.b}`;
      if (!onEdge.has(k)) onEdge.set(k, []);
      onEdge.get(k).push([c.t, i]);
    });
    for (const lst of onEdge.values()) lst.sort((p, q) => p[0] - q[0]);
    this.cars.forEach((c, i) => {
      let tgt = c.base;
      // deteksi HERO sebagai rintangan di depan (searah & dekat)
      if (hero) {
        const hx = Math.cos((c.heading * Math.PI) / 180), hy = Math.sin((c.heading * Math.PI) / 180);
        const dxh = hero[0] - c.x, dyh = hero[1] - c.y;
        const fwdh = dxh * hx + dyh * hy;
        if (0 < fwdh && fwdh < 26 && Math.abs(-dxh * hy + dyh * hx) < 3) tgt = 0.0;
      }
      for (const [tOther, j] of onEdge.get(`${c.a}:${c.b}`) ?? []) {
        if (j !== i && tOther > c.t) {
          const gap = (tOther - c.t) * c.L;
          if (gap < 14) { tgt = 0.0; break; }
        }
      }
      // lampu merah di node tujuan
      if (signals.nodes.has(c.b)) {
        const distNode = (1.0 - c.t) * c.L;
        const [ax, ay] = w.nodes.get(c.a);
        const [bx, by] = w.nodes.get(c.b);
        const axis = signals.axisOf(ax, ay, bx, by);
        if (6 < distNode && distNode < 30 && !signals.green(c.b, axis)) tgt = 0.0;
      }
      c.speed = tgt;
      c.t += c.speed * dt / c.L;
      if (c.t >= 1.0) {
        const nc = this._nextEdge(c);
        c.a = nc.a; c.b = nc.b; c.t = 0.0; c.L = nc.L;
        const [ax2, ay2] = w.nodes.get(c.a);
        const [bx2, by2] = w.nodes.get(c.b);
        c.heading = (Math.atan2(by2 - ay2, bx2 - ax2) * 180) / Math.PI;
      }
      const [ax, ay] = w.nodes.get(c.a);
      const [bx, by] = w.nodes.get(c.b);
      const t = c.t;
      const px = ax + (bx - ax) * t, py = ay + (by - ay) * t;
      const L = c.L;
      const off = w.segHalfw(c.a, c.b) * 0.55;
      const dx = bx - ax, dy = by - ay;
      c.x = px + (-dy / L) * off;
      c.y = py + (dx / L) * off;
    });
  }
}
