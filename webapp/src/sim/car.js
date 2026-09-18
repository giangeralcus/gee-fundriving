// Mobil hero di peta — PURE PURSUIT: progres rute dari proyeksi posisi ke
// segmen aktif, steering menuju titik lookahead DI ATAS rute (geser kanan
// buat lajur kanan). Port setia dari MapCar di fundriving.py.

const wrapDeg = (d) => ((d % 360) + 360) % 360;
const wrapErr = (d) => wrapDeg(d + 180) - 180;

export class MapCar {
  static MAXV = 4.2;         // m/frame (~40 km/h pada skala sim)
  static ACC = 0.05;
  static LOOKAHEAD_BASE = 16;
  static LOOKAHEAD_GAIN = 6.0;
  static CAPTURE = 12.0;     // radius capture kecil (toleransi ujung rute)
  static LANE_OFF = 3.5;     // geser kanan: mobil jalan di lajur kanan

  constructor(world, startNode, route) {
    this.world = world;
    this.route = route;
    this.wpI = 0;
    const [x, y] = world.nodes.get(startNode);
    this.x = x; this.y = y;
    this.heading = 0.0;
    this.speed = 0.0;
    this.crashes = 0;
    this.aliveTime = 0;
    this.finished = false;
    this.initHeading();
  }

  get maxv() { return MapCar.MAXV; }
  get laneOff() { return MapCar.LANE_OFF; }

  lookahead() {
    return MapCar.LOOKAHEAD_BASE + MapCar.LOOKAHEAD_GAIN * this.speed;
  }

  initHeading() {
    const wp = this.lookpoint(0.0);
    this.heading = (Math.atan2(wp[1] - this.y, wp[0] - this.x) * 180) / Math.PI;
  }

  project() {
    // Proyeksi posisi ke segmen aktif -> {t, cx, cy, dist}
    const a = this.route[this.wpI], b = this.route[this.wpI + 1];
    const abx = b[0] - a[0], aby = b[1] - a[1];
    const ab2 = abx * abx + aby * aby + 1e-6;
    const t = Math.max(0, Math.min(1, ((this.x - a[0]) * abx + (this.y - a[1]) * aby) / ab2));
    const cx = a[0] + abx * t, cy = a[1] + aby * t;
    return { t, cx, cy, dist: Math.hypot(this.x - cx, this.y - cy) };
  }

  lookpoint(tProj = 0.0) {
    // Titik lookahead DI ATAS rute, sejauh target dari proyeksi. Kalau
    // segmen aktif lebih panjang dari target -> JANGAN lompat ke goal.
    let i = this.wpI;
    const a = this.route[i], b = this.route[i + 1];
    const seglen = Math.hypot(b[0] - a[0], b[1] - a[1]) + 1e-6;
    const px = a[0] + (b[0] - a[0]) * tProj;
    const py = a[1] + (b[1] - a[1]) * tProj;
    const target = this.lookahead();
    const acc = Math.hypot(b[0] - px, b[1] - py);
    if (acc >= target) {
      const ux = (b[0] - a[0]) / seglen, uy = (b[1] - a[1]) / seglen;
      return [px + ux * target, py + uy * target];
    }
    let rem = target - acc;
    let bx = b[0], by = b[1];
    while (i + 2 < this.route.length && rem > 1e-6) {
      i++;
      const [nx, ny] = this.route[i + 1];
      const seg = Math.hypot(nx - bx, ny - by);
      if (rem <= seg) {
        const f = rem / Math.max(seg, 1e-6);
        return [bx + (nx - bx) * f, by + (ny - by) * f];
      }
      rem -= seg;
      bx = nx; by = ny;
    }
    return this.route[this.route.length - 1];
  }

  sense() {
    const w = this.world;
    // 1. progresi: maju selama proyeksi UDAH lewat ujung segmen
    while (this.wpI < this.route.length - 2 && this.project().t >= 1.0) this.wpI++;
    const p = this.project();
    // 2. capture radius kecil: nempel waypoint -> maju
    while (this.wpI < this.route.length - 2) {
      const wpn = this.route[this.wpI + 1];
      if (Math.hypot(this.x - wpn[0], this.y - wpn[1]) < MapCar.CAPTURE) {
        this.wpI++;
      } else break;
    }
    const tgt = this.route[Math.min(this.wpI + 1, this.route.length - 1)];
    // 3. PURE PURSUIT: arahkan ke titik lookahead + geser kanan (lajur kanan)
    const look0 = this.lookpoint(p.t);
    const dxl = look0[0] - this.x, dyl = look0[1] - this.y;
    const ll = Math.hypot(dxl, dyl) + 1e-6;
    const look = [look0[0] + (-dyl / ll) * MapCar.LANE_OFF,
                  look0[1] + (dxl / ll) * MapCar.LANE_OFF];
    const desired = (Math.atan2(look[1] - this.y, look[0] - this.x) * 180) / Math.PI;
    const headingErr = wrapErr(desired - this.heading);
    const hw = w.segHalfw(this.route[this.wpI], this.route[this.wpI + 1]);
    // 4. curvature: sudut belokan menunggu di depan (bobot jarak)
    let curv = 0.0, accD = 0.0;
    let i = this.wpI;
    while (i + 2 < this.route.length && accD < 120) {
      const a = this.route[i], b = this.route[i + 1], c = this.route[i + 2];
      const d1x = b[0] - a[0], d1y = b[1] - a[1];
      const d2x = c[0] - b[0], d2y = c[1] - b[1];
      const n1 = Math.hypot(d1x, d1y) + 1e-6, n2 = Math.hypot(d2x, d2y) + 1e-6;
      const dot = Math.max(-1, Math.min(1, (d1x * d2x + d1y * d2y) / (n1 * n2)));
      const ang = (Math.acos(dot) * 180) / Math.PI;
      const wgt = 0.45 + 0.55 * (1.0 - accD / 120.0);
      curv = Math.max(curv, ang * wgt);
      accD += n1;
      i++;
    }
    return {
      lateral: p.dist, halfw: hw,
      headingErr,
      speedNorm: this.speed / MapCar.MAXV,
      wp: tgt, cx: p.cx, cy: p.cy,
      curv,
    };
  }

  step(steer, thr, brk) {
    const turn = steer * 3.4 * (0.45 + 0.55 * this.speed / MapCar.MAXV);
    this.heading = wrapDeg(this.heading + turn);
    if (brk > 0) this.speed = Math.max(0.0, this.speed - 0.15);
    else if (thr > 0) this.speed = Math.min(MapCar.MAXV, this.speed + MapCar.ACC * thr);
    const a = (this.heading * Math.PI) / 180;
    this.x += Math.cos(a) * this.speed;
    this.y += Math.sin(a) * this.speed;
    this.aliveTime++;
    if (this.wpI >= this.route.length - 2) {
      const d = this.route[this.route.length - 1];
      if (Math.hypot(this.x - d[0], this.y - d[1]) < 12) this.finished = true;
    }
  }
}

export { wrapDeg, wrapErr };
