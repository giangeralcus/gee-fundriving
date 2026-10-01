// Sim core map mode: satukan world + signals + traffic + mission + car +
// brain, satu langkah = satu frame. Gak nyentuh DOM/Three — bisa jalan di
// Node (benchmark headless) atau browser. Port setia dari run_map
// di fundriving.py.

import { World, largestComponent, simplify } from "./world.js";
import { Signals } from "./signals.js";
import { Traffic } from "./traffic.js";
import { Mission } from "./mission.js";
import { MapCar, DT } from "./car.js";
import { mapBrain } from "./brain.js";
import { Planner } from "./planner.js";
import { RoadSigns } from "./roadsigns.js";
import { Parked } from "./parked.js";
import { VEHICLES } from "./vehicles.js";

export const FPS = 60;

const rad = (d) => (d * Math.PI) / 180;

export function ll2xy(meta, lat, lon) {
  // lat/lon -> meter lokal, konsisten dgn proj fetch_osm (origin bbox corner)
  const [lon0, lat0, lon1, lat1] = meta.bbox;
  const x = ((lon - lon0) * Math.PI) / 180 * 6378137.0
    * Math.cos((((lat0 + lat1) / 2) * Math.PI) / 180);
  const y = ((lat1 - lat) * Math.PI) / 180 * 6378137.0;
  return [x, y];
}

export function createSim(data, opts = {}) {
  const brain = opts.brain || "v4";
  const widthScale = opts.widthScale ?? 1.0;
  const speedScale = opts.speedScale ?? 1.0;
  // eps raut rute bisa diatur per peta (lingkaran butuh eps kecil biar mulus)
  const simplifyEps = data.meta.simplifyEps ?? 12.0;
  const world = new World(data, widthScale);
  const comp = largestComponent(world);
  let start;
  if (opts.startLL) {
    const [sxm, sym] = ll2xy(world.meta, opts.startLL[0], opts.startLL[1]);
    start = world.nearestNode(sxm, sym, comp);
  } else {
    start = [...comp].reduce((a, b) => (world.nodes.get(b)[0] < world.nodes.get(a)[0] ? b : a));
  }
  const [sx, sy] = world.nodes.get(start);
  const goal = [...comp].reduce((a, b) => {
    const da = dist2(world.nodes.get(a), [sx, sy]);
    const db = dist2(world.nodes.get(b), [sx, sy]);
    return db > da ? b : a;
  });
  const route0 = world.route(start, goal);
  if (route0.length < 2) throw new Error("rute gak ketemu");
  const car = new MapCar(world, start, simplify(route0.map((n) => world.nodes.get(n)), simplifyEps), speedScale, opts.vehicle ?? VEHICLES.citycar);
  const signals = new Signals(world, comp, opts.signalsMode);
  const signs = new RoadSigns(world, comp, signals);
  const parked = new Parked(world, comp);
  let totalLen = 0;
  for (const s of world.segs)
    totalLen += Math.hypot(s.bx - s.ax, s.by - s.ay);
  // traffic: 0 = mode penyempurnaan satu kendaraan (default web)
  const nAi = opts.traffic === 0 ? 0
    : Math.max(6, Math.min(16, Math.floor(totalLen / 700)));
  const traffic = new Traffic(world, comp, [sx, sy], nAi);
  const mission = new Mission(world, comp, start);
  let firstOk = false;
  if (opts.goalLL) {
    const [gxm, gym] = ll2xy(world.meta, opts.goalLL[0], opts.goalLL[1]);
    const goalNode = world.nearestNode(gxm, gym, comp);
    firstOk = mission.newFixed(start, goalNode, car);
  }
  if (!firstOk) mission.new(start, car);
  const worker = opts.makeWorker ? opts.makeWorker() : null;
  const planner = brain === "v4" ? new Planner(world, signals, traffic, worker) : null;
  if (planner) planner.parked = parked;   // parkiran jadi obstacle di rollout
  return new Sim(world, comp, car, signals, traffic, mission, planner, signs, parked);
}

const dist2 = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;

export class Sim {
  constructor(world, comp, car, signals, traffic, mission, planner, signs = null, parked = null) {
    this.world = world;
    this.comp = comp;
    this.car = car;
    this.signals = signals;
    this.traffic = traffic;
    this.mission = mission;
    this.planner = planner;
    this.signs = signs;
    this.parked = parked;
    this.offFrames = 0;
    this.frames = 0;
    this.crashCd = 0;
    this.stallFrames = 0;
    this.hardStall = 0;
    this.events = [];   // log kejadian ("misi selesai", dll) — di-flush tiap step
  }

  // Satu frame dunia. manual = [steer, thr, brk] kalau pemain yang nyetir —
  // dunia (tabrak, lampu, misi) tetap berjalan, cuma brain dilewati.
  // Balikin state sense + keputusan brain (buat render/HUD).
  step(fi, manual = null) {
    const car = this.car, mission = this.mission, traffic = this.traffic;
    const signals = this.signals;
    const state = car.sense();
    // zona batas kecepatan (rambu): cap buat autopilot + info HUD LIMIT
    state.speedCap = this.signs ? this.signs.speedLimitAt(car.x, car.y) : null;
    state.limitKmh = Math.round((state.speedCap ?? car.MAXV) * 3.6);
    // PARKIR OTONOM: route ke bay habis → sintesis maneuver dua-arc sekali,
    // lalu executor (bukan planner) yang nyetir sampai terparkir.
    if (mission.parking && car.finished && !mission.maneuver) {
      mission.maneuver = mission.synthManeuver(car);
      car.finished = false;   // complete ditahan sampai maneuver beneran selesai
    }
    let parkCtl = null, parkDone = false;
    if (mission.parking && mission.maneuver) {
      parkCtl = mission.playManeuver(car);
      parkDone = parkCtl[3];
      car.finished = false;   // completion mode parkir dikontrol manual di bawah
    } else if (mission.parking) {
      const rem = car.cum[car.cum.length - 1] - car.arcPos();
      if (rem < 9) state.speedCap = Math.min(state.speedCap ?? 0.9, 0.9);
      else if (rem < 25) state.speedCap = Math.min(state.speedCap ?? 2.5, 2.5);
    }
    // safety-net: keluar jalur > 12 m -> snap balik ke rute
    if (state.lateral > 12 && !car.finished) {
      car.x = state.cx;
      car.y = state.cy;
      car.speed *= 0.4;
      mission.recovers += 1;
    }
    // ACC: mobil AI SEARAH di koridor depan (lawan arah bukan rintangan) —
    // skala 1:1: koridor lat 4.5 m (selebar lajur), jarak pandang 55 m
    const fx = Math.cos(rad(car.heading)), fy = Math.sin(rad(car.heading));
    let gap = null;
    for (const tc of traffic.cars) {
      const dx = tc.x - car.x, dy = tc.y - car.y;
      const fwd = dx * fx + dy * fy;
      if (0 < fwd && fwd < 55) {
        const lat = Math.abs(-dx * fy + dy * fx);
        if (lat < 4.5 && (gap === null || fwd < gap)) {
          const tcFwd = Math.cos(rad(tc.heading)) * fx + Math.sin(rad(tc.heading)) * fy;
          if (tcFwd > 0.25 || tc.speed < 0.1) gap = fwd;
        }
      }
    }
    // mobil parkir: koridor ketat (≈ ambang kontak) — ACC ngerem pas beneran
    // mau nyenggol, bukan cuma karena parkiran ada di samping jalan.
    // parkAhead = jarak parkiran terdekat di koridor → bias hindar brain v3.
    let parkAhead = null;
    for (const pc of (this.parked ? this.parked.near(car.x, car.y, 60) : [])) {
      const dx = pc.x - car.x, dy = pc.y - car.y;
      const fwd = dx * fx + dy * fy;
      if (0 < fwd && fwd < 30) {
        const lat = Math.abs(-dx * fy + dy * fx);
        if (lat < car.wid / 2 + pc.wid / 2 + 0.5 && (gap === null || fwd < gap)) gap = fwd;
        if (lat < 2.9 && fwd < 30 && (parkAhead === null || fwd < parkAhead)) parkAhead = fwd;
      }
    }
    state.parkAhead = parkAhead;
    state.aheadGap = gap;
    let steer, thr, brk, dec;
    if (manual) {
      [steer, thr, brk] = manual;
      dec = { he: state.headingErr, lat: state.lateral, acc: "", man: "manual", src: "" };
    } else if (this.planner) {
      [steer, thr, brk, dec] = this.planner.drive(car, state, fi);
    } else {
      [steer, thr, brk, dec] = mapBrain(state);
    }
    // executor parkir menimpa keputusan planner/brain selama maneuver
    if (parkCtl) [steer, thr, brk] = parkCtl;
    car.gear = (mission.parking && mission.maneuver) ? (mission.maneuver.gear ?? 1) : 1;
    // berhenti di lampu merah: lampu terdekat di koridor depan
    let siBest = -1, sdBest = 1e9;
    const heroCalls = [];   // detector hero utk sinyal adaptive (actuated)
    signals.pos.forEach(([lx, ly], j) => {
      const dx = lx - car.x, dy = ly - car.y;
      const fwd = dx * fx + dy * fy;
      const latt = Math.abs(-dx * fy + dy * fx);
      // call: hero di zona deteksi (≤ Signals.ADAPT.ZONE) → demand simpang
      if (2 < fwd && fwd < Signals.ADAPT.ZONE && latt < 13 && !car.finished)
        heroCalls.push({ node: signals.nodeList[j],
          axis: Math.abs(fx) >= Math.abs(fy) ? 0 : 1,
          moving: car.speed >= 0.5 });
      if (6 < fwd && fwd < 25) {
        if (latt < 6 && fwd < sdBest) { sdBest = fwd; siBest = j; }
      }
    });
    if (siBest >= 0) {
      const axis = Math.abs(fx) >= Math.abs(fy) ? 0 : 1;
      if (!signals.green(signals.nodeList[siBest], axis)) {
        thr = 0.0; brk = 1.0;
        // nyabrang merah: nempel lampu + masih merah + gerak
        if (sdBest < 4.5 && car.speed > 2) {
          const last = mission.redCd.get(siBest) ?? -9999;
          if (fi - last > 240) {
            mission.reds += 1;
            mission.redCd.set(siBest, fi);
          }
        }
      }
    }
    // rambu STOP: wajib berhenti sebelum garis — rem ANTISIPATIF (jangkar
    // fisika v²/2b + margin) diterapkan SEBELUM car.step. Bug lama: rem
    // baru nyala di 9m padahal dari 11 m/s butuh 8m+ — mobil nyeret lewat.
    if (this.signs) {
      const sa = this.signs.stopAhead(car.x, car.y, Math.atan2(fy, fx));
      if (sa) {
        const [spDist, spI] = sa;
        // jangkar fisika v²/2b + margin, dengan FLOOR 3,5m biar rem gak lepas
        // di ujung pendekatan (osilasi lama: brakeDist menyusut → lepas → gas)
        const brakeDist = Math.max(3.5, (car.speed * car.speed) / (2 * car.BRAKE) + 2.0);
        if (car.speed > 0.3 && spDist < brakeDist && spDist > 0.8) { thr = 0.0; brk = 1.0; }
        const lastOk = mission.stopOk.get(spI) ?? -99999;
        if (spDist < 8 && Math.abs(car.speed) < 0.45 && fi - lastOk > 45) {
          mission.stopOk.set(spI, fi);   // catat: berhenti layak di rambu ini
        }
        const lastRun = mission.stopRunCd.get(spI) ?? -99999;
        if (spDist <= 1.5 && car.speed > 2 && fi - lastOk > 240 && fi - lastRun > 240) {
          mission.stopRuns += 1;
          mission.stopRunCd.set(spI, fi);
          this.events.push("kena rambu STOP tanpa berhenti");
        }
      }
    }
    car.step(steer, thr, brk);
    mission.driven += Math.abs(car.speed) * DT;   // |v|: mundur tetap dihitung jalan
    // deadlock breaker tier 1: berhenti + rintangan nempel -> pindahkan
    if (car.speed < 0.15 && state.aheadGap !== null && state.aheadGap < 15) this.stallFrames++;
    else this.stallFrames = 0;
    // tier 2: diam total 8 detik apa pun gapnya = deadlock beneran
    if (car.speed < 0.15) this.hardStall++;
    else this.hardStall = 0;
    if (this.stallFrames > 240 || this.hardStall > 480) {
      this.stallFrames = 0;
      this.hardStall = 0;
      this._teleportNearest();
    }
    signals.update(traffic, heroCalls);
    traffic.update(signals, [car.x, car.y], DT, this.signs?.stopNodeSet ?? null);
    // tabrakan hero vs mobil AI — box bodi skala 1:1, ikut ukuran kendaraan
    if (this.crashCd > 0) this.crashCd--;
    else {
      const halfF = car.len / 2, halfW = car.wid / 2;
      for (const tc of traffic.cars) {
        const dx = tc.x - car.x, dy = tc.y - car.y;
        const fwd = dx * fx + dy * fy;
        const lat = Math.abs(-dx * fy + dy * fx);
        if (lat < halfW + 1.45 && -(halfF + 1.2) < fwd && fwd < halfF + 2.2) {
          mission.crashes += 1;
          car.speed *= 0.3;
          this._teleportNearest();
          this.crashCd = 45;
          break;
        }
      }
      // mobil parkir: tabrak = penalti; hero diundur keluar dari overlap
      // (parkirannya statis — gak ada yang dipindah)
      for (const pc of (this.parked ? this.parked.cars : [])) {
        const dx = pc.x - car.x, dy = pc.y - car.y;
        const fwd = dx * fx + dy * fy;
        const lat = Math.abs(-dx * fy + dy * fx);
        if (lat < halfW + pc.wid / 2 + 0.25
            && -(halfF + pc.len / 2 + 0.25) < fwd && fwd < halfF + pc.len / 2 + 0.25) {
          mission.crashes += 1;
          car.speed = 0;
          car.x -= fx * 1.6;
          car.y -= fy * 1.6;
          this.crashCd = 45;
          this.events.push("kena mobil parkir");
          break;
        }
      }
    }
    if (state.lateral > state.halfw + 4) this.offFrames++;
    this.frames = fi + 1;
    // misi biasa selesai -> skor + (auto-park) + misi baru
    if (car.finished && !mission.parking) {
      const pts = mission.complete(car);
      this.events.push(mission.lastParked
        ? `misi #${mission.n} selesai +${pts} — terparkir 🅿️`
        : `misi #${mission.n} selesai +${pts}`);
      // snapshot sebelum misi baru me-reset counter (parity report Python)
      this.doneStats = { ...this.rawStats(), selesai: true };
      const near = this.world.nearestNode(car.x, car.y, this.comp);
      // AUTO-PARK: habis nyampe tujuan, coba parkir dulu sebelum misi baru
      const bay = (!mission.lastParked && this.parked)
        ? this.parked.nearestFreeBay(car.x, car.y, car.len + 1.6, 130) : null;
      if (bay && mission.startParking(car, bay)) {
        this.events.push("nyari slot parkir…");
      } else if (!mission.new(near, car)) {
        this.events.push("gak ada tujuan baru");
      }
      this._purgeNear();
    } else if (parkDone) {
      // maneuver parkir selesai → tutup misi mode parkir
      const pts = mission.complete(car);
      this.events.push(`misi #${mission.n} selesai +${pts} — terparkir 🅿️`);
      this.doneStats = { ...this.rawStats(), selesai: true };
      const near = this.world.nearestNode(car.x, car.y, this.comp);
      if (!mission.new(near, car)) this.events.push("gak ada tujuan baru");
      this._purgeNear();
    }
    return { state, dec };
  }

  _teleportNearest() {
    // pindahkan mobil AI terdekat jauh (pengganti random.choice dgn filter)
    const car = this.car;
    let bestJ = -1, bestD = 70.0;
    this.traffic.cars.forEach((tc, j) => {
      const d = Math.hypot(tc.x - car.x, tc.y - car.y);
      if (d < bestD) { bestJ = j; bestD = d; }
    });
    if (bestJ < 0) return;
    const far = this.traffic.cars.filter((c) => Math.hypot(c.x - car.x, c.y - car.y) > 400);
    if (far.length)
      this.traffic.cars[bestJ] = structuredClone(far[Math.floor(Math.random() * far.length)]);
  }

  _purgeNear(radius = 130.0) {
    const car = this.car;
    this.traffic.cars.forEach((tc, j) => {
      if (Math.hypot(tc.x - car.x, tc.y - car.y) < radius) {
        const far = this.traffic.cars.filter(
          (c) => Math.hypot(c.x - car.x, c.y - car.y) > radius + 150);
        if (far.length)
          this.traffic.cars[j] = structuredClone(far[Math.floor(Math.random() * far.length)]);
      }
    });
  }

  rawStats() {
    const m = this.mission;
    return {
      selesai: this.mission.n > 0,
      detik_sim: Math.floor(this.car.aliveTime / FPS),
      jarak_rute_m: Math.round(m.routeLen),
      tempuh_m: Math.round(m.driven),
      skor: m.score,
      merah: m.reds,
      tabrak: m.crashes,
      stopRuns: m.stopRuns,
      keluar_jalur: m.recovers,
      offroad_pct: +((100 * this.offFrames) / Math.max(this.frames, 1)).toFixed(1),
    };
  }

  stats() {
    return this.doneStats ?? this.rawStats();
  }
}
