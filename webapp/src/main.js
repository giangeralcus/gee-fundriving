// Gee-FunDriving Web — bootstrap ala jevpilot: loading screen, muat peta,
// sim 60fps fixed-step, HUD lengkap, manual (WASD/stick) atau otopilot (J).
// Param URL: ?brain=v3  ?jev=https://...  ?traffic=1 (aktifkan mobil AI)

import { createSim } from "./sim/sim.js";
import { Scene3D } from "./scene.js";
import { UI } from "./ui.js";

const params = new URLSearchParams(location.search);
if (params.get("jev")) globalThis.JEV_API_URL = params.get("jev");
const brain = params.get("brain") || "v4";
const traffic = params.get("traffic") === "1" ? undefined : 0;
// peta: "loop" (default) atau "circle" — bisa juga path JSON langsung
const mapKey = params.get("map") || "loop";
const mapUrl = mapKey.startsWith("/") || mapKey.endsWith(".json")
  ? mapKey : `/${mapKey === "circle" ? "circle" : "loop_city"}.json`;

const $ = (id) => document.getElementById(id);
const setLoad = (msg, pct) => {
  $("loading-message").textContent = msg;
  if (pct != null) $("loading-bar").style.width = `${pct}%`;
};

let sim = null, view = null, ui = null;
let auto = true, paused = false;
let steerManual = 0;
let turbo = 1;   // 1×/2×/4× — skala 1:1 bikin misi real-time, ini buat ngebut nonton
const keys = {};

addEventListener("keydown", (ev) => {
  keys[ev.code] = true;
  if (ev.code === "KeyJ") setPilot(!auto);
  if (ev.code === "KeyC" && view) ui.toast(`kamera: ${view.cycleCam()}`);
  if (ev.code === "KeyP" && view) togglePause();
  if (ev.code === "KeyR" && sim) newMission();
  if (ev.code === "KeyT") {
    turbo = turbo === 1 ? 2 : turbo === 2 ? 4 : 1;
    ui?.toast(`turbo ${turbo}×`);
  }
  if (ev.code === "Space") ev.preventDefault();
});
addEventListener("keyup", (ev) => { keys[ev.code] = false; });

function setPilot(on) {
  auto = on;
  steerManual = 0;
  ui?.toast(on ? "Otopilot Gee aktif" : "Manual — setir di tangan lo");
}

function togglePause(force) {
  paused = force ?? !paused;
  $("paused-overlay").hidden = !paused;
}

function newMission() {
  if (!sim) return;
  const near = sim.world.nearestNode(sim.car.x, sim.car.y, sim.comp);
  sim.mission.new(near, sim.car);
  ui?.toast("Misi baru");
}

function manualControls() {
  // gabung keyboard + thumbstick; steering di-ramp biar halus
  const kSteer = (keys.KeyA || keys.ArrowLeft ? -1 : 0) + (keys.KeyD || keys.ArrowRight ? 1 : 0);
  const tSteer = ui ? ui.touchControls()[0] : 0;
  const steerTarget = Math.max(-1, Math.min(1, kSteer + tSteer));
  steerManual += Math.max(-0.06, Math.min(0.06, steerTarget - steerManual));
  const thr = Math.min(1, (keys.KeyW || keys.ArrowUp ? 1 : 0) + (ui?.touchControls()[1] ?? 0));
  const brk = Math.max(keys.KeyS || keys.ArrowDown ? 1 : 0, keys.Space ? 1 : 0,
                       ui?.touchControls()[2] ?? 0);
  return [steerManual, thr, brk];
}

// ---- loading & bootstrap ------------------------------------------------
setLoad("Memuat peta…", 15);
const resp = await fetch(mapUrl);
if (!resp.ok) {
  setLoad(`Peta gagal di-load (${resp.status}) — jalankan dari root repo: npm run dev`, null);
  throw new Error("map load gagal");
}
const data = await resp.json();
setLoad("Membangun dunia 3D…", 45);
await new Promise((r) => setTimeout(r, 30));   // biar teks loading ke-sempat render

sim = createSim(data, {
  brain,
  traffic,
  widthScale: 1.0,   // skala 1:1 — peta loop city sudah real-meter
  makeWorker: brain === "v4" && typeof Worker !== "undefined"
    ? () => new Worker(new URL("./planner.worker.js", import.meta.url), { type: "module" })
    : null,
});
view = new Scene3D($("drive-area") ?? document.querySelector(".drive-area"), sim.world);
window.__gfd = {};

setLoad("Menyiapkan HUD…", 85);
ui = new UI(sim, view, {
  isPilot: () => auto,
  setPilot,
  pause: (f) => togglePause(f),
  cam: () => ui.toast(`kamera: ${view.cycleCam()}`),
  newMission,
  restart: () => {
    // ulang misi dari titik terdekat, reset penalti misi ini
    const near = sim.world.nearestNode(sim.car.x, sim.car.y, sim.comp);
    sim.mission.new(near, sim.car);
    sim.car.speed = 0;
  },
});
ui.lastCrashes = sim.mission.crashes;
ui.lastMissions = sim.mission.n;

// handler tombol pause overlay perlu setPilot dsb — sambungkan camera-name
$("camera-name").textContent = view.camMode;
// world picker: ganti dunia = reload dengan param map
const worldSel = $("world-select");
worldSel.value = mapKey === "circle" ? "circle" : "loop";
worldSel.onchange = () => {
  const p = new URLSearchParams(location.search);
  p.set("map", worldSel.value);
  location.search = p.toString();
};
window.__gfd.sim = sim;
window.__gfd.view = view;
window.__gfd.ui = ui;

// ---- loop fixed-step ------------------------------------------------------
// rAF saat tab terlihat; interval cadangan saat hidden (rAF pause total)
const STEP = 1000 / 60;
let acc = 0, last = performance.now(), fi = 0;
let fpsSm = 60;

function pump(maxDt) {
  let dt = performance.now() - last;
  last = performance.now();
  if (dt > maxDt) dt = maxDt;
  dt *= turbo;   // turbo = maju waktu lebih cepat, fisika tetap 60 langkah/s-sim
  fpsSm += (1000 / Math.max(dt / turbo, 1) - fpsSm) * 0.05;
  acc += dt;
  let stepped = false;
  while (acc >= STEP && fi < 10_000_000) {
    acc -= STEP;
    sim.step(fi++, paused ? null : (auto ? null : manualControls()));
    stepped = true;
  }
  if (stepped) ui.events();
  return stepped;
}

function frame() {
  requestAnimationFrame(frame);
  if (paused) {
    view.update(sim, 0);
    return;
  }
  pump(250);
  ui.update();
  view.update(sim, auto ? 0 : steerManual);
}

setInterval(() => { if (document.hidden && !paused) pump(1000); }, 200);
requestAnimationFrame(frame);

setLoad("Siap. Selamat nyetir!", 100);
setTimeout(() => $("loading").classList.add("done"), 350);
