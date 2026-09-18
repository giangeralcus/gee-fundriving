// Brain v3 (fallback): steering proporsional + antisipasi tikungan (slow-in,
// fast-out) + ACC. Port setia dari map_brain di fundriving.py.

export function mapBrain(state) {
  const he = state.headingErr;
  const curv = state.curv ?? 0.0;
  const gap = state.aheadGap;
  const steer = Math.max(-1.0, Math.min(1.0, he / 40.0));
  const sharp = Math.abs(he);
  let thr, brk;
  if (curv > 50) { thr = 0.0; brk = 0.9; }
  else if (curv > 30) { thr = 0.25; brk = 0.0; }
  else if (curv > 15) { thr = 0.65; brk = 0.0; }
  else { thr = 1.0; brk = 0.0; }
  if (sharp > 90) { thr = 0.0; brk = 1.0; }
  else if (sharp > 45) { thr = Math.min(thr, 0.25); brk = 0.0; }
  else if (sharp > 20) thr = Math.min(thr, 0.6);
  let acc = "";
  if (gap != null) {
    if (gap < 10) { thr = 0.0; brk = 1.0; acc = "REM!"; }
    else if (gap < 20) { thr = 0.0; brk = 0.7; acc = "REM!"; }
    else if (gap < 35) { thr = 0.0; brk = 0.0; acc = "ikut"; }
    else if (gap < 60) { thr = Math.min(thr, 0.35); acc = "geser"; }
  }
  // anti-stall: nol speed + gak ada rintangan -> jangan deadlock di rem
  if ((state.speedNorm ?? 0) < 0.05 && gap == null && brk > 0) {
    thr = 0.35; brk = 0.0;
  }
  return [steer, thr, brk, { he, lat: state.lateral, acc }];
}
