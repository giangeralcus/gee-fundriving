// Brain v3 (fallback): proporsional + cap kecepatan tikungan (profil rute)
// + ACC. Skala 1:1 — semua jarak meter, kecepatan m/s.

const MAXV = 11.1;

export function mapBrain(state) {
  const he = state.headingErr;
  const gap = state.aheadGap;
  const vmax = state.maxv ?? MAXV;          // ikut skala kendaraan (bus lebih pelan)
  const v = (state.speedNorm ?? 0) * vmax;
  // target speed: cap tikungan + zona rambu + kehati-hatian saat arah masih melebar
  let tgt = Math.min(vmax, state.speedCap ?? state.capV ?? vmax);
  const sharp = Math.abs(he);
  if (sharp > 60) tgt = Math.min(tgt, 2.5);
  else if (sharp > 30) tgt = Math.min(tgt, 4.5);
  else if (sharp > 15) tgt = Math.min(tgt, 8);
  // steer: pure pursuit curvature (konsisten model sepeda); fallback he/40
  const steer = state.ppSteer ?? Math.max(-1.0, Math.min(1.0, he / 40.0));
  // mobil parkir di koridor kanan → bias geser kiri (makin dekat makin kenceng)
  const avoid = state.parkAhead != null ? 0.38 * Math.max(0, 1 - state.parkAhead / 30) : 0;
  const steerOut = Math.max(-1, Math.min(1, steer - avoid));
  let thr = 0, brk = 0;
  if (v > tgt + 0.6) brk = 1;
  else if (v < tgt - 0.4) thr = 1;
  let acc = "";
  if (gap != null) {
    if (gap < 8) { thr = 0; brk = 1; acc = "REM!"; }
    else if (gap < 16) { thr = 0; brk = 0.6; acc = "REM!"; }
    else if (gap < 30) { thr = 0; acc = "ikut"; }
    else if (gap < 55) { thr = Math.min(thr, 0.4); acc = "geser"; }
  }
  // anti-stall: nyaris berhenti tanpa rintangan -> kasi gas
  if (v < 0.3 && gap == null && tgt > 1) { thr = 0.6; brk = 0; }
  return [steerOut, thr, brk, { he, lat: state.lateral, acc }];
}
