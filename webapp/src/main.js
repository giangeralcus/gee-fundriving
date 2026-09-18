// Gee-FunDriving Web — bootstrap: muat peta, jalanin sim 60fps, render 3D,
// manual (WASD) atau autopilot (J, brain v4 ala JevPilot).
// Param URL: ?map=/loop_city.json  ?brain=v3  ?jev=https://... (hook LLM)

import { createSim } from "./sim/sim.js";
import { Scene3D } from "./scene.js";

const params = new URLSearchParams(location.search);
if (params.get("jev")) globalThis.JEV_API_URL = params.get("jev");
const brain = params.get("brain") || "v4";
const mapUrl = params.get("map") || "/loop_city.json";

const $hud = document.getElementById("hud");
const $msg = document.getElementById("msg");

const keys = {};
let auto = true;
let steerManual = 0;

addEventListener("keydown", (ev) => {
  keys[ev.code] = true;
  if (ev.code === "KeyJ") {
    auto = !auto;
    flash(auto ? "AUTOPILOT ON" : "MANUAL");
  }
  if (ev.code === "KeyC" && view) flash(`kamera: ${view.toggleCam()}`);
  if (ev.code === "KeyR" && sim) {
    const near = sim.world.nearestNode(sim.car.x, sim.car.y, sim.comp);
    sim.mission.new(near, sim.car);
    flash("misi baru");
  }
});
addEventListener("keyup", (ev) => { keys[ev.code] = false; });

let flashMsg = "";
function flash(t) { flashMsg = t; setTimeout(() => { flashMsg = ""; }, 1500); }

let sim = null, view = null;

const resp = await fetch(mapUrl);
if (!resp.ok) {
  $msg.textContent = `peta gak ke-load (${resp.status}) — jalankan dari root repo: python -m http.server, buka /webapp/`;
  throw new Error("map load gagal");
}
const data = await resp.json();
sim = createSim(data, {
  brain,
  makeWorker: brain === "v4" && typeof Worker !== "undefined"
    ? () => new Worker(new URL("./planner.worker.js", import.meta.url), { type: "module" })
    : null,
});
view = new Scene3D(document.getElementById("app"), sim.world);
window.__gfd = { sim, view };   // debug dari console/automation

// loop fixed-step: sim selalu 60 langkah/detik — digerakkan rAF saat tab
// terlihat, dan interval cadangan saat tab tersembunyi (rAF pause total di
// tab hidden, tapi dunia tetap jalan; render menyusul pas terlihat lagi)
const STEP = 1000 / 60;
let acc = 0, last = performance.now(), fi = 0;
let fps = 60, fpsSm = 60;

function pump(maxDt) {
  let dt = performance.now() - last;
  last = performance.now();
  if (dt > maxDt) dt = maxDt;
  fps = 1000 / Math.max(dt, 1);
  fpsSm += (fps - fpsSm) * 0.05;
  acc += dt;
  let st = null;
  while (acc >= STEP && fi < 10_000_000) {
    acc -= STEP;
    const { state, dec } = sim.step(fi++, auto ? null : manualControls());
    st = { state, dec };
  }
  if (st) hud(st);
}

function frame() {
  requestAnimationFrame(frame);
  pump(250);
  view.update(sim);
}

function manualControls() {
  // steering di-ramp biar gak patah-patah (ala steering stick jevpilot)
  const tgt = (keys.KeyA || keys.ArrowLeft ? -1 : 0) + (keys.KeyD || keys.ArrowRight ? 1 : 0);
  steerManual += Math.max(-0.06, Math.min(0.06, tgt - steerManual));
  const thr = keys.KeyW || keys.ArrowUp ? 1 : 0;
  const brk = keys.KeyS || keys.ArrowDown ? 1 : 0;
  return [steerManual, thr, brk];
}

// catat kontrol manual terakhir biar HUD bisa nampilin mode aktif
function hud({ state, dec }) {
  const m = sim.mission;
  const gx = m.goal != null ? sim.world.nodes.get(m.goal) : null;
  const gdist = gx ? Math.hypot(sim.car.x - gx[0], sim.car.y - gx[1]) : 0;
  const mode = auto
    ? (sim.planner ? `otopilot ${dec.man} [${dec.src}]` : "otopilot v3")
    : "manual (WASD)";
  $hud.innerHTML =
    `Gee-FunDriving 3D | ${sim.world.meta.name}<br>` +
    `speed ${sim.car.speed.toFixed(1)}  alive ${Math.floor(sim.car.aliveTime / 60)}s<br>` +
    `${mode}<br>` +
    `misi #${m.n + 1} → ${gdist.toFixed(0)}m | skor ${m.score} | merah ${m.reds} tabrak ${m.crashes}<br>` +
    `${fpsSm.toFixed(0)} fps`;
}

setInterval(() => { if (document.hidden) pump(1000); }, 200);
requestAnimationFrame(frame);
