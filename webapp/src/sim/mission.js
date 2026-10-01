// Misi antar: tujuan acak 500-2600m, skor = (terpendek/tempuh)*1000
// - 40/lampu merah - 25/tabrakan. Port setia dari Mission di fundriving.py.

import { simplify } from "./world.js";
import { wrapErr } from "./car.js";

const DEG = Math.PI / 180;

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
    this.stopRuns = 0;   // nabrak rambu STOP tanpa berhenti
    this.via = null;     // daftar node waypoint (rute lewat sini)
    this.stopOk = new Map();    // index rambu -> tick terakhir berhenti layak
    this.stopRunCd = new Map(); // cooldown penalti per rambu
    this.parking = false;       // mode parkir otonom (route menuju bay)
    this.maneuver = null;       // keyframe maneuver masuk bay
    this.parkBay = null;        // bay yang dituju
    this.lastParked = null;     // bay terakhir berhasil diparkiri (buat UI)
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
    this.via = null;   // misi acak = tanpa waypoint
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
    this.via = null;
    this._set(goalNode, pts, car);
    return true;
  }

  // Rute lewat waypoint (ala "add stop" di Google Maps): from -> via1 ->
  // ... -> viaN (waypoint terakhir = tujuan). Tiap kaki diroute sendiri
  // lalu disambung — titik sambungan tetap persis di node waypoint.
  newVia(fromNode, viaNodes, car) {
    if (!viaNodes || !viaNodes.length) return false;
    const eps = this.world.meta.simplifyEps ?? 12.0;
    const seq = [fromNode, ...viaNodes];
    const pts = [];
    for (let i = 0; i < seq.length - 1; i++) {
      const leg = this.world.route(seq[i], seq[i + 1]);
      if (leg.length < 2) return false;
      const s = simplify(leg.map((n) => this.world.nodes.get(n)), eps);
      if (s.length < 2) return false;
      if (pts.length === 0) pts.push(...s);
      else pts.push(...s.slice(1));
    }
    this.via = [...viaNodes];
    this._set(viaNodes[viaNodes.length - 1], pts, car);
    return true;
  }

  _set(goal, pts, car) {
    this.goal = goal;
    this.routeLen = this.routeLenOf(pts);
    this.driven = 0.0;
    this.reds = 0;
    this.crashes = 0;
    this.recovers = 0;
    this.stopRuns = 0;
    this.done = false;
    this.redCd = new Map();
    this.stopOk = new Map();
    this.stopRunCd = new Map();
    car.route = pts;
    car.wpI = 0;
    car.finished = false;
    car.initHeading();
  }

  // PARKIR OTONOM: rute ke bay (Dijkstra ke node jangkar + jalur masuk bay).
  // laneOff dikunci 0 biar jalur bay diikuti persis, gak digeser lajur.
  startParking(car, bay) {
    const from = this.world.nearestNode(car.x, car.y, this.comp);
    const eps = this.world.meta.simplifyEps ?? 12.0;
    let pts;
    if (from === bay.anchorNode) {
      // mobil udah di node jangkar → langsung jalur masuk bay aja
      pts = [this.world.nodes.get(from)];
    } else {
      const r = this.world.route(from, bay.anchorNode);
      if (r.length < 2) return false;
      pts = simplify(r.map((n) => this.world.nodes.get(n)), eps);
    }
    const mouth = [bay.cx - Math.cos(bay.ang) * (bay.len / 2 + 2.2),
                   bay.cy - Math.sin(bay.ang) * (bay.len / 2 + 2.2)];
    const end = [bay.cx + Math.cos(bay.ang) * (bay.len * 0.28),
                 bay.cy + Math.sin(bay.ang) * (bay.len * 0.28)];
    pts.push(mouth, [bay.cx, bay.cy], end);
    this.parkBay = bay;
    this.parking = true;
    this.maneuver = null;
    car.laneOffLock = 0;
    this._set(bay.anchorNode, pts, car);
    return true;
  }

  // Keyframe maneuver parkir: servo masuk bay (Stanley crawl) -> goyangan
  // mundur-maju ala parkir beneran -> align presisi -> rem. Arah goyangan:
  // ekor digeser ke trotoar (mundur + kemudi kanan = ekor ke kanan; fisika
  // model sepeda: v<0 x delta<0 -> yaw positif).
  synthManeuver(car) {
    return {
      h0: car.heading,
      gear: 1,
      i: 0,
      dur: null,
      pt: 0,
      phases: [
        { gear: 1, steer: null, servoIn: true },                        // masuk bay pelan
        { gear: -1, steer: -0.75, untilDeg: -20, dir: -1 },             // mundur, ekor ke trotoar
        { gear: 1, steer: 0.75, untilDeg: -1.5, dir: 1 },               // maju lurusin
        { gear: 1, steer: null, servo: true },                          // align presisi
        { gear: 1, steer: 0, thr: 0, brk: 1, dur: 42 },                 // rem -> terparkir
      ],
    };
  }

  // Jalankan keyframe maneuver. Balikin [steer, thr, brk, done].
  // Servo low-speed pakai Stanley law (PythonRobotics):
  // delta = theta_e + atan2(k * e_ct, v + 0.7).
  playManeuver(car) {
    const m = this.maneuver;
    const p = m.phases[m.i];
    if (!p) return [0, 0, 1, true];
    const bay = this.parkBay;
    const tx = bay.cx + Math.cos(bay.ang) * (bay.len * 0.28);
    const ty = bay.cy + Math.sin(bay.ang) * (bay.len * 0.28);
    if (p.servoIn || p.servo) {
      const dx = tx - car.x, dy = ty - car.y;
      const dist = Math.hypot(dx, dy);
      const h = car.heading * DEG;
      const eCt = -dx * Math.sin(h) + dy * Math.cos(h);
      const thE = ((bay.ang / DEG - car.heading + 540) % 360) - 180;
      const delta = thE * DEG * 0.6 + Math.atan2(0.5 * eCt, Math.abs(car.speed) + 0.7);
      const steer = Math.max(-1, Math.min(1, delta / car.steerMax));
      const tolD = p.servoIn ? 1.1 : 0.5, tolH = p.servoIn ? 10 : 6;
      m.pt++;
      const maxTicks = p.servoIn ? 1800 : 900;
      if ((dist < tolD && Math.abs(thE) < tolH) || m.pt > maxTicks) {
        m.i++; m.pt = 0;
        return this.playManeuver(car);
      }
      m.gear = 1;
      const thr = Math.abs(car.speed) > 1.3 ? 0 : 0.5;
      const brk = Math.abs(car.speed) > 2.2 ? 0.6 : 0;
      return [steer, thr, brk, false];
    }
    if (p.untilDeg !== undefined) {
      const hd = wrapErr(car.heading - m.h0);
      if ((p.dir < 0 && hd <= p.untilDeg) || (p.dir > 0 && hd >= p.untilDeg)) {
        m.i++; m.pt = 0;
        return this.playManeuver(car);
      }
      m.gear = p.gear;
      return [p.steer, p.gear < 0 ? 0.5 : 0.4, 0, false];
    }
    // fase rem terakhir
    m.dur = (m.dur ?? p.dur) - 1;
    m.gear = 1;
    if (m.dur <= 0) return [0, 0, 1, true];
    return [0, 0, 1, false];
  }

  complete(car) {
    const base = Math.round(this.routeLen / Math.max(this.driven, 1.0) * 1000);
    const pts = Math.max(50, base - 40 * this.reds - 25 * this.crashes - 15 * this.stopRuns);
    this.score += pts;
    this.n += 1;
    this.done = true;
    this.lastParked = this.parking ? this.parkBay : null;
    this.parking = false;
    this.maneuver = null;
    car.laneOffLock = null;
    this.via = null;
    return pts;
  }
}
