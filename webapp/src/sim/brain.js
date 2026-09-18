// Brain v3 (fallback): proporsional + cap kecepatan tikungan (profil rute)
// + ACC. Skala 1:1 — semua jarak meter, kecepatan m/s.

const MAXV = 11.1;

export function mapBrain(state) {
  const he = state.headingErr;
  const gap = state.aheadGap;
  const v = (state.speedNorm ?? 0) * MAXV;
  // target speed: cap tikungan + kehati-hatian saat arah masih melebar
  let tgt = Math.min(MAXV, state.capV ?? MAXV);
  const sharp = Math.abs(he);
  if (sharp > 60) tgt = Math.min(tgt, 2.5);
  else if (sharp > 30) tgt = Math.min(tgt, 4.5);
  else if (sharp > 15) tgt = Math.min(tgt, 8);
  const steer = Math.max(-1.0, Math.min(1.0, he / 40.0));
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
  return [steer, thr, brk, { he, lat: state.lateral, acc }];
}
