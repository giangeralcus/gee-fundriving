// Lampu lalu lintas di simpang NYATA (derajat >= 4, minimal satu segmen
// penghubung jalan besar). Port setia dari Signals di fundriving.py,
// ditambah mode "adaptive": kontroler actuated per-simpang.
//   fixed    : siklus global CYCLE, fase selang-sumbu (perilaku lama,
//              backwards-compat persis — jangan ubah semantiknya).
//   adaptive : min-green, extend selama masih ada yang datang, gap-out,
//              max-green, fase kosong diskip, antrian ditimbang (mobil
//              berhenti = "call" lebih berat). Konsep standar traffic
//              engineering (actuated control ala SCOOT/SCATS versi satu
//              simpang), parameter desain sendiri buat skala kota sim.

const MAJOR = new Set(["motorway", "trunk", "primary", "secondary", "tertiary", "residential"]);

export class Signals {
  static CYCLE = 420; // frame per fase (7 detik @60fps) — mode fixed

  // Parameter actuated (frame @60fps). Kota sim: jalan pendek, antrian
  // cair cepat → min/max pendek; gap 1.3 dtk cukup bedain platoon vs celonan.
  static ADAPT = {
    MIN: 150,     // green minimum 2.5 dtk — semua yang nunggu bisa jalan
    MAX: 600,     // green maksimum 10 dtk — anti-starvation sumbu lain
    YELLOW: 75,   // 1.25 dtk kuning
    ALLRED: 45,   // 0.75 dtk semua-merah (clearance)
    ZONE: 42,     // zona deteksi (m dari simpang, sisi approach)
    GAP: 80,      // tak ada kendaraan BERGERAK selama ini → gap-out
    W_STOP: 1.6,  // bobot antrian: yang berhenti lebih "berat" dari yang jalan
  };

  constructor(world, comp, mode = "fixed") {
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
    this.mode = mode === "adaptive" ? "adaptive" : "fixed";
    this.world = world;             // buat sensus demand (koordinat edge)
    this._edgeAxis = new Map();     // cache "a:b" -> sumbu approach
    // state per simpang (mode adaptive). axis awal di-stagger biar kota
    // gak flip serentak (koridor lebih hidup).
    this.st = new Map();
    if (this.mode === "adaptive")
      this.nodeList.forEach((n, i) => this.st.set(n, { axis: i % 2, ph: "g", t: 0, still: 0 }));
  }

  axisOf(ax, ay, bx, by) {
    return Math.abs(bx - ax) >= Math.abs(by - ay) ? 0 : 1;
  }

  green(node, axis) {
    if (!this.nodes.has(node)) return true;
    if (this.mode === "fixed")
      return Math.floor(this.frame / Signals.CYCLE) % 2 === axis;
    const s = this.st.get(node);
    return s.ph === "g" && s.axis === axis;
  }

  // Perkiraan frame sampai axis itu hijau (dipakai planner rollout & ETA).
  // null kalau sudah hijau / simpang gak bersinyal. Fixed: eksak dari
  // siklus (semantik lama planner). Adaptive: estimasi dari state mesin —
  // worst-case min-green fase yang akan datang, cukup buat rem antisipatif.
  redRem(node, axis) {
    if (!this.nodes.has(node) || this.green(node, axis)) return null;
    if (this.mode === "fixed")
      return Signals.CYCLE - (this.frame % Signals.CYCLE);
    const A = Signals.ADAPT, s = this.st.get(node);
    if (s.ph === "y") return (A.YELLOW - s.t) + A.ALLRED + (s.axis === axis ? 0 : A.MIN);
    if (s.ph === "r") return (A.ALLRED - s.t) + (s.axis === axis ? 0 : A.MIN);
    // green di axis lain: tunggu min/gap/max + kuning + allred
    return Math.max(A.MIN - s.t, 0) + A.YELLOW + A.ALLRED;
  }

  // update(traffic, calls): calls = [{node, axis, moving}] — detector
  // tambahan (mis. hero/peserta yang bukan mobil AI). Setara push-button
  // actuated: nunggu = call, bergerak = extension.
  update(traffic = null, calls = null) {
    this.frame++;
    if (this.mode !== "adaptive") return;
    // Sensus demand: satu pass semua mobil → per simpang, per sumbu:
    //   D[axis] = bobot (antrian ditimbang), M[axis] = ada yang bergerak.
    const dem = new Map(), mov = new Map();
    const bump = (n, ax, moving) => {
      let D = dem.get(n);
      if (!D) { D = [0, 0]; dem.set(n, D); }
      D[ax] += moving ? 1.0 : Signals.ADAPT.W_STOP;
      if (moving) {
        let M = mov.get(n);
        if (!M) { M = [false, false]; mov.set(n, M); }
        M[ax] = true;
      }
    };
    if (calls) for (const c of calls) bump(c.node, c.axis, !!c.moving);
    if (traffic) {
      for (const c of traffic.cars) {
        if (!this.st.has(c.b)) continue;
        const d = (1.0 - c.t) * c.L;
        if (d > Signals.ADAPT.ZONE) continue;
        const k = c.a + ":" + c.b;
        let ax = this._edgeAxis.get(k);
        if (ax === undefined) {
          const p = this.world.nodes.get(c.a), q = this.world.nodes.get(c.b);
          ax = this.axisOf(p[0], p[1], q[0], q[1]);
          this._edgeAxis.set(k, ax);
        }
        bump(c.b, ax, c.speed >= 0.5);
      }
    }
    const A = Signals.ADAPT;
    for (const [n, s] of this.st) {
      const D = dem.get(n) ?? [0, 0];
      const M = mov.get(n) ?? [false, false];
      s.t++;
      if (s.ph === "g") {
        if (M[s.axis]) s.still = 0; else s.still++;
        const other = 1 - s.axis;
        // ganti fase kalau: min lewat DAN lawan minta DAN
        // (max tercapai  ATAU  kita udah kosong  ATAU  gap-out)
        if (s.t >= A.MIN && D[other] > 0 &&
          (s.t >= A.MAX || D[s.axis] === 0 || s.still >= A.GAP)) {
          s.ph = "y"; s.t = 0;
        }
      } else if (s.ph === "y") {
        if (s.t >= A.YELLOW) { s.ph = "r"; s.t = 0; }
      } else {
        if (s.t >= A.ALLRED) { s.axis = 1 - s.axis; s.ph = "g"; s.t = 0; s.still = 0; }
      }
    }
  }
}
