// HUD ala jevpilot: navigation card + minimap, driver dock (speed/limit/
// autopilot/kandidat/kamera), dialog crash & arrival, JSON inspector live,
// touch thumbstick. Semua binding DOM dipusatkan di sini; main.js cuma
// panggil ui.update(sim) tiap frame.

import { Signals } from "./sim/signals.js";

const $ = (id) => document.getElementById(id);
const rad = (d) => (d * Math.PI) / 180;

export class UI {
  constructor(sim, view, handlers) {
    this.sim = sim;
    this.view = view;
    this.h = handlers;           // {setPilot, pause, cam, newMission, restart}
    this.mapZoom = 1;
    this.mapOpen = true;
    this.frozen = null;          // JSON inspector dibekukan
    this.jsonTab = "request";
    this.lastCrashes = 0;
    this.lastMissions = 0;
    this._frame = 0;
    this._bind();
  }

  _bind() {
    $("autopilot").onclick = () => this.h.setPilot(!this.h.isPilot());
    $("candidates-toggle").onclick = (e) => {
      const on = !this.view.candVisible;
      this.view.candVisible = on;
      e.currentTarget.setAttribute("aria-pressed", String(on));
      this.toast(on ? "Kandidat tampil" : "Kandidat disembunyikan");
    };
    $("camera").onclick = () => this.h.cam();
    $("pause").onclick = () => this.h.pause();
    $("resume").onclick = () => this.h.pause(false);
    $("fullscreen").onclick = () => {
      document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    };
    $("map-toggle").onclick = () => {
      this.mapOpen = !this.mapOpen;
      $("minimap").classList.toggle("hidden", !this.mapOpen);
    };
    $("map-zoom-in").onclick = () => { this.mapZoom = Math.min(4, this.mapZoom * 1.3); };
    $("map-zoom-out").onclick = () => { this.mapZoom = Math.max(0.5, this.mapZoom / 1.3); };
    $("map-reset").onclick = () => { this.mapZoom = 1; };
    $("new-world").onclick = () => this.h.newMission();
    $("next-trip").onclick = () => { $("arrival").hidden = true; };
    $("retry-drive").onclick = () => { $("crash-dialog").close(); this.h.restart(); };
    $("scene-json").onclick = () => { $("json-dialog").showModal(); };
    $("help-fab").onclick = () => $("help-dialog").showModal();
    $("close-help").onclick = () => $("help-dialog").close();
    $("freeze-json").onclick = (e) => {
      this.frozen = this.frozen ? null : $("json-content").textContent;
      e.currentTarget.textContent = this.frozen ? "Lanjut" : "Bekukan";
      $("json-live").textContent = this.frozen ? "BEKU" : "LIVE · 4 Hz";
    };
    $("copy-json").onclick = () => navigator.clipboard.writeText($("json-content").textContent);
    document.querySelectorAll(".json-tabs button").forEach((b) => {
      b.onclick = () => {
        this.jsonTab = b.dataset.tab;
        document.querySelectorAll(".json-tabs button").forEach((x) =>
          x.classList.toggle("active", x === b));
      };
    });
    // touch: thumbstick + rem
    this.touch = { active: false, steer: 0, thr: 0, brk: 0 };
    const stick = $("stick"), knob = $("knob");
    const onStick = (ev) => {
      const r = stick.getBoundingClientRect();
      const dx = Math.max(-1, Math.min(1, (ev.clientX - r.left - r.width / 2) / (r.width / 2)));
      const dy = Math.max(-1, Math.min(1, (ev.clientY - r.top - r.height / 2) / (r.height / 2)));
      this.touch.steer = dx;
      this.touch.thr = Math.max(0, -dy);
      this.touch.brkStick = Math.max(0, dy);
      knob.style.left = `${41 + dx * 34}px`;
      knob.style.top = `${41 + dy * 34}px`;
    };
    stick.addEventListener("pointerdown", (ev) => {
      this.touch.active = true;
      stick.setPointerCapture(ev.pointerId);
      onStick(ev);
    });
    stick.addEventListener("pointermove", (ev) => { if (this.touch.active) onStick(ev); });
    stick.addEventListener("pointerup", () => {
      this.touch.active = false;
      this.touch.steer = this.touch.thr = this.touch.brkStick = 0;
      knob.style.left = "41px"; knob.style.top = "41px";
    });
    const brake = $("touch-brake");
    brake.addEventListener("pointerdown", () => { this.touch.brk = 1; });
    brake.addEventListener("pointerup", () => { this.touch.brk = 0; });
    if ("ontouchstart" in window) $("touch-controls").hidden = false;
  }

  touchControls() {
    return [this.touch.steer, this.touch.thr, Math.max(this.touch.brk, this.touch.brkStick || 0)];
  }

  // belokan berikutnya dari rute (buat navigation card)
  _nextTurn() {
    const { sim } = this;
    const route = sim.car.route, i = sim.car.wpI;
    const cum = sim.planner?.cum;
    let dist = 0;
    for (let k = i; k + 2 < route.length; k++) {
      const a = route[k], b = route[k + 1], c = route[k + 2];
      const d1x = b[0] - a[0], d1y = b[1] - a[1];
      const d2x = c[0] - b[0], d2y = c[1] - b[1];
      const ang = Math.atan2(d1x * d2y - d1y * d2x, d1x * d2x + d1y * d2y) * 180 / Math.PI;
      if (Math.abs(ang) > 25)
        return { kind: ang > 0 ? "Kanan" : "Kiri", icon: ang > 0 ? "↱" : "↰", dist };
      dist += Math.hypot(d1x, d1y);
    }
    return { kind: "Lurus", icon: "↑", dist };
  }

  update() {
    const { sim, view } = this;
    this._frame++;
    const car = sim.car, m = sim.mission;
    // speed & dock (skala 1:1: m/s -> km/j)
    $("speed").textContent = Math.round(car.speed * 3.6);
    const pilot = this.h.isPilot();
    $("pilot-label").textContent = pilot ? "Otopilot aktif" : "Ambil alih";
    $("autopilot").setAttribute("aria-checked", String(pilot));
    $("autopilot").classList.toggle("primary-on", pilot);
    $("pilot-state").textContent = sim.planner
      ? `${pilot ? "Otopilot" : "Manual"} · ${sim.planner.manName} [${sim.planner.src}]`
      : (pilot ? "Otopilot v3" : "Manual");
    // navigation card
    const turn = this._nextTurn();
    $("turn-icon").textContent = turn.icon;
    $("next-maneuver").textContent = turn.kind;
    $("turn-distance").textContent = turn.kind === "Lurus" ? "" : `dalam ${Math.round(turn.dist)} m`;
    const cum = sim.planner?.cum;
    $("remaining").textContent = cum
      ? `${Math.max(0, Math.round(cum[cum.length - 1] - (sim.planner.s || 0)))} m ke tujuan` : "—";
    // minimap tiap 6 frame
    if (this.mapOpen && this._frame % 6 === 0) this._minimap();
    // json inspector tiap 15 frame kalau kebuka & gak beku
    const jd = $("json-dialog");
    if (jd.open && !this.frozen && this._frame % 15 === 0) {
      const p = sim.planner;
      const payload = this.jsonTab === "request"
        ? (p?.lastRequest ?? { catatan: "menunggu keputusan pertama…" })
        : (p?.lastTable
            ? { choice: p.lastTable.find((c) => c.chosen)?.id, src: p.src,
                manuver: p.manName, kandidat: p.lastTable }
            : { catatan: "menunggu keputusan pertama…" });
      $("json-content").textContent = JSON.stringify(payload, null, 1);
    }
  }

  _minimap() {
    const cv = $("map-canvas"), ctx = cv.getContext("2d");
    const w = this.sim.world;
    const span = Math.max(w.maxx - w.minx, w.maxy - w.miny);
    const s = this.mapZoom * Math.min(cv.width, cv.height) / span;
    const car = this.sim.car;
    const cx = cv.width / 2, cy = cv.height / 2;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(s, s);
    ctx.translate(-car.x, -car.y);
    // jalan
    ctx.strokeStyle = "#b9bec7";
    ctx.lineWidth = 2.2 / s;
    ctx.beginPath();
    for (const seg of w.segs) {
      ctx.moveTo(seg.ax, seg.ay);
      ctx.lineTo(seg.bx, seg.by);
    }
    ctx.stroke();
    // rute
    ctx.strokeStyle = "#3e6ae1";
    ctx.lineWidth = 3.2 / s;
    ctx.beginPath();
    const route = car.route;
    ctx.moveTo(route[0][0], route[0][1]);
    for (let i = 1; i < route.length; i++) ctx.lineTo(route[i][0], route[i][1]);
    ctx.stroke();
    // goal
    if (this.sim.mission.goal != null) {
      const [gx, gy] = w.nodes.get(this.sim.mission.goal);
      ctx.fillStyle = "#e82127";
      ctx.beginPath();
      ctx.arc(gx, gy, 7 / s, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    // hero: segitiga ikut heading (diganbar layar biar ukurannya stabil)
    const scr = (x, y) => [cx + (x - car.x) * s, cy + (y - car.y) * s];
    const [hx, hy] = scr(car.x, car.y);
    const a = rad(car.heading);
    ctx.save();
    ctx.translate(hx, hy);
    ctx.rotate(a);
    ctx.fillStyle = "#171a20";
    ctx.beginPath();
    ctx.moveTo(9, 0); ctx.lineTo(-6, 5.5); ctx.lineTo(-6, -5.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  toast(msg, ms = 1600) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => t.classList.add("hidden"), ms);
  }

  // panggil tiap frame: deteksi misi selesai & tabrakan dari counter
  events() {
    const m = this.sim.mission;
    if (m.crashes > this.lastCrashes) {
      this.lastCrashes = m.crashes;
      $("crash-speed").textContent = Math.round(this.sim.car.speed * 3.6);
      $("crash-distance").textContent = Math.round(m.driven);
      if (!$("crash-dialog").open) $("crash-dialog").showModal();
      this.shake();
    }
    if (m.n > this.lastMissions) {
      this.lastMissions = m.n;
      const pts = m.score;
      $("arrival-summary").textContent =
        `${Math.round(m.routeLen)} m ditempuh dalam ${Math.round(m.driven)} m perjalanan — skor misi +${Math.max(0, pts - (this._prevScore || 0))}, total ${pts}.`;
      this._prevScore = pts;
      $("arrival").hidden = false;
      clearTimeout(this._arrT);
      this._arrT = setTimeout(() => { $("arrival").hidden = true; }, 6000);
    }
  }

  shake() {
    this.view.shakeT = 0.5;
  }
}
