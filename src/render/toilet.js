// Winged potty for the bunny's toilet visit (src/render/rabbit.js drives it).
//
// Look: a small round, glossy white ceramic potty like a vinyl figurine — a
// cup-like bowl on a short rounded foot, a thick rounded rim, a little lid
// hinge at the back, clean pale-aqua water, a pastel heart on the front — and
// two white feathered angel wings on its back sides.
//
// Cost: the potty (ceramic + feathers + water) is ONE static mesh (one draw,
// geometry built once and cached at module level), plus its soft contact
// shadow (one transparent quad); the flush bubbles are one instanced draw
// that is only visible during the flush.
//
// Frame ("potty space"): origin on the floor under the bowl's centre, +y up,
// +z = the potty's front (the bunny faces this way while sitting on it).
// The potty's group lives in the tray group (tray space), so it stays put
// while the bunny hops around it.
import * as THREE from "three/webgpu";
import { float, length, smoothstep, uniform, uv, vec3 } from "three/tsl";
import { createBubbleMaterial, createCeramicMaterial } from "./rabbit-fur.js";

// Design units (built at this size, then scaled by SIZE).
const D = {
  rimR: 0.0176, rimTube: 0.0036, rimY: 0.0224, top: 0.026, outer: 0.0212, seat: 0.0236, water: 0.0146,
  wingRoot: (s) => new THREE.Vector3(s * 0.0158, 0.0156, -0.0105),
};
const SIZE = 0.9;
// Potty metrics (potty space, m): the bunny sits on the rim's top (`seat` = its base height).
export const POTTY = Object.freeze({
  size: SIZE,
  top: D.top * SIZE,         // highest point of the rim
  outer: D.outer * SIZE,     // widest radius of the bowl (rim)
  seat: D.seat * SIZE,       // bunny base height while seated (its fur sinks into the rim a little)
});
const BUBBLES = 18;

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

// ---------------------------------------------------------------------------
// Geometry (built once)
// ---------------------------------------------------------------------------

// Collects pieces into one geometry with position / normal / color / surf.
class Pieces {
  constructor() { this.position = []; this.normal = []; this.color = []; this.surf = []; this.index = []; }
  add(g, attr) {
    const base = this.position.length / 3;
    const p = g.attributes.position, n = g.attributes.normal;
    const P = v3(), N = v3();
    for (let i = 0; i < p.count; i += 1) {
      P.fromBufferAttribute(p, i); N.fromBufferAttribute(n, i);
      const a = attr(P, N, i);
      this.position.push(P.x, P.y, P.z); this.normal.push(N.x, N.y, N.z);
      this.color.push(a.color.r, a.color.g, a.color.b);
      this.surf.push(a.gloss ?? 0.8, a.sheen ?? 0.1, a.trans ?? 0.5, 0);
    }
    if (g.index) for (let i = 0; i < g.index.count; i += 1) this.index.push(base + g.index.getX(i));
    else for (let i = 0; i < p.count; i += 1) this.index.push(base + i);
    g.dispose();
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.position, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.normal, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.color, 3));
    g.setAttribute("surf", new THREE.Float32BufferAttribute(this.surf, 4));
    g.setIndex(this.position.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.index, 1) : new THREE.Uint16BufferAttribute(this.index, 1));
    g.boundingSphere = new THREE.Sphere(v3(0, 0.025, -0.008), 0.06);
    return g;
  }
}

// Unit sphere deformed by fn(x, y, z) → Vector3 (normals recomputed, seams welded).
function blob(ws, hs, fn) {
  const g = new THREE.SphereGeometry(1, ws, hs);
  g.deleteAttribute("uv");
  const p = g.attributes.position, v = v3();
  for (let i = 0; i < p.count; i += 1) { v.fromBufferAttribute(p, i); const q = fn(v.x, v.y, v.z); p.setXYZ(i, q.x, q.y, q.z); }
  g.computeVertexNormals();
  weld(g);
  return g;
}
function weld(g) {
  const p = g.attributes.position, n = g.attributes.normal, groups = new Map();
  for (let i = 0; i < p.count; i += 1) {
    const key = `${Math.round(p.getX(i) * 2e6)},${Math.round(p.getY(i) * 2e6)},${Math.round(p.getZ(i) * 2e6)}`;
    let l = groups.get(key); if (!l) groups.set(key, (l = [])); l.push(i);
  }
  const s = v3();
  for (const l of groups.values()) {
    if (l.length < 2) continue;
    s.set(0, 0, 0);
    for (const i of l) s.x += n.getX(i), s.y += n.getY(i), s.z += n.getZ(i);
    s.normalize();
    for (const i of l) n.setXYZ(i, s.x, s.y, s.z);
  }
}

// Profile of the potty (r, y) from the floor centre up the outside, over the
// thick rim and down the inside to the water line; revolved (lathe).
function pottyProfile() {
  const { rimR, rimTube, rimY, water } = D;
  const pts = [];
  const push = (r, y) => pts.push(new THREE.Vector2(r, y));
  // foot: flat bottom with a soft rounded edge, a gentle waist
  push(0.0001, 0.0); push(0.006, 0.0); push(0.0102, 0.0001);
  for (let i = 1; i <= 6; i += 1) { const a = -Math.PI / 2 + (i / 6) * (Math.PI / 2); push(0.0102 + 0.0024 * Math.cos(a) * 1.05, 0.0024 + 0.0024 * Math.sin(a)); }
  push(0.0127, 0.0036); push(0.0119, 0.0055);
  // cup: flares out in a soft S up to the rim
  const cup = new THREE.CubicBezierCurve(new THREE.Vector2(0.0119, 0.0058), new THREE.Vector2(0.0126, 0.0098), new THREE.Vector2(0.0176, 0.0142), new THREE.Vector2(rimR + rimTube * Math.cos(-1.2), rimY + rimTube * Math.sin(-1.2)));
  for (let i = 1; i <= 14; i += 1) pts.push(cup.getPoint(i / 14));
  // rim: a fat round bead from the outside, over the top, to the inside
  for (let i = 1; i <= 20; i += 1) { const a = -1.2 + (i / 20) * (Math.PI + 1.0); push(rimR + rimTube * Math.cos(a), rimY + rimTube * Math.sin(a)); }
  // inside wall down to the water
  const inner = new THREE.QuadraticBezierCurve(pts[pts.length - 1].clone(), new THREE.Vector2(rimR - rimTube * 1.15, water + 0.0028), new THREE.Vector2(0.0116, water));
  for (let i = 1; i <= 8; i += 1) pts.push(inner.getPoint(i / 8));
  return pts;
}

// One feather (in feather space: x along it 0..len, y across, z thickness):
// a rounded blade, narrow at the quill, round at the tip, softly cupped.
function feather(len, wide, thick, curl) {
  return blob(14, 10, (x, y, z) => {
    const a = (x + 1) / 2; // 0 quill → 1 tip (round)
    const w = Math.pow(Math.max(0, 1 - Math.pow((a - 0.6) / 0.6, 2)), 0.42) * (0.7 + 0.3 * a);
    const X = a * len;
    return v3(X, y * wide * w, z * thick * (0.5 + 0.5 * w) - curl * a * a + 0.25 * wide * w * Math.abs(y) * 0.6);
  });
}

let geometryCache = null;
function buildPotty(colors) {
  const out = new Pieces();
  const white = colors.ceramic, inside = colors.inside;
  // bowl (lathe)
  const lathe = new THREE.LatheGeometry(pottyProfile(), 64);
  lathe.deleteAttribute("uv");
  weld(lathe);
  out.add(lathe, (p) => {
    const r = Math.hypot(p.x, p.z);
    const insideWall = p.y > 0.008 && r < D.rimR - 0.0006 && p.y < D.rimY + 0.0012;
    return { color: insideWall ? inside : white, gloss: 0.9, sheen: 0.05, trans: 0.55 };
  });
  // water (clean, pale aqua)
  const water = new THREE.CircleGeometry(0.0118, 40);
  water.deleteAttribute("uv");
  water.rotateX(-Math.PI / 2);
  water.translate(0, D.water, 0);
  out.add(water, (p) => ({ color: colors.water.clone().lerp(colors.waterDeep, 1 - Math.hypot(p.x, p.z) / 0.0118), gloss: 1, sheen: 0, trans: 0.2 }));
  // lid hinge at the back of the rim: a rounded block with two knuckles
  const hinge = blob(20, 12, (x, y, z) => {
    const sq = (a, e) => Math.sign(a) * Math.pow(Math.abs(a), e);
    return v3(sq(x, 0.55) * 0.0058, D.rimY + 0.0006 + sq(y, 0.6) * 0.0022, -D.rimR - 0.0018 + sq(z, 0.6) * 0.0028);
  });
  out.add(hinge, () => ({ color: white, gloss: 0.9, sheen: 0.05, trans: 0.5 }));
  for (const s of [1, -1]) {
    const k = blob(12, 8, (x, y, z) => v3(s * 0.0042 + x * 0.0019, D.rimY + 0.0013 + y * 0.0016, -D.rimR - 0.0029 + z * 0.0016));
    out.add(k, () => ({ color: white, gloss: 0.9, sheen: 0.05, trans: 0.5 }));
  }
  // pastel heart on the front of the bowl
  const heart = heartShape();
  heart.scale(0.0056, 0.0056, 0.0022);
  heart.rotateX(-0.42);
  heart.translate(0, 0.0128, 0.0159);
  out.add(heart, () => ({ color: colors.heart, gloss: 0.75, sheen: 0.1, trans: 0.4 }));
  // wings: three rows of feathers fanned from a root on each back side
  for (const s of [1, -1]) {
    const root = D.wingRoot(s);
    const outDir = v3(s, 0, -0.9).normalize();
    const up = v3(0, 1, 0);
    const nrm = outDir.clone().cross(up).multiplyScalar(s).normalize(); // toward the front
    // long flight feathers at the back, shorter rows layered in front, round coverts on top
    const rows = [
      { n: 6, a0: 1.25, a1: -0.3, len: (k) => 0.021 + 0.0075 * Math.sin(Math.PI * (0.15 + 0.85 * k)), wide: 0.0047, off: 0, tint: 0 },
      { n: 5, a0: 1.15, a1: -0.08, len: (k) => 0.015 + 0.0036 * Math.sin(Math.PI * (0.15 + 0.85 * k)), wide: 0.0051, off: 0.0012, tint: 0.45 },
      { n: 4, a0: 1.05, a1: 0.2, len: () => 0.0094, wide: 0.0055, off: 0.0024, tint: 0.85 },
    ];
    for (const row of rows) {
      for (let i = 0; i < row.n; i += 1) {
        const k = i / (row.n - 1);
        const a = row.a0 + (row.a1 - row.a0) * k;
        const len = row.len(k);
        const g = feather(len, row.wide, 0.0009, 0.0014 * (len / 0.022));
        // feather space → wing plane: x along (cos a · out + sin a · up), z = −nrm (curl backward)
        const dir = outDir.clone().multiplyScalar(Math.cos(a)).addScaledVector(up, Math.sin(a));
        const across = nrm.clone().cross(dir).normalize();
        const m = new THREE.Matrix4().makeBasis(dir, across, nrm.clone().negate());
        m.setPosition(root.clone().addScaledVector(dir, 0.0012).addScaledVector(nrm, row.off + 0.00022 * i));
        g.applyMatrix4(m);
        // flip so the front faces stay outward after the basis (det may be −1)
        if (m.determinant() < 0) flipWinding(g);
        g.computeVertexNormals();
        weld(g);
        out.add(g, (p) => ({ color: colors.feather.clone().lerp(colors.featherShade, 0.35 * (1 - row.tint) * sstep(0.02, 0.0, p.distanceTo(root))), gloss: 0.3, sheen: 0.75, trans: 0.85 }));
      }
    }
    // a round shoulder (covert puff) hiding the feather roots
    const puff = blob(16, 12, (x, y, z) => v3(x * 0.0046, y * 0.005, z * 0.003).add(root).addScaledVector(nrm, 0.0032).addScaledVector(outDir, 0.0022).add(v3(0, 0.0016, 0)));
    out.add(puff, () => ({ color: colors.feather, gloss: 0.3, sheen: 0.75, trans: 0.85 }));
  }
  const g = out.build();
  g.scale(SIZE, SIZE, SIZE);
  g.boundingSphere = new THREE.Sphere(v3(0, 0.022, -0.008), 0.055);
  return g;
}

function flipWinding(g) {
  const idx = g.index.array;
  for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
}

function heartShape() {
  const s = new THREE.Shape();
  s.moveTo(5, 5);
  s.bezierCurveTo(5, 5, 4, 0, 0, 0);
  s.bezierCurveTo(-6, 0, -6, 7, -6, 7);
  s.bezierCurveTo(-6, 11, -3, 15.4, 5, 19);
  s.bezierCurveTo(12, 15.4, 16, 11, 16, 7);
  s.bezierCurveTo(16, 7, 16, 0, 10, 0);
  s.bezierCurveTo(7, 0, 5, 5, 5, 5);
  const g = new THREE.ExtrudeGeometry(s, { depth: 2, bevelEnabled: true, bevelThickness: 2.5, bevelSize: 2, bevelSegments: 3, curveSegments: 8 });
  g.deleteAttribute("uv");
  g.center();
  g.rotateZ(Math.PI);
  g.scale(1 / 26, 1 / 26, 1 / 26);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------
// Potty object
// ---------------------------------------------------------------------------

/**
 * const potty = new Potty(tray, fur, colors);   // hidden until show()
 * potty.place([x, 0, z], yaw);  potty.update({ scale, squash, jiggle, flush });  potty.hide();
 *   scale: pop-in/out size (0..~1.2) · squash: vertical squish (1 = none) · jiggle: roll (rad)
 *   flush: seconds since the flush started (< 0 or ≥ 1.6: no bubbles)
 */
export class Potty {
  constructor(parent, fur, colors) {
    this.group = new THREE.Group();
    this.group.name = "Potty";
    this.group.visible = false;
    parent.add(this.group);
    if (!geometryCache) geometryCache = buildPotty(colors);
    this.mesh = new THREE.Mesh(geometryCache, createCeramicMaterial(fur));
    this.mesh.name = "PottyBody";
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
    // contact shadow
    this.shadowOpacity = uniform(0.45);
    const sm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    const r = length(uv().sub(0.5)).mul(2);
    sm.colorNode = vec3(0.24, 0.19, 0.18);
    sm.opacityNode = float(1).sub(smoothstep(0.0, 1.0, r)).pow(1.5).mul(this.shadowOpacity);
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.rotateX(-Math.PI / 2);
    this.shadow = new THREE.Mesh(quad, sm);
    this.shadow.name = "PottyShadow";
    this.shadow.renderOrder = 1;
    this.shadow.frustumCulled = false;
    this.shadow.position.set(0, 0.0003, -0.003);
    this.group.add(this.shadow);
    // flush bubbles (potty space)
    this.bubble = createBubbleMaterial(fur);
    this.bubbles = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 14, 10), this.bubble.material, BUBBLES);
    this.bubbles.name = "PottyBubbles";
    this.bubbles.frustumCulled = false;
    this.bubbles.visible = false;
    this.bubbles.renderOrder = 4;
    this.group.add(this.bubbles);
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._e = new THREE.Euler();
  }

  /** Meshes that need pipelines (precompile). */
  get parts() { return [this.group, this.mesh, this.shadow, this.bubbles]; }

  place(position, yaw) {
    this.group.position.set(position[0], 0, position[2]);
    this.group.rotation.set(0, yaw, 0);
    this.group.visible = true;
  }

  hide() { this.group.visible = false; this.bubbles.visible = false; }

  update({ scale = 1, squash = 1, jiggle = 0, flush = -1 } = {}) {
    const s = Math.max(1e-4, scale);
    this.mesh.scale.set(s / Math.sqrt(squash), s * squash, s / Math.sqrt(squash));
    this.mesh.rotation.set(0, 0, jiggle);
    this.shadow.scale.set(0.058 * Math.min(1, s), 1, 0.046 * Math.min(1, s));
    this.shadowOpacity.value = 0.45 * clamp01(s);
    this._updateBubbles(flush);
  }

  // Water-swirl bubbles: rise in a spiral from the rim around the sitting
  // bunny, growing, then pop.
  _updateBubbles(f) {
    if (!(f >= 0) || f >= 1.7) { this.bubbles.visible = false; return; }
    this.bubbles.visible = true;
    const m = this._m, q = this._q, p = v3(), sc = v3();
    for (let i = 0; i < BUBBLES; i += 1) {
      const t0 = 0.04 * i + 0.03 * ((i * 7) % 3);
      const life = 0.85 + 0.25 * ((i * 0.618) % 1);
      const k = (f - t0) / life;
      if (k <= 0 || k >= 1) { m.makeScale(0, 0, 0); this.bubbles.setMatrixAt(i, m); continue; }
      const a = i * 2.39996 + k * 5.2;
      const r = 0.024 + 0.011 * k + 0.003 * Math.sin(i * 1.7);
      p.set(Math.sin(a) * r, POTTY.top + 0.002 + 0.065 * Math.pow(k, 0.85) + 0.004 * ((i * 0.37) % 1), Math.cos(a) * r * 0.9);
      const pop = k > 0.88 ? 1 + 2.2 * (k - 0.88) / 0.12 : 1;
      const size = (0.0016 + 0.002 * ((i * 0.53) % 1)) * Math.min(1, k * 6) * (0.75 + 0.5 * k) * pop * (k > 0.97 ? 0 : 1);
      sc.setScalar(Math.max(1e-5, size));
      m.compose(p, q.identity(), sc);
      this.bubbles.setMatrixAt(i, m);
    }
    this.bubbles.instanceMatrix.needsUpdate = true;
    this.bubble.opacity.value = 1 - sstep(1.45, 1.7, f);
  }

  dispose() {
    this.group.removeFromParent();
    this.mesh.material.dispose();
    this.shadow.geometry.dispose(); this.shadow.material.dispose();
    this.bubbles.geometry.dispose(); this.bubble.material.dispose();
  }
}
