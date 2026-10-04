// Gold coin shower: 3D coins pour onto the tray, bounce and spin, rest a
// moment, then fly up into the coin counter on screen. One InstancedMesh.
import * as THREE from "three/webgpu";
import { abs, dot, float, mix, normalView, positionViewDirection, pow, vec3 } from "three/tsl";

const MAX_COINS = 40;
const RADIUS = 0.0062, THICK = 0.0016;
const GRAVITY = 9.81;

export class CoinShower {
  constructor(parent, camera) {
    this.parent = parent; this.camera = camera;
    const geometry = new THREE.CylinderGeometry(RADIUS, RADIUS, THICK, 40, 1);
    // A rim groove look: slightly bevelled edge via a second, thinner ring.
    const material = new THREE.MeshStandardNodeMaterial({ color: "#ffb300", metalness: 0.35, roughness: 0.3 });
    // No environment map in this scene: fake the gold's mirror look with a
    // view-dependent warm gradient (bright face, deeper amber toward the edge).
    const facing = abs(dot(normalView, positionViewDirection));
    material.emissiveNode = mix(vec3(0.62, 0.26, 0.0), vec3(1.0, 0.72, 0.08), pow(facing, float(0.6))).mul(0.95);
    this.mesh = new THREE.InstancedMesh(geometry, material, MAX_COINS);
    this.mesh.count = 0; this.mesh.visible = false; this.mesh.frustumCulled = false;
    this.mesh.name = "Coins";
    parent.add(this.mesh);
    this.coins = [];
    this.m = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.s = new THREE.Vector3(1, 1, 1);
    this.target = new THREE.Vector3();
    this.onLand = null; this.onCollect = null;
  }

  get busy() { return this.coins.length > 0; }

  // Pour `count` coins around tray-space `at`. `collectAt()` must return the
  // screen point (NDC x, y) of the coin counter when the coins fly away.
  pour({ count = 12, at = [0, 0.03, 0], collectAt, onLand, onCollect, onDone }) {
    this.collectAt = collectAt; this.onLand = onLand; this.onCollect = onCollect; this.onDone = onDone;
    this.coins = [];
    for (let i = 0; i < Math.min(count, MAX_COINS); i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * 0.012;
      this.coins.push({
        p: new THREE.Vector3(at[0] + Math.cos(a) * r, at[1] + 0.05 + Math.random() * 0.05 + i * 0.004, at[2] + Math.sin(a) * r),
        v: new THREE.Vector3(Math.cos(a) * (0.08 + Math.random() * 0.12), -0.1 * Math.random(), Math.sin(a) * (0.08 + Math.random() * 0.12)),
        rot: new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6),
        spin: new THREE.Vector3((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 30),
        delay: i * 0.035, landed: 0, rest: 0, flying: -1, from: null, done: false, scale: 1,
      });
    }
    this.mesh.visible = true;
  }

  update(dt) {
    if (!this.coins.length) return false;
    const R = 0.073;
    let alive = 0;
    for (const c of this.coins) {
      if (c.done) continue;
      alive++;
      if (c.delay > 0) { c.delay -= dt; c.scale = 0; continue; }
      c.scale = 1;
      if (c.flying >= 0) {
        // fly to the counter: ease along a curve, shrink, then count it
        c.flying += dt / 0.55;
        const t = Math.min(1, c.flying), e = t * t * (3 - 2 * t);
        this.target.copy(this.counterPoint());
        c.p.lerpVectors(c.from, this.target, e);
        c.p.y += Math.sin(t * Math.PI) * 0.03;
        c.rot.y += dt * 18;
        c.scale = 1 - 0.6 * e;
        if (t >= 1) { c.done = true; this.onCollect?.(); }
        continue;
      }
      c.v.y -= GRAVITY * dt;
      c.p.addScaledVector(c.v, dt);
      c.rot.x += c.spin.x * dt; c.rot.y += c.spin.y * dt; c.rot.z += c.spin.z * dt;
      // the tray's rim keeps them in
      const rr = Math.hypot(c.p.x, c.p.z);
      if (rr > R) { c.p.x *= R / rr; c.p.z *= R / rr; const vn = (c.v.x * c.p.x + c.v.z * c.p.z) / R; if (vn > 0) { c.v.x -= 1.6 * vn * c.p.x / R; c.v.z -= 1.6 * vn * c.p.z / R; } }
      if (c.p.y < THICK / 2) {
        c.p.y = THICK / 2;
        if (c.v.y < -0.25) { this.onLand?.(Math.min(1, -c.v.y / 1.5), c.landed++); }
        c.v.y = Math.abs(c.v.y) * 0.32;
        c.v.x *= 0.7; c.v.z *= 0.7;
        c.spin.multiplyScalar(0.55);
        // settle flat
        if (Math.abs(c.v.y) < 0.12) { c.v.y = 0; c.rot.x += (Math.round(c.rot.x / Math.PI) * Math.PI - c.rot.x) * 0.3; c.rot.z += (Math.round(c.rot.z / Math.PI) * Math.PI - c.rot.z) * 0.3; }
      }
      if (c.p.y <= THICK / 2 + 1e-4) c.rest += dt;
      if (c.rest > 0.9 + Math.random() * 0.02) { c.flying = 0; c.from = c.p.clone(); }
    }
    let n = 0;
    for (const c of this.coins) {
      if (c.done) continue;
      this.q.setFromEuler(c.rot);
      this.s.setScalar(Math.max(0.0001, c.scale));
      this.mesh.setMatrixAt(n++, this.m.compose(c.p, this.q, this.s));
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (!alive) { this.coins = []; this.mesh.visible = false; this.onDone?.(); }
    return true;
  }

  // Tray-space point in front of the camera under the on-screen counter.
  counterPoint() {
    const ndc = this.collectAt ? this.collectAt() : { x: -0.8, y: 0.9 };
    const v = new THREE.Vector3(ndc.x, ndc.y, 0.5).unproject(this.camera);
    const dir = v.sub(this.camera.position).normalize();
    const world = this.camera.position.clone().addScaledVector(dir, 0.09);
    return this.parent.worldToLocal(world);
  }
}
