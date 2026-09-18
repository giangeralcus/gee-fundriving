// Scene Three.js: dunia 3D dari data sim (jalan ribbon, bangunan ekstrusi,
// area flat, mobil box, lampu, rute, kandidat planner) + chase cam.
// Semua posisi (x, y_sim) dipetakan ke (x, z) — y dunia = ketinggian.

import * as THREE from "three";
import { Signals } from "./sim/signals.js";

const COL = {
  bg: 0x1a1c22,
  ground: 0x22242c,
  green: 0x2c3c2e,
  water: 0x243450,
  bldg: 0x2a2d36,
  casing: 0x343740,
  road: 0x585c68,
  roadMajor: 0x646876,
  route: 0x508ce6,
  routeCase: 0x1c3a76,
  hero: 0x50dc78,
  traffic: 0xeba54b,
  chosen: 0x78beff,
  eligible: 0x96dcdc,
  filtered: 0x965a5a,
  goal: 0xff78c8,
};

const rad = (d) => (d * Math.PI) / 180;

export class Scene3D {
  constructor(container, world) {
    this.world = world;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(COL.bg);
    this.scene.fog = new THREE.Fog(COL.bg, 600, 2200);
    this.camera = new THREE.PerspectiveCamera(
      60, container.clientWidth / container.clientHeight, 1, 6000);
    this.scene.add(new THREE.HemisphereLight(0xbfc8dd, 0x30282a, 1.6));
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.35));
    const sun = new THREE.DirectionalLight(0xfff2dd, 1.6);
    sun.position.set(-400, 700, 300);
    this.scene.add(sun);
    this.camMode = "chase";
    this.camPos = new THREE.Vector3();
    this._buildStatic();
    this._buildDynamic();
    window.addEventListener("resize", () => {
      this.renderer.setSize(container.clientWidth, container.clientHeight);
      this.camera.aspect = container.clientWidth / container.clientHeight;
      this.camera.updateProjectionMatrix();
    });
  }

  // ---- statis: ground, area, jalan, bangunan --------------------------------
  _buildStatic() {
    const w = this.world;
    const size = Math.max(w.maxx - w.minx, w.maxy - w.miny) + 4000;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshLambertMaterial({ color: COL.ground }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set((w.minx + w.maxx) / 2, 0, (w.miny + w.maxy) / 2);
    this.scene.add(ground);

    const shapeFrom = (pts) => {
      const s = new THREE.Shape();
      s.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
      return s;
    };
    // area hijau/air: flat di atas ground
    for (const a of w.areas) {
      const g = new THREE.ShapeGeometry(shapeFrom(a.pts));
      g.rotateX(Math.PI / 2);
      const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({
        color: a.kind === "water" ? COL.water : COL.green }));
      m.position.y = 0.02;
      this.scene.add(m);
    }
    // jalan: quads per segmen (casing lebih lebar di bawah, aspal di atas)
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
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      g.computeVertexNormals();   // tanpa ini Lambert ngerender item total
      return g;
    };
    const casing = new THREE.Mesh(quadGeo(w.segs, 1.5, 0.03),
      new THREE.MeshLambertMaterial({ color: COL.casing, side: THREE.DoubleSide }));
    this.scene.add(casing);
    const minor = w.segs.filter((s) => s.wd < 7.5);
    const major = w.segs.filter((s) => s.wd >= 7.5);
    this.scene.add(new THREE.Mesh(quadGeo(minor, 0, 0.05),
      new THREE.MeshLambertMaterial({ color: COL.road, side: THREE.DoubleSide })));
    this.scene.add(new THREE.Mesh(quadGeo(major, 0, 0.05),
      new THREE.MeshLambertMaterial({ color: COL.roadMajor, side: THREE.DoubleSide })));
    // disc joint di tiap node: nutup celah sambungan quads di tikungan/simpang
    const nodeSegs = new Map();
    for (const s of w.segs)
      for (const n of [s.a, s.b])
        (nodeSegs.get(n) ?? nodeSegs.set(n, []).get(n)).push(s);
    const jointGeoCache = new Map();
    const jointMat = { minor: new THREE.MeshLambertMaterial({ color: COL.road }),
                       major: new THREE.MeshLambertMaterial({ color: COL.roadMajor }) };
    for (const [n, ss] of nodeSegs) {
      const wd = Math.min(...ss.map((s) => s.wd));
      let g = jointGeoCache.get(wd);
      if (!g) {
        g = new THREE.CircleGeometry(wd * 0.99, 12);
        g.rotateX(-Math.PI / 2);
        jointGeoCache.set(wd, g);
      }
      const m = new THREE.Mesh(g, ss.some((s) => s.wd >= 7.5) ? jointMat.major : jointMat.minor);
      const [nx, ny] = w.nodes.get(n);
      m.position.set(nx, 0.055, ny);
      this.scene.add(m);
    }
    // bangunan: ekstrusi footprint, tinggi acak — kota kerasa hidup
    const bldgMat = new THREE.MeshLambertMaterial({ color: COL.bldg });
    for (const b of w.buildings) {
      const h = 8 + Math.random() * 26;
      const g = new THREE.ExtrudeGeometry(shapeFrom(b.pts), { depth: h });
      g.rotateX(Math.PI / 2);   // footprint ke bidang XZ, tebal ke -y
      g.translate(0, h, 0);     // angkat balik ke atas ground
      this.scene.add(new THREE.Mesh(g, bldgMat));
    }
  }

  // ---- dinamis: mobil, rute, kandidat, lampu, goal --------------------------
  _buildDynamic() {
    const mkCar = (color, len = 34, wid = 18) => {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(len, 9, wid),
        new THREE.MeshLambertMaterial({ color }));
      this.scene.add(m);
      return m;
    };
    this.hero = mkCar(COL.hero);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(20, 23, 48),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.08;
    this.heroRing = ring;
    this.scene.add(ring);
    this.trafficMeshes = this._sim?.traffic.cars.map(() => mkCar(COL.traffic, 22, 12)) ?? [];
    // rute: ribbon tipis (casing + garis), dibangun ulang tiap misi baru
    this.routeGroup = new THREE.Group();
    this.routeFor = null;
    this.scene.add(this.routeGroup);
    // kandidat planner: LineSegments [car -> endpoint] × N, warna per status
    const maxCand = 14;
    this.candPos = new THREE.Float32BufferAttribute(new Array(maxCand * 2 * 3).fill(0), 3);
    this.candCol = new THREE.Float32BufferAttribute(new Array(maxCand * 2 * 3).fill(0), 3);
    const cg = new THREE.BufferGeometry();
    cg.setAttribute("position", this.candPos);
    cg.setAttribute("color", this.candCol);
    this.candLines = new THREE.LineSegments(cg, new THREE.LineBasicMaterial({ vertexColors: true }));
    this.candLines.frustumCulled = false;
    this.scene.add(this.candLines);
    // goal misi: ring denyut
    this.goalRing = new THREE.Mesh(
      new THREE.TorusGeometry(14, 1.6, 8, 40),
      new THREE.MeshBasicMaterial({ color: COL.goal }));
    this.goalRing.rotation.x = -Math.PI / 2;
    this.goalRing.position.y = 1;
    this.scene.add(this.goalRing);
    this.signalViews = [];
  }

  _ensureSignals() {
    if (this.signalViews.length || !this._sim) return;
    const geo = new THREE.CylinderGeometry(1.2, 1.2, 16, 6);
    const poleMat = new THREE.MeshLambertMaterial({ color: 0x444a56 });
    const sMat = () => new THREE.MeshBasicMaterial({ color: 0x888888 });
    for (const [x, y] of this._sim.signals.pos) {
      const pole = new THREE.Mesh(geo, poleMat);
      pole.position.set(x, 8, y);
      this.scene.add(pole);
      const mk = (ox, oz) => {
        const s = new THREE.Mesh(new THREE.SphereGeometry(2.6, 12, 8), sMat());
        s.position.set(x + ox, 15, y + oz);
        this.scene.add(s);
        return s;
      };
      // dua bola = dua sumbu (horizontal & vertikal), warna ditukar per fase
      this.signalViews.push({ a0: mk(6, 0), a1: mk(0, 6) });
    }
  }

  _rebuildRoute(route) {
    this.routeFor = route;
    this.routeGroup.clear();
    if (route.length < 2) return;
    const ribbon = (width, y, color) => {
      const pos = [], idx = [];
      for (let i = 0; i < route.length - 1; i++) {
        const [ax, ay] = route[i], [bx, by] = route[i + 1];
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
      return new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide }));
    };
    this.routeGroup.add(ribbon(4.5, 0.09, COL.routeCase));
    this.routeGroup.add(ribbon(2.5, 0.1, COL.route));
  }

  _placeCar(mesh, x, y, heading) {
    mesh.position.set(x, 4.5, y);
    mesh.rotation.y = -rad(heading);
  }

  // sinkron dunia 3D dgn state sim; dipanggil tiap frame
  update(sim) {
    this._sim = sim;
    this._ensureSignals();
    const car = sim.car;
    this._placeCar(this.hero, car.x, car.y, car.heading);
    this.heroRing.position.set(car.x, 0.08, car.y);
    while (this.trafficMeshes.length < sim.traffic.cars.length) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(22, 9, 12),
        new THREE.MeshLambertMaterial({ color: COL.traffic }));
      this.scene.add(m);
      this.trafficMeshes.push(m);
    }
    sim.traffic.cars.forEach((tc, i) => {
      this._placeCar(this.trafficMeshes[i], tc.x, tc.y, tc.heading);
      this.trafficMeshes[i].visible = true;
    });
    if (sim.car.route !== this.routeFor) this._rebuildRoute(sim.car.route);
    // kandidat: refresh tiap frame (murah, max 14 segmen)
    const pos = this.candPos, col = this.candCol;
    const dbg = sim.planner?.candDbg ?? [];
    let n = 0;
    for (const [ex, ey, ok, chosen] of dbg) {
      if (n >= 14) break;
      const o = n * 6;
      pos.array[o] = car.x; pos.array[o + 1] = 1.5; pos.array[o + 2] = car.y;
      pos.array[o + 3] = ex; pos.array[o + 4] = 1.5; pos.array[o + 5] = ey;
      const c = chosen ? COL.chosen : ok ? COL.eligible : COL.filtered;
      const r = (c >> 16) / 255, g = ((c >> 8) & 255) / 255, b = (c & 255) / 255;
      col.array[o] = r; col.array[o + 1] = g; col.array[o + 2] = b;
      col.array[o + 3] = r; col.array[o + 4] = g; col.array[o + 5] = b;
      n++;
    }
    this.candLines.geometry.setDrawRange(0, n * 2);
    pos.needsUpdate = col.needsUpdate = true;
    // goal
    if (sim.mission.goal != null) {
      const [gx, gy] = this.world.nodes.get(sim.mission.goal);
      this.goalRing.position.set(gx, 1, gy);
      const t = performance.now() / 1000;
      const s = 1 + 0.15 * Math.sin(t * 4);
      this.goalRing.scale.set(s, 1, s);
    }
    // lampu: fase dari signals.frame (CYCLE = static — akses via class)
    const phase = Math.floor(sim.signals.frame / Signals.CYCLE) % 2;
    this.signalViews.forEach((v) => {
      v.a0.material.color.setHex(phase === 0 ? 0x5adc6e : 0xe65050);
      v.a1.material.color.setHex(phase === 1 ? 0x5adc6e : 0xe65050);
    });
    this._camera(car);
    this.renderer.render(this.scene, this.camera);
  }

  _camera(car) {
    const fwd = new THREE.Vector3(Math.cos(rad(car.heading)), 0, Math.sin(rad(car.heading)));
    let target, look;
    if (this.camMode === "top") {
      target = new THREE.Vector3(car.x, 380, car.y);
      look = new THREE.Vector3(car.x, 0, car.y);
    } else {
      target = new THREE.Vector3(car.x, 0, car.y).addScaledVector(fwd, -130);
      target.y = 80;
      look = new THREE.Vector3(car.x, 0, car.y).addScaledVector(fwd, 60);
    }
    if (this.camPos.lengthSq() === 0) this.camPos.copy(target);
    this.camPos.lerp(target, 0.08);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(look);
  }

  toggleCam() {
    this.camMode = this.camMode === "chase" ? "top" : "chase";
    this.camPos.set(0, 0, 0);   // lerp ulang dari posisi baru
    return this.camMode;
  }
}
