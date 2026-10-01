#!/usr/bin/env node
// Bench A/B sinyal: fixed (siklus global 2x7 dtk) vs adaptive (actuated
// per simpang). Headless, tanpa hero/planner — ngukur murni arus traffic.
//   node tools/signal-bench.mjs [--seconds 600] [--cars 24] [--map loop]
//
// Metode: fleet awal identik (Math.random di-seed saat konstruksi —
// penempatan mobil, kecepatan dasar sama persis antar mode). SETELAH
// jalan, keputusan random-walk tiap mobil tergantung timing → dua run
// gak bisa step-by-step identik; bandingkan agregat horizon panjang.
// (Demo ggcd nanti pakai model arrival Poisson seeded biar A/B strict.)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { World, largestComponent } from "../webapp/src/sim/world.js";
import { Signals } from "../webapp/src/sim/signals.js";
import { Traffic } from "../webapp/src/sim/traffic.js";

const args = process.argv.slice(2);
const get = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const seconds = Number(get("--seconds", "600"));
const NCARS = Number(get("--cars", "24"));
const mapArg = get("--map", "loop");
const SEED = 20260916;

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const mapFile = mapArg === "loop" || mapArg === "circle"
  ? path.join(root, "maps", mapArg === "circle" ? "circle.json" : "loop_city.json")
  : path.resolve(mapArg);
const data = JSON.parse(fs.readFileSync(mapFile, "utf8"));

// mulberry32 — PRNG deterministik buat seed Math.random
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function runOnce(mode) {
  const world = new World(data, 1.0);
  const comp = largestComponent(world);
  // start ala createSim (node paling kiri) — cuma buat titik avoid
  const start = [...comp].reduce((a, b) =>
    world.nodes.get(b)[0] < world.nodes.get(a)[0] ? b : a);
  const [sx, sy] = world.nodes.get(start);
  const orig = Math.random;
  Math.random = mulberry32(SEED);            // fleet awal identik antar mode
  const signals = new Signals(world, comp, mode);
  const traffic = new Traffic(world, comp, [sx, sy], NCARS);
  Math.random = orig;

  const N = seconds * 60;
  const waits = new Array(traffic.cars.length).fill(0);   // frame berhenti
  let dist = 0;
  // layanan per simpang: berapa kali fase hijau axis tsb dimulai
  const served = new Map();
  const prev = new Map();
  for (let f = 0; f < N; f++) {
    signals.update(traffic);
    traffic.update(signals, null, 1 / 60, null);
    traffic.cars.forEach((c, i) => {
      if (c.speed < 0.5) waits[i]++;
      dist += c.speed / 60;
    });
    if (signals.mode === "adaptive") {
      for (const [n, s] of signals.st) {
        const key = n + ":" + s.axis;
        const p = prev.get(n);
        if (s.ph === "g" && (!p || p.ph !== "g" || p.axis !== s.axis))
          served.set(key, (served.get(key) ?? 0) + 1);
        prev.set(n, { ph: s.ph, axis: s.axis });
      }
    }
  }
  const secs = waits.map((w) => w / 60).sort((a, b) => a - b);
  const pct = (p) => secs[Math.min(secs.length - 1, Math.floor(p * secs.length))];
  return {
    mode,
    avgWait: secs.reduce((a, b) => a + b, 0) / secs.length,
    p50: pct(0.5), p90: pct(0.9), max: secs[secs.length - 1],
    avgKmh: (dist / (NCARS * seconds)) * 3.6,
    totalKm: dist / 1000,
    flips: signals.mode === "adaptive"
      ? [...served.values()].reduce((a, b) => a + b, 0)
      : signals.nodeList.length * Math.floor(seconds / (2 * Signals.CYCLE / 60)) * 2,
  };
}

const res = [runOnce("fixed"), runOnce("adaptive")];
const fmt = (x) => (typeof x === "number" ? x.toFixed(1) : String(x));
console.log(`=== signal-bench map=${mapArg} cars=${NCARS} durasi=${seconds}s seed=${SEED} ===`);
const rows = [
  ["mode", "r tunggu (dtk)", "p50", "p90", "max", "km/j", "total km"],
  ...res.map((r) => [r.mode, fmt(r.avgWait), fmt(r.p50), fmt(r.p90), fmt(r.max), fmt(r.avgKmh), fmt(r.totalKm)]),
];
const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
rows.forEach((r) => console.log(r.map((c, i) => c.padStart(w[i])).join("  ")));
const d = ((res[1].avgWait - res[0].avgWait) / Math.max(res[0].avgWait, 0.01)) * 100;
console.log(`tunggu rata-rata: adaptive vs fixed = ${d >= 0 ? "+" : ""}${d.toFixed(1)}%`);
