#!/usr/bin/env node
// Benchmark headless versi JS: jalankan sim core di Node tanpa render —
// buat verifikasi port & smoke test tiap perubahan sim.
//   node tools/benchmark.mjs [--seconds 240] [--brain v4|v3] [--map loop]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSim } from "../webapp/src/sim/sim.js";

const args = process.argv.slice(2);
const get = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : dflt;
};
const seconds = Number(get("--seconds", "240"));
const brain = get("--brain", "v4");
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const mapArg = get("--map", "loop");
const mapFile = mapArg === "loop"
  ? path.join(root, "maps", "loop_city.json")
  : path.resolve(mapArg);

const data = JSON.parse(fs.readFileSync(mapFile, "utf8"));
const sim = createSim(data, { brain });
const total = seconds * 60;
let fi = 0;
const t0 = performance.now();
for (; fi < total; fi++) {
  sim.step(fi);
  if (sim.mission.n >= 1) break; // parity dgn Python headless: berhenti di misi pertama
}
const dt = (performance.now() - t0) / 1000;
const s = sim.stats();
console.log(JSON.stringify({ brain, map: path.basename(mapFile), real_s: +dt.toFixed(1), fps_efektif: Math.round((fi + 1) / dt), ...s }));
