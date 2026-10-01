// Mobil hero di peta — skala 1:1 ala jevpilot: meter beneran, kecepatan
// m/s, akselerasi & rem m/s². Gerak pakai MODEL SEPEDA KINEMATIK (kinematic
// bicycle): yaw_rate = v / wheelbase * tan(delta) — delta = sudut kemudi
// roda depan (rad), di-rate-limit biar belokan halus, dan otomatis ikut
// skala kendaraan (bus wheelbase panjang → radius putar lebar, realistis).
// Referensi: PythonRobotics pure_pursuit (delta = atan2(2·WB·sinα/Lf, 1),
// clip MAX_STEER), Coulter 1992 (κ = 2y/Ld²).
// Satu tick = DT detik. PURE PURSUIT: progres rute dari proyeksi posisi
// ke segmen aktif, steering menuju titik lookahead DI ATAS rute (geser
// kanan buat lajur kanan, dinamis ikut lebar jalan).

export const DT = 1 / 60;

import { routeArc, routeCaps, capAtV } from "./world.js";
import { VEHICLES } from "./vehicles.js";

const wrapDeg = (d) => ((d % 360) + 360) % 360;
const wrapErr = (d) => wrapDeg(d + 180) - 180;
const DEG = Math.PI / 180;

export class MapCar {
  static MAXV = 11.1;        // m/s (40 km/j)
  static ACC = 2.2;          // m/s²
  static BRAKE = 7.5;        // m/s²
  static YAW_MAX = 126;      // derajat/s full lock (radius putar ~5 m @40km/j)
  static LOOKAHEAD_BASE = 6;    // m
  static LOOKAHEAD_GAIN = 1.15; // × v (m/s)
  static CAPTURE = 4;        // radius capture waypoint (m)

  constructor(world, startNode, route, speedScale = 1.0, vehicle = VEHICLES.citycar) {
    this.world = world;
    this.route = route;
    this.wpI = 0;
    // spesifikasi kendaraan: instance menimpa konstanta kelas (kontrak
    // fisika MapCar.MAXV/ACC tetap utuh buat pembanding); kecepatan basis
    // (speed_scale) menggeser MAXV & ACC BARENG biar feel akselerasi
    // proporsional.
    this.spec = vehicle;
    this.len = vehicle.len;
    this.wid = vehicle.wid;
    this.wheelbase = vehicle.wheelbase;
    this.steerMax = vehicle.steerMax * DEG;   // sudut roda depan maks (rad)
    this.MAXV = vehicle.maxv * speedScale;
    this.ACC = vehicle.acc * speedScale;
    this.BRAKE = vehicle.brake;
    this.delta = 0.0;    // sudut kemudi roda depan saat ini (rad)
    this.gear = 1;       // 1 maju, -1 mundur (parkir otonom butuh R)
    this.laneOffLock = null;   // dipakai mode parkir: ikut jalur persis
    this.speed = 0.0;    // m/s
    const [x, y] = world.nodes.get(startNode);
    this.x = x; this.y = y;
    this.heading = 0.0;
    this.crashes = 0;
    this.aliveTime = 0;
    this.finished = false;
    this.initHeading();
  }

  get maxv() { return this.MAXV; }

  setSpeedScale(s) {
    this.MAXV = this.spec.maxv * s;
    this.ACC = this.spec.acc * s;
  }

  // Pure pursuit berbasis curvature (Coulter 1992): titik target diproyek-
  // sikan ke frame mobil → κ = 2·y_lokal / Ld²; sudut roda depan =
  // atan(κ·wheelbase) (bentuk lain dari delta = atan2(2·WB·sinα/Lf, 1) di
  // PythonRobotics). Balikin steer ternormalisasi [-1, 1] vs steerMax.
  purePursuitSteer(tx, ty) {
    const h = this.heading * DEG;
    const dx = tx - this.x, dy = ty - this.y;
    const Ld = Math.hypot(dx, dy) + 1e-6;
    const yLocal = -dx * Math.sin(h) + dy * Math.cos(h);
    const kappa = (2.0 * yLocal) / (Ld * Ld);
    const delta = Math.atan(kappa * this.wheelbase);
    return Math.max(-1, Math.min(1, delta / this.steerMax));
  }

  // lajur kanan-dalam dinamis: tiap arah kebagian 2 lajur (garis lajur di
  // ±½ lebar arah), mobil di tengah lajur kanan yang dekat garis tengah
  // (25% halfwidth dari garis tengah)
  get laneOff() {
    if (this.laneOffLock != null) return this.laneOffLock;   // parkir: ikut jalur persis
    return this.world.nearestSegW(this.x, this.y) * 0.25;
  }

  lookahead() {
    // makin panjang kendaraan, makin jauh pandang ke depan (kinematic bicycle:
    // Ld = base + gain·v + 0.4·wheelbase)
    return MapCar.LOOKAHEAD_BASE + MapCar.LOOKAHEAD_GAIN * this.speed + 0.4 * this.wheelbase;
  }

  initHeading() {
    const wp = this.lookpoint(0.0);
    this.heading = (Math.atan2(wp[1] - this.y, wp[0] - this.x) * 180) / Math.PI;
    this.cum = routeArc(this.route);
    this.caps = routeCaps(this.route, this.cum);
  }

  // posisi arc sepanjang rute (m)
  arcPos() {
    const t = this.project().t;
    return this.cum[this.wpI] + t * (this.cum[this.wpI + 1] - this.cum[this.wpI]);
  }

  // batas kecepatan profil tikungan pada posisi arc s (m)
  capAt(s) {
    return capAtV(this.caps, s);
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
    const lo = this.laneOff;
    const look = [look0[0] + (-dyl / ll) * lo,
                  look0[1] + (dxl / ll) * lo];
    const desired = (Math.atan2(look[1] - this.y, look[0] - this.x) * 180) / Math.PI;
    const headingErr = wrapErr(desired - this.heading);
    const hw = w.nearestSegW(this.x, this.y);
    // 4. curvature: sudut belokan menunggu di depan (bobot jarak)
    let curv = 0.0, accD = 0.0;
    let i = this.wpI;
    while (i + 2 < this.route.length && accD < 90) {
      const a = this.route[i], b = this.route[i + 1], c = this.route[i + 2];
      const d1x = b[0] - a[0], d1y = b[1] - a[1];
      const d2x = c[0] - b[0], d2y = c[1] - b[1];
      const n1 = Math.hypot(d1x, d1y) + 1e-6, n2 = Math.hypot(d2x, d2y) + 1e-6;
      const dot = Math.max(-1, Math.min(1, (d1x * d2x + d1y * d2y) / (n1 * n2)));
      const ang = (Math.acos(dot) * 180) / Math.PI;
      const wgt = 0.45 + 0.55 * (1.0 - accD / 90);
      curv = Math.max(curv, ang * wgt);
      accD += n1;
      i++;
    }
    return {
      lateral: p.dist, halfw: hw,
      headingErr,
      maxv: this.MAXV,
      speedNorm: this.speed / this.MAXV,
      wp: tgt, cx: p.cx, cy: p.cy,
      curv,
      // batas kecepatan tikungan dilihat 2.2 detik ke depan (buat brain v3)
      capV: Math.min(this.MAXV, this.capAt(this.arcPos() + this.speed * 2.2)),
      // steer pure pursuit (curvature) buat brain rule v3 — konsisten model sepeda
      ppSteer: this.purePursuitSteer(look[0], look[1]),
    };
  }

  _toward(v, target, step) {
    const d = target - v;
    return Math.abs(d) <= step ? target : v + Math.sign(d) * step;
  }

  step(steer, thr, brk) {
    // MODEL SEPEDA KINEMATIK: sudut roda depan dikejar ke target dengan
    // rate-limit (halus, gak snap), yaw lahir dari geometri kendaraan:
    // yaw_rate = v / L * tan(delta). Saat diam → yaw 0 (fisik beneran).
    const STEER_RATE = 1.7;   // rad/s maks perubahan sudut roda depan (~97°/s)
    const deltaTarget = Math.max(-1, Math.min(1, steer)) * this.steerMax;
    const dDelta = Math.max(-STEER_RATE * DT,
      Math.min(STEER_RATE * DT, deltaTarget - this.delta));
    this.delta += dDelta;
    let yawRate = (this.speed / this.wheelbase) * Math.tan(this.delta);
    // batas genggam lateral (lingkaran gesek): a_lat = v·|yaw| ≤ μ·g.
    // μ aspal 1.0, di luar aspal 0.55 — inilah understeer realistis kalau
    // kebut di tikungan (yaw kinematik minta lebih dari ban sanggup).
    const hw = this.world.nearestSegW(this.x, this.y);
    const offRoad = this.project().dist > hw + 0.4;
    const mu = offRoad ? 0.55 : 1.0;
    this.mu = mu;
    if (Math.abs(this.speed) > 0.5) {
      const yawMax = (mu * 9.81) / Math.abs(this.speed);
      yawRate = Math.max(-yawMax, Math.min(yawMax, yawRate));
    }
    this.heading = wrapDeg(this.heading + (yawRate / DEG) * DT);
    // gear mundur: target kecepatan negatif (maks 40% kecepatan maju);
    // model sepeda yang sama bikin mundur otomatis steer kebalik — fisik beneran
    const tgtSpeed = this.gear < 0 ? -this.MAXV * 0.4 : this.MAXV;
    if (brk > 0) this.speed = this._toward(this.speed, 0.0, this.BRAKE * brk * mu * DT);
    else if (thr > 0) this.speed = this._toward(this.speed, tgtSpeed,
      this.ACC * thr * (offRoad ? 0.7 : 1) * DT);
    else {
      // hambatan jalan: rolling konstan + drag kuadratik — mobil pelan-pelan
      // nyelesai sendiri tanpa gas (dulu: cruise selamanya — gak fisik)
      const dec = (this.spec.roll + this.spec.drag * this.speed * this.speed) * DT;
      this.speed = this.speed >= 0 ? Math.max(0, this.speed - dec)
                                   : Math.min(0, this.speed + dec);
    }
    const a = (this.heading * Math.PI) / 180;
    this.x += Math.cos(a) * this.speed * DT;
    this.y += Math.sin(a) * this.speed * DT;
    this.aliveTime++;
    if (this.wpI >= this.route.length - 2) {
      const d = this.route[this.route.length - 1];
      if (Math.hypot(this.x - d[0], this.y - d[1]) < 4) this.finished = true;
    }
  }
}

export { wrapDeg, wrapErr };
