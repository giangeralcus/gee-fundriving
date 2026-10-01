// Estimasi waktu sampai (ETA) — ala navigasi Google Maps/Waze.
// MATEMATIKANYA (jujur, semua asumsi tertulis):
//
//   ETA = Σ Δs / v_eff(s)                 (integrasi numerik sisa rute, Δs=6 m)
//         + Σ lampu: sisa fase MERAH pada saat estimasi tiba
//         + Σ STOP : v/(2·rem) + v/(2·gas) + 0,8 s dwell
//         + parkir: +20 s maneuver (mode parkir)
//
// - v_eff(s) = min(batas kendaraan, profil tikungan capAt, zona rambu) —
//   kayak Maps yang ngerti limit jalan, kita ngerti profil rutenya sendiri.
// - Lampu: siklus DETERMINISTIK (fase = floor(frame/420) % 2, semua simpang
//   sefase) — jadi sisa merah saat tiba bisa dihitung eksak, bukan tebakan.
// - Penalti STOP dihitung sebagai SELISIH vs ngebut lewat (biar jarak yang
//   sudah dihitung integrasi gak dobel): decel ekstra = v/2b, accel ekstra
//   = v/2a (rata-rata kecepatan separuh), plus dwell penuh karena beneran
//   berhenti.

import { capAtV } from "./world.js";
import { Signals } from "./signals.js";

const STEP = 6.0;        // m per langkah integrasi
const STOP_DWELL = 0.8;  // s berhenti di rambu STOP
const PARK_MANEUVER_S = 20;  // estimasi rata-rata maneuver parkir

// titik pada rute di arc s (walk polyline dengan tabel kumulatif car.cum)
function pointAtArc(route, cum, s) {
  let lo = 0, hi = cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid; else hi = mid;
  }
  const seg = Math.max(0, Math.min(1, (s - cum[lo]) / Math.max(cum[lo + 1] - cum[lo], 1e-6)));
  const a = route[lo], b = route[lo + 1];
  return [a[0] + (b[0] - a[0]) * seg, a[1] + (b[1] - a[1]) * seg];
}

// proyeksikan titik ke polyline rute → { s (arc), dist }
function projectOnRoute(route, cum, px, py) {
  let best = { s: 0, dist: 1e9 };
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i], b = route[i + 1];
    const abx = b[0] - a[0], aby = b[1] - a[1];
    const ab2 = abx * abx + aby * aby + 1e-9;
    const t = Math.max(0, Math.min(1, ((px - a[0]) * abx + (py - a[1]) * aby) / ab2));
    const d = Math.hypot(px - (a[0] + abx * t), py - (a[1] + aby * t));
    if (d < best.dist) best = { s: cum[i] + t * (cum[i + 1] - cum[i]), dist: d };
  }
  return best;
}

export function estimateEta({ car, mission, signs, signals, frame }) {
  const route = car.route;
  if (!route || route.length < 2) return null;
  const cum = car.cum;
  const sNow = car.arcPos();
  const sEnd = cum[cum.length - 1];
  if (sEnd <= sNow + 1) return null;

  // kecepatan efektif per arc (dipakai integrasi & penalti STOP)
  const vAt = (s, x, y) => {
    let v = Math.min(car.MAXV, capAtV(car.caps, s));
    const z = signs ? signs.speedLimitAt(x, y) : null;
    if (z != null) v = Math.min(v, z);
    return Math.max(v, 1.5);
  };

  // 1. waktu jalan murni + arc time table buat estimasi kedatangan di tiap titik
  let sec = 0;
  const samples = [];
  for (let s = sNow; s < sEnd; s += STEP) {
    const [x, y] = pointAtArc(route, cum, s);
    const v = vAt(s, x, y);
    samples.push({ s, sec, x, y, v });
    sec += STEP / v;
  }

  let stops = 0;
  const secAt = (s) => {
    // waktu kumulatif di arc s (interpolasi linier antar sampel)
    const i = Math.min(samples.length - 1, Math.floor((s - sNow) / STEP));
    const sm = samples[Math.max(0, i)];
    return sm.sec + (s - sm.s) / sm.v;
  };

  // 2. lampu merah di depan sepanjang rute
  if (signals) {
    signals.pos.forEach(([lx, ly]) => {
      const p = projectOnRoute(route, cum, lx, ly);
      if (p.dist > 8 || p.s < sNow + 3 || p.s > sEnd - 5) return;
      // sumbu pendekat kita = arah tangent rute di titik itu
      const [tx, ty] = pointAtArc(route, cum, Math.min(p.s + 3, sEnd - 0.5));
      const axis = Math.abs(tx - lx) >= Math.abs(ty - ly) ? 0 : 1;
      const tArr = signals.frame + secAt(p.s) * 60;
      // CYCLE itu STATIC field — akses lewat kelasnya (Signals.CYCLE), bukan
      // instance (signals.CYCLE === undefined → NaN)
      const phase = Math.floor(tArr / Signals.CYCLE) % 2;
      if (phase !== axis) {
        const rem = Signals.CYCLE - (tArr % Signals.CYCLE);
        sec += rem / 60;
        stops += 1;
      }
    });
  }

  // 3. rambu STOP di depan sepanjang rute
  if (signs) {
    for (const [sx, sy] of signs.stops) {
      const p = projectOnRoute(route, cum, sx, sy);
      if (p.dist > 8 || p.s < sNow + 3 || p.s > sEnd - 5) continue;
      const [x, y] = pointAtArc(route, cum, p.s);
      const v = vAt(p.s, x, y);
      sec += v / (2 * car.BRAKE) + v / (2 * car.ACC) + STOP_DWELL;
      stops += 1;
    }
  }

  // 4. mode parkir: rute ke bay + maneuver
  if (mission && mission.parking) sec += PARK_MANEUVER_S;

  const dist = sEnd - sNow;
  return { sec, dist, avg: dist / sec, stops };
}
