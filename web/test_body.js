const fakeCanvas = { getContext: () => ({}) };
let totalSelesai = 0, totalSkor = 0;
for (let seed = 1; seed <= 3; seed++) {
  // Math.random gak bisa di-seed native — jalankan 3 run berturut, masing2 harus selesai >= 1 misi
  const g = new Game(fakeCanvas, { mode: "assistant", fps: 30 }, () => {});
  let finished = 0, stuck = 0, lastDriven = -1;
  for (let t = 0; t < 300 * 60; t++) {
    g.simTick();
    if (g.over) break;
    if (Math.abs(g.mission.driven - lastDriven) < 1e-9) stuck++; else { stuck = 0; lastDriven = g.mission.driven; }
    if (g.mission.n > finished) { finished = g.mission.n; }
    if (stuck > 60 * 60) break; // 1 menit total diam = gagal
  }
  console.log(`run ${seed}: misi selesai ${finished} | skor ${g.mission.score} | merah ${g.mission.reds} | tabrak ${g.mission.crashes} | snap ${g.mission.recovers} | driven terakhir ${Math.round(g.mission.driven)}m`);
  if (finished < 1) throw new Error(`run ${seed}: gak ada misi selesai dalam 5 menit sim`);
  totalSelesai += finished; totalSkor += g.mission.score;
}
console.log(`HASIL: total misi ${totalSelesai}, total skor ${totalSkor}`);
console.log("SEMUA PASS (headless)");
