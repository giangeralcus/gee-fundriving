// Brain v4 map mode — arsitektur ala JevPilot (github.com/standardagents/
// jevpilot): sampling kandidat maneuver -> rollout proyeksi fisika -> tag
// (on-road, kontak, merah) -> filter + skor lokal -> pilih satu. Maneuver
// dieksekusi antar keputusan ~4 Hz. Hook LLM: set globalThis.JEV_API_URL
// biar model eksternal yang milih (balas {"choice":"v3"}); gagal -> skor lokal.
// Port setia dari Planner di fundriving.py.

import { wrapDeg, wrapErr, MapCar, DT } from "./car.js";
import { routeCaps, capAtV } from "./world.js";
import { Signals } from "./signals.js";

const CYCLE = Signals.CYCLE;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export const PLANNER_EVERY = 15;   // keputusan tiap 15 frame (4 Hz)
export const ROLLOUT_STEPS = 90;   // horizon 1.5 detik @60fps
export const CAND_SPEEDS = [1.0, 0.75, 0.5, 0.25];
export const CAND_OFFSETS = [-3.0, 0.0, 2.0];
export const IMMINENT_S = 0.5;     // kontak < 0.5 dtk = imminent
export const OFF_ROAD_M = 11.0;    // fallback; normalnya dinamis (halfw + 2.2)
export const STOP_BUF = 2.5;       // buffer berhenti di belakang lead/garis (m)
export const BRAKE_V4 = MapCar.BRAKE;  // decel rollout = rem mobil (m/s²)
export const FPS = 60;

export function routeArc(route) {
  const cum = [0.0];
  for (let i = 0; i < route.length - 1; i++) {
    const [ax, ay] = route[i], [bx, by] = route[i + 1];
    cum.push(cum[cum.length - 1] + Math.hypot(bx - ax, by - ay));
  }
  return cum;
}

export function routePointAt(route, cum, s) {
  // Posisi + arah (derajat) di sepanjang rute pada jarak s meter arc
  s = Math.max(0, Math.min(s, cum[cum.length - 1]));
  let lo = 0, hi = cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid; else hi = mid;
  }
  const [ax, ay] = route[lo], [bx, by] = route[lo + 1];
  const f = (s - cum[lo]) / (cum[lo + 1] - cum[lo] + 1e-6);
  return [ax + (bx - ax) * f, ay + (by - ay) * f,
          (Math.atan2(by - ay, bx - ax) * 180) / Math.PI];
}

export function distToRoad(segs, segGrid, x, y) {
  // Jarak posisi ke segmen jalan terdekat (grid 3x3 cell sekitar)
  const cx = Math.floor(x / 500), cy = Math.floor(y / 500);
  let best = 1e9;
  for (let gx = cx - 1; gx <= cx + 1; gx++) {
    for (let gy = cy - 1; gy <= cy + 1; gy++) {
      const cell = segGrid.get(`${gx},${gy}`);
      if (!cell) continue;
      for (const i of cell) {
        const s = segs[i];
        const abx = s.bx - s.ax, aby = s.by - s.ay;
        const tt = Math.max(0, Math.min(1, ((x - s.ax) * abx + (y - s.ay) * aby)
          / (abx * abx + aby * aby + 1e-6)));
        const d = Math.hypot(x - s.ax - abx * tt, y - s.ay - aby * tt);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

export async function remoteDecide(request) {
  // Hook brain eksternal: POST JSON -> {"choice": "v5"} / {"choice": "stop"}
  const url = globalThis.JEV_API_URL;
  if (!url) return null;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2000);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: ctl.signal,
    });
    clearTimeout(timer);
    return await res.json();
  } catch {
    return null;
  }
}

// Satu putusan penuh dari snapshot: murni fungsi, gak nyentuh DOM/world hidup —
// dipakai utk worker ATAU fallback lokal.
export async function decideCore(ctx, snap) {
  const { route, cum, segs, segGrid } = ctx;
  const { x, y, heading, speed, maxv, laneOff, lookahead, offRoadM = OFF_ROAD_M } = snap;
  const s0 = snap.s0;
  // rollout satu kandidat
  const rollout = (off, sf) => {
    let tgtV = sf * maxv;
    let gx = x, gy = y, ghd = heading, v = speed;
    let trav = 0.0, offroad = 0, checked = 0, predTau = null, crossedRed = false;
    for (let i = 0; i < ROLLOUT_STEPS; i++) {
      let tgtEff = tgtV;
      // cap profil tikungan (ala routeSpeedLimit) + rem menuju lead/garis
      tgtEff = Math.min(tgtEff, capAtV(snap.caps, s0 + trav));
      if (snap.gap != null) {
        const room = snap.gap - trav - STOP_BUF;
        tgtEff = Math.min(tgtEff, room > 0 ? Math.sqrt(2 * BRAKE_V4 * room) : 0.0);
      }
      if (snap.red) {
        const room = snap.red[0] - trav - 2.0;
        tgtEff = Math.min(tgtEff, room > 0 ? Math.sqrt(2 * BRAKE_V4 * room) : 0.0);
      }
      // pure pursuit ke titik lookahead di rute + offset lajur
      const [px, py, tang] = routePointAt(route, cum, s0 + trav + lookahead);
      const tx = px - Math.sin(rad(tang)) * (laneOff + off);
      const ty = py + Math.cos(rad(tang)) * (laneOff + off);
      const desired = deg(Math.atan2(ty - gy, tx - gx));
      const he = wrapErr(desired - ghd);
      const steer = Math.max(-1, Math.min(1, he / 40.0));
      const yaw = steer * MapCar.YAW_MAX * (0.45 + 0.55 * v / maxv);
      ghd = wrapDeg(ghd + yaw * DT);
      if (v > tgtEff + 0.1) v = Math.max(0.0, v - BRAKE_V4 * DT);
      else if (v < tgtEff - 0.1) v = Math.min(maxv, v + MapCar.ACC * DT);
      const a = rad(ghd);
      gx += Math.cos(a) * v * DT;
      gy += Math.sin(a) * v * DT;
      trav += v * DT;
      if (i % 5) continue;
      checked++;
      if (distToRoad(segs, segGrid, gx, gy) > offRoadM) offroad++;
      const tau = i / FPS;
      if (predTau === null) {
        // kontak dinilai di frame ghost (box bodi + margin, skala mobil 4.6m)
        const ca = Math.cos(a), sa = Math.sin(a);
        for (const p of snap.preds) {
          const dxo = p[0] + p[2] * tau - gx, dyo = p[1] + p[3] * tau - gy;
          const f = dxo * ca + dyo * sa, l = -dxo * sa + dyo * ca;
          if (-3.0 < f && f < 4.5 && Math.abs(l) < 2.4) { predTau = tau; break; }
        }
      }
      if (snap.red && snap.red[1] - i > 0 && trav > snap.red[0] && v > 1.5)
        crossedRed = true;
    }
    const end = routePointAt(route, cum, s0 + trav);
    const tx = end[0] - Math.sin(rad(end[2])) * (laneOff + off);
    const ty = end[1] + Math.cos(rad(end[2])) * (laneOff + off);
    const laneErr = Math.hypot(gx - tx, gy - ty);
    const heEnd = wrapErr(end[2] - ghd);
    return {
      off, sf, ex: gx, ey: gy,
      prog: trav, laneErr, he: heEnd,
      speedEnd: v, offFrac: offroad / Math.max(checked, 1),
      predTau,
      imminent: predTau !== null && predTau < IMMINENT_S,
      predicted: predTau !== null,
      red: crossedRed,
      name: sf === 0 ? "Rem"
        : `${off < -1 ? "Kiri" : off > 1 ? "Kanan" : "Lurus"} ${sf.toFixed(2)}x`,
    };
  };

  const cands = [];
  for (const sf of CAND_SPEEDS)
    for (const off of CAND_OFFSETS) cands.push(rollout(off, sf));
  for (const c of cands) {
    c.score = c.prog - 2.0 * c.laneErr - 0.03 * Math.abs(c.he)
      + 0.5 * c.speedEnd
      - 40.0 * c.offFrac
      - (c.imminent ? 900.0 : 0.0)
      - (c.predicted ? 800.0 + 60.0 / Math.max(0.2, c.predTau ?? 1.5) : 0.0)
      - 300.0 * (c.red ? 1 : 0);
    // ala movingCandidates jevpilot: kandidat berkontak / keluar jalan gak
    // masuk moving set
    c.eligible = !c.predicted && c.offFrac <= 0.1;
  }
  const stop = rollout(0.0, 0.0);
  stop.score = -100.0 - 0.3 * speed;   // rem itu pilihan terakhir
  const required = (snap.gap != null && snap.gap < 12)
    || (snap.red && snap.red[0] < 35);
  let pool = cands.filter((c) => c.eligible);
  if (!pool.length) pool = cands;      // darurat: least-bad
  if (required) pool = pool.concat([stop]);
  let best = pool.reduce((a, b) => (b.score > a.score ? b : a));
  // hook model eksternal: boleh timpa pilihan scorer lokal
  let src = "lokal";
  const req = buildRequest(ctx, snap, cands, stop);
  const resp = await remoteDecide(req);
  if (resp && typeof resp.choice === "string") {
    const ch = resp.choice;
    let pick = null;
    if (ch === "stop") {
      if (pool.includes(stop)) pick = stop;
    } else if (ch.startsWith("v") && /^\d+$/.test(ch.slice(1))) {
      const k = Number(ch.slice(1));
      if (k < cands.length && pool.includes(cands[k])) pick = cands[k];
    }
    if (pick) { best = pick; src = resp.src || "jev"; }
  }
  const candDbg = cands.map((c) => [c.ex, c.ey, c.eligible, c === best]);
  candDbg.push([stop.ex, stop.ey, true, stop === best]);
  // tabel kandidat + probabilitas softmax (buat panel & JSON inspector —
  // ala "vector probabilities" jevpilot)
  const all = [...cands, stop];
  const idOf = (c) => (c === stop ? "stop" : `v${cands.indexOf(c)}`);
  const T = 25.0;
  const top = Math.max(...all.map((c) => c.score));
  let sum = 0;
  const p = all.map((c) => { const v = Math.exp((c.score - top) / T); sum += v; return v; });
  const table = all.map((c, i) => ({
    id: idOf(c), name: c.name, sf: c.sf, off: c.off,
    prog: +c.prog.toFixed(1), laneErr: +c.laneErr.toFixed(1),
    speedEnd: +c.speedEnd.toFixed(2), offroad: c.offFrac > 0.1,
    collision: c.predTau, red: c.red,
    score: +c.score.toFixed(1), eligible: c.eligible,
    chosen: c === best, p: +(p[i] / sum).toFixed(3),
  }));
  return { off: best.off, sf: best.sf, name: best.name, src, candDbg, table, request: req };
}

function buildRequest(ctx, snap, cands, stop) {
  const tbl = {};
  cands.forEach((c, i) => {
    tbl[`v${i}`] = {
      name: c.name, off_m: c.off, speed_factor: c.sf,
      progress_m: +c.prog.toFixed(1), lane_error_m: +c.laneErr.toFixed(1),
      end_speed: +c.speedEnd.toFixed(2),
      on_road: c.offFrac <= 0.1,
      collision_in_s: c.predTau ? +c.predTau.toFixed(2) : null,
      crosses_red: c.red,
    };
  });
  tbl.stop = {
    name: "Rem", off_m: 0.0, speed_factor: 0.0,
    progress_m: +stop.prog.toFixed(1), lane_error_m: +stop.laneErr.toFixed(1),
    end_speed: 0.0, on_road: true, collision_in_s: null, crosses_red: false,
  };
  return {
    speed: +snap.speed.toFixed(2),
    limit: snap.maxv,
    lane_offset: +(snap.laneOff + snap.manOff).toFixed(1),
    red_ahead_m: snap.red ? +snap.red[0].toFixed(1) : null,
    red_remaining_s: snap.red ? +(snap.red[1] / FPS).toFixed(1) : null,
    lead_gap_m: snap.gap,
    destination_m: +(ctx.cum[ctx.cum.length - 1] - snap.s0).toFixed(1),
    questions: { vector: "pilih id kandidat fastest useful progress" },
    candidates: tbl,
  };
}

export class Planner {
  // useWorker: instance Worker (planner.worker.js) — kalau null, putusan lokal
  constructor(world, signals, traffic, useWorker = null) {
    this.world = world;
    this.signals = signals;
    this.traffic = traffic;
    this.worker = useWorker;
    this.route = null;
    this.cum = null;
    this.man = [0.0, 1.0];
    this.manName = "Lurus";
    this.src = "lokal";
    this.candDbg = [];
    this.frame = -999;
    this.s = 0.0;
    this.pending = false;
    this.seq = 0;
  }

  _ctx() {
    return { route: this.route, cum: this.cum, segs: this.world.segs, segGrid: this.world.segGrid };
  }

  _syncRoute(car) {
    if (this.route !== car.route) {
      this.route = car.route;
      this.cum = routeArc(car.route);
      this.frame = -999;    // misi baru -> putusan ulang segera
      if (this.worker)
        this.worker.postMessage({
          type: "init",
          route: this.route,
          segs: this.world.segs,
          segGrid: [...this.world.segGrid.entries()],
        });
    }
  }

  _heroArc(car) {
    const t = car.project().t;
    return this.cum[car.wpI] + t * (this.cum[car.wpI + 1] - this.cum[car.wpI]);
  }

  _redAhead(car) {
    const fx = Math.cos(rad(car.heading)), fy = Math.sin(rad(car.heading));
    let best = null;
    this.signals.pos.forEach(([lx, ly], j) => {
      const dx = lx - car.x, dy = ly - car.y;
      const fwd = dx * fx + dy * fy;
      if (!(4 < fwd && fwd < 90) || Math.abs(-dx * fy + dy * fx) > 13) return;
      const axis = Math.abs(fx) >= Math.abs(fy) ? 0 : 1;
      if (!this.signals.green(this.signals.nodeList[j], axis)) {
        const rem = CYCLE - (this.signals.frame % CYCLE);
        if (!best || fwd < best[0]) best = [fwd, rem];
      }
    });
    return best;
  }

  _buildSnap(car, state) {
    const preds = this.traffic.cars.map((tc) => {
      const a = rad(tc.heading);
      return [tc.x, tc.y, Math.cos(a) * tc.speed, Math.sin(a) * tc.speed];
    });
    return {
      s0: this.s,
      x: car.x, y: car.y, heading: car.heading, speed: car.speed,
      maxv: car.maxv, laneOff: car.laneOff,
      lookahead: car.lookahead(),
      // ambang off-road ikut lebar jalan (halfw + setengah lebar mobil + margin)
      offRoadM: this.world.nearestSegW(car.x, car.y) + 2.2,
      caps: car.caps,
      preds,
      red: this._redAhead(car),
      gap: state.aheadGap,
      curv: state.curv ?? 0.0,
      manOff: this.man[0],
    };
  }

  _applyResult(res) {
    this.man = [res.off, res.sf];
    this.manName = res.name;
    this.src = res.src;
    this.candDbg = res.candDbg;
    this.lastTable = res.table ?? null;
    this.lastRequest = res.request ?? null;
    this.pending = false;
  }

  drive(car, state, fi) {
    this._syncRoute(car);
    this.s = this._heroArc(car);
    if (fi - this.frame >= PLANNER_EVERY && !this.pending) {
      this.frame = fi;
      this.pending = true;
      const snap = this._buildSnap(car, state);
      if (this.worker) {
        const seq = ++this.seq;
        this._onResult = (r) => { if (r.seq === seq) this._applyResult(r); };
        this.worker.onmessage = (ev) => this._onResult?.(ev.data);
        this.worker.postMessage({ type: "decide", seq, snap });
      } else {
        decideCore(this._ctx(), snap).then((r) => this._applyResult(r));
      }
    }
    const [off, sf] = this.man;
    // steering: pure pursuit ke titik lookahead + offset lajur terpilih
    const [px, py, tang] = routePointAt(this.route, this.cum, this.s + car.lookahead());
    const gx = px - Math.sin(rad(tang)) * (car.laneOff + off);
    const gy = py + Math.cos(rad(tang)) * (car.laneOff + off);
    const desired = deg(Math.atan2(gy - car.y, gx - car.x));
    const he = wrapErr(desired - car.heading);
    const steer = Math.max(-1, Math.min(1, he / 40.0));
    // speed: target maneuver, di-cap profil tikungan (mirror rollout)
    let tgtV = Math.min(sf * car.maxv, car.capAt(this.s + 0.5 * car.lookahead()));
    const gap = state.aheadGap;
    let acc = "", thr, brk;
    if (gap != null && gap < 10) { thr = 0.0; brk = 1.0; acc = "REM!"; }
    else if (gap != null && gap < 20) { thr = 0.0; brk = 0.7; acc = "REM!"; }
    else if (car.speed < tgtV - 0.05) { thr = 1.0; brk = 0.0; }
    else if (car.speed > tgtV + 0.1) { thr = 0.0; brk = Math.min(1.0, (car.speed - tgtV) / 1.0); }
    else { thr = 0.0; brk = 0.0; }
    if (gap != null && gap >= 20 && gap < 35) { thr = 0.0; acc = "ikut"; }
    else if (gap != null && gap >= 35 && gap < 60) { thr = Math.min(thr, 0.35); acc = "geser"; }
        // anti-stall: nyaris berhenti tanpa rintangan -> kasi gas
        if (car.speed < 0.15 && gap == null && tgtV > 0.5) { thr = 0.35; brk = 0.0; }
    return [steer, thr, brk, { he, lat: state.lateral, acc, man: this.manName, src: this.src }];
  }
}
