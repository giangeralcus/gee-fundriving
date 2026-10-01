// Test body: Game.simTick asli, multi-scale kecepatan, deteksi macet.
const fakeCanvas = { getContext: () => ({}) };
let totalSelesai = 0, totalSkor = 0;
for (const scale of [1.0, 0.6]) {
  for (let run = 1; run <= 2; run++) {
    const g = new Game(fakeCanvas, { mode: "assistant", fps: 30, speed: scale }, () => {});
    if (Math.abs(g.car.MAXV - 4.2 * scale) > 1e-9) throw new Error("MAXV gak ke-scale");
    if (g.signals.nodeList.length !== 6) throw new Error(`lampu = ${g.signals.nodeList.length}, harusnya 6 (paritas desktop)`);
    if (g.traffic.cars.length !== 13) throw new Error(`mobil AI = ${g.traffic.cars.length}, harusnya 13`);
    let finished = 0, stuck = 0, lastDriven = -1;
    for (let t = 0; t < 240 * 60; t++) {
      g.simTick();
      if (g.over) break;
      if (Math.abs(g.mission.driven - lastDriven) < 1e-9) stuck++;
      else { stuck = 0; lastDriven = g.mission.driven; }
      if (g.mission.n > finished) finished = g.mission.n;
      if (stuck > 60 * 60) throw new Error(`scale ${scale} run ${run}: macet 1 menit penuh di ${Math.round(g.mission.driven)}m`);
    }
    console.log(`scale ${scale} run ${run}: misi ${finished} | skor ${g.mission.score} | merah ${g.mission.reds} | tabrak ${g.mission.crashes} | snap ${g.mission.recovers} | tempuh ${Math.round(g.mission.driven)}m`);
    if (finished < 1) throw new Error(`scale ${scale} run ${run}: gak ada misi selesai dalam 4 menit sim`);
    totalSelesai += finished; totalSkor += g.mission.score;
  }
}
console.log(`HASIL: total misi ${totalSelesai}, total skor ${totalSkor}`);
console.log("SEMUA PASS (headless)");
