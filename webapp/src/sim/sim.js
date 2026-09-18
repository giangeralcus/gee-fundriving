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
  const car = new MapCar(world, start, simplify(route0.map((n) => world.nodes.get(n)), 12.0));
  const signals = new Signals(world, comp);
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
  return new Sim(world, comp, car, signals, traffic, mission, planner);
}

const dist2 = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;

export class Sim {
  constructor(world, comp, car, signals, traffic, mission, planner) {
    this.world = world;
    this.comp = comp;
    this.car = car;
    this.signals = signals;
    this.traffic = traffic;
    this.mission = mission;
    this.planner = planner;
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
    // berhenti di lampu merah: lampu terdekat di koridor depan
    let siBest = -1, sdBest = 1e9;
    signals.pos.forEach(([lx, ly], j) => {
      const dx = lx - car.x, dy = ly - car.y;
      const fwd = dx * fx + dy * fy;
      if (6 < fwd && fwd < 25) {
        const latt = Math.abs(-dx * fy + dy * fx);
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
    car.step(steer, thr, brk);
    mission.driven += car.speed * DT;
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
    signals.update();
    traffic.update(signals, [car.x, car.y], DT);
    // tabrakan hero vs mobil AI (box bodi skala 1:1: lebar 1.9 m, panjang 4.6 m)
    if (this.crashCd > 0) this.crashCd--;
    else {
      for (const tc of traffic.cars) {
        const dx = tc.x - car.x, dy = tc.y - car.y;
        const fwd = dx * fx + dy * fy;
        const lat = Math.abs(-dx * fy + dy * fx);
        if (lat < 2.4 && -3.5 < fwd && fwd < 4.5) {
          mission.crashes += 1;
          car.speed *= 0.3;
          this._teleportNearest();
          this.crashCd = 45;
          break;
        }
      }
    }
    if (state.lateral > state.halfw + 4) this.offFrames++;
    this.frames = fi + 1;
    // misi selesai -> skor + misi baru
    if (car.finished) {
      const pts = mission.complete(car);
      this.events.push(`misi #${mission.n} selesai +${pts}`);
      // snapshot sebelum misi baru me-reset counter (parity report Python)
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
      keluar_jalur: m.recovers,
      offroad_pct: +((100 * this.offFrames) / Math.max(this.frames, 1)).toFixed(1),
    };
  }

  stats() {
    return this.doneStats ?? this.rawStats();
  }
}
