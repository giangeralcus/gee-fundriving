// Scene Three.js gaya jevpilot: dunia siang terang, jalan bermarka, mobil
// low-poly beroda + blob shadow, pohon, lampu lalu lintas beneran, tiga
// mode kamera (chase/driver/top). Semua posisi (x, y_sim) dipetakan ke
// (x, z); y dunia = ketinggian.

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { Signals } from "./sim/signals.js";
import { DT } from "./sim/car.js";

const COL = {
  sky: 0xa8cdf0,
  fog: 0xc3d9ee,
  grass: 0x8fae72,
  grassDark: 0x7fa05f,
  water: 0x4f83b8,
  asphalt: 0x585d66,
  asphaltMajor: 0x60656e,
  casing: 0x4a4f58,
  mark: 0xe8eaee,
  edge: 0xc9cdd4,
  route: 0x2f7df6,
  routeCase: 0xffffff,
  heroBody: 0xe8e9ed,
  glass: 0x1c2126,
  tire: 0x17181c,
  chosen: 0x2f7df6,     // jalur terpilih: biru terang (ala jevpilot)
  eligible: 0x39c2d7,   // layak: cyan
  offroad: 0xf59e0b,    // keluar lajur: amber
  collision: 0xf97316,  // prediksi tabrak: oranye
  goal: 0xe82127,
};

const rad = (d) => (d * Math.PI) / 180;
const PALETTE = [0xd7d9de, 0xc0392b, 0x2e86c1, 0xf4d03f, 0x7f8c8d, 0x27ae60, 0xffffff];

// warna per-vertex buat geometry yang di-merge jadi satu mesh
function paint(geo, hex) {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return geo;
}

export class Scene3D {
  constructor(container, world) {
    this.world = world;
    this.renderer = new THREE.WebGLRenderer({
      canvas: container.querySelector("canvas"), antialias: true });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(COL.sky);
    this.scene.fog = new THREE.Fog(COL.fog, 700, 2600);
    this.camera = new THREE.PerspectiveCamera(
      58, container.clientWidth / container.clientHeight, 1, 6000);
    this.scene.add(new THREE.HemisphereLight(0xdfeaff, 0x8a9a6d, 1.35));
    const sun = new THREE.DirectionalLight(0xfff4e0, 1.7);
    sun.position.set(-500, 800, 350);
    this.scene.add(sun);
    this.camModes = ["Chase", "Driver", "Top"];
    this.camMode = "Chase";
    this.camPos = new THREE.Vector3();
    this.shakeT = 0;
    this.candVisible = true;
    this._buildStatic();
    this._buildDynamic();
    window.addEventListener("resize", () => {
      this.renderer.setSize(container.clientWidth, container.clientHeight);
      this.camera.aspect = container.clientWidth / container.clientHeight;
      this.camera.updateProjectionMatrix();
    });
  }

  // ---- statis: tanah, area, jalan bermarka, bangunan, pohon ---------------
  _buildStatic() {
    const w = this.world;
    const size = Math.max(w.maxx - w.minx, w.maxy - w.miny) + 4000;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshLambertMaterial({ color: COL.grass }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set((w.minx + w.maxx) / 2, 0, (w.miny + w.maxy) / 2);
    this.scene.add(ground);

    const shapeFrom = (pts) => {
      const s = new THREE.Shape();
      s.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
      return s;
    };
    // area: taman & air
    const flatGeos = { green: [], water: [] };
    for (const a of w.areas) {
      const g = new THREE.ShapeGeometry(shapeFrom(a.pts));
      g.rotateX(Math.PI / 2);
      (flatGeos[a.kind === "water" ? "water" : "green"]).push(paint(g, a.kind === "water" ? COL.water : COL.grassDark));
    }
    if (flatGeos.green.length) {
      const m = new THREE.Mesh(mergeGeometries(flatGeos.green),
        new THREE.MeshLambertMaterial({ vertexColors: true }));
      m.position.y = 0.02;
      this.scene.add(m);
    }
    for (const g of flatGeos.water) {
      const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
      m.position.y = 0.015;
      this.scene.add(m);
    }

    // ---- jalan: casing + aspal + marka tengah putus + garis pinggir ----
    const quadGeo = (segs, pad, y) => {
      const pos = [], idx = [];
      for (const s of segs) {
        const dx = s.bx - s.ax, dy = s.by - s.ay;
        const L = Math.hypot(dx, dy) + 1e-6;
        const px = (-dy / L) * (s.wd + pad), py = (dx / L) * (s.wd + pad);
        const b = pos.length / 3;
        pos.push(s.ax - px, y, s.ay - py, s.ax + px, y, s.ay + py,
                 s.bx + px, y, s.by + py, s.bx - px, y, s.by - py);
        idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
      }
      return finishGeo(pos, idx);
    };
    const finishGeo = (pos, idx) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      return g;
    };
    const minor = w.segs.filter((s) => s.wd < 7.5);
    const major = w.segs.filter((s) => s.wd >= 7.5);
    this.scene.add(new THREE.Mesh(quadGeo(w.segs, 1.5, 0.03),
      new THREE.MeshLambertMaterial({ color: COL.casing, side: THREE.DoubleSide })));
    this.scene.add(new THREE.Mesh(quadGeo(minor, 0, 0.05),
      new THREE.MeshLambertMaterial({ color: COL.asphalt, side: THREE.DoubleSide })));
    this.scene.add(new THREE.Mesh(quadGeo(major, 0, 0.05),
      new THREE.MeshLambertMaterial({ color: COL.asphaltMajor, side: THREE.DoubleSide })));
    // disc joint nutup celah quads di tikungan & simpang
    const nodeSegs = new Map();
    for (const s of w.segs)
      for (const n of [s.a, s.b])
        (nodeSegs.get(n) ?? nodeSegs.set(n, []).get(n)).push(s);
    const jointGeoCache = new Map();
    for (const [n, ss] of nodeSegs) {
      const wd = Math.min(...ss.map((s) => s.wd));
      let g = jointGeoCache.get(wd);
      if (!g) {
        g = new THREE.CircleGeometry(wd * 0.99, 12);
        g.rotateX(-Math.PI / 2);
        jointGeoCache.set(wd, g);
      }
      const majorJ = ss.some((s) => s.wd >= 7.5);
      const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial(
        { color: majorJ ? COL.asphaltMajor : COL.asphalt }));
      const [nx, ny] = w.nodes.get(n);
      m.position.set(nx, 0.052, ny);
      this.scene.add(m);
    }
    // marka: garis tengah putus-putus + garis pinggir solid
    const dashPos = [], edgePos = [], dashIdx = [], edgeIdx = [];
    const strip = (arr, iri, x0, z0, x1, z1, wd) => {
      const dx = x1 - x0, dz = z1 - z0;
      const L = Math.hypot(dx, dz) + 1e-6;
      const px = (-dz / L) * wd, pz = (dx / L) * wd;
      const b = arr.pos.length / 3;
      arr.pos.push(x0 - px, 0.07, z0 - pz, x0 + px, 0.07, z0 + pz,
                   x1 + px, 0.07, z1 + pz, x1 - px, 0.07, z1 - pz);
      arr.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    };
    for (const s of w.segs) {
      const dx = s.bx - s.ax, dy = s.by - s.ay;
      const L = Math.hypot(dx, dy) + 1e-6;
      const ux = dx / L, uy = dy / L;
      // pinggir kiri/kanan
      for (const side of [-1, 1]) {
        const off = (s.wd - 0.4) * side;
        strip({ pos: edgePos, idx: edgeIdx }, null,
              s.ax - uy * off, s.ay + ux * off,
              s.bx - uy * off, s.by + ux * off, 0.12);
      }
      // tengah putus-putus
      const period = 6.0, dash = 3.0;
      for (let t = 1.0; t < L - dash; t += period) {
        const t2 = Math.min(t + dash, L - 1.0);
        strip({ pos: dashPos, idx: dashIdx }, null,
              s.ax + ux * t, s.ay + uy * t, s.ax + ux * t2, s.ay + uy * t2, 0.15);
      }
    }
    this.scene.add(new THREE.Mesh(finishGeo(dashPos, dashIdx),
      new THREE.MeshBasicMaterial({ color: COL.mark })));
    this.scene.add(new THREE.Mesh(finishGeo(edgePos, edgeIdx),
      new THREE.MeshBasicMaterial({ color: COL.edge })));

    // ---- bangunan: ekstrusi + warna variatif, di-merge satu mesh ----
    const bldgGeos = [];
    const tones = [0xe8e2d4, 0xd8d3c8, 0xcfd6dd, 0xded6c2, 0xc8cdd4, 0xe3d9c8];
    w.buildings.forEach((b, i) => {
      const h = 8 + Math.random() * 26;
      const g = new THREE.ExtrudeGeometry(shapeFrom(b.pts), { depth: h });
      g.rotateX(Math.PI / 2);
      g.translate(0, h, 0);
      bldgGeos.push(paint(g, tones[i % tones.length]));
    });
    if (bldgGeos.length) {
      const m = new THREE.Mesh(mergeGeometries(bldgGeos),
        new THREE.MeshLambertMaterial({ vertexColors: true }));
      this.scene.add(m);
    }

    // ---- pohon di area hijau (batang + daun, merge) ----
    const trunks = [], leaves = [];
    const put = (arr, geo, x, y, z) => {
      const g = geo.clone();
      g.translate(x, y, z);
      arr.push(paint(g, arr === trunks ? 0x8a6642 : 0x4e7a3a + Math.floor(Math.random() * 0x103018)));
    };
    const trunkGeo = new THREE.CylinderGeometry(0.7, 1.0, 5, 5);
    const leafGeo = new THREE.ConeGeometry(3.2, 8, 7);
    const leaf2 = new THREE.ConeGeometry(2.3, 5.5, 7);
    for (const a of w.areas) {
      if (a.kind === "water") continue;
      const [x0, y0, x1, y1] = a.bbox;
      const n = Math.min(24, Math.floor((x1 - x0) * (y1 - y0) / 4500));
      for (let i = 0; i < n; i++) {
        const x = x0 + Math.random() * (x1 - x0);
        const y = y0 + Math.random() * (y1 - y0);
        put(trunks, trunkGeo, x, 2.5, y);
        put(leaves, leafGeo, x, 8, y);
        put(leaves, leaf2, x, 13, y);
      }
    }
    if (trunks.length) {
      this.scene.add(new THREE.Mesh(mergeGeometries(trunks),
        new THREE.MeshLambertMaterial({ vertexColors: true })));
      this.scene.add(new THREE.Mesh(mergeGeometries(leaves),
        new THREE.MeshLambertMaterial({ vertexColors: true })));
    }
  }

  // ---- dinamis: mobil, rute, kandidat, lampu, goal --------------------------
  _buildDynamic() {
    this.hero = this._mkCar(COL.heroBody, 4.6, 1.85, true);
    this.heroGroup = this.hero;
    this.scene.add(this.hero);
    this.trafficMeshes = [];
    // rute: ribbon ( casing putih + garis biru terang ala jevpilot)
    this.routeGroup = new THREE.Group();
    this.routeFor = null;
    this.scene.add(this.routeGroup);
    // kandidat: LineSegments warna per status (biru/cyan/amber/oranye)
    const maxCand = 14;
    this.candPos = new THREE.Float32BufferAttribute(new Array(maxCand * 2 * 3).fill(0), 3);
    this.candCol = new THREE.Float32BufferAttribute(new Array(maxCand * 2 * 3).fill(0), 3);
    const cg = new THREE.BufferGeometry();
    cg.setAttribute("position", this.candPos);
    cg.setAttribute("color", this.candCol);
    this.candLines = new THREE.LineSegments(cg,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 }));
    this.candLines.frustumCulled = false;
    this.candLines.visible = this.candVisible;
    this.scene.add(this.candLines);
    // goal misi: ring merah denyut
    this.goalRing = new THREE.Mesh(
      new THREE.TorusGeometry(4.5, 0.45, 8, 40),
      new THREE.MeshBasicMaterial({ color: COL.goal }));
    this.goalRing.rotation.x = -Math.PI / 2;
    this.goalRing.position.y = 0.3;
    this.scene.add(this.goalRing);
    this.signalViews = [];
  }

  _mkCar(color, len = 4.6, wid = 1.85, hero = false) {
    // low-poly skala 1:1: bodi + kabin kaca + 4 roda (depan bisa ngesteer)
    // + lampu + blob shadow. Group dgn sumbu: maju = +X lokal.
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(len, 0.72, wid),
      new THREE.MeshLambertMaterial({ color }));
    body.position.y = 0.55;
    g.add(body);
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(len * 0.48, 0.58, wid * 0.82),
      new THREE.MeshLambertMaterial({ color: COL.glass }));
    cabin.position.set(-len * 0.06, 1.12, 0);
    g.add(cabin);
    const wheels = [];
    const tireGeo = new THREE.CylinderGeometry(0.33, 0.33, 0.24, 10);
    tireGeo.rotateX(Math.PI / 2);   // sumbu roda = lebar mobil (z lokal)
    const tireMat = new THREE.MeshLambertMaterial({ color: COL.tire });
    for (const [fx, fz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const pivot = new THREE.Group();
      pivot.position.set(fx * len * 0.31, 0.33, fz * (wid / 2 - 0.02));
      const tire = new THREE.Mesh(tireGeo, tireMat);
      pivot.add(tire);
      g.add(pivot);
      wheels.push({ pivot, tire, front: fx > 0 });
    }
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff6d8 });
    for (const s of [-1, 1]) {
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.16, 0.36), lampMat);
      lamp.position.set(len / 2, 0.58, s * wid * 0.3);
      g.add(lamp);
      const tail = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.14, 0.34),
        new THREE.MeshBasicMaterial({ color: hero ? 0xd23430 : 0x7a1f1c }));
      tail.position.set(-len / 2, 0.6, s * wid * 0.3);
      g.add(tail);
    }
    // blob shadow
    const blob = new THREE.Mesh(
      new THREE.CircleGeometry(1, 20),
      new THREE.MeshBasicMaterial({ color: 0x101828, transparent: true, opacity: 0.22 }));
    blob.rotation.x = -Math.PI / 2;
    blob.scale.set(len * 0.75, wid * 1.25, 1);
    blob.position.y = 0.048;
    blob.renderOrder = 1;
    g.add(blob);
    g.userData = { wheels, spin: 0, len, wid };
    return g;
  }

  _placeCar(group, x, y, heading, steer = 0, speed = 0) {
    group.position.set(x, 0, y);
    group.rotation.y = -rad(heading);
    const { wheels, spin } = group.userData;
    for (const w of wheels) {
      if (w.front) w.pivot.rotation.y = -steer * 0.45;
      w.tire.rotation.z = -spin;
    }
    group.userData.spin = spin + (speed * DT / 0.33) % (Math.PI * 2);
  }

  _ensureSignals() {
    if (this.signalViews.length || !this._sim) return;
    const poleMat = new THREE.MeshLambertMaterial({ color: 0x3c4148 });
    const boxMat = new THREE.MeshLambertMaterial({ color: 0x22262c });
    for (const [x, y] of this._sim.signals.pos) {
      const g = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 5.5, 6), poleMat);
      pole.position.y = 2.75;
      g.add(pole);
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.55, 1.4, 0.42), boxMat);
      box.position.set(1.1, 4.75, 0);
      g.add(box);
      const mk = (hex) => new THREE.Mesh(
        new THREE.SphereGeometry(0.17, 10, 8), new THREE.MeshBasicMaterial({ color: hex }));
      const red = mk(0xe82127), green = mk(0x35c759);
      red.position.set(1.1, 5.2, 0.24);
      green.position.set(1.1, 4.35, 0.24);
      g.add(red, green);
      g.position.set(x, 0, y);
      // arah box biar keliatan dari jalan — rotasi ikut sumbu dominan
      const [ax, ay] = [Math.abs(x - this._sim.car.x), Math.abs(y - this._sim.car.y)];
      g.rotation.y = ax > ay ? 0 : Math.PI / 2;
      this.scene.add(g);
      this.signalViews.push({ red, green });
    }
  }

  _rebuildRoute(route) {
    this.routeFor = route;
    this.routeGroup.clear();
    if (route.length < 2) return;
    // garis rute digeser ke LAJUR KANAN (ala lajur dinamis mobil) — biar
    // kebaca jelas: garis biru = lajur kita, lajur kiri buat lawan arah
    const pts = route.map((p, i) => {
      const q = route[Math.min(i + 1, route.length - 1)];
      const r = route[Math.max(i - 1, 0)];
      const dx = q[0] - r[0], dy = q[1] - r[1];
      const L = Math.hypot(dx, dy) + 1e-6;
      const off = this.world.nearestSegW(p[0], p[1]) * 0.45;
      return [p[0] + (-dy / L) * off, p[1] + (dx / L) * off];
    });
    const ribbon = (width, y, color) => {
      const pos = [], idx = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
        const dx = bx - ax, dy = by - ay;
        const L = Math.hypot(dx, dy) + 1e-6;
        const px = (-dy / L) * width, py = (dx / L) * width;
        const b = pos.length / 3;
        pos.push(ax - px, y, ay - py, ax + px, y, ay + py,
                 bx + px, y, by + py, bx - px, y, by - py);
        idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.92 }));
    };
    this.routeGroup.add(ribbon(0.55, 0.075, COL.routeCase));
    this.routeGroup.add(ribbon(0.3, 0.085, COL.route));
  }

  // sinkron dunia 3D dgn state sim; dipanggil tiap frame
  update(sim, steerView = 0) {
    this._sim = sim;
    this._ensureSignals();
    const car = sim.car;
    this._placeCar(this.hero, car.x, car.y, car.heading, steerView, car.speed);
    this.trafficMeshes.slice(sim.traffic.cars.length).forEach((m) => this.scene.remove(m));
    this.trafficMeshes.length = Math.min(this.trafficMeshes.length, sim.traffic.cars.length);
    sim.traffic.cars.forEach((tc, i) => {
      if (!this.trafficMeshes[i]) {
        const color = PALETTE[i % PALETTE.length];
        this.trafficMeshes[i] = this._mkCar(color, 4.3, 1.8);
        this.scene.add(this.trafficMeshes[i]);
      }
      this._placeCar(this.trafficMeshes[i], tc.x, tc.y, tc.heading, 0, tc.speed);
    });
    if (sim.car.route !== this.routeFor) this._rebuildRoute(sim.car.route);
    // kandidat: refresh tiap frame (murah, max 14 segmen)
    const pos = this.candPos, col = this.candCol;
    const dbg = sim.planner?.candDbg ?? [];
    let n = 0;
    for (const [ex, ey, ok, chosen] of dbg) {
      if (n >= 14) break;
      const o = n * 6;
      pos.array[o] = car.x; pos.array[o + 1] = 0.5; pos.array[o + 2] = car.y;
      pos.array[o + 3] = ex; pos.array[o + 4] = 0.5; pos.array[o + 5] = ey;
      const c = chosen ? COL.chosen : ok ? COL.eligible : COL.offroad;
      const r = (c >> 16) / 255, g = ((c >> 8) & 255) / 255, b = (c & 255) / 255;
      col.array[o] = r; col.array[o + 1] = g; col.array[o + 2] = b;
      col.array[o + 3] = r; col.array[o + 4] = g; col.array[o + 5] = b;
      n++;
    }
    this.candLines.geometry.setDrawRange(0, n * 2);
    pos.needsUpdate = col.needsUpdate = true;
    this.candLines.visible = this.candVisible;
      // goal
    if (sim.mission.goal != null) {
      const [gx, gy] = this.world.nodes.get(sim.mission.goal);
      this.goalRing.position.set(gx, 0.3, gy);
      const t = performance.now() / 1000;
      const s = 1 + 0.15 * Math.sin(t * 4);
      this.goalRing.scale.set(s, 1, s);
    }
    // lampu: fase dari signals.frame — dua lampu housing, nyala bergantian
    const phase = Math.floor(sim.signals.frame / Signals.CYCLE) % 2;
    this.signalViews.forEach((v) => {
      v.red.material.color.setHex(phase === 0 ? 0x5a1414 : 0xe82127);
      v.green.material.color.setHex(phase === 0 ? 0x35c759 : 0x14501f);
    });
    this._camera(car);
    this.renderer.render(this.scene, this.camera);
  }

  _camera(car) {
    const fwd = new THREE.Vector3(Math.cos(rad(car.heading)), 0, Math.sin(rad(car.heading)));
    let target, look;
    if (this.camMode === "Top") {
      target = new THREE.Vector3(car.x, 70, car.y);
      look = new THREE.Vector3(car.x, 0, car.y);
    } else if (this.camMode === "Driver") {
      target = new THREE.Vector3(car.x, 0, car.y).addScaledVector(fwd, 0.6);
      target.y = 1.35;
      look = new THREE.Vector3(car.x, 0, car.y).addScaledVector(fwd, 60);
      look.y = 1.2;
      this.camPos.copy(target);
      this.camera.position.copy(target);
      this.camera.lookAt(look);
      return;
    } else {
      target = new THREE.Vector3(car.x, 0, car.y).addScaledVector(fwd, -13);
      target.y = 5.5;
      look = new THREE.Vector3(car.x, 0, car.y).addScaledVector(fwd, 25);
      look.y = 1.4;
    }
    if (this.camPos.lengthSq() === 0) this.camPos.copy(target);
    this.camPos.lerp(target, 0.09);
    this.camera.position.copy(this.camPos);
    if (this.shakeT > 0) {
      this.shakeT -= 1 / 60;
      this.camera.position.x += (Math.random() - 0.5) * 1.4;
      this.camera.position.y += (Math.random() - 0.5) * 0.9;
    }
    this.camera.lookAt(look);
  }

  cycleCam() {
    const i = (this.camModes.indexOf(this.camMode) + 1) % this.camModes.length;
    this.camMode = this.camModes[i];
    this.camPos.set(0, 0, 0);
    return this.camMode;
  }
}
