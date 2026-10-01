// Rambu lalu lintas statis: STOP di sebagian simpang tanpa lampu + zona
// batas kecepatan di sebagian ruas. Dibangkitkan DETERMINISTIK dari id node
// (peta sama = rambu sama — bisa dites & direproduksi). Autopilot wajib
// nurut: berhenti sebelum garis STOP, kepat limit zona; langgar = penalti.
//
// Referensi penempatan: rambu dipasang di KANAN pendekat, di luar tepi
// aspal (kaya dunia nyata). Zona kecepatan: cek jarak titik-ke-segmen.

const KMH = 1 / 3.6;   // km/j -> m/s

// hash deterministik sederhana (bukan kripto, cukup buat seeding stabil)
const hash01 = (n) => {
  let x = (n | 0) * 2654435761;
  x = (x ^ (x >>> 13)) * 1274126177;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
};

// jarak titik ke segmen (buat zona kecepatan)
function distPtSeg(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const ab2 = abx * abx + aby * aby + 1e-9;
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / ab2));
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
}

export class RoadSigns {
  constructor(world, comp, signals) {
    this.world = world;
    this.stops = [];      // [[x, y]] posisi titik STOP (di node)
    this.items = [];      // buat render: {type, x, y, limit?, ang}
    this.zones = [];      // {ax, ay, bx, by, limit} — zona batas kecepatan (m/s)

    const signaled = new Set(signals.nodeList);
    const nodes = [...comp].sort((a, b) => a - b);
    this.stopNodeSet = new Set();   // id node ber-STOP (buat mobil AI)

    // 1. STOP: simpang >= 3 cabang yang gak berlampu, ~35% dari kandidat
    for (const n of nodes) {
      if (signaled.has(n)) continue;
      const deg = this.world.adj.get(n)?.size ?? 0;
      if (deg < 3) continue;
      if (hash01(n * 7 + 1) >= 0.35) continue;
      const [x, y] = world.nodes.get(n);
      this.stops.push([x, y]);
      this.stopNodeSet.add(n);
      const ang = this._approachAngle(n);
      this.items.push({ type: "stop", x, y, ang });
    }

    // 1b. fallback: kalau gak ada simpang yang kwalifikasi (peta kecil/semua
    // berlampu), pasang STOP di sebagian kecil node belokan dobel biar
    // fiturnya tetap nongol di semua peta.
    if (this.stops.length === 0) {
      for (const n of nodes) {
        if (signaled.has(n)) continue;
        if ((this.world.adj.get(n)?.size ?? 0) !== 2) continue;
        if (hash01(n * 7 + 2) >= 0.14) continue;
        const [x, y] = world.nodes.get(n);
        this.stops.push([x, y]);
        this.stopNodeSet.add(n);
        this.items.push({ type: "stop", x, y, ang: this._approachAngle(n) });
      }
    }

    // 2. zona kecepatan 25 km/j: ~18% ruas, makin panjang ruas makin layak
    const w = world;
    for (let i = 0; i < w.segs.length; i++) {
      const s = w.segs[i];
      const len = Math.hypot(s.bx - s.ax, s.by - s.ay);
      if (len < 90) continue;                       // ruas pendek gak perlu zona
      if (hash01(i * 13 + 5) >= 0.18) continue;
      const halfw = s.wd ?? 5;
      this.zones.push({ ax: s.ax, ay: s.ay, bx: s.bx, by: s.by, limit: 25 * KMH });
      // rambu di dekat ujung awal segmen, sisi kanan (offset tegak lurus)
      const ang = Math.atan2(s.by - s.ay, s.bx - s.ax);
      const rx = -Math.sin(ang), ry = Math.cos(ang);
      this.items.push({
        type: "speed", limit: 25,
        x: s.ax + Math.cos(ang) * 8 - rx * (halfw + 1.2),
        y: s.ay + Math.sin(ang) * 8 - ry * (halfw + 1.2),
        ang,
      });
    }
  }

  // sudut pendekat pertama ke node ini (buat arah hadap rambu)
  _approachAngle(n) {
    const nb = [...(this.world.adj.get(n) || [])][0];
    if (nb == null) return 0;
    const [ax, ay] = this.world.nodes.get(nb);
    const [bx, by] = this.world.nodes.get(n);
    return Math.atan2(by - ay, bx - ax);
  }

  // limit aktif di posisi (m/s) atau null — dipakai sim buat cap + HUD LIMIT
  speedLimitAt(x, y) {
    for (const z of this.zones) {
      if (distPtSeg(x, y, z.ax, z.ay, z.bx, z.by) < 9) return z.limit;
    }
    return null;
  }

  // rambu STOP terdekat di koridor depan → [jarak, index] | null
  // (koridor & ambang = pola yang sama dengan deteksi lampu di sim.js)
  stopAhead(x, y, heading) {
    const fx = Math.cos(heading), fy = Math.sin(heading);
    let best = null, bi = -1;
    for (let i = 0; i < this.stops.length; i++) {
      const dx = this.stops[i][0] - x, dy = this.stops[i][1] - y;
      const fwd = dx * fx + dy * fy;
      if (!(3 < fwd && fwd < 20)) continue;
      const lat = Math.abs(-dx * fy + dy * fx);
      if (lat > 5) continue;
      if (best === null || fwd < best) { best = fwd; bi = i; }
    }
    return best === null ? null : [best, bi];
  }
}

export { distPtSeg };
