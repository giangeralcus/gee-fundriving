// Web worker buat planner: sampling+rollout 13 kandidat jalan di thread
// terpisah (ala planner.worker.js jevpilot), main thread tetap 60fps.
import { decideCore, routeArc } from "./sim/planner.js";

let ctx = null;

self.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === "init") {
    ctx = {
      route: m.route,
      cum: routeArc(m.route),
      segs: m.segs,
      segGrid: new Map(m.segGrid),
    };
  } else if (m.type === "decide" && ctx) {
    decideCore(ctx, m.snap).then((r) => self.postMessage({ ...r, seq: m.seq }));
  }
};
