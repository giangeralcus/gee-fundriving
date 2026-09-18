#!/usr/bin/env node
// Test otomatis sim versi web (skala 1:1). Ngukur hal-hal yang "pastikan":
//   1. lampu merah: mobil BERHENTI sebelum garis, gak nyabrang, jalan lagi
//      pas hijau
//   2. lajur kanan: posisi mobil konsisten di KANAN garis tengah rute
//      (lajur kiri buat lawan arah)
//   3. misi selesai & metrik sehat
// Pakai: node tools/test-sim.mjs [--brain v4] [--seconds 300] [--traffic 1]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSim } from "../webapp/src/sim/sim.js";

const args = process.argv.slice(2);
const get = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const brain = get("--brain", "v4");
const seconds = Number(get("--seconds", "300"));
const traffic = get("--traffic", "0") === "1" ? undefined : 0;

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(fs.readFileSync(path.join(root, "maps", "loop_city.json"), "utf8"));
const sim = createSim(data, { brain, traffic });

const rad = (d) => (d * Math.PI) / 180;
const redEvents = [];      // {minD, waited, passed}
let curRed = null;
const rightOff = [];       // offset bertanda dari garis tengah rute (m, + = kanan)
let maxV = 0, movingSum = 0, movingN = 0;

const total = seconds * 60;
for (let fi = 0; fi < total; fi++) {
  sim.step(fi);
  const car = sim.car;
  maxV = Math.max(maxV, car.speed);
  if (car.speed > 1) { movingSum += car.speed; movingN++; }

  // offset bertanda dari segmen rute aktif (positif = kanan arah rute)
  const a = car.route[car.wpI], b = car.route[car.wpI + 1];
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = Math.hypot(dx, dy) + 1e-6;
  const relx = car.x - a[0], rely = car.y - a[1];
  rightOff.push((-dy * relx + dx * rely) / L);

  // pantau pendekatan lampu merah di koridor depan
  const fx = Math.cos(rad(car.heading)), fy = Math.sin(rad(car.heading));
  let red = null;
  sim.signals.pos.forEach(([lx, ly], j) => {
    const ddx = lx - car.x, ddy = ly - car.y;
    const fwd = ddx * fx + ddy * fy;
    if (2 < fwd && fwd < 45 && Math.abs(-ddx * fy + ddy * fx) < 6) {
      const axis = Math.abs(fx) >= Math.abs(fy) ? 0 : 1;
      if (!sim.signals.green(sim.signals.nodeList[j], axis))
        if (!red || fwd < red.d) red = { d: fwd };
    }
  });
  if (red) {
    if (!curRed) curRed = { minD: red.d, waited: 0 };
    curRed.minD = Math.min(curRed.minD, red.d);
    curRed.waited++;
  } else if (curRed) {
    if (curRed.waited > 60) redEvents.push(curRed);   // reda >= 1 dtk = event
    curRed = null;
  }
  if (sim.mission.n >= 1) break;
}
const m = sim.mission;
const s = sim.stats();

// statistik lajur: median & IQR offset kanan
const sorted = [...rightOff].sort((a, b) => a - b);
const med = sorted[Math.floor(sorted.length / 2)];
const p25 = sorted[Math.floor(sorted.length * 0.25)];
const p75 = sorted[Math.floor(sorted.length * 0.75)];

const fails = [];
if (s.selesai !== true) fails.push("misi gak selesai");
if (m.reds > 0) fails.push(`nyabrang merah ${m.reds}x`);
for (const [i, e] of redEvents.entries())
  if (e.minD < 2.5) fails.push(`lampu #${i}: cuma berhenti ${e.minD.toFixed(1)} m sebelum garis`);
if (!(med > 0.8 && med < 3.2)) fails.push(`lajur kanan-dalam gak stabil (median ${med.toFixed(2)} m)`);
if (p25 < 0.5) fails.push(`ada saat nyeret lajur kiri (p25 ${p25.toFixed(2)} m)`);
if (maxV > 11.5) fails.push(`kecepatan lewat batas (${maxV.toFixed(1)} m/s)`);

console.log(`=== test-sim brain=${brain} traffic=${traffic === 0 ? "off" : "on"} ===`);
console.log(`misi selesai : ${s.selesai ? "YA" : "TIDAK"} (${sim.mission.n}x, skor ${m.score})`);
console.log(`tempuh       : ${s.tempuh_m} m dalam ${s.detik_sim} dtk (avg ${(s.tempuh_m / Math.max(s.detik_sim, 1) * 3.6).toFixed(0)} km/j, puncak ${(maxV * 3.6).toFixed(0)} km/j)`);
console.log(`lampu merah  : ${redEvents.length} pendekatan, dilanggar ${m.reds}x, stop terdekat ${redEvents.length ? Math.min(...redEvents.map((e) => e.minD)).toFixed(1) : "-"} m`);
console.log(`lajur kanan  : median +${med.toFixed(2)} m (IQR ${p25.toFixed(2)}..${p75.toFixed(2)} m, positif = kanan)`);
console.log(`lainnya      : tabrak ${m.crashes}, snap ${m.recovers}, offroad ${s.offroad_pct}%`);
if (fails.length) {
  console.log("GAGAL:\n - " + fails.join("\n - "));
  process.exit(1);
}
console.log("SEMUA CEK LOLOS ✓");
