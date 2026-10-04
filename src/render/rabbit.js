// 말랑젤리 plush bunny: hops in, grabs the jelly with both paws, eats it in a
// few bites, reacts with a mood and hops away (~8 s).
//
// Look: a cream needle-felt bunny (big upright ears with pink insides, bead
// eyes, pink nose and blush, chubby cheeks, round paws and feet). It is built
// procedurally from smooth deformed ellipsoids in bind pose; every part is
// attached to one or two bones of a small rig (Object3D hierarchy, never in
// the scene graph). The whole bunny is ONE geometry drawn as ONE instanced
// draw call whose instances are the fur shells (see rabbit-fur.js); bones are
// streamed to the shader as a uniform array each frame.
//
// Draw calls while visible: bunny 1 + contact shadow 1 (+ hearts 1 during the
// happy reaction). Shells per quality: high 14, medium 7, low 0 (velvet only).
//
// Frames: the bunny lives in the tray group (y up, floor y = 0). "Rig space"
// is the bunny's own frame: origin on the floor under it, +z = facing,
// +y = up, +x = the bunny's LEFT.
//
// API: see the class doc below.
import * as THREE from "three/webgpu";
import { float, length, smoothstep, uniform, uv, vec3 } from "three/tsl";
import { BONE_STRIDE, createCandyMaterial, createFurMaterial } from "./rabbit-fur.js";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const SHELLS = Object.freeze({ high: 14, medium: 7, low: 0 });
const HOLD_MAX_R = 0.057;      // paw targets stay within this of the tray centre (spec: 0.06)
const HOLD_Y = 0.052;          // hold height of the paws / jelly centre (spec: 0.05–0.12)
const BITE_SHRINK = 0.87;      // the app shrinks the jelly ~13 % (linear) per bite
const HOLD_SQUEEZE = 0.92;     // paws hold the jelly's sides a little inside (a hug)

const T_ARRIVE = 1.2, T_REACH = 0.55, T_LIFT = 0.6, T_BITE = 0.72, T_FINISH = 0.45, T_REACT = 1.25, T_LEAVE = 1.05;
const BITE_CONTACT = 0.26, BITE_CHEW = 0.4;

// Palette colours are given as the colour they should DISPLAY at nominal
// lighting (irradiance 1, the app's ACES tone mapping at exposure 1.12), so
// the bunny reads as the reference's cream-peach felt and not washed-out grey.
const EXPOSURE = 1.12;
const ACES_IN = [[0.59719, 0.35458, 0.04823], [0.076, 0.90834, 0.01566], [0.0284, 0.13383, 0.83777]];
const ACES_OUT = [[1.60475, -0.53108, -0.07367], [-0.10208, 1.10813, -0.00605], [-0.00327, -0.07276, 1.07602]];
const m3 = (m, v) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const rrt = (x) => (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.432951) + 0.238081);
const aces = (rgb) => m3(ACES_OUT, m3(ACES_IN, rgb.map((c) => (c * EXPOSURE) / 0.6)).map(rrt)).map((c) => Math.min(1, Math.max(0, c)));
function display(hex) {
  const target = new THREE.Color(hex); // linear (display-referred, before sRGB encoding)
  const goal = [target.r, target.g, target.b];
  let x = goal.slice();
  for (let k = 0; k < 120; k += 1) {
    const y = aces(x);
    x = x.map((v, i) => Math.max(0, v * Math.pow((goal[i] + 1e-4) / (y[i] + 1e-4), 1.4)));
  }
  return new THREE.Color(x[0], x[1], x[2]);
}
const COLORS = {
  fur: display("#f2d5bf"),
  furLight: display("#f8e5d5"),
  furWarm: display("#edcab2"),
  earInner: display("#f3a9b2"),
  nose: display("#e5909c"),
  eye: new THREE.Color(0.002, 0.0015, 0.0015),
  line: display("#9a5a5c"),
  cavity: display("#8a3446"),
  tooth: display("#fbf6ee"),
  arc: display("#3a2523"),
  blush: display("#f39aa6"),
  heart: display("#ff7aa2"),
};

// ---------------------------------------------------------------------------
// Small math helpers
// ---------------------------------------------------------------------------

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const easeInOut = (t) => { t = clamp01(t); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
const easeOut = (t) => 1 - Math.pow(1 - clamp01(t), 3);
const easeIn = (t) => Math.pow(clamp01(t), 2);
const easeOutBack = (t) => { t = clamp01(t); const c = 1.9; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
const pulse = (t, a, b) => (t <= a || t >= b ? 0 : Math.sin(Math.PI * (t - a) / (b - a)));
const angleLerp = (a, b, t) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return a + d * t; };
const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const toArr = (v) => [v.x, v.y, v.z];

// Hop: crouch → airborne parabola → landing squash. u in seconds from hop start.
const HOP = { crouch: 0.08, air: 0.3, land: 0.12 };
function hopShape(u, height) {
  const { crouch, air, land } = HOP;
  if (u < 0) return { y: 0, s: 1, k: 0 };
  if (u < crouch) return { y: 0, s: 1 - 0.14 * Math.sin((u / crouch) * Math.PI * 0.5), k: 0 };
  if (u < crouch + air) {
    const a = (u - crouch) / air;
    return { y: 4 * height * a * (1 - a), s: lerp(1.15, 1.03, a) - 0.1 * Math.max(0, a - 0.85) / 0.15 * 0.5, k: a };
  }
  const l = u - crouch - air;
  if (l < land * 2.5) {
    const w = l / land;
    return { y: 0, s: 1 - 0.2 * Math.exp(-3.2 * w) * Math.cos(w * 4.2), k: 1 };
  }
  return { y: 0, s: 1, k: 1 };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

// Unit-sphere based part: `deform(x, y, z)` maps a unit-sphere point to a rig
// space position. Normals are recomputed and welded across the UV seam/poles.
function sphereGeometry(ws, hs, deform) {
  const g = new THREE.SphereGeometry(1, ws, hs);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  const unit = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i += 1) {
    v.fromBufferAttribute(p, i);
    unit[i * 3] = v.x; unit[i * 3 + 1] = v.y; unit[i * 3 + 2] = v.z;
    const q = deform(v.x, v.y, v.z);
    p.setXYZ(i, q.x, q.y, q.z);
  }
  g.deleteAttribute("uv");
  g.computeVertexNormals();
  weldNormals(g);
  g.userData.unit = unit;
  return g;
}

function weldNormals(g) {
  const p = g.attributes.position, n = g.attributes.normal;
  const groups = new Map();
  for (let i = 0; i < p.count; i += 1) {
    const key = `${Math.round(p.getX(i) * 2e6)},${Math.round(p.getY(i) * 2e6)},${Math.round(p.getZ(i) * 2e6)}`;
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    list.push(i);
  }
  const s = new THREE.Vector3();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    s.set(0, 0, 0);
    for (const i of list) s.x += n.getX(i), s.y += n.getY(i), s.z += n.getZ(i);
    s.normalize();
    for (const i of list) n.setXYZ(i, s.x, s.y, s.z);
  }
}

function tubeGeometry(points, radius, segments = 24) {
  const curve = new THREE.CatmullRomCurve3(points, false, "centripetal");
  const g = new THREE.TubeGeometry(curve, segments, radius, 6, false);
  g.deleteAttribute("uv");
  // Round caps: shrink the ring radius at both ends.
  const p = g.attributes.position;
  const ring = 7, rings = segments + 1;
  const c = new THREE.Vector3(), v = new THREE.Vector3();
  for (let r = 0; r < rings; r += 1) {
    const t = r / segments;
    const k = Math.sqrt(Math.max(0.05, 1 - Math.pow(Math.max(0, Math.abs(t - 0.5) * 2 - 0.82) / 0.18, 2)));
    curve.getPointAt(t, c);
    for (let j = 0; j < ring; j += 1) {
      const i = r * ring + j;
      v.fromBufferAttribute(p, i).sub(c).multiplyScalar(k).add(c);
      p.setXYZ(i, v.x, v.y, v.z);
    }
  }
  g.computeVertexNormals();
  weldNormals(g);
  return g;
}

// Accumulates parts into one geometry with the custom attributes.
class PartBuilder {
  constructor() {
    this.position = []; this.normal = []; this.skin = []; this.fur = []; this.comb = []; this.color = []; this.index = [];
    this.partOf = [];
    this.parts = 0;
  }
  // attr(p, n, i) → { b0, b1?, w?, blush?, len, density?, gloss?, comb?: Vector3, thin?, color: Color }
  add(geometry, attr) {
    const part = this.parts++;
    const base = this.position.length / 3;
    const p = geometry.attributes.position, n = geometry.attributes.normal;
    const P = new THREE.Vector3(), N = new THREE.Vector3(), comb = new THREE.Vector3();
    for (let i = 0; i < p.count; i += 1) {
      P.fromBufferAttribute(p, i); N.fromBufferAttribute(n, i);
      const a = attr(P, N, i);
      this.position.push(P.x, P.y, P.z);
      this.normal.push(N.x, N.y, N.z);
      this.skin.push(a.b0, a.b1 ?? a.b0, a.w ?? 0, a.blush ?? 0);
      this.fur.push(a.len, a.density ?? 2800, a.gloss ?? 0, 1);
      comb.set(0, 0, 0);
      if (a.comb) comb.copy(a.comb).addScaledVector(N, -N.dot(a.comb)); // tangent only
      this.comb.push(comb.x, comb.y, comb.z, a.thin ?? 0);
      this.color.push(a.color.r, a.color.g, a.color.b);
      this.partOf.push(a.occluderPart ?? part);
    }
    const index = geometry.index;
    if (index) for (let i = 0; i < index.count; i += 1) this.index.push(base + index.getX(i));
    else for (let i = 0; i < p.count; i += 1) this.index.push(base + i);
    return part;
  }
  // Analytic ambient occlusion from sphere occluders + the floor (bind pose).
  bakeOcclusion(occluders) {
    const count = this.position.length / 3;
    for (let i = 0; i < count; i += 1) {
      const px = this.position[i * 3], py = this.position[i * 3 + 1], pz = this.position[i * 3 + 2];
      const nx = this.normal[i * 3], ny = this.normal[i * 3 + 1], nz = this.normal[i * 3 + 2];
      const self = this.partOf[i];
      let occ = 0;
      for (const o of occluders) {
        if (o.parts.includes(self) || (o.skip && o.skip.includes(self))) continue;
        const dx = o.c[0] - px, dy = o.c[1] - py, dz = o.c[2] - pz;
        const d2 = dx * dx + dy * dy + dz * dz;
        const d = Math.sqrt(d2) || 1e-6;
        const cos = (dx * nx + dy * ny + dz * nz) / d;
        if (cos <= 0) continue;
        occ += Math.min(1.5, (o.r * o.r) / d2) * cos * 0.85;
      }
      occ += Math.max(0, -ny) * (1 - sstep(0, 0.014, py)) * 0.5 + (1 - sstep(0, 0.008, py)) * 0.15;
      this.fur[i * 4 + 3] = Math.max(0.32, 1 - occ);
    }
  }
  build() {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.position, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.normal, 3));
    g.setAttribute("skin", new THREE.Float32BufferAttribute(this.skin, 4));
    g.setAttribute("fur", new THREE.Float32BufferAttribute(this.fur, 4));
    g.setAttribute("comb", new THREE.Float32BufferAttribute(this.comb, 4));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.color, 3));
    const count = this.position.length / 3;
    g.setIndex(count > 65535 ? new THREE.Uint32BufferAttribute(this.index, 1) : new THREE.Uint16BufferAttribute(this.index, 1));
    g.instanceCount = 1;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.05, 0), 0.12);
    return g;
  }
}

// ---------------------------------------------------------------------------
// Rig (bind pose, rig space). Every node: absolute bind position + bind
// rotation; `skin: true` nodes are skinning bones (index into the uniform array).
// ---------------------------------------------------------------------------

const HEAD_C = v3(0, 0.0505, 0.003), HEAD_R = v3(0.0205, 0.018, 0.0188);
const BODY_C = v3(0, 0.0235, -0.0025), BODY_R = v3(0.0262, 0.0242, 0.024);
const ARM_LEN = 0.03;
const EAR_LEN = 0.04, EAR_HALF_W = 0.0091, EAR_HALF_T = 0.0027, EAR_SPLIT = 0.46;
const MOUTH_POINT = v3(0, 0.0412, 0.0246); // bite point (bind, rig space)
const NOSE_TIP = v3(0, 0.0447, 0.0246);

function headSurface(dir) {
  const d = dir.clone().normalize();
  const k = 1 / Math.hypot(d.x / HEAD_R.x, d.y / HEAD_R.y, d.z / HEAD_R.z);
  return HEAD_C.clone().addScaledVector(d, k);
}
function headNormal(point) {
  return v3((point.x - HEAD_C.x) / (HEAD_R.x * HEAD_R.x), (point.y - HEAD_C.y) / (HEAD_R.y * HEAD_R.y), (point.z - HEAD_C.z) / (HEAD_R.z * HEAD_R.z)).normalize();
}

function rigLayout() {
  const eye = (s) => {
    const surf = headSurface(v3(s * 0.53, 0.0, 0.85));
    const n = headNormal(surf);
    const q = new THREE.Quaternion().setFromUnitVectors(v3(0, 0, 1), n.clone().lerp(v3(0, 0, 1), 0.35).normalize());
    return { pos: surf.clone().addScaledVector(n, -0.0006), normal: n, quat: q };
  };
  const earQuat = (s) => new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.12, s * 0.32, -s * 0.2, "YXZ"));
  const armDir = (s) => v3(-s * 0.17, -0.62, 0.72).normalize();
  const nodes = [];
  const add = (name, parent, pos, quat = new THREE.Quaternion(), skin = true) => { nodes.push({ name, parent, pos, quat, skin }); };
  add("base", null, v3(0, 0, 0), undefined, false);
  add("footL", "base", v3(0.0135, 0.0042, 0.0165));
  add("footR", "base", v3(-0.0135, 0.0042, 0.0165));
  add("hips", "base", v3(0, 0.011, -0.01), undefined, false);
  add("body", "hips", BODY_C.clone());
  add("tail", "hips", v3(0, 0.0118, -0.0262));
  add("chest", "hips", v3(0, 0.036, -0.002), undefined, false);
  add("neck", "chest", v3(0, 0.042, 0.0), undefined, false);
  add("head", "neck", HEAD_C.clone());
  add("cheekL", "head", v3(0.0112, 0.0425, 0.0105));
  add("cheekR", "head", v3(-0.0112, 0.0425, 0.0105));
  add("muzzle", "head", v3(0, 0.0425, 0.019));
  add("jaw", "head", v3(0, 0.042, 0.012));
  add("mouth", "head", v3(0, 0.0428, 0.0236));
  add("nose", "head", v3(0, 0.0447, 0.0232));
  for (const [s, side] of [[1, "L"], [-1, "R"]]) {
    const e = eye(s);
    add(`eye${side}`, "head", e.pos, e.quat);
    add(`happy${side}`, "head", e.pos.clone(), e.quat.clone());
    const q = earQuat(s);
    const base = v3(s * 0.0088, 0.064, -0.0015);
    add(`ear1${side}`, "head", base, q);
    add(`ear2${side}`, `ear1${side}`, base.clone().add(v3(0, EAR_LEN * EAR_SPLIT, 0).applyQuaternion(q)), q.clone());
    const aq = new THREE.Quaternion().setFromUnitVectors(v3(0, -1, 0), armDir(s));
    const shoulder = v3(s * 0.0172, 0.0405, 0.0125);
    add(`shoulder${side}`, "chest", shoulder, aq);
    add(`paw${side}`, `shoulder${side}`, shoulder.clone().addScaledVector(armDir(s), ARM_LEN), aq.clone());
  }
  return { nodes, eye };
}

function buildRig() {
  const { nodes, eye } = rigLayout();
  const byName = {};
  const skel = new THREE.Object3D();
  const skinBones = [];
  for (const def of nodes) {
    const o = new THREE.Object3D();
    o.name = def.name;
    const parent = def.parent ? byName[def.parent] : null;
    const pq = parent ? parent.userData.bindQuat : new THREE.Quaternion();
    const pp = parent ? parent.userData.bindPos : v3();
    const inv = pq.clone().invert();
    o.position.copy(def.pos).sub(pp).applyQuaternion(inv);
    o.quaternion.copy(inv).multiply(def.quat);
    o.userData.bindPos = def.pos.clone();
    o.userData.bindQuat = def.quat.clone();
    o.userData.restPos = o.position.clone();
    o.userData.restQuat = o.quaternion.clone();
    (parent || skel).add(o);
    byName[def.name] = o;
    if (def.skin) { o.userData.index = skinBones.length; skinBones.push(o); }
  }
  skel.updateMatrixWorld(true);
  for (const b of skinBones) b.userData.bindInverse = b.matrixWorld.clone().invert();
  return { skel, bones: byName, skinBones, eye };
}

function buildGeometry(rig) {
  const B = (name) => rig.bones[name].userData.index;
  const pb = new PartBuilder();
  const C = COLORS;
  const tmp = new THREE.Color();
  const mixColor = (a, b, t) => tmp.copy(a).lerp(b, clamp01(t)).clone();
  const occ = [];

  // Body: pear-shaped, flat-bottomed, lighter chest/belly.
  const body = pb.add(sphereGeometry(40, 30, (x, y, z) => {
    const t = y; // −1 bottom .. 1 top
    const narrow = t > 0 ? 1 - 0.2 * t * t : 1 + 0.03 * (1 - (t + 1) * (t + 1));
    let px = x * BODY_R.x * narrow, pz = z * BODY_R.z * narrow, py = y * BODY_R.y;
    pz += z > 0 ? 0.0018 * z * Math.max(0, 1 - Math.abs(t + 0.25) * 1.4) : 0; // tummy
    let Y = BODY_C.y + py;
    if (Y < 0.0016) Y = 0.0016 - (0.0016 - Y) * 0.12;
    return v3(px + BODY_C.x, Y, pz + BODY_C.z);
  }), (p, n) => ({
    b0: B("body"), len: 0.0024, density: 2600,
    comb: v3(0, -0.75, -0.35),
    color: mixColor(mixColor(C.fur, C.furWarm, sstep(0.02, -0.02, p.z) * 0.6), C.furLight, sstep(0.3, 0.9, n.z) * sstep(0.004, 0.02, p.y) * 0.7),
  }));
  occ.push({ parts: [body], c: [0, 0.016, -0.002], r: 0.022 }, { parts: [body], c: [0, 0.032, -0.003], r: 0.019 });

  // Tail: fluffy pom-pom (long fur, no lean).
  const tail = pb.add(sphereGeometry(18, 12, (x, y, z) => v3(x * 0.0058, 0.0118 + y * 0.0056, -0.0262 + z * 0.0052)), () => ({
    b0: B("tail"), len: 0.0036, density: 2400, color: C.furLight,
  }));
  occ.push({ parts: [tail], c: [0, 0.0118, -0.0262], r: 0.0058 });

  // Feet: oval, flat soles, toes forward.
  const feet = [];
  for (const s of [1, -1]) {
    const c = v3(s * 0.0135, 0.0042, 0.0165);
    feet.push(pb.add(sphereGeometry(22, 16, (x, y, z) => {
      let Y = c.y + y * 0.0045;
      if (Y < 0.0007) Y = 0.0007 - (0.0007 - Y) * 0.1;
      return v3(c.x + x * 0.0066, Y, c.z + z * 0.0102);
    }), (p) => ({ b0: B(s > 0 ? "footL" : "footR"), len: 0.0018, density: 2900, comb: v3(0, 0, 0.6), color: mixColor(C.fur, C.furLight, sstep(0.016, 0.026, p.z)) })));
    occ.push({ parts: [feet[feet.length - 1]], c: [c.x, c.y + 0.001, c.z], r: 0.0058 });
  }

  // Head: round, short face fur near the eyes / nose, lighter muzzle.
  const eyeL = rig.eye(1).pos, eyeR = rig.eye(-1).pos;
  const head = pb.add(sphereGeometry(44, 32, (x, y, z) => {
    const low = y < 0 ? 1 + 0.05 * Math.sin(-y * Math.PI) : 1;
    return v3(HEAD_C.x + x * HEAD_R.x * low, HEAD_C.y + y * HEAD_R.y, HEAD_C.z + z * HEAD_R.z * (z > 0 ? 1 + 0.04 * Math.max(0, -y) : 1));
  }), (p, n) => {
    const dEye = Math.min(p.distanceTo(eyeL), p.distanceTo(eyeR));
    const dNose = p.distanceTo(NOSE_TIP);
    const face = Math.min(sstep(0.0028, 0.0062, dEye), sstep(0.004, 0.012, dNose));
    return {
      b0: B("head"), len: lerp(0.0007, 0.002, face), density: 3000,
      comb: p.clone().sub(NOSE_TIP).normalize().multiplyScalar(0.55).add(v3(0, -0.15, 0)),
      color: mixColor(C.fur, C.furLight, sstep(0.45, 0.9, n.z) * (1 - sstep(0.048, 0.056, p.y)) * 0.8),
    };
  });
  occ.push({ parts: [head], c: [HEAD_C.x, HEAD_C.y, HEAD_C.z], r: 0.0182 });

  // Cheeks: chubby, fluffy, blushing on the front.
  const cheeks = [];
  for (const s of [1, -1]) {
    const c = rig.bones[s > 0 ? "cheekL" : "cheekR"].userData.bindPos;
    cheeks.push(pb.add(sphereGeometry(24, 16, (x, y, z) => v3(c.x + x * 0.0096, c.y + y * 0.0082, c.z + z * 0.0088)), (p, n) => ({
      b0: B(s > 0 ? "cheekL" : "cheekR"), len: 0.0022, density: 2900,
      comb: v3(s * 0.7, -0.45, -0.25),
      blush: sstep(0.35, 0.85, n.dot(v3(s * 0.45, -0.15, 0.88).normalize())),
      color: mixColor(C.fur, C.furLight, sstep(0.3, 0.9, n.z) * 0.6),
    })));
    occ.push({ parts: [cheeks[cheeks.length - 1]], c: [c.x, c.y, c.z], r: 0.0082 });
  }

  // Muzzle pads (whisker pads) and chin: short light fur.
  const pads = [];
  for (const s of [1, -1]) {
    const c = v3(s * 0.0036, 0.0425, 0.0186);
    pads.push(pb.add(sphereGeometry(20, 14, (x, y, z) => v3(c.x + x * 0.0049, c.y + y * 0.004, c.z + z * 0.0047)), () => ({
      b0: B("muzzle"), len: 0.0009, density: 3400, comb: v3(s * 0.6, -0.3, 0), color: C.furLight,
    })));
  }
  const padSurfaceZ = (x, y) => {
    let best = -1;
    for (const s of [1, -1]) {
      const dx = (x - s * 0.0036) / 0.0049, dy = (y - 0.0425) / 0.004;
      const q = 1 - dx * dx - dy * dy;
      if (q > 0) best = Math.max(best, 0.0186 + 0.0047 * Math.sqrt(q));
    }
    return best > 0 ? best : 0.021;
  };
  pb.add(sphereGeometry(18, 12, (x, y, z) => v3(x * 0.0048, 0.0386 + y * 0.0032, 0.0158 + z * 0.0048)), () => ({
    b0: B("jaw"), len: 0.0012, density: 3200, comb: v3(0, -0.5, 0.2), color: C.furLight,
  }));

  // Nose: small rounded inverted triangle, satin pink.
  pb.add(sphereGeometry(20, 14, (x, y, z) => {
    const w = 1 - 0.42 * Math.max(0, -y);
    return v3(x * 0.0025 * w, 0.0447 + y * 0.0016, 0.0232 + z * 0.0014 + 0.0004 * (1 - Math.abs(y)));
  }), () => ({ b0: B("nose"), len: 0, gloss: 0.38, color: C.nose }));

  // Mouth line: an inverted Y just under the nose, on top of the pad fur.
  for (const s of [1, -1]) {
    const pts = [[0, 0.0438], [0, 0.0426], [s * 0.0009, 0.0418], [s * 0.002, 0.0415], [s * 0.003, 0.0419]]
      .map(([x, y]) => v3(x, y, Math.max(padSurfaceZ(x, y), 0.0214) + 0.0011));
    pb.add(tubeGeometry(pts, 0.00027, 20), () => ({ b0: B("muzzle"), len: 0, gloss: 0, color: C.line }));
  }

  // Mouth cavity + two little front teeth (scaled open/closed by the mouth bone).
  pb.add(sphereGeometry(18, 12, (x, y, z) => v3(x * 0.0026, 0.0407 + y * 0.0021, 0.0238 + z * 0.0011)), () => ({ b0: B("mouth"), len: 0, color: C.cavity }));
  for (const s of [1, -1]) {
    pb.add(sphereGeometry(10, 8, (x, y, z) => {
      const box = (a) => Math.sign(a) * Math.pow(Math.abs(a), 0.45);
      return v3(s * 0.00066 + box(x) * 0.00058, 0.0419 + box(y) * 0.00082, 0.0247 + box(z) * 0.00032);
    }), () => ({ b0: B("mouth"), len: 0, gloss: 0.25, color: C.tooth }));
  }

  // Bead eyes (glossy black) and the happy ^ ^ arcs (hidden until happy).
  for (const s of [1, -1]) {
    const e = rig.eye(s);
    const q = e.quat;
    pb.add(sphereGeometry(22, 16, (x, y, z) => v3(x * 0.003, y * 0.0032, z * 0.0024).applyQuaternion(q).add(e.pos)), () => ({
      b0: B(s > 0 ? "eyeL" : "eyeR"), len: 0, gloss: 1, color: C.eye,
    }));
    // Closed-eye arc "∩" (happy ^ ^); the bone turns it into "∪" for blinks.
    const arc = [];
    for (let i = 0; i <= 10; i += 1) {
      const a = Math.PI * (1.1 - 1.2 * (i / 10));
      arc.push(v3(Math.cos(a) * 0.0031, Math.sin(a) * 0.0024 - 0.0008, 0.0022).applyQuaternion(q).add(e.pos));
    }
    pb.add(tubeGeometry(arc, 0.00068, 28), () => ({ b0: B(s > 0 ? "happyL" : "happyR"), len: 0, gloss: 0.1, color: C.arc }));
  }

  // Ears: leaf-shaped, spoon-concave front with pink inner velvet, blended
  // over two bones so they bend smoothly. Built in ear space, then placed.
  for (const s of [1, -1]) {
    const side = s > 0 ? "L" : "R";
    const e1 = rig.bones[`ear1${side}`];
    const q = e1.userData.bindQuat, base = e1.userData.bindPos;
    const prof = (t) => Math.pow(Math.sin(Math.PI * Math.min(1, 0.12 + 0.9 * t)), 0.5) * (1 - 0.16 * t);
    const cavity = (t) => sstep(0.06, 0.26, t) * (1 - sstep(0.78, 0.97, t));
    const earInfo = [];
    const geo = sphereGeometry(24, 36, (x, y, z) => {
      const t = (y + 1) / 2;
      const rho = Math.sqrt(Math.max(0, 1 - y * y));
      const full = Math.pow(rho, 0.5) / Math.max(rho, 1e-6);
      const a = EAR_HALF_W * prof(t), b = EAR_HALF_T * (0.55 + 0.45 * prof(t));
      const X = x * full * a;
      let Z = z * full * b;
      const across = a > 0 ? X / a : 0;
      if (z > 0) Z -= 1.45 * b * cavity(t) * Math.max(0, 1 - across * across) * Math.min(1, z * full * 1.6);
      const inner = z > 0 ? cavity(t) * sstep(0.85, 0.55, Math.abs(across)) * sstep(0.05, 0.35, z * full) : 0;
      earInfo.push({ t, inner });
      return v3(X, t * (EAR_LEN + 0.004) - 0.004, Z).applyQuaternion(q).add(base);
    });
    const tipDir = v3(0, 1, 0).applyQuaternion(q);
    let k = 0;
    pb.add(geo, () => {
      const { t, inner } = earInfo[k++];
      return {
        b0: B(`ear1${side}`), b1: B(`ear2${side}`), w: sstep(EAR_SPLIT - 0.12, EAR_SPLIT + 0.12, t),
        len: lerp(0.0013, 0.00045, inner), density: lerp(3200, 4200, inner),
        comb: tipDir.clone().multiplyScalar(0.5), thin: 0.6 + 0.4 * inner,
        color: mixColor(mixColor(C.fur, C.furLight, 0.25), C.earInner, inner),
      };
    });
    const c1 = base.clone().addScaledVector(tipDir, EAR_LEN * 0.18);
    occ.push({ parts: [pb.parts - 1], c: toArr(c1), r: 0.005 });
  }

  // Arms: soft tubes from inside the chest ending in round paws; two bones
  // (shoulder, paw) so the arm stretches like a plush toy when reaching.
  const arms = [];
  for (const s of [1, -1]) {
    const side = s > 0 ? "L" : "R";
    const sh = rig.bones[`shoulder${side}`];
    const q = sh.userData.bindQuat, base = sh.userData.bindPos;
    const top = 0.004, bottom = -(ARM_LEN + 0.0066);
    const along = [];
    const geo = sphereGeometry(20, 28, (x, y, z) => {
      const t = (1 - y) / 2; // 0 shoulder top → 1 paw tip
      const Y = lerp(top, bottom, t);
      const rho = Math.sqrt(Math.max(0, 1 - y * y));
      const full = Math.pow(rho, 0.45) / Math.max(rho, 1e-6);
      const paw = Math.exp(-Math.pow((Y + ARM_LEN) / 0.0058, 2));
      const r = 0.0049 + 0.0019 * paw;
      along.push(Y);
      return v3(x * full * r, Y, z * full * r * 0.96).applyQuaternion(q).add(base);
    });
    const dir = v3(0, -1, 0).applyQuaternion(q);
    let k = 0;
    arms.push(pb.add(geo, () => {
      const Y = along[k++];
      return {
        b0: B(`shoulder${side}`), b1: B(`paw${side}`), w: sstep(-0.004, -0.013, Y),
        len: 0.0019, density: 2900, comb: dir.clone().multiplyScalar(0.55),
        color: mixColor(C.fur, C.furLight, sstep(-0.012, -0.022, Y) * 0.6),
      };
    }));
  }
  // Arms move a lot: the body does not occlude them in the bake.
  for (const o of occ) if (o.parts.includes(body)) o.skip = arms.slice();
  pb.bakeOcclusion(occ);
  return pb.build();
}

function heartGeometry() {
  const s = new THREE.Shape();
  s.moveTo(5, 5);
  s.bezierCurveTo(5, 5, 4, 0, 0, 0);
  s.bezierCurveTo(-6, 0, -6, 7, -6, 7);
  s.bezierCurveTo(-6, 11, -3, 15.4, 5, 19);
  s.bezierCurveTo(12, 15.4, 16, 11, 16, 7);
  s.bezierCurveTo(16, 7, 16, 0, 10, 0);
  s.bezierCurveTo(7, 0, 5, 5, 5, 5);
  const g = new THREE.ExtrudeGeometry(s, { depth: 3, bevelEnabled: true, bevelThickness: 3, bevelSize: 2.4, bevelSegments: 5, curveSegments: 14 });
  g.deleteAttribute("uv");
  g.center();
  g.rotateZ(Math.PI);
  g.scale(1 / 26, 1 / 26, 1 / 26);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------
// Ear spring (2 segments × pitch/roll), driven by head acceleration.
// ---------------------------------------------------------------------------

class EarSpring {
  constructor() { this.a = [0, 0, 0, 0]; this.v = [0, 0, 0, 0]; }
  // a = [pitch1, outward1, pitch2, outward2] (rad; pitch + = tip backwards).
  // force = [pitch, outward] angular acceleration from the head's motion;
  // segment 2 also feels segment 1's acceleration (follow-through).
  step(dt, target, force, wobble = 0) {
    const n = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / n;
    const w1 = 2 * Math.PI * 3.4, w2 = 2 * Math.PI * 4.2, z1 = 0.28, z2 = 0.2;
    for (let k = 0; k < n; k += 1) {
      for (let j = 0; j < 2; j += 1) {
        const acc1 = w1 * w1 * (target[j] - this.a[j]) - 2 * z1 * w1 * this.v[j] + force[j] + wobble * 0.4;
        const acc2 = w2 * w2 * (target[j + 2] - this.a[j + 2]) - 2 * z2 * w2 * this.v[j + 2] + force[j] * 1.3 - acc1 * 0.45 + wobble;
        this.v[j] += acc1 * h; this.a[j] += this.v[j] * h;
        this.v[j + 2] += acc2 * h; this.a[j + 2] += this.v[j + 2] * h;
      }
    }
  }
  reset() { this.a.fill(0); this.v.fill(0); }
}

// ---------------------------------------------------------------------------
// Rabbit
// ---------------------------------------------------------------------------

/**
 * Plush bunny that eats the jelly.
 *
 *   const rabbit = new Rabbit(tray, { quality: "high" });   // hidden until play()
 *   rabbit.play({ position: [x, 0, z], faceTo: [x, y, z], jelly: { center, width, height },
 *                 bites: 4, mood: "happy" | "ok" | "sad", onEvent(type, data) {} });
 *   // every frame:
 *   const { paws, mouth } = rabbit.update(dt, { center, bounds } | null);
 *   //   paws: null | [[x,y,z] left paw, [x,y,z] right paw]  (tray space; rabbit's left/right)
 *   //   mouth: [x,y,z]  (tray space)
 *   rabbit.skip();      // fast-forward to leaving, emitting the remaining key events in order
 *   rabbit.setQuality("high" | "medium" | "low");  rabbit.busy;  rabbit.dispose();
 *
 * Events (type, data), times for bites = 4:
 *   arrive 0.00 {position}            hop 0.38/0.88 {phase:"arrive", index}
 *   grab   1.75 {paws}                lift 1.75 {hold}
 *   bite   2.61 + 0.72·i {index, count, mouth}   chew 2.75 + 0.72·i {index, count, duration}
 *   finish 5.23 {}                    react 5.68 {mood}      leave 6.93 {}
 *   hop (leave) …                     done 7.98 {}
 */
export class Rabbit {
  constructor(parent, { quality = "high" } = {}) {
    this.parent = parent;
    this.root = new THREE.Group();
    this.root.name = "Rabbit";
    this.root.visible = false;
    parent.add(this.root);

    this.rig = buildRig();
    this.fur = createFurMaterial(this.rig.skinBones.length);
    this.fur.u.blushColor.value.copy(COLORS.blush);
    this.geometry = buildGeometry(this.rig);
    this.mesh = new THREE.Mesh(this.geometry, this.fur.material);
    this.mesh.name = "RabbitBody";
    this.mesh.frustumCulled = false;
    this.root.add(this.mesh);

    // Soft contact shadow (one transparent quad; the stage has no shadow maps).
    this.shadowOpacity = uniform(0.42);
    const shadowMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    const r = length(uv().sub(0.5)).mul(2);
    shadowMaterial.colorNode = vec3(0.24, 0.19, 0.18);
    shadowMaterial.opacityNode = float(1).sub(smoothstep(0.0, 1.0, r)).pow(1.6).mul(this.shadowOpacity);
    shadowMaterial.fog = true;
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.rotateX(-Math.PI / 2);
    this.shadow = new THREE.Mesh(quad, shadowMaterial);
    this.shadow.name = "RabbitShadow";
    this.shadow.renderOrder = 1;
    this.shadow.frustumCulled = false;
    this.root.add(this.shadow);

    // Hearts for the happy reaction (one instanced draw).
    this.hearts = new THREE.InstancedMesh(heartGeometry(), createCandyMaterial(this.fur, COLORS.heart), 3);
    this.hearts.name = "RabbitHearts";
    this.hearts.frustumCulled = false;
    this.hearts.visible = false;
    this.root.add(this.hearts);

    this.ears = [new EarSpring(), new EarSpring()];
    this.state = null;
    this.quality = "high";
    this.setQuality(quality);
    this._m = new THREE.Matrix4(); this._n = new THREE.Matrix3(); this._q = new THREE.Quaternion();
    this._rootInv = new THREE.Matrix4();
    this._sunA = v3(); this._sunB = v3(); this._e = new THREE.Euler();
  }

  setQuality(q) {
    const key = q === "medium" || q === "mid" ? "medium" : q === "low" ? "low" : "high";
    this.quality = key;
    const shells = SHELLS[key];
    this.geometry.instanceCount = shells + 1;
    this.fur.u.shellCount.value = Math.max(1, shells);
    this.fur.u.inflate.value = shells === 0 ? 0.5 : 0;
    this.fur.u.rootDark.value = shells === 0 ? 1 : shells < 10 ? 0.76 : 0.7;
  }

  get busy() { return this.state !== null; }

  /** Optional: compile the bunny's pipelines ahead of the first play() (avoids a hitch). */
  async precompile(renderer, camera, scene) {
    const was = [this.root.visible, this.hearts.visible];
    this.root.visible = true; this.hearts.visible = true;
    try { await renderer.compileAsync(this.root, camera, scene); } finally { [this.root.visible, this.hearts.visible] = was; }
  }

  // -------------------------------------------------------------------------
  play({ position = [0, 0, -0.105], faceTo = [0, 0.02, 0], jelly = null, bites = 4, mood = "happy", onEvent = null } = {}) {
    if (this.state) this._finish();
    const P = v3(position[0], 0, position[2]);
    const face = v3(faceTo[0], 0, faceTo[2]);
    const F = face.clone().sub(P);
    if (F.lengthSq() < 1e-8) F.set(-P.x, 0, -P.z);
    if (F.lengthSq() < 1e-8) F.set(0, 0, 1);
    F.normalize();
    const X = v3(F.z, 0, -F.x); // bunny's left
    const outward = P.clone().setY(0);
    if (outward.lengthSq() < 1e-8) outward.copy(F).negate();
    outward.normalize();
    const side = v3(outward.z, 0, -outward.x);
    const j = jelly || { center: [0, 0.018, 0], width: 0.072, height: 0.036 };
    bites = Math.max(1, Math.min(8, Math.round(bites)));
    mood = mood === "ok" || mood === "sad" ? mood : "happy";

    const t = {};
    t.arrive = 0;
    t.reach = T_ARRIVE;
    t.grab = t.reach + T_REACH;
    t.lift = t.grab;
    t.bites = t.lift + T_LIFT;
    t.finish = t.bites + bites * T_BITE;
    t.react = t.finish + T_FINISH;
    t.leave = t.react + T_REACT;
    t.done = t.leave + T_LEAVE;

    this.state = {
      t: 0, times: t, bites, mood, onEvent,
      seat: P, F, X, yaw: Math.atan2(F.x, F.z), outward, side,
      start: P.clone().addScaledVector(outward, 0.072).addScaledVector(side, 0.03),
      mid: P.clone().addScaledVector(outward, 0.035).addScaledVector(side, 0.012),
      exitA: P.clone().addScaledVector(outward, 0.036).addScaledVector(side, -0.018),
      exitB: P.clone().addScaledVector(outward, 0.076).addScaledVector(side, -0.036),
      faceTo: v3(faceTo[0], faceTo[1] ?? 0.02, faceTo[2]),
      jelly0: { center: v3(...j.center), width: j.width ?? 0.072, height: j.height ?? 0.036 },
      jellyNow: null,
      plan: null,
      emitted: new Set(),
      events: [],
      bitesDone: 0,
      sizeScale: 1, refDepth: 0,
      skipped: false, blendFrom: null, blendT: 1,
      blink: { next: 1.4 + Math.random() * 1.5 },
      twitch: { next: 0.6 },
      prevHead: null, prevVel: v3(), accel: v3(),
      lastPose: null,
    };
    this._buildEvents();
    for (const e of this.ears) e.reset();
    this.root.visible = true;
    this.hearts.visible = false;
    this.update(0, null);
  }

  skip() {
    const s = this.state;
    if (!s || s.t >= s.times.leave) return;
    if (!s.plan) this._makePlan();
    // Emit everything that would have happened before leaving, in order.
    for (const e of s.events) {
      if (e.t < s.times.leave && !s.emitted.has(e.id)) {
        s.emitted.add(e.id);
        if (e.type === "hop") continue; // cosmetic, not a key event
        const data = e.make(true);
        if (e.type === "bite") s.bitesDone = Math.max(s.bitesDone, data.index + 1);
        this._emit(e.type, data);
        if (this.state !== s) return; // the handler stopped or restarted the bunny
      }
    }
    s.skipped = true;
    s.blendFrom = s.lastPose ? clonePose(s.lastPose) : null;
    s.blendT = 0;
    s.t = s.times.leave;
  }

  dispose() {
    this.state = null;
    this.root.removeFromParent();
    this.geometry.dispose();
    this.fur.material.dispose();
    this.shadow.geometry.dispose(); this.shadow.material.dispose();
    this.hearts.geometry.dispose(); this.hearts.material.dispose();
  }

  // -------------------------------------------------------------------------
  _emit(type, data) {
    try { this.state?.onEvent?.(type, data); } catch (error) { console.error(error); }
  }

  _buildEvents() {
    const s = this.state, t = s.times;
    const ev = (id, time, type, make) => s.events.push({ id, t: time, type, make });
    ev("arrive", 0, "arrive", () => ({ position: toArr(s.seat) }));
    ev("hop-a0", HOP.crouch + HOP.air, "hop", () => ({ phase: "arrive", index: 0 }));
    ev("hop-a1", 0.5 + HOP.crouch + HOP.air, "hop", () => ({ phase: "arrive", index: 1 }));
    ev("grab", t.grab, "grab", () => ({ paws: this._pawTargets(t.grab).map(toArr) }));
    ev("lift", t.lift + 1e-4, "lift", () => ({ hold: toArr(s.plan.hold) }));
    for (let i = 0; i < s.bites; i += 1) {
      const t0 = t.bites + i * T_BITE;
      ev(`bite${i}`, t0 + BITE_CONTACT, "bite", (skipped) => ({ index: i, count: s.bites, mouth: skipped ? toArr(this._biteTarget(i)) : this._mouthTray() }));
      ev(`chew${i}`, t0 + BITE_CHEW, "chew", () => ({ index: i, count: s.bites, duration: T_BITE - BITE_CHEW }));
    }
    ev("finish", t.finish, "finish", () => ({}));
    ev("react", t.react, "react", () => ({ mood: s.mood }));
    ev("leave", t.leave, "leave", () => ({}));
    ev("hop-l0", t.leave + 0.05 + HOP.crouch + HOP.air, "hop", () => ({ phase: "leave", index: 0 }));
    ev("hop-l1", t.leave + 0.55 + HOP.crouch + HOP.air, "hop", () => ({ phase: "leave", index: 1 }));
    ev("done", t.done, "done", () => ({}));
    s.events.sort((a, b) => a.t - b.t);
  }

  // Jelly measurements in the bunny's frame (from bounds if available).
  _measureJelly() {
    const s = this.state;
    const j = s.jellyNow;
    const F = s.F, X = s.X;
    if (j && j.bounds) {
      const b = j.bounds;
      const ex = (b[3] - b[0]) / 2, ey = (b[4] - b[1]) / 2, ez = (b[5] - b[2]) / 2;
      return {
        center: v3((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2),
        hw: Math.abs(X.x) * ex + Math.abs(X.z) * ez,
        hd: Math.abs(F.x) * ex + Math.abs(F.z) * ez,
        hh: ey,
      };
    }
    if (j && j.center) {
      const w = s.jelly0.width / 2 * s.sizeScale;
      return { center: v3(...j.center), hw: w, hd: w, hh: s.jelly0.height / 2 * s.sizeScale };
    }
    const w = s.jelly0.width / 2;
    return { center: s.jelly0.center.clone(), hw: w, hd: w, hh: s.jelly0.height / 2 };
  }

  _makePlan() {
    const s = this.state;
    const m = this._measureJelly();
    const X = s.X;
    // Paws touch the jelly's left/right sides (relative to the bunny's facing) at mid-height.
    const contactL = m.center.clone().addScaledVector(X, m.hw);
    const contactR = m.center.clone().addScaledVector(X, -m.hw);
    s.plan = { contactL, contactR, hw: m.hw, hd: m.hd, hh: m.hh, hold: this._holdCenter(1) };
  }

  // Hold centre (tray) for jelly scale k: on the facing line, as close to the
  // bunny as allowed while BOTH paws stay within HOLD_MAX_R of the tray centre.
  _holdCenter(k) {
    const s = this.state, P = s.seat, F = s.F, X = s.X, p = s.plan;
    const a = (p ? p.hw : s.jelly0.width / 2) * HOLD_SQUEEZE * k;
    const pf = P.x * F.x + P.z * F.z, px = Math.abs(P.x * X.x + P.z * X.z);
    const c = P.x * P.x + P.z * P.z + a * a + 2 * a * px - HOLD_MAX_R * HOLD_MAX_R;
    const disc = pf * pf - c;
    const d = Math.max(0.03, disc >= 0 ? -pf - Math.sqrt(disc) : -pf);
    return P.clone().addScaledVector(F, d).setY(HOLD_Y);
  }

  // Planned paw targets (tray space) at time t: [left, right].
  _pawTargets(t) {
    const s = this.state, p = s.plan, T = s.times;
    if (!p) return null;
    const X = s.X, F = s.F;
    const k = s.sizeScale;
    const hold = this._holdCenter(k);
    const a = p.hw * HOLD_SQUEEZE * k;
    const holdL = hold.clone().addScaledVector(X, a);
    const holdR = hold.clone().addScaledVector(X, -a);
    if (t <= T.lift) return [p.contactL.clone(), p.contactR.clone()];
    const u = (t - T.lift) / T_LIFT;
    let out;
    if (u < 1) {
      const hz = easeInOut(u), vy = easeOut(Math.min(1, u * 1.3));
      const bump = 0.0025 * Math.sin(Math.PI * clamp01(u * 1.1));
      out = [[p.contactL, holdL], [p.contactR, holdR]].map(([from, to]) => {
        const q = from.clone().lerp(to, hz);
        q.y = lerp(from.y, to.y, vy) + bump;
        return q;
      });
    } else {
      // Biting: tug toward the mouth at contact, pull away while tearing.
      let tug = 0, lift = 0;
      if (t < T.finish) {
        const bt = (t - T.bites) % T_BITE;
        tug = -0.003 * pulse(bt, 0.12, BITE_CONTACT + 0.03) + 0.0025 * pulse(bt, BITE_CONTACT, BITE_CHEW + 0.08);
        lift = 0.002 * pulse(bt, BITE_CONTACT, BITE_CHEW + 0.12);
      }
      out = [holdL, holdR].map((q) => q.addScaledVector(F, tug).setY(q.y + lift));
    }
    // Hard guarantee for the app: within HOLD_MAX_R horizontally, y in [0.05, 0.12].
    for (const q of out) {
      const r = Math.hypot(q.x, q.z);
      if (r > HOLD_MAX_R + 1e-6 && t >= T.lift + T_LIFT) { q.x *= HOLD_MAX_R / r; q.z *= HOLD_MAX_R / r; }
      if (t >= T.lift + T_LIFT) q.y = Math.min(0.12, Math.max(0.05, q.y));
    }
    return out;
  }

  // Mouth target for bite i (tray): the near top edge of the jelly, a little inside.
  _biteTarget(i) {
    const s = this.state, p = s.plan;
    const m = s.jellyNow && s.jellyNow.bounds ? this._measureJelly() : null;
    const k = Math.pow(BITE_SHRINK, i);
    const c = m ? m.center : this._holdCenter(k);
    const hd = m ? m.hd : p.hd * k, hh = m ? m.hh : p.hh * k;
    return c.clone().addScaledVector(s.F, -hd * 0.86 + 0.0035).setY(c.y + hh * 0.42);
  }

  // -------------------------------------------------------------------------
  update(dt, jelly = null) {
    const s = this.state;
    if (!s) return { paws: null, mouth: this._mouthTray(), phase: "idle" };
    dt = Math.min(Math.max(dt || 0, 0), 0.1);
    if (jelly && (jelly.center || jelly.bounds)) s.jellyNow = jelly;
    s.t += dt;
    const t = s.t, T = s.times;

    if (!s.plan && t >= T.reach) this._makePlan();

    // Size of the (shrinking) jelly while held: planned 13 % per bite, checked
    // against the measured depth along the facing (not constrained by paws).
    const planned = Math.pow(BITE_SHRINK, s.bitesDone);
    let target = planned;
    if (s.plan && t >= T.bites && s.jellyNow && s.jellyNow.bounds) {
      const m = this._measureJelly();
      if (!s.refDepth) s.refDepth = m.hd / Math.max(0.3, planned);
      const measured = m.hd / s.refDepth;
      target = Math.min(Math.max(measured, planned * 0.85), Math.min(1.02, planned * 1.15));
    }
    s.sizeScale += (target - s.sizeScale) * (1 - Math.exp(-dt / 0.09));

    const pose = this._samplePose(t);
    let finalPose = pose;
    if (s.blendFrom && s.blendT < 1) {
      s.blendT = Math.min(1, s.blendT + dt / 0.3);
      finalPose = lerpPose(s.blendFrom, pose, easeInOut(s.blendT));
    }
    s.lastPose = finalPose;
    this._applyPose(finalPose, dt);

    // Events crossing this frame.
    for (const e of s.events) {
      if (e.t <= t && !s.emitted.has(e.id)) {
        s.emitted.add(e.id);
        const data = e.make(false);
        if (e.type === "bite") s.bitesDone = Math.max(s.bitesDone, data.index + 1);
        this._emit(e.type, data);
        if (!this.state) break;
      }
    }
    if (this.state && t >= T.done) this._finish(true);

    const holding = this.state && s.plan && t >= T.grab && t < T.finish && !s.skipped;
    const paws = holding ? this._pawTargets(t).map(toArr) : null;
    return { paws, mouth: this._mouthTray(), phase: this.state ? phaseOf(s) : "idle" };
  }

  _finish() {
    this.state = null;
    this.root.visible = false;
    this.hearts.visible = false;
  }

  // -------------------------------------------------------------------------
  // Pose sampling: pure function of time (plus the plan).
  _samplePose(t) {
    const s = this.state, T = s.times;
    const pose = defaultPose();
    pose.pos.copy(s.seat);
    pose.yaw = s.yaw;

    // Idle: breathing, nose twitch, blink, tail.
    pose.breath = Math.sin(t * 2 * Math.PI * 1.1);
    pose.look.copy(s.faceTo);

    if (t < T.reach) {
      // ---- arrive: two hops in ----
      const legs = [[s.start, s.mid], [s.mid, s.seat]];
      const hopIndex = t < 0.5 ? 0 : 1;
      const u = t - hopIndex * 0.5;
      const [a, b] = legs[hopIndex];
      const h = hopShape(u, hopIndex === 0 ? 0.022 : 0.018);
      pose.pos.copy(a).lerp(b, easeInOut(h.k));
      if (t >= 1.0) pose.pos.copy(s.seat);
      pose.hopY = h.y; pose.squash = h.s;
      const travel = Math.atan2(b.x - a.x, b.z - a.z);
      pose.yaw = hopIndex === 0 ? travel : angleLerp(travel, s.yaw, easeInOut((u - 0.05) / 0.4));
      if (t >= 1.0) pose.yaw = s.yaw;
      pose.appear = lerp(0.35, 1, easeOutBack(t / 0.32));
      pose.earPerk = h.k > 0 && h.k < 1 ? -0.15 : 0.1;
      pose.pawTuck = h.y > 0 ? 1 : 0;
      pose.headPitch = -0.08 * Math.sin(Math.PI * clamp01(h.k));
      pose.look.copy(s.faceTo);
      if (t > 1.0) { pose.earPerk = 0.25 * sstep(1.0, 1.15, t); pose.headRoll = 0.12 * pulse(t, 1.0, 1.2); }
    } else if (t < T.finish) {
      const p = s.plan;
      const paws = this._pawTargets(Math.max(t, T.grab));
      pose.look.copy(p.hold);
      if (t < T.grab) {
        // ---- reach over the rim ----
        const u = (t - T.reach) / T_REACH;
        const reach = easeInOut(sstep(0.05, 1, u));
        pose.pawMode = reach;
        pose.pawL.copy(paws[0]); pose.pawR.copy(paws[1]);
        pose.look.copy(p.contactL).lerp(p.contactR, 0.5);
        pose.earPerk = 0.45; pose.earSplay = -0.1;
        pose.eyesWide = 0.4;
        pose.mouthOpen = 0.12 * sstep(0.6, 1, u);
      } else if (t < T.bites) {
        // ---- lift toward the mouth ----
        const u = (t - T.lift) / T_LIFT;
        pose.pawMode = 1;
        pose.pawL.copy(paws[0]); pose.pawR.copy(paws[1]);
        const e = easeInOut(u);
        pose.headUp = 0.009 * e; pose.rise = 0.004 * e;
        pose.stretch = 1 + 0.1 * e;
        pose.leanExtra = 0.02 * e;
        pose.headPitch = 0.12 * e;
        pose.mouthOpen = 0.12 + 0.35 * sstep(0.6, 1, u);
        pose.earPerk = 0.45 + 0.2 * pulse(u, 0, 1);
        pose.squash = 1 - 0.06 * pulse(u, 0, 0.4);
        pose.eyesWide = 0.5;
      } else {
        // ---- bites ----
        const i = Math.min(s.bites - 1, Math.floor((t - T.bites) / T_BITE));
        const u = t - T.bites - i * T_BITE;
        pose.pawMode = 1;
        pose.pawL.copy(paws[0]); pose.pawR.copy(paws[1]);
        pose.headUp = 0.009; pose.rise = 0.004; pose.stretch = 1.1; pose.leanExtra = 0.02;
        pose.headPitch = 0.12;
        pose.biteTarget.copy(this._biteTarget(i));
        if (u < 0.16) {
          const w = easeOut(u / 0.16);
          pose.mouthOpen = lerp(i === 0 ? 0.47 : 0.15, 1, w);
          pose.lunge = -0.25 * w;
          pose.headPitch = 0.12 - 0.08 * w;
          pose.eyesWide = 0.7 * w;
          pose.earPerk = 0.55;
        } else if (u < BITE_CONTACT) {
          const w = easeIn((u - 0.16) / (BITE_CONTACT - 0.16));
          pose.lunge = lerp(-0.25, 1, w);
          pose.headPitch = lerp(0.04, 0.2, w);
          pose.mouthOpen = 1 - 0.55 * sstep(0.7, 1, w);
          pose.eyesWide = 0.7;
          pose.earPerk = 0.55;
          pose.squash = 1 - 0.03 * w;
        } else if (u < BITE_CHEW) {
          const w = (u - BITE_CONTACT) / (BITE_CHEW - BITE_CONTACT);
          pose.lunge = 1 - easeOut(w);
          pose.headPitch = 0.2 - 0.14 * easeOut(w);
          pose.mouthOpen = 0.45 * (1 - sstep(0, 0.35, w));
          pose.cheekPuff = 0.35 * sstep(0.2, 1, w);
          pose.squint = 0.5 * sstep(0.1, 0.6, w);
          pose.earPerk = 0.4;
          pose.earWobble = 1;
          pose.squash = 1 + 0.04 * pulse(w, 0, 1);
        } else {
          const w = (u - BITE_CHEW) / (T_BITE - BITE_CHEW);
          const chew = Math.sin((u - BITE_CHEW) * 2 * Math.PI * 7);
          pose.chew = chew;
          pose.mouthOpen = 0.16 * Math.max(0, chew);
          pose.cheekPuff = 0.35 + 0.12 * chew;
          pose.squint = 0.55 * (1 - sstep(0.75, 1, w));
          pose.headPitch = 0.06 + 0.03 * chew;
          pose.headRoll = 0.06 * Math.sin(u * 2 * Math.PI * 3.5);
          pose.earPerk = 0.35;
          pose.earWobble = 0.7 * Math.sin(u * 2 * Math.PI * 7);
          pose.blush = 0.25;
        }
      }
    } else if (t < T.react) {
      // ---- finish: paws come together, satisfied ----
      const u = (t - T.finish) / T_FINISH;
      pose.pawMode = 0;
      pose.pawTogether = easeOut(u / 0.4);
      pose.headUp = 0.009 * (1 - easeInOut(u)); pose.rise = 0.004 * (1 - easeInOut(u));
      pose.stretch = 1.1 - 0.1 * easeInOut(u);
      pose.cheekPuff = 0.3 * (1 - easeInOut(u));
      pose.chew = Math.sin(u * T_FINISH * 2 * Math.PI * 6) * (1 - u);
      pose.mouthOpen = 0.1 * Math.max(0, pose.chew);
      pose.squint = 0.5;
      pose.squash = 1 - 0.05 * pulse(u, 0.25, 0.6);
      pose.earPerk = 0.3;
      pose.blush = 0.3;
    } else if (t < T.leave) {
      this._reactPose(pose, t - T.react);
    } else {
      // ---- leave: turn and hop away, shrinking out ----
      const u = t - T.leave;
      const legs = [[s.seat, s.exitA], [s.exitA, s.exitB]];
      const away = Math.atan2(s.exitA.x - s.seat.x, s.exitA.z - s.seat.z);
      const hi = u < 0.55 ? 0 : 1;
      const hu = u - 0.05 - hi * 0.5;
      const [a, b] = legs[hi];
      const sad = s.mood === "sad" ? 0.6 : 1;
      const h = hopShape(hu, (hi === 0 ? 0.02 : 0.024) * sad);
      pose.pos.copy(a).lerp(b, easeInOut(h.k));
      pose.hopY = h.y; pose.squash = h.s;
      pose.yaw = angleLerp(s.yaw, away, easeInOut(u / 0.2));
      pose.appear = 1 - easeIn((u - 0.55) / (T_LEAVE - 0.55));
      pose.pawTuck = h.y > 0 ? 1 : 0;
      pose.earPerk = s.mood === "sad" ? -0.4 : 0.1;
      pose.earDroop = s.mood === "sad" ? 0.6 : 0;
      pose.look.copy(s.exitB).setY(0.03);
    }

    // Idle overlays.
    const b = s.blink;
    if (t >= b.next) {
      const bt = t - b.next;
      pose.blink = Math.max(pose.blink, pulse(bt, 0, 0.14));
      if (bt > 0.14) b.next = t + 2 + Math.random() * 2.2;
    }
    const tw = s.twitch;
    if (t >= tw.next) {
      const nt = t - tw.next;
      pose.noseTwitch = Math.sin(nt * 2 * Math.PI * 9) * pulse(nt, 0, 0.45);
      if (nt > 0.45) tw.next = t + 1.2 + Math.random() * 1.6;
    }
    return pose;
  }

  _reactPose(pose, u) {
    const s = this.state;
    pose.look.copy(s.faceTo);
    pose.pawMode = 0;
    if (s.mood === "happy") {
      const h = hopShape(u - 0.04, 0.024);
      pose.hopY = h.y;
      pose.squash = h.s;
      if (u > 0.62) { const h2 = hopShape(u - 0.62, 0.009); pose.hopY = h2.y; pose.squash = h2.s; }
      pose.happyEyes = sstep(0.05, 0.15, u) * (1 - sstep(1.0, 1.15, u));
      pose.earPerk = 0.7; pose.earSplay = 0.25 * sstep(0.1, 0.3, u);
      pose.blush = 1;
      pose.pawCheer = sstep(0.0, 0.2, u) * (1 - sstep(1.0, 1.25, u));
      pose.headRoll = 0.14 * Math.sin(u * 2 * Math.PI * 1.6) * sstep(0.4, 0.6, u);
      pose.mouthOpen = 0.35 * pulse(u, 0.1, 0.7);
      pose.tailWag = 1;
      pose.hearts = u;
    } else if (s.mood === "ok") {
      const nod = 0.24 * (pulse(u, 0.12, 0.42) + pulse(u, 0.52, 0.82));
      pose.headPitch = nod;
      pose.squint = 0.55 * sstep(0.05, 0.2, u) * (1 - sstep(1.05, 1.25, u));
      pose.earPerk = 0.2 + 0.15 * Math.sin(u * 2 * Math.PI * 2);
      pose.pawTogether = 1;
      pose.pawPat = Math.max(0, Math.sin(u * 2 * Math.PI * 2.2)) * sstep(0, 0.2, u);
      pose.squash = 1 - 0.03 * nod;
      pose.headRoll = 0.06 * Math.sin(u * 2 * Math.PI * 0.8);
      pose.blush = 0.4;
    } else {
      const droop = easeInOut(u / 0.4);
      const inhale = pulse(u, 0.3, 0.75), exhale = sstep(0.75, 1.2, u);
      pose.earDroop = droop;
      pose.earPerk = -0.4 * droop;
      pose.headPitch = 0.16 * droop - 0.1 * inhale + 0.06 * exhale;
      pose.headRoll = 0.14 * droop;
      pose.stretch = 1 - 0.05 * droop + 0.04 * inhale - 0.03 * exhale;
      pose.leanExtra = 0.12 * droop - 0.05 * inhale;
      pose.squint = 0.6 * droop;
      pose.lookDown = droop;
      pose.mouthOpen = 0.25 * pulse(u, 0.75, 1.15);
      pose.pawTogether = 1;
      pose.pawLow = 1;
    }
  }

  // -------------------------------------------------------------------------
  _applyPose(pose, dt) {
    const s = this.state;
    const R = this.rig.bones;
    const t = s.t;

    // Root (tray space).
    this.root.position.copy(pose.pos);
    this.root.rotation.set(0, pose.yaw, 0);
    this.root.scale.setScalar(Math.max(1e-4, pose.appear));
    this.root.updateMatrix();
    this.root.updateMatrixWorld(true);
    this._rootInv.copy(this.root.matrix).invert();

    // Reset rig to rest.
    for (const b of Object.values(R)) {
      b.position.copy(b.userData.restPos);
      b.quaternion.copy(b.userData.restQuat);
      b.scale.set(1, 1, 1);
    }

    // Paw targets in rig space.
    const pawL = v3(), pawR = v3();
    const restL = v3(0.0118, 0.025, 0.03), restR = v3(-0.0118, 0.025, 0.03);
    const together = pose.pawTogether, cheer = pose.pawCheer;
    const idleL = restL.clone(), idleR = restR.clone();
    if (pose.pawTuck) { idleL.add(v3(-0.002, 0.004, 0.002)); idleR.add(v3(0.002, 0.004, 0.002)); }
    if (together > 0) {
      const low = pose.pawLow ? -0.007 : 0;
      const pat = pose.pawPat * 0.003;
      idleL.lerp(v3(0.0058, 0.031 + low + pat, 0.027), together);
      idleR.lerp(v3(-0.0058, 0.031 + low + pat, 0.027), together);
    }
    if (cheer > 0) {
      idleL.lerp(v3(0.0105, 0.037, 0.03), cheer);
      idleR.lerp(v3(-0.0105, 0.037, 0.03), cheer);
    }
    if (pose.pawMode > 0) {
      pawL.copy(pose.pawL).applyMatrix4(this._rootInv);
      pawR.copy(pose.pawR).applyMatrix4(this._rootInv);
      pawL.lerp(idleL, 1 - pose.pawMode); pawR.lerp(idleR, 1 - pose.pawMode);
    } else { pawL.copy(idleL); pawR.copy(idleR); }

    // Body reach effort from how far forward the paws go.
    const reachZ = Math.max(pawL.z, pawR.z), reachLow = Math.max(0, 0.034 - Math.min(pawL.y, pawR.y));
    const far = clamp01((reachZ - 0.064) / 0.036);
    const effort = clamp01(far + reachLow * 12 * clamp01((reachZ - 0.064) / 0.02));
    const lean = 0.8 * effort + pose.leanExtra;
    const slide = 0.02 * effort, rise = 0.014 * effort + pose.rise;
    const stretch = pose.stretch * (1 + 0.08 * effort);

    // Base: hop + squash/stretch (volume preserving), feet stay planted.
    const sq = pose.squash;
    R.base.position.y = pose.hopY;
    R.base.scale.set(1 / Math.sqrt(sq), sq, 1 / Math.sqrt(sq));
    if (pose.hopY > 0) { R.footL.position.y += 0.002; R.footR.position.y += 0.002; }
    R.hips.position.z += slide;
    R.hips.position.y += rise;
    R.hips.rotation.x = lean;
    const breath = 1 + 0.011 * pose.breath;
    R.body.scale.set(breath, stretch * (1 + 0.006 * pose.breath), breath);
    R.chest.position.y += (stretch - 1) * 0.034 + 0.0003 * pose.breath;
    R.tail.position.y += (stretch - 1) * 0.008;

    // Head: look direction + expression offsets.
    this.rig.skel.updateMatrixWorld(true);
    const lookRig = pose.look.clone().applyMatrix4(this._rootInv);
    const neckWorld = v3().setFromMatrixPosition(R.neck.matrixWorld);
    const toLook = lookRig.sub(neckWorld);
    const yawLook = Math.max(-0.5, Math.min(0.5, Math.atan2(toLook.x, Math.max(0.01, toLook.z))));
    const pitchLook = Math.max(-0.35, Math.min(0.45, -Math.atan2(toLook.y - 0.01, Math.hypot(toLook.x, toLook.z))));
    const headPitch = 0.4 * pitchLook + pose.headPitch - lean * 0.55 + 0.12 * pose.lookDown;
    R.neck.rotation.set(headPitch, yawLook * 0.6, pose.headRoll, "YXZ");
    R.neck.position.y += pose.headUp;
    R.neck.position.z += 0.002 * pose.headUp / 0.007;

    // Bite lunge: move the head so the mouth reaches the bite target
    // (negative lunge = wind-up: pull back & up).
    if (pose.lunge !== 0) {
      this.rig.skel.updateMatrixWorld(true);
      R.neck.position.add(this._chestDelta(pose, pose.lunge));
    }

    // Face.
    // Eyes: squint/half-close by squashing the bead; a full blink or the happy
    // face swaps the bead for an arc ("∪" closed, "∩" happy ^ ^).
    const happy = pose.happyEyes;
    const closed = sstep(0.55, 0.7, pose.blink);
    const arc = Math.max(happy, closed);
    const open = Math.max(0.25, 1 - Math.max(pose.blink * 0.8, pose.squint * 0.5)) * (1 + 0.1 * pose.eyesWide);
    for (const e of [R.eyeL, R.eyeR]) e.scale.set(1 + 0.05 * pose.eyesWide, Math.max(0.02, open * (1 - arc)), Math.max(0.02, 1 - arc));
    R.eyeL.position.y -= 0.0006 * pose.lookDown; R.eyeR.position.y -= 0.0006 * pose.lookDown;
    for (const h of [R.happyL, R.happyR]) {
      h.scale.setScalar(Math.max(1e-3, arc));
      if (closed > happy) h.quaternion.multiply(this._q.setFromAxisAngle(v3(0, 0, 1), Math.PI));
    }
    const mouthOpen = clamp01(pose.mouthOpen);
    const shown = sstep(0, 0.1, mouthOpen); // fully hidden when closed
    R.mouth.scale.set(Math.max(0.02, (0.7 + 0.3 * mouthOpen) * shown), Math.max(0.02, mouthOpen), Math.max(0.02, shown));
    R.jaw.rotation.x = 0.35 * mouthOpen;
    R.jaw.position.x += 0.0004 * pose.chew;
    R.muzzle.position.y += 0.0003 * pose.chew;
    R.muzzle.position.x += 0.0003 * pose.chew;
    const puff = 1 + pose.cheekPuff * 0.42;
    R.cheekL.scale.set(puff, 1 + pose.cheekPuff * 0.22, puff);
    R.cheekR.scale.copy(R.cheekL.scale);
    R.cheekL.position.x += 0.0012 * pose.cheekPuff; R.cheekR.position.x -= 0.0012 * pose.cheekPuff;
    R.nose.position.y += 0.00035 * pose.noseTwitch;
    R.nose.scale.set(1 + 0.08 * pose.noseTwitch, 1 - 0.1 * Math.abs(pose.noseTwitch), 1);
    R.tail.rotation.y = pose.tailWag * 0.35 * Math.sin(t * 2 * Math.PI * 4);
    this.fur.u.blush.value = 0.3 + 0.45 * pose.blush;

    // Ears: springs around an expressive target, driven by head acceleration.
    this.rig.skel.updateMatrixWorld(true);
    this._earDynamics(pose, dt);

    // Arms (IK with plush stretch) after the body/head are posed.
    this.rig.skel.updateMatrixWorld(true);
    this._solveArm(R.shoulderL, R.pawL, pawL);
    this._solveArm(R.shoulderR, R.pawR, pawR);
    this.rig.skel.updateMatrixWorld(true);

    this._uploadBones();
    this._updateShadow(pose);
    this._updateHearts(pose);
    this._updateSun();
  }

  // Chest-space head offset that brings the mouth to the bite target.
  _chestDelta(pose, amount) {
    const R = this.rig.bones;
    const mouth = this._mouthRig();
    const delta = amount < 0
      ? v3(0, 0.004, -0.008).multiplyScalar(-amount)
      : pose.biteTarget.clone().applyMatrix4(this._rootInv).sub(mouth).multiplyScalar(amount);
    if (delta.length() > 0.022) delta.setLength(0.022);
    // Into chest space (rotation + scale of the chest).
    const m = this._m.copy(R.chest.matrixWorld).setPosition(0, 0, 0).invert();
    return delta.applyMatrix4(m);
  }

  _solveArm(shoulder, paw, target) {
    const parent = shoulder.parent;
    const local = target.clone().applyMatrix4(this._m.copy(parent.matrixWorld).invert());
    const dir = local.sub(shoulder.position);
    const dist = dir.length();
    if (dist < 1e-6) return;
    dir.divideScalar(dist);
    const restDir = v3(0, -1, 0).applyQuaternion(shoulder.userData.restQuat);
    this._q.setFromUnitVectors(restDir, dir);
    shoulder.quaternion.copy(this._q).multiply(shoulder.userData.restQuat);
    const L = Math.min(Math.max(dist, ARM_LEN * 0.5), ARM_LEN * 2.6);
    paw.position.set(0, -L, 0);
    // Plush stretch: a stretched arm gets thinner (volume), a compressed paw squishes.
    const thin = Math.pow(Math.max(1, L / ARM_LEN), -0.3);
    shoulder.scale.set(thin, 1, thin);
    const c = clamp01((ARM_LEN - L) / ARM_LEN);
    paw.scale.set((1 + 0.15 * c) / thin, 1 - 0.15 * c, (1 + 0.15 * c) / thin);
  }

  _earDynamics(pose, dt) {
    const s = this.state, R = this.rig.bones;
    // Head acceleration in tray space → head-local-ish (rig yaw only).
    const head = v3().setFromMatrixPosition(R.head.matrixWorld).applyMatrix4(this.root.matrix);
    if (s.prevHead && dt > 0) {
      const vel = head.clone().sub(s.prevHead).divideScalar(dt);
      const acc = vel.clone().sub(s.prevVel).divideScalar(dt);
      if (acc.length() > 40) acc.setLength(40);
      s.accel.lerp(acc, 1 - Math.exp(-dt / 0.02));
      s.prevVel.copy(vel);
    }
    s.prevHead = head;
    const local = s.accel.clone().applyAxisAngle(v3(0, 1, 0), -pose.yaw);
    const G = 20; // rad/s² per m/s² of head acceleration
    const forcePitch = (local.z * 0.8 + local.y * 0.55) * G;
    const perk = pose.earPerk, droop = pose.earDroop;
    const wob = pose.earWobble * 60;
    for (let i = 0; i < 2; i += 1) {
      const side = i === 0 ? 1 : -1;
      const idle = 0.035 * Math.sin(s.t * 1.7 + i * 1.3);
      const target = [
        -0.14 * perk + 0.55 * droop + idle,
        -0.12 * pose.earSplay + 0.85 * droop + 0.02 * Math.sin(s.t * 1.1 + i),
        -0.1 * perk + 0.7 * droop,
        0.45 * droop,
      ];
      const forceOut = (-local.x * side + 0.3 * local.y) * G;
      this.ears[i].step(dt, target, [forcePitch, forceOut], wob * side);
      const a = this.ears[i].a;
      const e1 = i === 0 ? R.ear1L : R.ear1R, e2 = i === 0 ? R.ear2L : R.ear2R;
      // Ear space: −x rotation tips the ear backwards, −side·z tips it outward.
      e1.quaternion.copy(e1.userData.restQuat).multiply(this._q.setFromEuler(this._e.set(-a[0], 0, -side * a[1])));
      e2.quaternion.copy(e2.userData.restQuat).multiply(this._q.setFromEuler(this._e.set(-a[2], 0, -side * a[3])));
    }
  }

  _uploadBones() {
    const bones = this.fur.bones;
    const m = this._m, n = this._n;
    for (const b of this.rig.skinBones) {
      m.multiplyMatrices(b.matrixWorld, b.userData.bindInverse);
      n.getNormalMatrix(m);
      const e = m.elements, ne = n.elements, o = b.userData.index * BONE_STRIDE;
      bones[o].set(e[0], e[1], e[2], 0);
      bones[o + 1].set(e[4], e[5], e[6], 0);
      bones[o + 2].set(e[8], e[9], e[10], 0);
      bones[o + 3].set(e[12], e[13], e[14], 1);
      bones[o + 4].set(ne[0], ne[1], ne[2], 0);
      bones[o + 5].set(ne[3], ne[4], ne[5], 0);
      bones[o + 6].set(ne[6], ne[7], ne[8], 0);
    }
  }

  _updateShadow(pose) {
    const air = clamp01(pose.hopY / 0.025);
    this.shadow.position.set(0, 0.0004, 0.004);
    this.shadow.scale.set(0.078 * (1 - 0.3 * air), 1, 0.074 * (1 - 0.3 * air));
    this.shadowOpacity.value = 0.5 * (1 - 0.55 * air);
  }

  _updateHearts(pose) {
    const u = pose.hearts;
    if (!(u >= 0) || !this.state || this.state.mood !== "happy") { this.hearts.visible = false; return; }
    this.hearts.visible = true;
    const m = this._m, q = this._q, pos = v3(), scl = v3();
    const R = this.rig.bones;
    const top = v3().setFromMatrixPosition(R.head.matrixWorld);
    for (let i = 0; i < 3; i += 1) {
      const t0 = 0.12 + i * 0.14;
      const k = (u - t0) / 0.95;
      const side = [0, 1, -1][i];
      if (k <= 0 || k >= 1) { m.makeScale(0, 0, 0); this.hearts.setMatrixAt(i, m); continue; }
      pos.set(top.x + side * 0.016 + 0.004 * Math.sin(k * 9 + i), top.y + 0.026 + 0.045 * easeOut(k) + (i === 0 ? 0.006 : 0), top.z + 0.008);
      const sc = 0.0105 * easeOutBack(Math.min(1, k * 4)) * (1 - sstep(0.7, 1, k)) * (i === 0 ? 1.15 : 0.9);
      q.setFromEuler(new THREE.Euler(0, Math.sin(k * 5 + i) * 0.6, side * -0.25));
      scl.setScalar(Math.max(1e-4, sc));
      m.compose(pos, q, scl);
      this.hearts.setMatrixAt(i, m);
    }
    this.hearts.instanceMatrix.needsUpdate = true;
  }

  _updateSun() {
    if (this._sun === undefined) {
      let sun = null, root = this.parent;
      while (root.parent) root = root.parent;
      root.traverse((o) => { if (!sun && o.isDirectionalLight) sun = o; });
      this._sun = sun;
    }
    const u = this.fur.u;
    if (this._sun) {
      const sun = this._sun;
      sun.getWorldPosition(this._sunA);
      sun.target.getWorldPosition(this._sunB);
      const d = this._sunA.sub(this._sunB);
      if (d.lengthSq() > 1e-10) u.sunDir.value.copy(d.normalize());
      u.sunColor.value.copy(sun.color).multiplyScalar(sun.intensity / Math.PI);
    } else {
      u.sunDir.value.set(0.6123724357, 0.5, -0.6123724357).normalize().applyQuaternion(this.parent.getWorldQuaternion(this._q));
    }
  }

  _mouthRig() {
    const R = this.rig.bones;
    const m = this._m2 || (this._m2 = new THREE.Matrix4());
    m.multiplyMatrices(R.head.matrixWorld, R.head.userData.bindInverse);
    return MOUTH_POINT.clone().applyMatrix4(m);
  }

  _mouthTray() {
    return toArr(this._mouthRig().applyMatrix4(this.root.matrix));
  }
}

function phaseOf(s) {
  const t = s.t, T = s.times;
  if (t < T.reach) return "arrive";
  if (t < T.grab) return "grab";
  if (t < T.bites) return "lift";
  if (t < T.finish) return "bite";
  if (t < T.react) return "finish";
  if (t < T.leave) return "react";
  return "leave";
}

function defaultPose() {
  return {
    pos: v3(), yaw: 0, appear: 1, hopY: 0, squash: 1,
    stretch: 1, leanExtra: 0, rise: 0, breath: 0,
    look: v3(), headPitch: 0, headRoll: 0, headUp: 0, lookDown: 0,
    lunge: 0, biteTarget: v3(),
    pawMode: 0, pawL: v3(), pawR: v3(), pawTuck: 0, pawTogether: 0, pawCheer: 0, pawPat: 0, pawLow: 0,
    earPerk: 0, earSplay: 0, earDroop: 0, earWobble: 0,
    blink: 0, squint: 0, eyesWide: 0, happyEyes: 0,
    mouthOpen: 0, chew: 0, cheekPuff: 0, blush: 0, noseTwitch: 0, tailWag: 0,
    hearts: -1,
  };
}

function clonePose(p) {
  const o = {};
  for (const [k, v] of Object.entries(p)) o[k] = v && v.isVector3 ? v.clone() : v;
  return o;
}

function lerpPose(a, b, t) {
  const o = {};
  for (const [k, v] of Object.entries(b)) {
    const from = a[k];
    if (v && v.isVector3) o[k] = from.clone().lerp(v, t);
    else if (k === "yaw") o[k] = angleLerp(from, v, t);
    else if (k === "hearts") o[k] = v;
    else o[k] = lerp(from, v, t);
  }
  return o;
}
