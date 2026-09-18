// Lampu lalu lintas di simpang NYATA (derajat >= 4, minimal satu segmen
// penghubung jalan besar). Fase bergantian sumbu horizontal (0) / vertikal (1).
// Port setia dari Signals di fundriving.py.

const MAJOR = new Set(["motorway", "trunk", "primary", "secondary", "tertiary", "residential"]);

export class Signals {
  static CYCLE = 420; // frame per fase (7 detik @60fps)

  constructor(world, comp) {
    const cand = new Set();
    for (const s of world.segs) {
      if (!MAJOR.has(s.kind)) continue;
      if (comp.has(s.a) && (world.adj.get(s.a)?.size ?? 0) >= 4) cand.add(s.a);
      if (comp.has(s.b) && (world.adj.get(s.b)?.size ?? 0) >= 4) cand.add(s.b);
    }
    this.nodeList = [...cand].sort((a, b) => a - b);
    this.nodes = new Set(this.nodeList);
    this.pos = this.nodeList.map((n) => world.nodes.get(n));
    this.frame = 0;
  }

  axisOf(ax, ay, bx, by) {
    return Math.abs(bx - ax) >= Math.abs(by - ay) ? 0 : 1;
  }

  green(node, axis) {
    if (!this.nodes.has(node)) return true;
    return Math.floor(this.frame / Signals.CYCLE) % 2 === axis;
  }

  update() {
    this.frame++;
  }
}
