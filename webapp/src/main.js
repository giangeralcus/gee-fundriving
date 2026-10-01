// Gee-FunDriving Web — bootstrap ala jevpilot: loading screen, muat peta,
// sim 60fps fixed-step, HUD lengkap, manual (WASD/stick) atau otopilot (J).
// Param URL: ?brain=v3  ?jev=https://...  ?traffic=1 (aktifkan mobil AI)

import { createSim } from "./sim/sim.js";
import { Scene3D } from "./scene.js";
import { UI } from "./ui.js";
import { getVehicle } from "./sim/vehicles.js";

// ---- settings (localStorage) — param URL tetap menang kalau ada -----------
const SETTINGS_KEY = "gfd-web-settings";
const SET_DEFAULTS = { mode: "otopilot", speed: 1.0, map: "loop", brain: "v4", traffic: false, vehicle: "citycar" };
function loadSettings() {
  try { return { ...SET_DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") }; }
  catch (_e) { return { ...SET_DEFAULTS }; }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_e) { /* ignore */ }
}
const settings = loadSettings();

const params = new URLSearchParams(location.search);
if (params.get("jev")) globalThis.JEV_API_URL = params.get("jev");
const brain = params.get("brain") || settings.brain || "v4";
const traffic = params.has("traffic")
  ? (params.get("traffic") === "1" ? undefined : 0)
  : (settings.traffic ? undefined : 0);
// peta: "loop" (default) atau "circle" — bisa juga path JSON langsung
const mapKey = params.get("map") || settings.map || "loop";
const mapUrl = mapKey.startsWith("/") || mapKey.endsWith(".json")
  ? mapKey : `/${mapKey === "circle" ? "circle" : "loop_city"}.json`;

const $ = (id) => document.getElementById(id);
const setLoad = (msg, pct) => {
  $("loading-message").textContent = msg;
  if (pct != null) $("loading-bar").style.width = `${pct}%`;
};

let sim = null, view = null, ui = null;
let auto = settings.mode !== "manual";
let paused = true;      // menu utama di depan: dunia ke-render beku sampai MULAI
let menuOpen = true;
let steerManual = 0;
let turbo = 1;   // 1×/2×/4× — skala 1:1 bikin misi real-time, ini buat ngebut nonton
const keys = {};

addEventListener("keydown", (ev) => {
  keys[ev.code] = true;
  if (menuOpen) return;   // menu & dialog punya tombolnya sendiri
  if (document.getElementById("settings-dialog")?.open) return;
  if (document.getElementById("about-dialog")?.open) return;
  if (ev.code === "KeyJ") setPilot(!auto);
  if (ev.code === "KeyC" && view) ui.toast(`kamera: ${view.cycleCam()}`);
  if (ev.code === "KeyP" && view) togglePause();
  if (ev.code === "Escape") togglePause();
  if (ev.code === "KeyR" && sim) newMission();
  if (ev.code === "KeyK" && sim) startParkingManual();
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

function openMenu() {
  menuOpen = true;
  paused = true;
  $("paused-overlay").hidden = true;
  const m = $("main-menu");
  m.hidden = false;
  m.classList.remove("gone");
}

function startDriving() {
  menuOpen = false;
  const m = $("main-menu");
  m.classList.add("gone");
  setTimeout(() => { if (!menuOpen) m.hidden = true; }, 380);   // tunggu fade selesai
  paused = false;
}

function setSetting(k, v) {
  if (k === "mode") {
    settings.mode = v;
    saveSettings();
    setPilot(v === "otopilot");
  } else if (k === "speed") {
    settings.speed = parseFloat(v) || 1.0;
    saveSettings();
    sim?.car.setSpeedScale(settings.speed);
    ui?.toast(`kecepatan basis ${settings.speed}×`);
  } else if (k === "map" || k === "brain" || k === "traffic" || k === "vehicle") {
    settings[k] = k === "traffic" ? v === "on" : v;
    saveSettings();
    // tiga ini ikut konstruksi dunia -> diterapkan dengan memuat ulang;
    // param URL dibersihkan biar setelan jadi sumber kebenaran
    const p = new URLSearchParams(location.search);
    p.set("map", settings.map);
    p.delete("brain");
    p.delete("traffic");
    location.search = p.toString();
  }
}

function newMission() {
  if (!sim) return;
  const near = sim.world.nearestNode(sim.car.x, sim.car.y, sim.comp);
  sim.mission.new(near, sim.car);
  ui?.toast("Misi baru");
}

// waypoint ala "add stop": reroute dari posisi mobil lewat daftar node via
function setVia(vias) {
  if (!sim) return;
  if (!vias.length) return clearVia();
  const from = sim.world.nearestNode(sim.car.x, sim.car.y, sim.comp);
  if (sim.mission.newVia(from, vias, sim.car)) {
    ui?.toast(vias.length === 1 ? "Waypoint diset — rute lewat situ" : `Rute via ${vias.length} waypoint`);
  } else {
    ui?.toast("Waypoint gak bisa diroute");
  }
}

function clearVia() {
  if (!sim) return;
  const near = sim.world.nearestNode(sim.car.x, sim.car.y, sim.comp);
  sim.mission.new(near, sim.car);
  ui?.toast("Waypoint dihapus — misi baru");
}

// parkir otopilot manual [K]: nyari bay kosong terdekat & parkir di sana
function startParkingManual() {
  if (!sim || sim.mission.parking) return;
  const bay = sim.parked?.nearestFreeBay(sim.car.x, sim.car.y, sim.car.len + 1.6, 260);
  if (!bay) { ui?.toast("Gak ada bay parkir kosong di dekat sini"); return; }
  if (sim.mission.startParking(sim.car, bay)) ui?.toast("Parkir otopilot — nyari slot…");
  else ui?.toast("Gak bisa route ke parkiran");
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
  speedScale: settings.speed,
  vehicle: getVehicle(settings.vehicle),
  widthScale: 1.0,   // skala 1:1 — peta loop city sudah real-meter
  makeWorker: brain === "v4" && typeof Worker !== "undefined"
    ? () => new Worker(new URL("./planner.worker.js", import.meta.url), { type: "module" })
    : null,
});
view = new Scene3D($("drive-area") ?? document.querySelector(".drive-area"), sim.world, sim.car.spec, sim.signs, sim.parked, sim.signals);
window.__gfd = {};

setLoad("Menyiapkan HUD…", 85);
ui = new UI(sim, view, {
  isPilot: () => auto,
  setPilot,
  pause: (f) => togglePause(f),
  cam: () => ui.toast(`kamera: ${view.cycleCam()}`),
  newMission,
  setVia,
  clearVia,
  start: startDriving,
  openMenu,
  setSetting,
  getSettings: () => settings,
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
// world picker: ganti dunia = reload dengan param map (persist ke settings)
const worldSel = $("world-select");
worldSel.value = mapKey === "circle" ? "circle" : "loop";
worldSel.onchange = () => setSetting("map", worldSel.value);
window.__gfd.sim = sim;
window.__gfd.view = view;
window.__gfd.ui = ui;
window.__gfd.settings = settings;
openMenu();   // tampilkan menu utama di atas dunia yang udah siap

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
