// Parkir tepi jalan: bay parkir (beberapa kosong, beberapa terisi mobil)
// + mobil parkir sebagai obstacle. Dibangkitkan DETERMINISTIK dari hash id
// segmen (peta sama = parkiran sama). Bay nempel trotoar (offset ~0.72×
// halfw), laju nyetir kanan-dalam (0.25×halfw) tetap lewat — kaya parkir
// tepi jalan beneran. Bus cuma muat di bay panjang.

import { VEHICLES } from "./vehicles.js";

const hash01 = (n) => {
  let x = (n | 0) * 2654435761;
  x = (x ^ (x >>> 13)) * 1274126177;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
};

const PALETTE = [0xb8bcc4, 0x4a5568, 0x8c3b3b, 0x35507a, 0xd8d9dd, 0x5a6e4e];

export class Parked {
  constructor(world, comp) {
    this.world = world;
    this.bays = [];      // {cx, cy, ang, len, occupied, anchorNode, edge:{a,b}}
    this.cars = [];      // obstacle: {x, y, ang, len, wid}

    const w = world;
    const seen = new Set();
    for (const k of [...w.halfw.keys()].sort()) {
      const [a, b] = k.split(":").map(Number);
      if (seen.has(b)) continue;          // satu sisi ruas cukup (a:b & b:a dobel)
      if (!comp.has(a) || !comp.has(b)) continue;
      const [ax, ay] = w.nodes.get(a);
      const [bx, by] = w.nodes.get(b);
      const L = Math.hypot(bx - ax, by - ay);
      const halfw = w.segHalfw(a, b);
      if (L < 22 || halfw < 5.0) continue;          // ruas pendek/sempit: gak cocok parkir
      if (hash01(a * 31 + b * 7) >= 0.4) continue;   // ~40% ruas panjang punya parkiran

      seen.add(b);
      const ang = Math.atan2(by - ay, bx - ax);
      // koordinat bay: sepanjang ruas, nempel sisi kanan arah ang
      const rx = Math.sin(ang), ry = -Math.cos(ang);   // kanan ruas
      const off = halfw * 0.72;
      const longBay = hash01(a * 13 + b) < 0.12;       // sesekali bay panjang (bus)
      const bayLen = longBay ? 13.0 : 6.8;
      const usable = L - 14;                            // jauhin ujung ruas/simpang
      const nBays = Math.max(1, Math.min(longBay ? 1 : 3,
        Math.floor(usable / (bayLen + 1.5))));
      const pitch = usable / nBays;
      for (let i = 0; i < nBays; i++) {
        const tAlong = 7 + pitch * (i + 0.5);
        if (tAlong > L - 7) break;
        const cx = ax + (bx - ax) * (tAlong / L) + rx * off;
        const cy = ay + (by - ay) * (tAlong / L) + ry * off;
        // anchor = titik laju nyetir di depan bay (buat route pendekatan)
        const axn = cx - rx * off + Math.cos(ang) * 2.5;
        const ayn = cy - ry * off + Math.sin(ang) * 2.5;
        const bay = {
          cx, cy, ang, len: bayLen,
          anchorNode: w.nearestNode(axn, ayn, comp),
          occupied: hash01(a * 101 + b * 3 + i) < 0.45,
          x: cx, y: cy,
        };
        this.bays.push(bay);
        if (bay.occupied) {
          const type = (longBay && hash01(a + i * 17) < 0.5) ? VEHICLES.bus : VEHICLES.citycar;
          const color = PALETTE[Math.floor(hash01(b * 5 + i) * PALETTE.length)];
          this.cars.push({
            x: cx, y: cy, ang,
            len: type.len, wid: type.wid, color,
            key: `${a}:${b}:${i}`,
          });
        }
      }
    }
  }

  // bay kosong terdekat (untuk parkir otonom): muat kendaraan + radius jarak
  nearestFreeBay(x, y, needLen, maxDist = 220) {
    let best = null, bd = maxDist;
    for (const b of this.bays) {
      if (b.occupied || b.len < needLen) continue;
      const d = Math.hypot(b.cx - x, b.cy - y);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  // mobil parkir dalam radius r dari titik (buat collision & planner)
  near(x, y, r = 130) {
    return this.cars.filter((c) => Math.hypot(c.x - x, c.y - y) < r);
  }
}
