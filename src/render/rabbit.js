// 말랑젤리 plush bunny: hops in, grabs the jelly with both paws, eats it in a
// few bites, reacts with a mood and hops away (~8 s). Other visits: one bite
// and 퉤 ("spit"), or no bite at all — it sniffs the jelly on the tray, shakes
// its head 절레절레, turns round and kicks it with a hind foot ("kick").
// Dress-up: setOutfit() puts procedural items on the rig (ribbon / crown /
// flower band, round glasses, knitted scarf, fairy wings / star cape); a
// picky visit wears a monocle on a gold chain.
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
// happy reaction) + outfit ≤ 2 (solid pieces 1, glass pieces 1: lenses, wings).
// Shells per quality: high 14, medium 7, low 0 (velvet only); outfit pieces
// have no shells and cost the same at every quality.
//
// Frames: the bunny lives in the tray group (y up, floor y = 0). "Rig space"
// is the bunny's own frame: origin on the floor under it, +z = facing,
// +y = up, +x = the bunny's LEFT.
//
// API: see the class doc below.
import * as THREE from "three/webgpu";
import { float, length, smoothstep, uniform, uv, vec3 } from "three/tsl";
import { BONE_STRIDE, createBlobMaterial, createCandyMaterial, createFurMaterial, createOutfitMaterials } from "./rabbit-fur.js";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const SHELLS = Object.freeze({ high: 14, medium: 7, low: 0 });
const HOLD_MAX_R = 0.057;      // carried jelly centre stays within this of the tray centre (spec: 0.06)
const HOLD_Y = 0.052;          // carry height of the jelly's centre of mass (spec: 0.05–0.12)
const BITE_SHRINK = 0.87;      // the app shrinks the jelly ~13 % (linear) per bite

const T_ARRIVE = 1.2, T_REACH = 0.55, T_LIFT = 0.6, T_BITE = 0.72, T_FINISH = 0.45, T_REACT = 1.25, T_LEAVE = 1.05;
const BITE_CONTACT = 0.26, BITE_CHEW = 0.4;
// "kick": approach (two hops) · sniff · head shake · hop-turn · kick · 흥 (grumpy).
const T_APPROACH = 1.0, T_SNIFF = 1.2, T_SHAKE = 0.9, T_TURN = 0.4, T_KICK = 0.6, T_HMPH = 1.0;
const KICK_CONTACT = 0.3;      // s into the kick segment when the foot hits the jelly
const KICK_REACH = 0.047;      // root → foot sole at full extension (m, rig space)
const KICK_SWING = 0.38;       // rad the kicking spot is swung sideways (three-quarter view; stays in a phone frame)
const KICK_SIDE = 0.8;         // rad: it turns its back-side to the jelly (profile kick) and
                               // the foot shoots back-and-out at this angle
const KICK_STRENGTH = 0.8;
const SHAKE_HZ = 2.1;          // 절레절레: ≈ 3.8 swings in T_SHAKE
// The tray rim (stage.js: TRAY_RADIUS 0.075 + tube 0.0028 at y = 0.7·tube): the
// kicking bunny perches on it while it stands across it.
const RIM_R = 0.0778, RIM_TOP = 0.0048;

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
  tongue: display("#ee8296"),
  heart: display("#ff7aa2"),
  pad: display("#f59aae"),
  sparkle: display("#fff1b8"),
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
  add("tongue", "head", v3(0, 0.0412, 0.0232));
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
  // Outfit bones (no fur geometry of their own): the collar carries the neck and
  // back pieces; the scarf tails and the cape hem swing on springs; wings flutter.
  add("collar", "chest", v3(0, 0.04, 0));
  add("scarfTail", "collar", SCARF_KNOT.clone());
  add("capeHem", "collar", v3(0, 0.0435, -0.017));
  for (const [s, side] of [[1, "L"], [-1, "R"]]) add(`wing${side}`, "collar", WING_ROOT(s));
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

  // Feet: oval, flat soles, toes forward. Pink paw pads on the soles (only
  // seen when a foot is lifted: kick, thump); the sole fur is short there.
  const feet = [];
  const soles = [];
  for (const s of [1, -1]) {
    const c = v3(s * 0.0135, 0.0042, 0.0165);
    const bone = B(s > 0 ? "footL" : "footR");
    feet.push(pb.add(sphereGeometry(22, 16, (x, y, z) => {
      let Y = c.y + y * 0.0045;
      if (Y < 0.0007) Y = 0.0007 - (0.0007 - Y) * 0.1;
      return v3(c.x + x * 0.0066, Y, c.z + z * 0.0102);
    }), (p, n) => ({ b0: bone, len: n.y < -0.97 && p.y < 0.00075 ? 0.0004 : 0.0018, density: 2900, comb: v3(0, 0, 0.6), color: mixColor(C.fur, C.furLight, sstep(0.016, 0.026, p.z)) })));
    occ.push({ parts: [feet[feet.length - 1]], c: [c.x, c.y + 0.001, c.z], r: 0.0058 });
    const from = pb.position.length / 3;
    for (const [x, z, rx, rz] of [[0, -0.0014, 0.0029, 0.0034], [-0.0021, 0.0043, 0.001, 0.0011], [0, 0.0049, 0.0011, 0.0012], [0.0021, 0.0043, 0.001, 0.0011]]) {
      pb.add(sphereGeometry(14, 8, (X, Y, Z) => v3(c.x + x + X * rx, 0.00048 + Y * 0.0003, c.z + z + Z * rz)), () => ({ b0: bone, len: 0, gloss: 0.18, color: C.pad }));
    }
    soles.push([from, pb.position.length / 3]);
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

  // Tongue for the "bleh" (collapsed inside the mouth until shown).
  pb.add(sphereGeometry(16, 10, (x, y, z) => {
    const tip = Math.max(0, z);
    return v3(x * 0.0024 * (1 - 0.2 * tip), 0.0398 + y * 0.0009 - 0.0012 * tip, 0.0246 + z * 0.0033);
  }), () => ({ b0: B("tongue"), len: 0, gloss: 0.4, color: C.tongue }));

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
  for (const [a, b] of soles) for (let i = a; i < b; i += 1) pb.fur[i * 4 + 3] = 0.9; // paw pads: no floor AO
  return pb.build();
}

function heartGeometry(curveSegments = 14, bevelSegments = 5) {
  const s = new THREE.Shape();
  s.moveTo(5, 5);
  s.bezierCurveTo(5, 5, 4, 0, 0, 0);
  s.bezierCurveTo(-6, 0, -6, 7, -6, 7);
  s.bezierCurveTo(-6, 11, -3, 15.4, 5, 19);
  s.bezierCurveTo(12, 15.4, 16, 11, 16, 7);
  s.bezierCurveTo(16, 7, 16, 0, 10, 0);
  s.bezierCurveTo(7, 0, 5, 5, 5, 5);
  const g = new THREE.ExtrudeGeometry(s, { depth: 3, bevelEnabled: true, bevelThickness: 3, bevelSize: 2.4, bevelSegments, curveSegments });
  g.deleteAttribute("uv");
  g.center();
  g.rotateZ(Math.PI);
  g.scale(1 / 26, 1 / 26, 1 / 26);
  g.computeVertexNormals();
  return g;
}

// Four-point twinkle star for the special celebration.
function sparkleGeometry() {
  const s = new THREE.Shape();
  const pts = 8;
  for (let i = 0; i <= pts; i += 1) {
    const a = (i / pts) * Math.PI * 2 + Math.PI / 2;
    const r = i % 2 === 0 ? 1 : 0.28;
    if (i === 0) s.moveTo(Math.cos(a) * r, Math.sin(a) * r); else s.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.12, bevelEnabled: true, bevelThickness: 0.14, bevelSize: 0.1, bevelSegments: 2 });
  g.deleteAttribute("uv");
  g.center();
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------
// Outfits: procedural dress-up pieces in bind pose (rig space), skinned to the
// rig's bones by the outfit materials (rabbit-fur.js). Every piece is built
// once (lazily, cached) as a chunk of attributes; the worn set is merged into
// one solid + one glass geometry (≤ 2 draws). Pieces are placed against an
// analytic model of the bunny's parts (insideBunny) so they sit on the fur
// without poking into it.
// ---------------------------------------------------------------------------

export const OUTFIT_SLOTS = Object.freeze({
  head: Object.freeze(["ribbon", "crown", "flowerband"]),
  face: Object.freeze(["glasses"]),
  neck: Object.freeze(["scarf"]),
  back: Object.freeze(["wings", "cape"]),
});

// Solid colours are calibrated like the fur palette (display()); near-whites
// keep some headroom (the inverse tone curve explodes at 1.0) and a colour the
// inverse cannot reach falls back to its plain value. Glass colours are blended
// before tone mapping, so they are plain linear values.
function paint(hex) {
  const c = display(hex), goal = new THREE.Color(hex);
  const y = aces([c.r, c.g, c.b]);
  return Math.max(Math.abs(y[0] - goal.r), Math.abs(y[1] - goal.g), Math.abs(y[2] - goal.b)) < 0.05 ? c : goal;
}
const OC = {
  ribbon: paint("#f87fae"), ribbonDeep: paint("#e8689a"),
  gold: paint("#e2ae45"), goldPale: paint("#f0d26a"),
  gemPink: paint("#f4467f"), gemBlue: paint("#4b9ff2"), gemMint: paint("#36c795"),
  petals: [paint("#f7a6c4"), paint("#f0e8e4"), paint("#c6b2f0"), paint("#f5bf98")],
  flowerHeart: paint("#eecb52"), leaf: paint("#78c06e"), band: paint("#9ccf89"),
  frame: paint("#5e3c35"), lens: new THREE.Color(0.72, 0.8, 0.88),
  scarf: paint("#e8566a"), scarfStripe: paint("#f3e6d4"),
  wingA: new THREE.Color(0.95, 0.66, 1.0), wingB: new THREE.Color(0.55, 0.86, 1.0),
  cape: paint("#5a63c4"), capeLining: paint("#f6a3bd"), star: paint("#f0d26a"),
  dot: paint("#f0e8e4"),
};
// mat = [gloss, metal, sheen, pattern] (the "surf" attribute)
const MAT = {
  satin: [0.38, 0, 0.75, 0], gold: [0.85, 1, 0, 0], gem: [1, 0, 0, 0], petal: [0.12, 0, 0.6, 0],
  leaf: [0.25, 0, 0.3, 0], frame: [0.75, 0, 0, 0], knit: [0, 0, 0.9, 3], cape: [0.06, 0, 0.7, 1],
  lining: [0.1, 0, 0.6, 0], band: [0.2, 0, 0.4, 0],
};
const UP = v3(0, 1, 0);

class OutfitBuilder {
  constructor() { this.position = []; this.normal = []; this.skin = []; this.color = []; this.surf = []; this.puv = []; this.index = []; }
  get count() { return this.position.length / 3; }
  // attr(p, n, i) → { b0, b1?, w?, color, mat: [4] (→ "surf"), uv?: [u, v] }
  add(geometry, attr) {
    const base = this.count;
    const p = geometry.attributes.position, n = geometry.attributes.normal;
    const P = v3(), N = v3();
    for (let i = 0; i < p.count; i += 1) {
      P.fromBufferAttribute(p, i); N.fromBufferAttribute(n, i);
      const a = attr(P, N, i);
      this.position.push(P.x, P.y, P.z);
      this.normal.push(N.x, N.y, N.z);
      this.skin.push(a.b0, a.b1 ?? a.b0, a.w ?? 0, 0);
      this.color.push(a.color.r, a.color.g, a.color.b);
      this.surf.push(...a.mat);
      this.puv.push(a.uv ? a.uv[0] : 0, a.uv ? a.uv[1] : 0);
    }
    const index = geometry.index;
    if (index) for (let i = 0; i < index.count; i += 1) this.index.push(base + index.getX(i));
    else for (let i = 0; i < p.count; i += 1) this.index.push(base + i);
    geometry.dispose();
  }
  chunk() {
    if (!this.count) return null;
    return {
      position: new Float32Array(this.position), normal: new Float32Array(this.normal), skin: new Float32Array(this.skin),
      color: new Float32Array(this.color), surf: new Float32Array(this.surf), puv: new Float32Array(this.puv), index: this.index.slice(),
    };
  }
}

const CHUNK_ATTRS = [["position", 3], ["normal", 3], ["skin", 4], ["color", 3], ["surf", 4], ["puv", 2]];
function mergeChunks(chunks) {
  const g = new THREE.BufferGeometry();
  const count = chunks.reduce((n, c) => n + c.position.length / 3, 0);
  for (const [name, size] of CHUNK_ATTRS) {
    const out = new Float32Array(count * size);
    let o = 0;
    for (const c of chunks) { out.set(c[name], o); o += c[name].length; }
    g.setAttribute(name, new THREE.BufferAttribute(out, size));
  }
  const total = chunks.reduce((n, c) => n + c.index.length, 0);
  const index = count > 65535 ? new Uint32Array(total) : new Uint16Array(total);
  let o = 0, base = 0;
  for (const c of chunks) { for (let i = 0; i < c.index.length; i += 1) index[o + i] = c.index[i] + base; o += c.index.length; base += c.position.length / 3; }
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.boundingSphere = new THREE.Sphere(v3(0, 0.05, 0), 0.14);
  return g;
}

// Orthonormal frame (x = left, y = up, z = forward) from an up vector and a forward hint.
function frame(up, fwd) {
  const y = up.clone().normalize();
  const z = fwd.clone().addScaledVector(y, -fwd.dot(y)).normalize();
  const x = y.clone().cross(z);
  return { x, y, z };
}
function place(g, origin, f) {
  g.applyMatrix4(new THREE.Matrix4().makeBasis(f.x, f.y, f.z).setPosition(origin));
  return g;
}
const ellipsoid = (rx, ry, rz, ws = 16, hs = 12) => sphereGeometry(ws, hs, (x, y, z) => v3(x * rx, y * ry, z * rz));

// Tube along a sampled path with an explicit cross-section frame:
// at(t) → { p, n, b, r1, r2, e = 1 }: section point p + n·r1·c + b·r2·s
// (superellipse exponent e: < 1 squarer). Seams duplicated (continuous pattern
// uvs), normals welded, winding made outward. userData.tv/av: path / section param.
function sweep(segments, radial, at, { closed = false, caps = true } = {}) {
  const pos = [], tv = [], av = [], index = [];
  const centers = [];
  const ring = radial + 1;
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const f = at(closed && i === segments ? 0 : t);
    const e = f.e ?? 1;
    centers.push(f.p);
    for (let j = 0; j <= radial; j += 1) {
      const a = (j / radial) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      const cc = Math.sign(c) * Math.pow(Math.abs(c), e), ss = Math.sign(s) * Math.pow(Math.abs(s), e);
      pos.push(f.p.x + f.n.x * f.r1 * cc + f.b.x * f.r2 * ss, f.p.y + f.n.y * f.r1 * cc + f.b.y * f.r2 * ss, f.p.z + f.n.z * f.r1 * cc + f.b.z * f.r2 * ss);
      tv.push(t); av.push(j / radial);
    }
  }
  for (let i = 0; i < segments; i += 1) {
    for (let j = 0; j < radial; j += 1) {
      const a = i * ring + j, b = a + ring;
      index.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  if (!closed && caps) {
    for (const [i, sgn] of [[0, -1], [segments, 1]]) {
      const c = centers[i];
      const ci = pos.length / 3;
      pos.push(c.x, c.y, c.z); tv.push(i / segments); av.push(0);
      for (let j = 0; j < radial; j += 1) {
        const a = i * ring + j;
        if (sgn > 0) index.push(ci, a, a + 1); else index.push(ci, a + 1, a);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  // Outward check on a side vertex; flip the winding if needed.
  const k = Math.floor(segments / 2) * ring + 1;
  const P = v3().fromBufferAttribute(g.attributes.position, k), N = v3().fromBufferAttribute(g.attributes.normal, k);
  if (N.dot(P.sub(centers[Math.floor(segments / 2)])) < 0) {
    const idx = g.index.array;
    for (let i = 0; i < idx.length; i += 3) { const tmp = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = tmp; }
    g.computeVertexNormals();
  }
  weldNormals(g);
  g.userData.tv = tv; g.userData.av = av;
  return g;
}

// Analytic bind-pose model of the bunny (body, head, cheeks, chin, pads, tail,
// arm roots), grown by margin m (fur clearance). Used to sit pieces on the fur.
const ARM_ROOTS = [1, -1].map((s) => {
  const d = v3(-s * 0.17, -0.62, 0.72).normalize(), sh = v3(s * 0.0172, 0.0405, 0.0125);
  return { a: sh.clone().addScaledVector(d, -0.004), b: sh.clone().addScaledVector(d, 0.011), r: 0.0052 };
});
const PARTS = [
  { c: HEAD_C, r: v3(HEAD_R.x * 1.03, HEAD_R.y, HEAD_R.z * 1.03), fur: 0.0018 },
  ...[1, -1].map((s) => ({ c: v3(s * 0.0112, 0.0425, 0.0105), r: v3(0.0096, 0.0082, 0.0088), fur: 0.0022 })),
  { c: v3(0, 0.0386, 0.0158), r: v3(0.0048, 0.0032, 0.0048), fur: 0.0012 },
  ...[1, -1].map((s) => ({ c: v3(s * 0.0036, 0.0425, 0.0186), r: v3(0.0049, 0.004, 0.0047), fur: 0.0009 })),
  { c: v3(0, 0.0118, -0.0262), r: v3(0.0058, 0.0056, 0.0052), fur: 0.0036 },
];
const _q1 = v3(), _q2 = v3();
// arms: include the arm roots; head: include the head parts (head, cheeks, chin, pads).
function insideBunny(p, m, arms = true, head = true) {
  const t = (p.y - BODY_C.y) / BODY_R.y;
  if (t > -1 && t < 1 + m / BODY_R.y) {
    const tt = Math.min(1, t);
    const narrow = tt > 0 ? 1 - 0.2 * tt * tt : 1 + 0.03 * (1 - (tt + 1) * (tt + 1));
    const k = Math.sqrt(Math.max(0, 1 - tt * tt));
    const ex = BODY_R.x * narrow * k + m + 0.0024, ez = BODY_R.z * narrow * k + m + 0.0024;
    const dz = p.z - BODY_C.z - (p.z > BODY_C.z ? 0.0018 * Math.max(0, 1 - Math.abs(tt + 0.25) * 1.4) : 0);
    if ((p.x / ex) ** 2 + (dz / ez) ** 2 <= 1) return true;
  }
  for (const q of PARTS) {
    if (!head && q !== PARTS[PARTS.length - 1]) continue;
    const g = m + q.fur;
    if (((p.x - q.c.x) / (q.r.x + g)) ** 2 + ((p.y - q.c.y) / (q.r.y + g)) ** 2 + ((p.z - q.c.z) / (q.r.z + g)) ** 2 <= 1) return true;
  }
  if (arms) {
    for (const a of ARM_ROOTS) {
      _q1.subVectors(a.b, a.a); _q2.subVectors(p, a.a);
      const h = clamp01(_q2.dot(_q1) / _q1.lengthSq());
      if (_q2.addScaledVector(_q1, -h).length() <= a.r + 0.0019 + m) return true;
    }
  }
  return false;
}
// Farthest distance along a ray (from o, direction d) that is still inside:
// coarse march inward from max (parts are thicker than the step), then bisect.
function surfaceAlong(o, d, m, arms = true, max = 0.045, head = true) {
  const p = v3(), step = 0.0008;
  let r = max;
  while (r > 0 && !insideBunny(p.copy(o).addScaledVector(d, r), m, arms, head)) r -= step;
  if (r <= 0) return 0;
  let lo = r, hi = r + step;
  for (let k = 0; k < 10; k += 1) { const mid = (lo + hi) / 2; if (insideBunny(p.copy(o).addScaledVector(d, mid), m, arms, head)) lo = mid; else hi = mid; }
  return hi;
}
const smoothLoop = (arr, passes = 3) => {
  let a = arr.slice();
  for (let k = 0; k < passes; k += 1) a = a.map((v, i) => (a[(i - 1 + a.length) % a.length] + 2 * v + a[(i + 1) % a.length]) / 4);
  return a;
};

// Head surface helpers for head-worn pieces.
function onHead(dir, lift) {
  const p = headSurface(dir), n = headNormal(p);
  return { p: p.addScaledVector(n, lift), n };
}

// Scarf ring: a rolled knit band around the neck, low in front (under the
// chin), high at the back, over the arm roots. Shared with the rig (tail bone).
// (The cheeks and chin rest on it: the head parts are left out of its fit.)
// It sinks into the fur (snug) and the arms hang in front of it.
const SCARF = { segs: 96, y: (th) => 0.0338 - 0.0005 * Math.cos(th), r1: 0.0022, r2: 0.0041, knotTh: 1.72 };
let scarfRingCache = null;
function scarfRing() {
  if (scarfRingCache) return scarfRingCache;
  const radii = [];
  for (let i = 0; i < SCARF.segs; i += 1) {
    const th = (i / SCARF.segs) * Math.PI * 2;
    const d = v3(Math.sin(th), 0, Math.cos(th));
    let r = 0;
    for (const dy of [-SCARF.r2 * 0.7, 0, SCARF.r2 * 0.7]) r = Math.max(r, surfaceAlong(v3(0, SCARF.y(th) + dy, -0.002), d, -0.0015, false, 0.045, false));
    radii.push(r + SCARF.r1 * 0.62);
  }
  const r = smoothLoop(radii, 4);
  const at = (th) => {
    const u = (((th / (Math.PI * 2)) % 1) + 1) % 1 * SCARF.segs;
    const i = Math.floor(u), f = u - i;
    const R = lerp(r[i % SCARF.segs], r[(i + 1) % SCARF.segs], f);
    const n = v3(Math.sin(th), 0, Math.cos(th));
    return { p: v3(0, SCARF.y(th), -0.002).addScaledVector(n, R), n, R };
  };
  scarfRingCache = { at, length: r.reduce((s, x) => s + x, 0) / SCARF.segs * Math.PI * 2 };
  return scarfRingCache;
}
function scarfKnot() {
  const k = scarfRing().at(SCARF.knotTh);
  return k.p.clone().addScaledVector(k.n, SCARF.r1 * 0.9);
}

// ---- items --------------------------------------------------------------------
// Each builder(ctx) → { solid: OutfitBuilder, glass: OutfitBuilder } filled in rig space.
const ITEMS = {
  ribbon({ B, solid }) {
    // Big pink bow between the ears: a knot and two puffy loops with a crease,
    // two short tails, all leaning back with the head's curve.
    const BOW = 1.3;
    const base = onHead(v3(0, 0.93, 0.37), 0.0016);
    const f = frame(base.n.clone().lerp(UP, 0.35), v3(0, 0, 1));
    const head = B("head");
    const sat = (c) => () => ({ b0: head, color: c, mat: MAT.satin });
    for (const s of [1, -1]) {
      const g = sphereGeometry(30, 20, (x, y, z) => {
        const a = (x * s + 1) / 2; // 0 at the knot → 1 at the loop's end
        const flare = Math.pow(Math.sin(Math.PI * Math.min(1, 0.16 + 0.92 * a)), 0.55);
        const H = 0.0017 + 0.0047 * flare, T = 0.0011 + 0.0016 * Math.sin(Math.PI * Math.min(1, a * 1.05));
        const crease = 1 - 0.32 * Math.exp(-Math.pow(y / 0.35, 2)) * Math.max(0, z) * sstep(0.2, 0.6, a);
        const X = s * (0.0012 + a * 0.0118);
        return v3(X, y * H + a * a * 0.0034, z * T * crease);
      });
      g.rotateZ(s * -0.06);
      g.scale(BOW, BOW, BOW);
      solid.add(place(g, base.p, f), sat(OC.ribbon));
      // tails: short ribbons hanging down the back of the bow, notched ends
      const tail = sweep(14, 10, (t) => {
        const p = v3(s * (0.0012 + 0.0048 * t), -0.0016 - 0.0062 * t, -0.0016 - 0.0006 * t);
        return { p, n: v3(0, 0, 1), b: v3(1, -0.15 * s, 0).normalize(), r1: 0.0006, r2: 0.0019 * (1 + 0.25 * t), e: 0.5 };
      });
      tail.rotateX(-0.15);
      tail.scale(BOW, BOW, BOW);
      solid.add(place(tail, base.p, f), sat(OC.ribbonDeep));
    }
    const knot = sphereGeometry(18, 14, (x, y, z) => v3(x * 0.0026, y * 0.0031 + 0.0003, z * 0.0021 + 0.0004));
    knot.scale(BOW, BOW, BOW);
    solid.add(place(knot, base.p, f), sat(OC.ribbonDeep));
  },

  crown({ B, solid }) {
    // Small gold crown: flared band with five points and pearl tips, a heart
    // gem in front and round gems around; tilted a little for charm.
    const base = onHead(v3(0.04, 0.92, 0.39), 0.0003);
    const f = frame(base.n.clone().lerp(UP, 0.45).applyAxisAngle(v3(0, 0, 1), -0.1), v3(0, 0, 1));
    const head = B("head");
    const gold = { b0: head, color: OC.gold, mat: MAT.gold };
    const R0 = 0.0053, H0 = 0.0028, HP = 0.0036, WALL = 0.00055;
    const top = (a) => { const k = Math.abs(((a / (Math.PI * 2)) * 5 + 0.5) % 1 - 0.5) * 2; return H0 + HP * Math.pow(1 - k, 1.6); };
    const N = 60, M = 4;
    const pos = [], index = [];
    const vert = (a, v, inner) => {
      const h = top(a) * v, r = R0 + 0.0011 * v - (inner ? WALL : 0);
      return [Math.sin(a) * r, h, Math.cos(a) * r];
    };
    // outer wall, inner wall, top lip (between them), bottom lip
    for (const layer of [0, 1]) {
      const o = pos.length / 3;
      for (let i = 0; i <= N; i += 1) for (let j = 0; j <= M; j += 1) pos.push(...vert((i / N) * Math.PI * 2, j / M, layer === 1));
      for (let i = 0; i < N; i += 1) for (let j = 0; j < M; j += 1) {
        const a = o + i * (M + 1) + j, b = a + M + 1;
        if (layer === 0) index.push(a, b, a + 1, b, b + 1, a + 1); else index.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
    const lip = (j) => {
      const o = pos.length / 3;
      for (let i = 0; i <= N; i += 1) { pos.push(...vert((i / N) * Math.PI * 2, j, false)); pos.push(...vert((i / N) * Math.PI * 2, j, true)); }
      for (let i = 0; i < N; i += 1) {
        const a = o + i * 2, b = a + 2;
        if (j > 0) index.push(a, b, a + 1, b, b + 1, a + 1); else index.push(a, a + 1, b, b, a + 1, b + 1);
      }
    };
    lip(1); lip(0);
    const wall = new THREE.BufferGeometry();
    wall.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    wall.setIndex(index);
    wall.computeVertexNormals();
    solid.add(place(wall, base.p, f), () => gold);
    // band rings (bottom rim + a beaded top line of the band)
    for (const [y, r, tube] of [[0.00045, R0 + 0.0001, 0.0006], [H0 * 0.92, R0 + 0.0011 * (H0 * 0.92) / (H0 + HP) + 0.0001, 0.00042]]) {
      const ring = new THREE.TorusGeometry(r, tube, 6, 48);
      ring.deleteAttribute("uv");
      ring.rotateX(Math.PI / 2);
      ring.translate(0, y, 0);
      solid.add(place(ring, base.p, f), () => gold);
    }
    // pearls on the points
    for (let k = 0; k < 5; k += 1) {
      const a = (k / 5) * Math.PI * 2;
      const [x, y, z] = vert(a, 1, false);
      const pearl = ellipsoid(0.0009, 0.0009, 0.0009, 10, 6);
      pearl.translate(x * 0.97, y + 0.0004, z * 0.97);
      solid.add(place(pearl, base.p, f), () => ({ b0: head, color: OC.goldPale, mat: MAT.gold }));
    }
    // gems on the band: heart in front, round gems on the sides
    const heart = heartGeometry(4, 1);
    heart.scale(0.0042, 0.0042, 0.0028);
    heart.translate(0, H0 * 0.5, R0 + 0.0011 * 0.18 + 0.0006);
    solid.add(place(heart, base.p, f), () => ({ b0: head, color: OC.gemPink, mat: MAT.gem }));
    for (const [a, c] of [[1.1, OC.gemBlue], [-1.1, OC.gemBlue], [2.2, OC.gemMint], [-2.2, OC.gemMint]]) {
      const gem = sphereGeometry(10, 6, (x, y, z) => v3(x * 0.00095, y * 0.00095, z * 0.0006));
      gem.rotateY(a);
      const r = R0 + 0.0011 * 0.18 + 0.0004;
      gem.translate(Math.sin(a) * r, H0 * 0.5, Math.cos(a) * r);
      solid.add(place(gem, base.p, f), () => ({ b0: head, color: c, mat: MAT.gem }));
    }
  },

  flowerband({ B, solid }) {
    // Flower crown: a slim green band over the head in front of the ears with
    // little five-petal flowers and leaves.
    const head = B("head");
    const tilt = 0.5;
    const dirAt = (phi) => v3(Math.sin(phi), Math.cos(phi) * Math.cos(tilt), Math.cos(phi) * Math.sin(tilt));
    const PH = 1.22;
    const band = sweep(48, 8, (t) => {
      const phi = lerp(-PH, PH, t);
      const s = onHead(dirAt(phi), 0.0011);
      const tan = onHead(dirAt(phi + 0.01), 0.0011).p.sub(s.p).normalize();
      return { p: s.p, n: s.n, b: s.n.clone().cross(tan).normalize(), r1: 0.0006, r2: 0.0011, e: 0.8 };
    });
    solid.add(band, () => ({ b0: head, color: OC.band, mat: MAT.band }));
    const flowers = [[0, 1.45, 0], [0.42, 1.25, 1], [-0.42, 1.25, 2], [0.8, 1.12, 3], [-0.8, 1.12, 1], [1.12, 0.95, 0], [-1.12, 0.95, 2]];
    for (const [phi, size, ci] of flowers) {
      const s = onHead(dirAt(phi), 0.0019);
      const tan = onHead(dirAt(phi + 0.01), 0.0019).p.sub(s.p).normalize();
      const f = frame(s.n, tan.clone().cross(s.n).negate().lerp(v3(0, 0, 1), 0.2));
      const twist = phi * 2.3;
      for (let k = 0; k < 5; k += 1) {
        const a = twist + (k / 5) * Math.PI * 2;
        const petal = sphereGeometry(10, 6, (x, y, z) => {
          const along = (x + 1) / 2;
          const w = Math.sin(Math.PI * Math.min(1, 0.2 + along)) * (1 - 0.15 * along);
          return v3(x * 0.0018, y * 0.00055 + 0.0006 * along * along, z * 0.0015 * w);
        });
        petal.translate(0.0016, 0, 0);
        petal.rotateY(a);
        petal.scale(size, size, size);
        const c = OC.petals[ci];
        solid.add(place(petal, s.p, f), (p, n) => ({ b0: head, color: c, mat: MAT.petal }));
      }
      const heart = ellipsoid(0.00095 * size, 0.0007 * size, 0.00095 * size, 12, 8);
      heart.translate(0, 0.0007 * size, 0);
      solid.add(place(heart, s.p, f), () => ({ b0: head, color: OC.flowerHeart, mat: [0.3, 0, 0.5, 0] }));
    }
    for (const phi of [0.2, -0.2, 0.6, -0.6, 0.95, -0.95]) {
      const s = onHead(dirAt(phi), 0.0014);
      const tan = onHead(dirAt(phi + 0.01), 0.0014).p.sub(s.p).normalize();
      const f = frame(s.n, tan);
      const leaf = sphereGeometry(12, 8, (x, y, z) => {
        const w = Math.pow(Math.max(0, 1 - x * x), 0.7);
        return v3(x * 0.0021, y * 0.0003 + 0.0004 * (1 - x * x), z * 0.0009 * w);
      });
      leaf.rotateY(Math.PI / 2 + (phi > 0 ? 0.6 : -0.6));
      leaf.translate(0, 0, 0.0004);
      solid.add(place(leaf, s.p, f), () => ({ b0: head, color: OC.leaf, mat: MAT.leaf }));
    }
  },

  glasses({ B, rig, solid, glass }) {
    // Round glasses: two thin cocoa rings in front of the bead eyes, a curved
    // bridge over the nose and temples running back into the head fur.
    const head = B("head");
    const lens = [];
    for (const s of [1, -1]) {
      const e = rig.eye(s);
      const n = e.normal.clone().lerp(v3(0, 0, 1), 0.5).normalize();
      const c = e.pos.clone().addScaledVector(n, 0.0041).add(v3(s * 0.0004, 0.0003, 0));
      const fr = frame(v3(0, 1, 0).addScaledVector(n, -n.y).normalize(), n); // y = up on the lens plane, z = lens normal
      lens.push({ c, n, fr });
      const ring = new THREE.TorusGeometry(0.0047, 0.00058, 10, 48);
      ring.deleteAttribute("uv");
      solid.add(place(ring, c, fr), () => ({ b0: head, color: OC.frame, mat: MAT.frame }));
      const disc = new THREE.CircleGeometry(0.0046, 32);
      disc.deleteAttribute("uv");
      // slight dome
      const pp = disc.attributes.position;
      for (let i = 0; i < pp.count; i += 1) { const r = Math.hypot(pp.getX(i), pp.getY(i)) / 0.0046; pp.setZ(i, 0.0005 * (1 - r * r)); }
      disc.computeVertexNormals();
      glass.add(place(disc, c, fr), () => ({ b0: head, color: OC.lens, mat: [0.07, 0, 0, 0] }));
    }
    // bridge
    const [L, R] = lens;
    const a = L.c.clone().addScaledVector(L.fr.x, -0.0047).addScaledVector(L.fr.y, 0.0012);
    const b = R.c.clone().addScaledVector(R.fr.x, 0.0047).addScaledVector(R.fr.y, 0.0012);
    const mid = a.clone().lerp(b, 0.5).add(v3(0, 0.0014, 0.0012));
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
    const bridge = sweep(16, 8, (t) => {
      const p = curve.getPoint(t), tan = curve.getTangent(t);
      const n = v3(0, 0, 1).addScaledVector(tan, -tan.z).normalize();
      return { p, n, b: tan.clone().cross(n).normalize(), r1: 0.00045, r2: 0.00045 };
    });
    solid.add(bridge, () => ({ b0: head, color: OC.frame, mat: MAT.frame }));
    // temples: from the outer rim straight back along the side of the head
    for (const [k, s] of [[0, 1], [1, -1]]) {
      const l = lens[k];
      const start = l.c.clone().addScaledVector(l.fr.x, s * 0.0047).addScaledVector(l.fr.y, 0.0008);
      const pts = [start];
      for (let i = 1; i <= 6; i += 1) {
        const z = lerp(start.z, -0.002, i / 6);
        const dir = v3(s * 1, (start.y + 0.0006 * i / 6 - HEAD_C.y) / HEAD_R.y * 0.8, (z - HEAD_C.z) / HEAD_R.z * 0.9);
        const q = onHead(dir, 0.0012).p;
        pts.push(v3(q.x, start.y + 0.0006 * i / 6, z));
      }
      const tc = new THREE.CatmullRomCurve3(pts);
      const temple = sweep(20, 6, (t) => {
        const p = tc.getPoint(t), tan = tc.getTangent(t);
        const n = v3(s, 0, 0).addScaledVector(tan, -tan.x * s).normalize();
        return { p, n, b: tan.clone().cross(n).normalize(), r1: 0.0004, r2: 0.00045 };
      });
      solid.add(temple, () => ({ b0: head, color: OC.frame, mat: MAT.frame }));
    }
  },

  monocle({ B, rig, solid, glass, wearing }) {
    // Monocle on the right eye: gold ring, clear lens, and a fine bead chain
    // that hangs from the ring down to a little pin on the chest (or on the scarf).
    const head = B("head"), collar = B("collar");
    const e = rig.eye(-1);
    const n = e.normal.clone().lerp(v3(0, 0, 1), 0.45).normalize();
    const c = e.pos.clone().addScaledVector(n, 0.0043).add(v3(-0.0005, 0.0002, 0));
    const fr = frame(v3(0, 1, 0).addScaledVector(n, -n.y).normalize(), n);
    const R = 0.0054;
    const ring = new THREE.TorusGeometry(R, 0.00068, 10, 52);
    ring.deleteAttribute("uv");
    solid.add(place(ring, c, fr), () => ({ b0: head, color: OC.gold, mat: MAT.gold }));
    const disc = new THREE.CircleGeometry(R - 0.0002, 32);
    disc.deleteAttribute("uv");
    glass.add(place(disc, c, fr), () => ({ b0: head, color: OC.lens, mat: [0.09, 0, 0, 0] }));
    // eyelet at the bottom-outer edge
    const ea = -2.2;
    const eye = c.clone().addScaledVector(fr.x, Math.cos(ea) * (R + 0.0009)).addScaledVector(fr.y, Math.sin(ea) * (R + 0.0009));
    const loop = new THREE.TorusGeometry(0.0007, 0.00025, 6, 16);
    loop.deleteAttribute("uv");
    solid.add(place(loop, eye, frame(fr.z, fr.x)), () => ({ b0: head, color: OC.gold, mat: MAT.gold }));
    // anchor: a pin on the chest, or on the front of the scarf
    let anchor;
    if (wearing.neck === "scarf") {
      const k = scarfRing().at(-0.42);
      anchor = k.p.clone().addScaledVector(k.n, SCARF.r1 * 0.75).add(v3(0, SCARF.r2 * 0.55, 0));
    } else {
      const o = v3(-0.0085, 0.0312, 0);
      anchor = o.clone().add(v3(0, 0, surfaceAlong(o, v3(0, 0, 1), -0.0012, false)));
    }
    const pin = ellipsoid(0.0011, 0.0011, 0.0008, 12, 8);
    pin.translate(anchor.x, anchor.y, anchor.z);
    solid.add(pin, () => ({ b0: collar, color: OC.gold, mat: MAT.gold }));
    // chain: sagging curve, pushed out of the fur (cheek, chest)
    const start = eye.clone().addScaledVector(fr.y, -0.0006);
    const pts = [];
    for (let i = 0; i <= 24; i += 1) {
      const t = i / 24;
      const p = start.clone().lerp(anchor, t);
      p.y -= 0.0042 * Math.sin(Math.PI * t);
      p.x -= 0.0028 * Math.sin(Math.PI * t);
      for (let k = 0; k < 40 && insideBunny(p, 0.0009, true); k += 1) p.z += 0.0003;
      pts.push(p);
    }
    const cc = new THREE.CatmullRomCurve3(pts);
    const len = cc.getLength();
    const chain = sweep(120, 6, (t) => {
      const p = cc.getPoint(t), tan = cc.getTangent(t);
      const nn = v3(0, 0, 1).addScaledVector(tan, -tan.z).normalize();
      const bead = 0.00023 + 0.00013 * Math.abs(Math.sin((t * len) / 0.0009 * Math.PI));
      return { p, n: nn, b: tan.clone().cross(nn).normalize(), r1: bead, r2: bead };
    });
    const tv = chain.userData.tv;
    solid.add(chain, (p, nrm, i) => ({ b0: head, b1: collar, w: sstep(0.3, 0.8, tv[i]), color: OC.gold, mat: MAT.gold }));
  },

  scarf({ B, solid }) {
    // Knitted scarf: a rolled striped band around the neck, a knot on the left
    // side and two fringed tails that swing on their own bone.
    const collar = B("collar"), tailBone = B("scarfTail");
    const ring = scarfRing();
    const rows = ring.length / 0.00115;
    const band = sweep(SCARF.segs, 14, (t) => {
      const th = t * Math.PI * 2, k = ring.at(th);
      const soft = 1 + 0.07 * Math.sin(th * 7 + 0.5) + 0.04 * Math.sin(th * 13);
      return { p: k.p.clone().add(v3(0, 0.0004 * Math.sin(th * 5), 0)), n: k.n, b: UP, r1: SCARF.r1 * soft, r2: SCARF.r2 * (2 - soft), e: 0.75 };
    }, { closed: true });
    const tv = band.userData.tv, av = band.userData.av;
    solid.add(band, (p, n, i) => ({ b0: collar, color: OC.scarf, mat: MAT.knit, uv: [tv[i] * Math.round(rows / 7) * 7, av[i] * 8] }));
    const K = scarfKnot();
    const kn = ring.at(SCARF.knotTh).n;
    const knot = sphereGeometry(20, 14, (x, y, z) => v3(x * 0.0036, y * 0.0042, z * 0.0034));
    const kf = frame(UP, kn);
    place(knot, K, kf);
    const ku = knot.userData.unit;
    solid.add(knot, (p, n, i) => ({ b0: collar, color: OC.scarf, mat: MAT.knit, uv: [Math.atan2(ku[i * 3], ku[i * 3 + 2]) * 2.2 + 3.5, ku[i * 3 + 1] * 3] }));
    // tails hang down the side, following the body
    for (const [dth, len, wide] of [[-0.12, 0.024, 0.0031], [0.3, 0.019, 0.0028]]) {
      const pts = [];
      for (let i = 0; i <= 10; i += 1) {
        const t = i / 10;
        const th = SCARF.knotTh + dth * t + 0.08 * t * t;
        const y = K.y - 0.002 - len * t;
        const d = v3(Math.sin(th), 0, Math.cos(th));
        const r = surfaceAlong(v3(0, y, -0.002), d, 0.0012, false);
        pts.push(v3(0, y, -0.002).addScaledVector(d, Math.max(r + 0.0012, 0.0015 * (1 - t))));
      }
      pts[0].lerp(K, 0.85);
      const curve = new THREE.CatmullRomCurve3(pts);
      const strip = sweep(30, 10, (t) => {
        const p = curve.getPoint(t), tan = curve.getTangent(t);
        const out = v3(p.x, 0, p.z + 0.002).normalize();
        const n = out.addScaledVector(tan, -out.dot(tan)).normalize();
        return { p, n, b: tan.clone().cross(n).normalize(), r1: 0.0009, r2: wide * (1 - 0.1 * t), e: 0.55 };
      });
      const stv = strip.userData.tv, sav = strip.userData.av;
      solid.add(strip, (p, n, i) => ({ b0: collar, b1: tailBone, w: sstep(0, 0.35, stv[i]), color: OC.scarf, mat: MAT.knit, uv: [stv[i] * Math.round(len / 0.00115) + 1.5, sav[i] * 5] }));
      // fringe
      const end = curve.getPoint(1), tan = curve.getTangent(1);
      const side = tan.clone().cross(v3(end.x, 0, end.z + 0.002).normalize()).normalize();
      for (let k = 0; k < 4; k += 1) {
        const o = end.clone().addScaledVector(side, (k / 3 - 0.5) * wide * 1.5);
        const fr = sweep(4, 5, (t) => ({ p: o.clone().addScaledVector(tan, t * 0.0026), n: side, b: side.clone().cross(tan).normalize(), r1: 0.00042 * (1 - 0.4 * t), r2: 0.00042 * (1 - 0.4 * t) }));
        solid.add(fr, () => ({ b0: tailBone, color: OC.scarfStripe, mat: [0, 0, 0.9, 0] }));
      }
    }
  },

  wings({ B, glass }) {
    // Fairy wings: two pairs of rounded, softly cupped lobes on the upper back,
    // translucent with an opaque rim and radial veins; they flutter on their bones.
    for (const s of [1, -1]) {
      const bone = B(s > 0 ? "wingL" : "wingR");
      const root = WING_ROOT(s);
      const beta = 0.38;
      const out = v3(s * Math.cos(beta), 0, -Math.sin(beta));
      const nrm = out.clone().cross(UP).multiplyScalar(s).normalize(); // points backward-ish
      for (const [phi, L, span, color] of [[0.62, 0.041, 1.3, OC.wingA], [-0.36, 0.029, 1.1, OC.wingB]]) {
        const A = 40, P = 7;
        const pos = [], mat = [], index = [];
        for (let i = 0; i <= A; i += 1) {
          const th = lerp(-span / 2, span / 2, i / A);
          const r = L * Math.pow(Math.cos((th / span) * Math.PI), 0.42) * (1 + 0.1 * Math.sin(th * 2.2 + phi));
          for (let j = 0; j <= P; j += 1) {
            const rho = j / P;
            const a = phi + th;
            const d = out.clone().multiplyScalar(Math.cos(a) * r * rho).addScaledVector(UP, Math.sin(a) * r * rho);
            const cup = 0.0045 * Math.pow(rho, 1.6) * (0.6 + 0.4 * Math.cos((th / span) * Math.PI));
            const p = root.clone().add(d).addScaledVector(nrm, cup);
            pos.push(p.x, p.y, p.z);
            mat.push(rho, th / span * Math.PI * 2 * 3.5);
          }
        }
        for (let i = 0; i < A; i += 1) for (let j = 0; j < P; j += 1) {
          const a = i * (P + 1) + j, b = a + P + 1;
          index.push(a, b, a + 1, b, b + 1, a + 1);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        g.setIndex(index);
        g.computeVertexNormals();
        glass.add(g, (p, n, i) => ({ b0: bone, color, mat: [0.3, 1, mat[i * 2], mat[i * 2 + 1]] }));
      }
    }
  },

  cape({ B, solid, wearing }) {
    // Little star cape: wraps the shoulders and back (behind the arms), flares
    // to a scalloped hem above the tail; indigo with gold stars, pink lining,
    // gold piping and a star clasp on a cord under the chin.
    const collar = B("collar"), hem = B("capeHem");
    const TH0 = 1.2, TH1 = Math.PI * 2 - 1.2;
    const NA = 44, NV = 12;
    const yTop = (th) => 0.0428 - 0.0016 * Math.cos(th);
    // hem: lowest at the back (just above the tail), rising toward the front
    // corners, with five soft scallops
    const yHem = (th) => 0.0214 + 0.0062 * sstep(0.7, 1.95, Math.abs(th - Math.PI)) - 0.0012 * (0.5 - 0.5 * Math.cos(((th - TH0) / (TH1 - TH0)) * Math.PI * 2 * 5));
    const grid = [];
    for (let i = 0; i <= NA; i += 1) {
      const th = lerp(TH0, TH1, i / NA);
      const d = v3(Math.sin(th), 0, Math.cos(th));
      const col = [];
      const top = surfaceAlong(v3(0, yTop(th), -0.002), d, 0.0004) + 0.0006;
      for (let j = 0; j <= NV; j += 1) {
        const v = j / NV;
        const y = lerp(yTop(th), yHem(th), v);
        const body = surfaceAlong(v3(0, y, -0.002), d, 0.0007) + 0.0006;
        const flare = top + (0.0025 + 0.0075 * Math.sin(th / 2) ** 2) * Math.pow(v, 1.25);
        col.push(v3(0, y, -0.002).addScaledVector(d, Math.max(body, flare)));
      }
      grid.push(col);
    }
    // smooth across θ for a soft drape
    for (let pass = 0; pass < 2; pass += 1) {
      for (let j = 0; j <= NV; j += 1) {
        const row = grid.map((c) => c[j].clone());
        for (let i = 1; i < NA; i += 1) grid[i][j].copy(row[i - 1]).add(row[i].clone().multiplyScalar(2)).add(row[i + 1]).multiplyScalar(0.25);
      }
    }
    const surface = (inner) => {
      const pos = [], index = [], uv = [], vv = [];
      for (let i = 0; i <= NA; i += 1) for (let j = 0; j <= NV; j += 1) {
        const p = grid[i][j];
        const q = inner ? p.clone().sub(v3(0, p.y, -0.002)).setY(0).normalize().multiplyScalar(-0.00055).add(p) : p;
        pos.push(q.x, q.y, q.z);
        const th = lerp(TH0, TH1, i / NA);
        uv.push(th * 0.03 / 0.0052, p.y / 0.0052);
        vv.push(j / NV);
      }
      for (let i = 0; i < NA; i += 1) for (let j = 0; j < NV; j += 1) {
        const a = i * (NV + 1) + j, b = a + NV + 1;
        if (inner) index.push(a, a + 1, b, b, a + 1, b + 1); else index.push(a, b, a + 1, b, b + 1, a + 1);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(index);
      g.computeVertexNormals();
      // outward check
      const k = Math.floor(NA / 2) * (NV + 1) + Math.floor(NV / 2);
      const P = v3().fromBufferAttribute(g.attributes.position, k), N = v3().fromBufferAttribute(g.attributes.normal, k);
      const outward = v3(P.x, 0, P.z + 0.002).normalize();
      if ((N.dot(outward) < 0) !== inner) {
        const idx = g.index.array;
        for (let t = 0; t < idx.length; t += 3) { const tmp = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = tmp; }
        g.computeVertexNormals();
      }
      return { g, uv, vv };
    };
    const skinAt = (v) => ({ b0: collar, b1: hem, w: sstep(0.15, 1, v) });
    const outer = surface(false);
    solid.add(outer.g, (p, n, i) => ({ ...skinAt(outer.vv[i]), color: OC.cape, mat: MAT.cape, uv: [outer.uv[i * 2], outer.uv[i * 2 + 1]] }));
    const inner = surface(true);
    solid.add(inner.g, (p, n, i) => ({ ...skinAt(inner.vv[i]), color: OC.capeLining, mat: MAT.lining }));
    // piping around the whole edge (hides the seam between outer and lining)
    const edge = [];
    for (let i = 0; i <= NA; i += 1) edge.push([grid[i][0], 0]);
    for (let j = 1; j <= NV; j += 1) edge.push([grid[NA][j], j / NV]);
    for (let i = NA - 1; i >= 0; i -= 1) edge.push([grid[i][NV], 1]);
    for (let j = NV - 1; j >= 1; j -= 1) edge.push([grid[0][j], j / NV]);
    const ec = new THREE.CatmullRomCurve3(edge.map(([p]) => p), true, "centripetal");
    const ev = edge.map(([, v]) => v);
    const piping = sweep(edge.length * 2, 5, (t) => {
      const p = ec.getPoint(t), tan = ec.getTangent(t);
      const out = v3(p.x, 0, p.z + 0.002).normalize();
      const n = out.addScaledVector(tan, -out.dot(tan)).normalize();
      return { p, n, b: tan.clone().cross(n).normalize(), r1: 0.00062, r2: 0.00062 };
    }, { closed: true });
    const ptv = piping.userData.tv;
    solid.add(piping, (p, n, i) => {
      const k = ptv[i] * edge.length;
      const v = lerp(ev[Math.floor(k) % edge.length], ev[Math.ceil(k) % edge.length], k % 1);
      return { ...skinAt(v), color: OC.gold, mat: MAT.gold };
    });
    // cord under the chin from corner to corner, with a star clasp (not under a scarf)
    if (wearing.neck === "scarf") return;
    const cA = grid[0][0], cB = grid[NA][0];
    const pts = [];
    for (let i = 0; i <= 16; i += 1) {
      const t = i / 16;
      const th = lerp(TH0, -TH0, t);
      const y = lerp(yTop(TH0), 0.0322, Math.sin(Math.PI * t) ** 0.7) - 0.0004;
      const d = v3(Math.sin(th), 0, Math.cos(th));
      const r = surfaceAlong(v3(0, y, -0.002), d, 0.0009);
      pts.push(v3(0, y, -0.002).addScaledVector(d, r + 0.0005));
    }
    pts[0].copy(cA); pts[16].copy(cB);
    const cord = new THREE.CatmullRomCurve3(pts);
    const cordG = sweep(40, 6, (t) => {
      const p = cord.getPoint(t), tan = cord.getTangent(t);
      const n = v3(p.x, 0, p.z + 0.002).normalize();
      n.addScaledVector(tan, -n.dot(tan)).normalize();
      return { p, n, b: tan.clone().cross(n).normalize(), r1: 0.00045, r2: 0.00045 };
    });
    solid.add(cordG, () => ({ b0: collar, color: OC.gold, mat: MAT.gold }));
    const clasp = starGeometry(0.0026, 0.0011, 0.0009);
    const cp = cord.getPoint(0.5);
    place(clasp, cp.clone().add(v3(0, 0, 0.0006)), frame(v3(0, 1, 0), v3(0, -0.15, 1)));
    solid.add(clasp, () => ({ b0: collar, color: OC.gold, mat: MAT.gold }));
  },
};

// Wing roots on the upper back and the scarf knot (rig space), shared with the
// rig's bones (pivots). SCARF_KNOT ≈ scarfKnot() (kept constant so building the
// rig never needs the ring).
const WING_ROOT = (s) => v3(s * 0.0042, 0.0362, -0.0232);
const SCARF_KNOT = v3(0.0263, 0.034, -0.006);

// Five-point puffy star (clasp).
function starGeometry(r, rIn, depth) {
  const shape = new THREE.Shape();
  for (let i = 0; i <= 10; i += 1) {
    const a = (i / 10) * Math.PI * 2 + Math.PI / 2;
    const rr = i % 2 === 0 ? r : rIn;
    if (i === 0) shape.moveTo(Math.cos(a) * rr, Math.sin(a) * rr); else shape.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  const g = new THREE.ExtrudeGeometry(shape, { depth: depth * 0.4, bevelEnabled: true, bevelThickness: depth * 0.3, bevelSize: r * 0.12, bevelSegments: 2 });
  g.deleteAttribute("uv");
  g.center();
  g.computeVertexNormals();
  return g;
}

function buildOutfitItem(id, rig, wearing) {
  const solid = new OutfitBuilder(), glass = new OutfitBuilder();
  const B = (name) => rig.bones[name].userData.index;
  ITEMS[id]({ B, rig, solid, glass, wearing });
  return { solid: solid.chunk(), glass: glass.chunk() };
}

// Small spring (pitch, roll) for swinging pieces (scarf tails, cape hem).
class Swing {
  constructor(hz, damping) { this.w = 2 * Math.PI * hz; this.z = damping; this.a = [0, 0]; this.v = [0, 0]; }
  step(dt, target, force) {
    const n = Math.max(1, Math.ceil(dt / (1 / 240))), h = dt / n;
    for (let k = 0; k < n; k += 1) for (let j = 0; j < 2; j += 1) {
      const acc = this.w * this.w * (target[j] - this.a[j]) - 2 * this.z * this.w * this.v[j] + force[j];
      this.v[j] += acc * h; this.a[j] += this.v[j] * h;
    }
  }
  reset() { this.a.fill(0); this.v.fill(0); }
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

const SPIT_AT = 0.25;            // s into the "spit" segment when the chunk leaves the mouth
const SPIT_TURN = 0.62;          // rad the head turns to the bunny's right before spitting
const CHUNK_R = 0.0055;          // spat-out chunk radius (m)

// Segment timeline per outcome. Every segment: { name, t0, t1, dur, ...extra }.
function buildTimeline(outcome, bites, mood) {
  const segs = [];
  let t = 0;
  const add = (name, dur, extra = {}) => { const seg = { name, t0: t, t1: t + dur, dur, ...extra }; segs.push(seg); t += dur; return seg; };
  add("arrive", T_ARRIVE);
  if (outcome === "kick") {
    // No grab / lift / carry: the jelly stays on the tray until it is kicked.
    const T = { approach: add("approach", T_APPROACH).t0 };
    T.sniff = add("sniff", T_SNIFF).t0;
    T.shake = add("shake", T_SHAKE).t0;
    T.turn = add("turn", T_TURN).t0;
    T.kick = add("kick", T_KICK).t0 + KICK_CONTACT;
    T.react = add("hmph", T_HMPH).t0;
    const leave = add("leave", T_LEAVE);
    T.leave = leave.t0;
    T.done = leave.t1;
    return { segs, T };
  }
  const reach = add("grab", T_REACH);
  add("lift", T_LIFT);
  const T = { grab: reach.t1 };
  if (outcome === "eat") {
    for (let i = 0; i < bites; i += 1) add("bite", T_BITE, { index: i, count: bites, chew: true });
    T.holdEnd = t;
    add("finish", T_FINISH);
    add("react", T_REACT + (mood === "special" ? 0.6 : 0));
  } else if (outcome === "refuse") {
    add("bite", BITE_CHEW, { index: 0, count: 1, chew: false });
    add("ponder", 0.7);
    T.holdEnd = add("putDown", 0.6).t1;
    add("refuse", 1.2);
  } else {
    add("bite", BITE_CHEW, { index: 0, count: 1, chew: false });
    add("chew", 0.4);
    add("scrunch", 0.35);
    T.holdEnd = add("putDown", 0.6).t1;
    add("spit", 0.85);
    add("grumpy", 1.1);
  }
  const leave = add("leave", T_LEAVE);
  T.leave = leave.t0;
  T.done = leave.t1;
  return { segs, T };
}

/**
 * Plush bunny that comes to taste the jelly.
 *
 *   const rabbit = new Rabbit(tray, { quality: "high" });   // hidden until play()
 *   rabbit.setOutfit({ head: "ribbon", face: "glasses", neck: "scarf", back: "wings" });
 *   //   persists across plays (also before the first); null / undefined / unknown id =
 *   //   empty slot. Ids: OUTFIT_SLOTS (head ribbon|crown|flowerband · face glasses ·
 *   //   neck scarf · back wings|cape). rabbit.outfit → a copy of the current choice.
 *   rabbit.play({ position: [x, 0, z], faceTo: [x, y, z], jelly: { center, width, height },
 *                 outcome: "eat" | "spit" | "kick" | "refuse", bites: 4,
 *                 mood: "happy" | "ok" | "sad" | "special", jellyColor: "#rrggbb",
 *                 picky: false,   // true: a monocle for this visit (replaces the glasses)
 *                 onEvent(type, data) {} });
 *   // every frame (jelly = the app's current jelly, or null):
 *   const { hold, paws, mouth, phase } = rabbit.update(dt, { center, bounds });
 *   //   hold:  null | [x,y,z]  target for the jelly's centre of mass while carried (tray space)
 *   //   paws:  null | [[x,y,z] left, [x,y,z] right]  where the paws are (cosmetic; they hug
 *   //          the jelly's actual sides from `bounds`)
 *   //   mouth: [x,y,z]
 *   rabbit.skip();      // fast-forward to leaving, emitting the remaining key events in order
 *   rabbit.setQuality("high" | "medium" | "low");  rabbit.busy;  rabbit.dispose();
 *   await rabbit.precompile(renderer, camera, scene);   // optional, avoids a first-play hitch
 *
 * Events (type, data); see the timeline in buildTimeline(). For outcome "eat", bites = 4:
 *   arrive 0 · hop 0.38/0.88 · grab 1.75 {paws, hold} · lift 1.75 {hold}
 *   bite 2.61+0.72i {index,count,mouth} · chew 2.75+0.72i {index,count,duration}
 *   finish 5.23 · react 5.68 {mood} · leave 6.93 (+0.6 if special) · hop ×2 · done 7.98 (8.58)
 * "refuse": … lift · bite 2.61 · chew 2.75 · taste 3.45 · putDown 3.45 {to} · release 4.05
 *           · refuse 4.05 {mood} · leave 5.25 · done 6.30
 * "spit":   … lift · bite 2.61 · chew 2.75 · putDown 3.50 {to} · release 4.10
 *           · spit 4.35 {from, velocity} · react 4.95 {mood:"grumpy"} · leave 6.05 · done 7.10
 * "kick" (no grab / lift / release / bite / chew; `hold` and `paws` stay null):
 *           arrive 0 · hop 0.38/0.88 · approach 1.20 {to} · hop 1.60/2.08
 *           · sniff 2.20 {duration} · shake 3.40 {duration, swings} · turn 4.30 · hop 4.68
 *           · kick 5.00 {dir:[dx,dz] (unit, tray space, bunny → jelly), strength 0.8,
 *             point:[x,y,z] (the foot at contact)} · react 5.30 {mood:"grumpy"}
 *           · leave 6.30 · hop ×2 · done 7.35
 *   It hops right up to the jelly (perching on the tray rim where it stands across it)
 *   so that its extended hind foot reaches the jelly's near side.
 * "hop" events are cosmetic; skip() does not replay them.
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
    this.shadowOpacity = uniform(0.5);
    const shadowMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    const r = length(uv().sub(0.5)).mul(2);
    shadowMaterial.colorNode = vec3(0.24, 0.19, 0.18);
    shadowMaterial.opacityNode = float(1).sub(smoothstep(0.0, 1.0, r)).pow(1.6).mul(this.shadowOpacity);
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.rotateX(-Math.PI / 2);
    this.shadow = new THREE.Mesh(quad, shadowMaterial);
    this.shadow.name = "RabbitShadow";
    this.shadow.renderOrder = 1;
    this.shadow.frustumCulled = false;
    this.root.add(this.shadow);

    // Hearts (happy 3, special 6) and twinkles (special): one instanced draw each, only while shown.
    this.hearts = new THREE.InstancedMesh(heartGeometry(), createCandyMaterial(this.fur, COLORS.heart), 6);
    this.hearts.name = "RabbitHearts";
    this.sparkles = new THREE.InstancedMesh(sparkleGeometry(), createCandyMaterial(this.fur, COLORS.sparkle, { glow: 0.9 }), 10);
    this.sparkles.name = "RabbitSparkles";
    for (const m of [this.hearts, this.sparkles]) { m.frustumCulled = false; m.visible = false; this.root.add(m); }

    // Spat-out chunk: tray space (it stays where it lands while the bunny leaves).
    this.blob = createBlobMaterial(this.fur);
    this.chunk = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), this.blob.material);
    this.chunk.name = "RabbitSpitChunk";
    this.chunk.visible = false;
    this.chunk.frustumCulled = false;
    this.chunk.renderOrder = 2;
    parent.add(this.chunk);
    this.chunkSim = null;

    // Outfit: one solid + one glass (lenses, wings) mesh; their geometry is the
    // merge of the worn pieces, rebuilt only when the worn set changes.
    this.outfitMaterials = createOutfitMaterials(this.fur, { star: OC.star, dot: OC.dot, stripe: OC.scarfStripe });
    this.outfitMeshes = [this.outfitMaterials.solid, this.outfitMaterials.glass].map((material, i) => {
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
      mesh.name = i ? "RabbitOutfitGlass" : "RabbitOutfit";
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = i ? 3 : 0;
      this.root.add(mesh);
      return mesh;
    });
    this._outfit = { head: null, face: null, neck: null, back: null };
    this._outfitParts = new Map();
    this._outfitKey = "";
    this.swings = { scarf: new Swing(2.4, 0.22), cape: new Swing(1.9, 0.28) };
    this._wingPhase = 0;

    this.ears = [new EarSpring(), new EarSpring()];
    this.state = null;
    this.quality = "high";
    this.setQuality(quality);
    this._m = new THREE.Matrix4(); this._n = new THREE.Matrix3(); this._q = new THREE.Quaternion();
    this._rootInv = new THREE.Matrix4();
    this._sunA = v3(); this._sunB = v3(); this._e = new THREE.Euler(); this._eYXZ = new THREE.Euler(0, 0, 0, "YXZ");
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

  /** Current outfit (copy): { head, face, neck, back }, each an id or null. */
  get outfit() { return { ...this._outfit }; }

  /** Dress up (persists across plays). Unknown ids / null / undefined = empty slot. */
  setOutfit({ head = null, face = null, neck = null, back = null } = {}) {
    const pick = (slot, id) => (OUTFIT_SLOTS[slot].includes(id) ? id : null);
    this._outfit = { head: pick("head", head), face: pick("face", face), neck: pick("neck", neck), back: pick("back", back) };
    this._syncOutfit();
  }

  // Worn pieces right now: the outfit, with the monocle replacing the face slot on a picky visit.
  _wornItems() {
    const o = this._outfit;
    return [o.head, this.state?.picky ? "monocle" : o.face, o.neck, o.back].filter(Boolean);
  }

  // Pieces that adapt to a worn scarf: the monocle's chain hangs to it, the
  // cape leaves out its cord and clasp (the scarf covers the neck).
  _outfitVariant(id) {
    return (id === "monocle" || id === "cape") && this._outfit.neck === "scarf" ? `${id}/scarf` : id;
  }

  _outfitPart(id) {
    const key = this._outfitVariant(id);
    let part = this._outfitParts.get(key);
    if (!part) {
      part = buildOutfitItem(id, this.rig, { ...this._outfit });
      this._outfitParts.set(key, part);
    }
    return part;
  }

  _syncOutfit(ids = this._wornItems()) {
    const key = ids.map((id) => this._outfitVariant(id)).join("+");
    if (key === this._outfitKey) return;
    this._outfitKey = key;
    const parts = ids.map((id) => this._outfitPart(id));
    ["solid", "glass"].forEach((kind, i) => {
      const mesh = this.outfitMeshes[i];
      const chunks = parts.map((p) => p[kind]).filter(Boolean);
      mesh.geometry.dispose();
      mesh.geometry = chunks.length ? mergeChunks(chunks) : new THREE.BufferGeometry();
      mesh.visible = chunks.length > 0;
    });
  }

  /** Optional: compile every pipeline the bunny can use ahead of the first play() (avoids a hitch). */
  async precompile(renderer, camera, scene) {
    // Outfit pipelines (solid + glass) do not depend on which pieces are worn:
    // compile them with a small representative piece that has both parts.
    this._syncOutfit(["glasses"]);
    const parts = [this.root, this.hearts, this.sparkles, this.chunk, ...this.outfitMeshes];
    const was = parts.map((o) => o.visible);
    for (const o of parts) o.visible = true;
    try {
      await renderer.compileAsync(this.root, camera, scene);
      await renderer.compileAsync(this.chunk, camera, scene);
    } finally {
      parts.forEach((o, i) => { o.visible = was[i]; });
      this._syncOutfit();
    }
  }

  // -------------------------------------------------------------------------
  play({ position = [0, 0, -0.111], faceTo = [0, 0.02, 0], jelly = null, bites = 4, mood = "happy", outcome = "eat", jellyColor = "#ff8fb1", picky = false, onEvent = null } = {}) {
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
    outcome = outcome === "refuse" || outcome === "spit" || outcome === "kick" ? outcome : "eat";
    mood = mood === "ok" || mood === "sad" || mood === "special" ? mood : "happy";
    bites = outcome === "eat" ? Math.max(1, Math.min(8, Math.round(bites))) : 1;
    try { this.blob.color.value.set(jellyColor); } catch { this.blob.color.value.set("#ff8fb1"); }
    const { segs, T } = buildTimeline(outcome, bites, mood);

    this.state = {
      t: 0, segs, T, outcome, bites, mood, onEvent,
      seat: P, F, X, yaw: Math.atan2(F.x, F.z), outward, side,
      start: P.clone().addScaledVector(outward, 0.072).addScaledVector(side, 0.03),
      mid: P.clone().addScaledVector(outward, 0.035).addScaledVector(side, 0.012),
      exitA: P.clone().addScaledVector(outward, 0.036).addScaledVector(side, -0.018),
      exitB: P.clone().addScaledVector(outward, 0.076).addScaledVector(side, -0.036),
      faceTo: v3(faceTo[0], faceTo[1] ?? 0.02, faceTo[2]),
      jelly0: { center: v3(...j.center), width: j.width ?? 0.072, height: j.height ?? 0.036 },
      jellyNow: null,
      liftFrom: null, holdPoint: null, tall: 0,
      emitted: new Set(), events: [],
      bitesDone: 0, sizeScale: 1,
      skipped: false, blendFrom: null, blendT: 1,
      blink: { next: 1.4 + Math.random() * 1.5 },
      twitch: { next: 0.6 },
      prevHead: null, prevVel: v3(), accel: v3(),
      lastPose: null, pawsTray: null,
      picky: Boolean(picky), kick: null, leaveFrom: null, leaveYaw: null,
    };
    this._buildEvents();
    this._syncOutfit();
    for (const e of this.ears) e.reset();
    this.swings.scarf.reset(); this.swings.cape.reset();
    this.root.visible = true;
    this.hearts.visible = false;
    this.sparkles.visible = false;
    this.update(0, null);
  }

  skip() {
    const s = this.state;
    if (!s || s.t >= s.T.leave) return;
    if (s.T.grab !== undefined) this._ensureGrab();
    if (s.outcome === "kick") {
      this._kickPlan();
      // not at its kicking spot yet: leave from where it is
      if (s.t < s.T.sniff && s.lastPose) this._setExit(s.lastPose.pos.clone().setY(0), s.lastPose.yaw);
    }
    // Emit everything that would have happened before leaving, in order.
    for (const e of s.events) {
      if (e.t < s.T.leave && !s.emitted.has(e.id)) {
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
    s.t = s.T.leave;
  }

  dispose() {
    this.state = null;
    this.root.removeFromParent();
    this.chunk.removeFromParent();
    this.geometry.dispose();
    this.fur.material.dispose();
    for (const m of [this.shadow, this.hearts, this.sparkles, this.chunk, ...this.outfitMeshes]) { m.geometry.dispose(); m.material.dispose(); }
    this._outfitParts.clear();
  }

  // -------------------------------------------------------------------------
  _emit(type, data) {
    try { this.state?.onEvent?.(type, data); } catch (error) { console.error(error); }
  }

  _seg(t) {
    const segs = this.state.segs;
    for (const seg of segs) if (t < seg.t1) return seg;
    return segs[segs.length - 1];
  }

  _buildEvents() {
    const s = this.state, T = s.T;
    const ev = (id, time, type, make) => s.events.push({ id, t: time, type, make });
    ev("arrive", 0, "arrive", () => ({ position: toArr(s.seat) }));
    ev("hop-a0", HOP.crouch + HOP.air, "hop", () => ({ phase: "arrive", index: 0 }));
    ev("hop-a1", 0.5 + HOP.crouch + HOP.air, "hop", () => ({ phase: "arrive", index: 1 }));
    if (T.grab !== undefined) {
      ev("grab", T.grab, "grab", () => ({ paws: this._jellySides(T.grab).map(toArr), hold: toArr(s.liftFrom) }));
      ev("lift", T.grab + 1e-4, "lift", () => ({ hold: toArr(s.holdPoint) }));
    }
    for (const seg of s.segs) {
      if (seg.name === "bite") {
        const i = seg.index;
        ev(`bite${i}`, seg.t0 + BITE_CONTACT, "bite", (skipped) => ({ index: i, count: seg.count, mouth: skipped ? toArr(this._biteTarget(i)) : this._mouthTray() }));
        if (seg.chew) ev(`chew${i}`, seg.t0 + BITE_CHEW, "chew", () => ({ index: i, count: seg.count, duration: T_BITE - BITE_CHEW }));
      } else if (seg.name === "ponder" || seg.name === "chew") {
        ev("chew0", seg.t0, "chew", () => ({ index: 0, count: 1, duration: seg.dur }));
        if (seg.name === "ponder") ev("taste", seg.t1, "taste", () => ({}));
      } else if (seg.name === "putDown") {
        ev("putDown", seg.t0, "putDown", () => ({ to: toArr(s.liftFrom) }));
        ev("release", seg.t1, "release", () => ({ at: toArr(s.liftFrom) }));
      } else if (seg.name === "refuse") {
        ev("refuse", seg.t0, "refuse", () => ({ mood: s.mood }));
      } else if (seg.name === "spit") {
        ev("spit", seg.t0 + SPIT_AT, "spit", () => this._launchChunk());
      } else if (seg.name === "grumpy") {
        ev("react", seg.t0, "react", () => ({ mood: "grumpy" }));
      } else if (seg.name === "approach") {
        ev("approach", seg.t0, "approach", () => ({ to: toArr(this._kickPlan().spot) }));
        ev("hop-p0", seg.t0 + 0.02 + HOP.crouch + HOP.air, "hop", () => ({ phase: "approach", index: 0 }));
        ev("hop-p1", seg.t0 + 0.5 + HOP.crouch + HOP.air, "hop", () => ({ phase: "approach", index: 1 }));
      } else if (seg.name === "sniff") {
        ev("sniff", seg.t0, "sniff", () => ({ duration: seg.dur }));
      } else if (seg.name === "shake") {
        ev("shake", seg.t0, "shake", () => ({ duration: seg.dur, swings: 4 }));
      } else if (seg.name === "turn") {
        ev("turn", seg.t0, "turn", () => ({}));
        ev("hop-t", seg.t0 + HOP.crouch + HOP.air, "hop", () => ({ phase: "turn", index: 0 }));
      } else if (seg.name === "kick") {
        ev("kick", seg.t0 + KICK_CONTACT, "kick", (skipped) => this._kickEvent(skipped));
      } else if (seg.name === "hmph") {
        ev("react", seg.t0, "react", () => ({ mood: "grumpy" }));
      } else if (seg.name === "finish") {
        ev("finish", seg.t0, "finish", () => ({}));
      } else if (seg.name === "react") {
        ev("react", seg.t0, "react", () => ({ mood: s.mood }));
      } else if (seg.name === "leave") {
        ev("leave", seg.t0, "leave", () => ({}));
        ev("hop-l0", seg.t0 + 0.05 + HOP.crouch + HOP.air, "hop", () => ({ phase: "leave", index: 0 }));
        ev("hop-l1", seg.t0 + 0.55 + HOP.crouch + HOP.air, "hop", () => ({ phase: "leave", index: 1 }));
        ev("done", seg.t1, "done", () => ({}));
      }
    }
    s.events.sort((a, b) => a.t - b.t); // stable: same-time events keep this order
  }

  // Jelly in the bunny's frame: centre (bounds centre), half extents along the
  // bunny's left (hw), facing (hd) and up (hh). Elliptic support of the AABB, so
  // round shapes seen diagonally are not overestimated. Falls back to the plan.
  _measureJelly(t = this.state.t) {
    const s = this.state, j = s.jellyNow, X = s.X, F = s.F;
    if (j && j.bounds) {
      const b = j.bounds;
      const ex = (b[3] - b[0]) / 2, ey = (b[4] - b[1]) / 2, ez = (b[5] - b[2]) / 2;
      return {
        center: v3((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2),
        hw: Math.hypot(X.x * ex, X.z * ez), hd: Math.hypot(F.x * ex, F.z * ez), hh: ey,
      };
    }
    const k = s.sizeScale;
    const hold = this._holdAt(t);
    const center = hold || (j && j.center ? v3(...j.center) : (s.liftFrom || s.jelly0.center).clone());
    return { center, hw: (s.jelly0.width / 2) * k, hd: (s.jelly0.width / 2) * k, hh: (s.jelly0.height / 2) * k };
  }

  // Kick plan (computed once, when the approach starts or on skip): where the
  // bunny stands to sniff and kick, which way it turns, which foot kicks, how it
  // stands for its 흥 and where it leaves to. Frames: u = from the jelly toward the
  // bunny; the spot is u·(jelly half extent along u + KICK_REACH) from the jelly.
  _kickPlan() {
    const s = this.state;
    if (s.kick) return s.kick;
    const j = s.jellyNow;
    const b = j && j.bounds ? j.bounds : null;
    const J = b ? v3((b[0] + b[3]) / 2, 0, (b[2] + b[5]) / 2) : j && j.center ? v3(j.center[0], 0, j.center[2]) : s.jelly0.center.clone().setY(0);
    const top = b ? b[4] : (j && j.center ? j.center[1] : s.jelly0.center.y) + s.jelly0.height / 2;
    const ext = (d) => (b ? Math.hypot(d.x * (b[3] - b[0]) / 2, d.z * (b[5] - b[2]) / 2) : s.jelly0.width / 2);
    // Swing the approach a little to the side (seen from where it faced on
    // arrival = the viewer), so sniffing and kicking read in three-quarter view.
    const u0 = s.seat.clone().sub(J).setY(0);
    if (u0.lengthSq() < 1e-8) u0.copy(s.F).negate();
    u0.normalize();
    const cands = [KICK_SWING, -KICK_SWING].map((a) => u0.clone().applyAxisAngle(UP, a));
    const u = Math.abs(cands[0].dot(s.X)) >= Math.abs(cands[1].dot(s.X)) ? cands[0] : cands[1];
    const spot = J.clone().addScaledVector(u, ext(u) + KICK_REACH);
    const sniffSpot = J.clone().addScaledVector(u, ext(u) + KICK_REACH - 0.011); // a step closer to sniff
    const faceYaw = Math.atan2(-u.x, -u.z);
    // Turn its back-side to the jelly: the jelly ends up behind it, KICK_SIDE
    // toward the kicking foot, and that foot's side faces the viewer (profile kick).
    const options = [1, -1].map((foot) => {
      const yaw = Math.atan2(u.x, u.z) + foot * KICK_SIDE; // jelly behind it, toward the foot's side
      const left = v3(Math.cos(yaw), 0, -Math.sin(yaw));
      return { foot, yaw, show: foot * left.dot(s.F) };
    });
    const { foot, yaw: backYaw } = options[0].show >= options[1].show ? options[0] : options[1];
    let turn = (backYaw - faceYaw) % (Math.PI * 2);
    if (turn > Math.PI) turn -= Math.PI * 2;
    if (turn < -Math.PI) turn += Math.PI * 2;
    // 흥: faces the viewer again (a little away from the jelly), nose turned away
    const hf = s.F.clone().addScaledVector(u, 0.45).normalize();
    const hmphYaw = Math.atan2(hf.x, hf.z);
    let hmphTurn = (hmphYaw - backYaw) % (Math.PI * 2);
    if (hmphTurn > Math.PI) hmphTurn -= Math.PI * 2;
    if (hmphTurn < -Math.PI) hmphTurn += Math.PI * 2;
    const jellyLeft = J.clone().sub(spot).dot(v3(hf.z, 0, -hf.x)) >= 0 ? 1 : -1;
    s.kick = {
      J, top, u, spot, faceYaw, backYaw, turn, foot, hmphYaw, hmphTurn,
      hmphHead: -jellyLeft * 0.5,
      mid: s.seat.clone().lerp(sniffSpot, 0.5), sniffSpot,
      sniffAt: J.clone().addScaledVector(u, ext(u) * 0.72).setY(top + 0.007),
      dir: u.clone().negate(),
    };
    this._setExit(spot, hmphYaw);
    return s.kick;
  }

  // Leave path for "kick": hop away from the tray centre (and from the jelly).
  _setExit(from, yaw) {
    const s = this.state;
    const out = from.clone().setY(0);
    if (out.lengthSq() < 1e-8) out.copy(s.outward);
    out.normalize();
    const side = v3(out.z, 0, -out.x);
    const k = s.kick && side.dot(s.kick.u) < 0 ? -1 : 1;
    s.leaveFrom = from.clone();
    s.leaveYaw = yaw;
    s.exitA = from.clone().addScaledVector(out, 0.036).addScaledVector(side, 0.014 * k);
    s.exitB = from.clone().addScaledVector(out, 0.074).addScaledVector(side, 0.032 * k);
  }

  _jellyCenterNow() {
    const s = this.state, j = s.jellyNow;
    if (j && j.bounds) { const b = j.bounds; return v3((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2); }
    if (j && j.center) return v3(...j.center);
    return s.jelly0.center.clone();
  }

  // "kick" event data at contact: direction bunny → jelly (tray xz, unit), the foot.
  _kickEvent(skipped) {
    const s = this.state, K = this._kickPlan();
    const jc = this._jellyCenterNow();
    const d = jc.clone().sub(K.spot).setY(0);
    if (d.lengthSq() < 1e-8) d.copy(K.dir);
    d.normalize();
    let point;
    if (skipped) {
      point = jc.clone().addScaledVector(d, -this._extentAlong(d)).setY(0.012);
    } else {
      const foot = K.foot > 0 ? this.rig.bones.footL : this.rig.bones.footR;
      point = v3(0, -0.004, -0.002).applyMatrix4(foot.matrixWorld).applyMatrix4(this.root.matrix);
    }
    return { dir: [d.x, d.z], strength: KICK_STRENGTH, point: toArr(point) };
  }

  _extentAlong(d) {
    const s = this.state, j = s.jellyNow;
    if (j && j.bounds) { const b = j.bounds; return Math.hypot(d.x * (b[3] - b[0]) / 2, d.z * (b[5] - b[2]) / 2); }
    return s.jelly0.width / 2;
  }

  // Standing across the tray rim: lift the body onto it, feet stay where they
  // are (on the plate, on the rim or on the bench).
  _perch(pose) {
    const c = Math.cos(pose.yaw + pose.yawExtra), sn = Math.sin(pose.yaw + pose.yawExtra);
    const over = (x, z, inner, outer) => {
      const tx = pose.pos.x + x * c + z * sn, tz = pose.pos.z - x * sn + z * c;
      return RIM_TOP * (1 - sstep(inner, outer, Math.abs(Math.hypot(tx, tz) - RIM_R)));
    };
    pose.perch = over(0, -0.004, 0.011, 0.021);
    pose.footLiftL = over(0.0135, 0.0165, 0.006, 0.0115);
    pose.footLiftR = over(-0.0135, 0.0165, 0.006, 0.0115);
  }

  // Grab bookkeeping: where the jelly is lifted from and where it is held.
  _ensureGrab() {
    const s = this.state;
    if (s.liftFrom) return;
    const j = s.jellyNow;
    s.liftFrom = j && j.center ? v3(...j.center) : j && j.bounds ? this._measureJelly().center : s.jelly0.center.clone();
    s.holdPoint = this._holdCenter();
    s.tall = clamp01((this._measureJelly().hh - 0.019) / 0.011);
  }

  // Hold point (tray): on the facing line, as close to the bunny as allowed
  // while staying within HOLD_MAX_R of the tray centre, at HOLD_Y.
  _holdCenter() {
    const s = this.state, P = s.seat, F = s.F;
    const pf = P.x * F.x + P.z * F.z;
    const disc = pf * pf - (P.x * P.x + P.z * P.z - HOLD_MAX_R * HOLD_MAX_R);
    const d = Math.max(0.03, disc >= 0 ? -pf - Math.sqrt(disc) : -pf);
    const h = P.clone().addScaledVector(F, d).setY(HOLD_Y);
    const r = Math.hypot(h.x, h.z);
    if (r > HOLD_MAX_R) { h.x *= HOLD_MAX_R / r; h.z *= HOLD_MAX_R / r; }
    return h;
  }

  // Carry target for the jelly's centre of mass at time t (tray), or null.
  _holdAt(t) {
    const s = this.state, T = s.T;
    if (!s.liftFrom || s.skipped || t < T.grab || t >= T.holdEnd) return null;
    const seg = this._seg(t), H = s.holdPoint, from = s.liftFrom;
    const u = (t - seg.t0) / seg.dur;
    const out = H.clone();
    if (seg.name === "grab") return from.clone();
    if (seg.name === "lift") {
      out.copy(from).lerp(H, easeInOut(u));
      out.y = lerp(from.y, H.y, easeOut(Math.min(1, u * 1.3))) + 0.0025 * Math.sin(Math.PI * u);
      return out;
    }
    if (seg.name === "putDown") {
      out.copy(H).lerp(from, easeInOut(sstep(0, 0.75, u)));
      out.y = lerp(H.y, from.y, easeInOut(sstep(0.2, 1, u)));
      return out;
    }
    if (seg.name === "bite") {
      const bt = t - seg.t0;
      out.addScaledVector(s.F, -0.003 * pulse(bt, 0.12, BITE_CONTACT + 0.03) + 0.0025 * pulse(bt, BITE_CONTACT, BITE_CHEW + 0.08));
      out.y += 0.002 * pulse(bt, BITE_CONTACT, BITE_CHEW + 0.12);
    } else if (seg.name === "ponder") {
      out.addScaledVector(s.X, 0.003 * Math.sin(u * Math.PI * 2) * sstep(0, 0.2, u));
      out.y += 0.002 * Math.sin(u * Math.PI);
    } else if (seg.name === "scrunch") {
      out.addScaledVector(s.F, 0.003 * sstep(0, 0.5, u)); // holds it a bit away, unsure
    }
    const r = Math.hypot(out.x, out.z);
    if (r > HOLD_MAX_R) { out.x *= HOLD_MAX_R / r; out.z *= HOLD_MAX_R / r; }
    out.y = Math.min(0.12, Math.max(0.05, out.y));
    return out;
  }

  // Where the paws hug the jelly (tray): its actual left/right sides, slightly
  // below the middle and toward the bunny.
  _jellySides(t = this.state.t) {
    const s = this.state, m = this._measureJelly(t);
    const y = Math.max(0.008, m.center.y - 0.12 * m.hh);
    const a = m.hw + 0.0025, back = -0.1 * m.hd;
    return [1, -1].map((k) => m.center.clone().addScaledVector(s.X, k * a).addScaledVector(s.F, back).setY(y));
  }

  // Mouth target for bite i (tray): the near top edge of the jelly, a little inside.
  _biteTarget(i) {
    const s = this.state;
    const m = s.jellyNow && s.jellyNow.bounds ? this._measureJelly() : null;
    const k = Math.pow(BITE_SHRINK, i);
    const c = m ? m.center : (s.holdPoint || this._holdCenter());
    const hd = m ? m.hd : (s.jelly0.width / 2) * k, hh = m ? m.hh : (s.jelly0.height / 2) * k;
    return c.clone().addScaledVector(s.F, -hd * 0.86 + 0.0035).setY(c.y + hh * 0.42);
  }

  // Spit: launch the chunk from the mouth, to the bunny's right and forward.
  _launchChunk() {
    const s = this.state;
    const from = v3(...this._mouthTray());
    const a = s.yaw - SPIT_TURN;
    const velocity = v3(Math.sin(a) * 0.6, 0.32, Math.cos(a) * 0.6); // lands ~6 cm from the tray centre
    this.chunkSim = { p: from.clone(), v: velocity.clone(), phase: "fly", t: 0, ts: 0, spin: v3(7, 3, 5), rot: new THREE.Euler() };
    this.blob.opacity.value = 1;
    this.chunk.visible = true;
    this._updateChunk(0);
    return { from: toArr(from), velocity: toArr(velocity) };
  }

  _updateChunk(dt) {
    const c = this.chunkSim;
    if (!c) return;
    const mesh = this.chunk;
    c.t += dt;
    if (c.phase === "fly") {
      c.v.y -= 9.81 * dt;
      c.p.addScaledVector(c.v, dt);
      c.rot.x += c.spin.x * dt; c.rot.y += c.spin.y * dt; c.rot.z += c.spin.z * dt;
      mesh.position.copy(c.p);
      mesh.rotation.copy(c.rot);
      const wob = 1 + 0.12 * Math.sin(c.t * 40);
      mesh.scale.set(CHUNK_R * wob, CHUNK_R / wob, CHUNK_R);
      if (c.p.y <= CHUNK_R * 0.45 && c.v.y < 0) { c.phase = "splat"; c.ts = 0; c.p.y = 0; }
    } else {
      // Squash-splat on the tray, wobble, then fade out ~1 s later.
      c.ts += dt;
      const w = c.ts;
      const flat = 0.38 + 0.62 * Math.exp(-w * 18) * Math.cos(w * 26) * 0.6 + 0.12 * Math.exp(-w * 5) * Math.sin(w * 30);
      const spread = 1 / Math.sqrt(Math.max(0.2, flat));
      mesh.rotation.set(0, c.rot.y, 0);
      mesh.scale.set(CHUNK_R * spread * 1.1, CHUNK_R * flat, CHUNK_R * spread);
      mesh.position.set(c.p.x, CHUNK_R * flat * 0.55, c.p.z);
      this.blob.opacity.value = 1 - sstep(1.0, 1.45, w);
      if (w > 1.45) { this.chunkSim = null; mesh.visible = false; }
    }
  }

  // -------------------------------------------------------------------------
  update(dt, jelly = null) {
    dt = Math.min(Math.max(dt || 0, 0), 0.1);
    this._updateChunk(dt);
    const s = this.state;
    if (!s) return { hold: null, paws: null, mouth: this._mouthTray(), phase: "idle" };
    if (jelly && (jelly.center || jelly.bounds)) s.jellyNow = jelly;
    s.t += dt;
    const t = s.t, T = s.T;

    if (!s.liftFrom && t >= T.grab) this._ensureGrab();
    s.sizeScale += (Math.pow(BITE_SHRINK, s.bitesDone) - s.sizeScale) * (1 - Math.exp(-dt / 0.09));

    const pose = this._samplePose(t);
    let finalPose = pose;
    if (s.blendFrom && s.blendT < 1) {
      s.blendT = Math.min(1, s.blendT + dt / 0.3);
      finalPose = lerpPose(s.blendFrom, pose, easeInOut(s.blendT));
    }
    s.lastPose = finalPose;
    this._applyPose(finalPose, dt);

    // Events crossing this frame ("done" waits for a flying/splatted chunk).
    for (const e of s.events) {
      if (e.t <= t && !s.emitted.has(e.id)) {
        if (e.type === "done" && this.chunkSim) break;
        s.emitted.add(e.id);
        const data = e.make(false);
        if (e.type === "bite") s.bitesDone = Math.max(s.bitesDone, data.index + 1);
        this._emit(e.type, data);
        if (this.state !== s) break;
      }
    }
    if (this.state === s && s.emitted.has("done")) this._finish();

    const live = this.state === s;
    const hold = live ? this._holdAt(t) : null;
    const touching = live && !s.skipped && t >= T.grab && t < T.holdEnd;
    return {
      hold: hold ? toArr(hold) : null,
      paws: touching && s.pawsTray ? s.pawsTray.map(toArr) : null,
      mouth: this._mouthTray(),
      phase: live ? this._seg(t).name : "idle",
    };
  }

  _finish() {
    this.state = null;
    this.root.visible = false;
    this.hearts.visible = false;
    this.sparkles.visible = false;
    this._syncOutfit(); // a picky visit's monocle comes off
  }

  // -------------------------------------------------------------------------
  // Pose sampling: a function of time, the segment timeline and the live jelly.
  _samplePose(t) {
    const s = this.state, T = s.T;
    const pose = defaultPose();
    pose.pos.copy(s.seat);
    pose.yaw = s.yaw;
    pose.breath = Math.sin(t * 2 * Math.PI * 1.1);
    pose.look.copy(s.faceTo);
    const seg = this._seg(t);
    const u = t - seg.t0, k = clamp01(u / seg.dur);
    // Hold posture: sits up tall with the jelly at the mouth (e = 0..1); taller
    // jellies (up to ~60 mm) make it stretch up more so its face stays above them.
    const tall = s.tall || 0;
    const holdPose = (e) => {
      pose.headUp = (0.009 + 0.006 * tall) * e; pose.rise = (0.004 + 0.004 * tall) * e;
      pose.stretch = 1 + (0.1 + 0.06 * tall) * e;
      pose.leanExtra = 0.02 * e; pose.headPitch = (0.12 - 0.04 * tall) * e;
    };
    const hugJelly = (amount = 1) => {
      const sides = this._jellySides(t);
      pose.pawMode = amount;
      pose.pawL.copy(sides[0]); pose.pawR.copy(sides[1]);
      pose.look.copy(sides[0]).lerp(sides[1], 0.5);
    };

    switch (seg.name) {
      case "arrive": {
        const legs = [[s.start, s.mid], [s.mid, s.seat]];
        const hi = t < 0.5 ? 0 : 1;
        const hu = t - hi * 0.5;
        const [a, b] = legs[hi];
        const h = hopShape(hu, hi === 0 ? 0.022 : 0.018);
        pose.pos.copy(a).lerp(b, easeInOut(h.k));
        if (t >= 1.0) pose.pos.copy(s.seat);
        pose.hopY = h.y; pose.squash = h.s;
        const travel = Math.atan2(b.x - a.x, b.z - a.z);
        pose.yaw = hi === 0 ? travel : angleLerp(travel, s.yaw, easeInOut((hu - 0.05) / 0.4));
        if (t >= 1.0) pose.yaw = s.yaw;
        pose.appear = lerp(0.35, 1, easeOutBack(t / 0.32));
        pose.earPerk = h.k > 0 && h.k < 1 ? -0.15 : 0.1;
        pose.pawTuck = h.y > 0 ? 1 : 0;
        pose.headPitch = -0.08 * Math.sin(Math.PI * clamp01(h.k));
        if (t > 1.0) { pose.earPerk = 0.25 * sstep(1.0, 1.15, t); pose.headRoll = 0.12 * pulse(t, 1.0, 1.2); }
        break;
      }
      case "grab": {
        hugJelly(easeInOut(sstep(0.05, 1, k)));
        pose.look.copy(this._measureJelly(t).center);
        pose.earPerk = 0.45; pose.earSplay = -0.1;
        pose.eyesWide = 0.4;
        pose.mouthOpen = 0.12 * sstep(0.6, 1, k);
        break;
      }
      case "lift": {
        hugJelly();
        holdPose(easeInOut(k));
        pose.mouthOpen = 0.12 + 0.35 * sstep(0.6, 1, k);
        pose.earPerk = 0.45 + 0.2 * pulse(k, 0, 1);
        pose.squash = 1 - 0.06 * pulse(k, 0, 0.4);
        pose.eyesWide = 0.5;
        break;
      }
      case "bite": {
        hugJelly();
        holdPose(1);
        this._bitePose(pose, seg, u);
        break;
      }
      case "ponder": {
        // Thoughtful chew: slow munching, head tilted, looking up, one ear flops.
        hugJelly();
        holdPose(1);
        const chew = Math.sin(u * 2 * Math.PI * 4.5);
        pose.chew = chew;
        pose.mouthOpen = 0.12 * Math.max(0, chew);
        pose.cheekPuff = 0.25 + 0.07 * chew;
        const think = easeOut(k / 0.35);
        pose.headRoll = 0.24 * think;
        pose.headYaw = 0.12 * think;
        pose.headPitch = 0.12 - 0.26 * think;
        pose.earTilt = think;
        pose.squint = 0.25;
        pose.earPerk = 0.2;
        break;
      }
      case "chew": {
        hugJelly();
        holdPose(1);
        const chew = Math.sin(u * 2 * Math.PI * 7);
        pose.chew = chew;
        pose.mouthOpen = 0.16 * Math.max(0, chew);
        pose.cheekPuff = 0.35 + 0.12 * chew;
        pose.squint = 0.4 * sstep(0.1, 0.4, k);
        pose.headPitch = 0.06 + 0.03 * chew;
        pose.earPerk = 0.3;
        pose.earWobble = 0.5 * Math.sin(u * 2 * Math.PI * 7);
        break;
      }
      case "scrunch": {
        // Yuck: face scrunches (> <), ears back, cheeks puff, a shiver.
        hugJelly();
        holdPose(1);
        const e = easeOut(k / 0.4);
        pose.scrunch = sstep(0, 0.3, k);
        pose.cheekPuff = 0.35 + 0.35 * e;
        pose.earDroop = 0.45 * e; pose.earPerk = -0.5 * e;
        pose.headPitch = 0.12 - 0.08 * e;
        pose.shudder = 0.6 * pulse(k, 0.1, 0.9);
        pose.squash = 1 - 0.04 * e;
        break;
      }
      case "putDown": {
        hugJelly();
        holdPose(1 - easeInOut(k));
        if (s.outcome === "spit") {
          pose.scrunch = 1; pose.cheekPuff = 0.7; pose.earDroop = 0.45; pose.earPerk = -0.5;
        } else {
          pose.squint = 0.2; pose.earPerk = 0.1; pose.headRoll = 0.1 * (1 - k);
        }
        break;
      }
      case "refuse": {
        // "No thanks": head shake, one paw waving in front of the face, ears a bit flat.
        hugJelly(1 - easeOut(k / 0.2));
        const env = sstep(0, 0.12, k) * (1 - sstep(0.85, 1, k));
        pose.look.copy(s.faceTo);
        pose.headYaw = 0.36 * Math.sin(u * 2 * Math.PI * 2.3) * env;
        pose.headPitch = 0.03;
        pose.pawWave = env; pose.wave = u;
        pose.earDroop = 0.3 * env; pose.earPerk = -0.25 * env;
        pose.squint = 0.35 * env;
        pose.squash = 1 - 0.03 * pulse(k, 0, 0.15);
        break;
      }
      case "spit": {
        // Turns the head aside, puffs and spits, then "bleh" with a shudder.
        hugJelly(1 - easeOut(k / 0.2));
        pose.look.copy(s.faceTo);
        const turn = easeOut(u / 0.2);
        pose.headYaw = -SPIT_TURN * turn * (1 - 0.75 * sstep(SPIT_AT + 0.04, SPIT_AT + 0.2, u)); // turns back for the "bleh"
        const spat = u >= SPIT_AT;
        pose.cheekPuff = spat ? 0.85 * (1 - sstep(SPIT_AT, SPIT_AT + 0.08, u)) : 0.7 + 0.15 * sstep(0, SPIT_AT, u);
        pose.headPitch = spat ? 0.08 * pulse(u, SPIT_AT, SPIT_AT + 0.2) : -0.06 * sstep(0, SPIT_AT, u);
        pose.lunge = 0;
        pose.tongue = sstep(0.3, 0.38, u) * (1 - sstep(0.72, 0.82, u));
        pose.mouthOpen = Math.max(0.8 * pulse(u, SPIT_AT - 0.03, SPIT_AT + 0.14), 0.42 * pose.tongue);
        pose.shudder = pulse(u, 0.3, 0.62);
        pose.scrunch = 1 - sstep(0.7, 0.85, u);
        pose.earDroop = 0.35; pose.earPerk = -0.3;
        pose.earWobble = 0.8 * pulse(u, 0.3, 0.62) * Math.sin(u * 60);
        pose.leanExtra = -0.06 * pulse(u, SPIT_AT, 0.6);
        break;
      }
      case "grumpy": {
        // "흥": turns away, nose up, eyes half-lidded, arms crossed.
        const e = easeOut(k / 0.25);
        pose.look.copy(s.faceTo);
        pose.yawExtra = 0.5 * e;
        pose.headYaw = 0.35 * e;
        pose.headPitch = -0.18 * e;
        pose.squint = 0.65 * e;
        pose.pawCross = easeOut(u / 0.22);
        pose.earDroop = 0.25 * e; pose.earPerk = -0.15;
        pose.cheekPuff = 0.5 * pulse(u, 0.05, 0.45);
        pose.squash = 1 - 0.05 * pulse(u, 0.05, 0.25);
        break;
      }
      case "approach": {
        // Two hops up to the jelly (onto the rim), turning to face it.
        const K = this._kickPlan();
        const hi = u < 0.5 ? 0 : 1;
        const hu = u - 0.02 - hi * 0.48;
        const [a, b] = hi === 0 ? [s.seat, K.mid] : [K.mid, K.sniffSpot];
        const h = hopShape(hu, hi === 0 ? 0.016 : 0.013);
        pose.pos.copy(a).lerp(b, easeInOut(h.k));
        pose.hopY = h.y; pose.squash = h.s;
        const travel = Math.atan2(K.sniffSpot.x - s.seat.x, K.sniffSpot.z - s.seat.z);
        pose.yaw = hi === 0 ? angleLerp(s.yaw, travel, easeInOut(u / 0.3)) : angleLerp(travel, K.faceYaw, easeInOut((hu - 0.05) / 0.35));
        pose.look.copy(K.sniffAt);
        pose.earPerk = h.k > 0 && h.k < 1 ? -0.15 : 0.4;
        pose.pawTuck = h.y > 0 ? 1 : 0;
        pose.headPitch = -0.07 * Math.sin(Math.PI * clamp01(h.k));
        pose.eyesWide = 0.35;
        break;
      }
      case "sniff": {
        // Leans in over the jelly: quick sniffs (nose twitching, little forward
        // pecks, cheeks puffing), ears perked, curious head tilt; then recoils.
        const K = this._kickPlan();
        pose.pos.copy(K.sniffSpot); pose.yaw = K.faceYaw;
        pose.squash = hopShape(u + T_APPROACH - 0.5, 0.013).s;
        const lean = easeInOut(sstep(0.05, 0.4, u));
        const recoil = sstep(1.0, 1.18, u);
        const peck = Math.max(0, Math.sin(u * 2 * Math.PI * 3.3));
        const on = lean * (1 - recoil);
        // sits up tall to peer over the jelly, paws held up at its chest
        const tall = easeInOut(sstep(0, 0.35, u));
        pose.headUp = 0.011 * tall; pose.rise = 0.006 * tall; pose.stretch = 1 + 0.11 * tall;
        pose.pawTogether = tall; pose.pawPat = 0.6 * tall;
        pose.biteTarget.copy(K.sniffAt);
        pose.lunge = (0.82 + 0.18 * peck) * on - 0.2 * recoil;
        pose.lungeMax = 0.027;
        pose.leanExtra = 0.1 * on;
        pose.look.copy(K.sniffAt);
        pose.noseTwitch = Math.sin(u * 2 * Math.PI * 9.5) * on;
        pose.cheekPuff = (0.18 + 0.2 * peck) * on + 0.45 * recoil;
        pose.earPerk = 0.8 * on - 0.2 * recoil; pose.earSplay = -0.12 * on;
        pose.eyesWide = 0.6 * on;
        pose.squint = 0.7 * recoil;
        pose.headRoll = 0.12 * Math.sin(u * 2 * Math.PI * 0.7) * on;
        pose.headPitch = 0.05 * peck * on;
        pose.tailWag = 0.4 * on;
        break;
      }
      case "shake": {
        // 절레절레: head shakes "no" (≈ 4 swings), eyes squeezed shut, ears flopping.
        const K = this._kickPlan();
        pose.pos.copy(K.sniffSpot); pose.yaw = K.faceYaw;
        const env = sstep(0, 0.1, u) * (1 - sstep(0.72, 0.9, u));
        const w = 2 * Math.PI * SHAKE_HZ, ph = w * u;
        pose.headYaw = 0.42 * Math.sin(ph) * env;
        pose.headRoll = -0.1 * Math.sin(ph) * env;
        pose.earSwing = -0.42 * w * w * Math.sin(ph) * env;
        pose.scrunch = sstep(0, 0.08, u) * (1 - sstep(0.78, 0.9, u));
        pose.squint = 0.6 * sstep(0.78, 0.9, u);
        pose.cheekPuff = 0.45;
        pose.earDroop = 0.22 * env; pose.earPerk = -0.25 * env;
        pose.lunge = -0.2 * (1 - sstep(0.55, 0.9, u));
        pose.leanExtra = -0.03 * env;
        const tall = 1 - easeInOut(sstep(0.6, 0.9, u));
        pose.headUp = 0.011 * tall; pose.rise = 0.006 * tall; pose.stretch = 1 + 0.11 * tall;
        pose.pawTogether = tall; pose.pawPat = 0.6 * tall;
        pose.look.copy(K.sniffAt);
        pose.squash = 1 - 0.02 * env;
        break;
      }
      case "turn": {
        // Hop-turn: turns its back(-side) on the jelly, hopping back a step.
        const K = this._kickPlan();
        const h = hopShape(u, 0.012);
        pose.pos.copy(K.sniffSpot).lerp(K.spot, easeInOut(h.k));
        pose.hopY = h.y; pose.squash = h.s;
        pose.yaw = K.faceYaw + K.turn * easeInOut(sstep(0.04, 0.36, u));
        pose.look.set(pose.pos.x + Math.sin(pose.yaw) * 0.1, 0.035, pose.pos.z + Math.cos(pose.yaw) * 0.1);
        pose.pawTuck = h.y > 0 ? 1 : 0;
        pose.squint = 0.6; pose.cheekPuff = 0.4;
        pose.earPerk = -0.1; pose.earDroop = 0.1;
        break;
      }
      case "kick": {
        // Gathers (leans forward on its front paws, tucks the foot along its
        // side, glances back over its shoulder), snaps the foot back into the
        // jelly (contact at KICK_CONTACT), holds, and puts it down again.
        const K = this._kickPlan();
        pose.yaw = K.backYaw;
        const F = v3(Math.sin(K.backYaw), 0, Math.cos(K.backYaw));
        const wind = easeOut(sstep(0, 0.2, u));
        const out = easeOut(sstep(0.21, KICK_CONTACT - 0.015, u));
        const back = easeInOut(sstep(0.42, 0.6, u));
        pose.pos.copy(K.spot).addScaledVector(F, 0.003 * pulse(u, 0.22, 0.55));
        pose.kickSide = K.foot;
        pose.kickWind = back > 0 ? 0 : wind;
        pose.kickLeg = out * (1 - back);
        const gather = Math.max(wind * (1 - back), 0);
        pose.leanExtra = 0.3 * gather + 0.08 * pulse(u, KICK_CONTACT - 0.03, 0.45);
        pose.pawBrace = gather;
        pose.squash = hopShape(u + T_TURN, 0.012).s * (1 - 0.06 * wind * (1 - out) + 0.05 * pulse(u, 0.22, 0.4));
        pose.headYaw = K.foot * 0.75 * gather;
        pose.look.set(pose.pos.x + F.x * 0.1, 0.035, pose.pos.z + F.z * 0.1);
        pose.scrunch = sstep(0.22, 0.27, u) * (1 - sstep(0.4, 0.48, u));
        pose.squint = 0.55 * wind;
        pose.cheekPuff = 0.45 * wind;
        pose.earPerk = -0.35 * wind; pose.earDroop = 0.12 * wind;
        break;
      }
      case "hmph": {
        // 흥: hop-turns back toward the viewer, crosses its arms, nose up and
        // turned away from the jelly, eyes shut; a little foot thump.
        const K = this._kickPlan();
        pose.pos.copy(K.spot);
        const h = hopShape(u, 0.008);
        pose.hopY = h.y; pose.squash = h.s;
        pose.yaw = K.backYaw + K.hmphTurn * easeInOut(sstep(0.04, 0.34, u));
        const e = easeOut(sstep(0.2, 0.45, u));
        pose.look.copy(s.faceTo);
        pose.pawCross = easeOut(sstep(0.12, 0.4, u));
        pose.headYaw = K.hmphHead * e;
        pose.headPitch = -0.2 * e;
        pose.blink = Math.max(pose.blink, 0.8 * sstep(0.35, 0.45, u) * (1 - sstep(0.85, 0.95, u)));
        pose.squint = 0.6 * e;
        pose.cheekPuff = 0.6 * pulse(u, 0.32, 0.8);
        pose.earDroop = 0.22 * e; pose.earPerk = -0.15;
        pose.squash *= 1 - 0.05 * pulse(u, 0.38, 0.55);
        pose.kickSide = -K.foot;
        pose.thump = pulse(u, 0.55, 0.72) * (u < 0.66 ? 1 : 0.6);
        break;
      }
      case "finish": {
        if (k < 0.35) hugJelly(1 - easeOut(k / 0.35));
        pose.look.copy(s.faceTo);
        pose.pawTogether = easeOut(k / 0.4);
        holdPose(1 - easeInOut(k));
        pose.headPitch = 0;
        pose.cheekPuff = 0.3 * (1 - easeInOut(k));
        pose.chew = Math.sin(u * 2 * Math.PI * 6) * (1 - k);
        pose.mouthOpen = 0.1 * Math.max(0, pose.chew);
        pose.squint = 0.5;
        pose.squash = 1 - 0.05 * pulse(k, 0.25, 0.6);
        pose.earPerk = 0.3;
        pose.blush = 0.3;
        break;
      }
      case "react": {
        this._reactPose(pose, u);
        break;
      }
      default: { // leave
        const from = s.leaveFrom || s.seat;
        const legs = [[from, s.exitA], [s.exitA, s.exitB]];
        const away = Math.atan2(s.exitA.x - from.x, s.exitA.z - from.z);
        const hi = u < 0.55 ? 0 : 1;
        const hu = u - 0.05 - hi * 0.5;
        const [a, b] = legs[hi];
        const low = s.mood === "sad" && s.outcome === "eat" ? 0.6 : 1;
        const h = hopShape(hu, (hi === 0 ? 0.02 : 0.024) * low);
        pose.pos.copy(a).lerp(b, easeInOut(h.k));
        pose.hopY = h.y; pose.squash = h.s;
        const startYaw = s.leaveYaw ?? (s.outcome === "spit" ? s.yaw + 0.5 : s.yaw);
        pose.yaw = angleLerp(startYaw, away, easeInOut(u / 0.2));
        pose.appear = 1 - easeIn((u - 0.55) / (T_LEAVE - 0.55));
        pose.pawTuck = h.y > 0 ? 1 : 0;
        const droopy = s.mood === "sad" && s.outcome === "eat";
        pose.earPerk = droopy ? -0.4 : 0.1;
        pose.earDroop = droopy ? 0.6 : 0;
        pose.look.copy(s.exitB).setY(0.03);
      }
    }

    // Idle overlays.
    const b = s.blink;
    if (t >= b.next) {
      const bt = t - b.next;
      pose.blink = Math.max(pose.blink, pulse(bt, 0, 0.14));
      if (bt > 0.14) b.next = t + 2 + Math.random() * 2.2;
    }
    const tw = s.twitch;
    if (t >= tw.next && pose.noseTwitch === 0) {
      const nt = t - tw.next;
      pose.noseTwitch = Math.sin(nt * 2 * Math.PI * 9) * pulse(nt, 0, 0.45);
      if (nt > 0.45) tw.next = t + 1.2 + Math.random() * 1.6;
    }
    if (T.holdEnd !== undefined && t >= T.holdEnd) s.pawsTray = null;
    else if (pose.pawMode > 0) s.pawsTray = [pose.pawL.clone(), pose.pawR.clone()];
    if (s.outcome === "kick") this._perch(pose);
    return pose;
  }

  // One bite: wind-up, lunge to the jelly's near top edge (contact), tear back,
  // then (eat) happy chewing.
  _bitePose(pose, seg, u) {
    const i = seg.index;
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
    } else if (u < BITE_CHEW || !seg.chew) {
      const w = clamp01((u - BITE_CONTACT) / (BITE_CHEW - BITE_CONTACT));
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

  _reactPose(pose, u) {
    const s = this.state;
    pose.look.copy(s.faceTo);
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
    } else if (s.mood === "special") {
      // ★4: twirl jump, more hops, flapping ears, hearts and twinkles.
      const h = hopShape(u - 0.04, 0.032);
      pose.hopY = h.y; pose.squash = h.s;
      pose.yawExtra = h.k > 0 ? Math.PI * 2 * easeInOut(h.k) : 0;
      for (const [t0, height] of [[0.62, 0.014], [0.98, 0.012], [1.34, 0.008]]) {
        if (u > t0) { const h2 = hopShape(u - t0, height); pose.hopY = h2.y; pose.squash = h2.s; }
      }
      const flap = sstep(0.5, 0.65, u) * (1 - sstep(1.6, 1.8, u));
      pose.happyEyes = sstep(0.05, 0.15, u) * (1 - sstep(1.6, 1.75, u));
      pose.earPerk = 0.8; pose.earSplay = 0.2 + 2.6 * Math.sin(u * 2 * Math.PI * 5) * flap;
      pose.earWobble = 0.5 * flap;
      pose.blush = 1.2;
      pose.pawCheer = sstep(0.0, 0.2, u) * (1 - sstep(1.6, 1.85, u));
      pose.pawClap = flap;
      pose.headRoll = 0.16 * Math.sin(u * 2 * Math.PI * 1.8) * sstep(0.6, 0.8, u);
      pose.mouthOpen = 0.45 * pulse(u, 0.1, 0.8) + 0.3 * pulse(u, 0.9, 1.5);
      pose.tailWag = 1;
      pose.hearts = u;
      pose.sparkles = u;
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
    this.root.rotation.set(0, pose.yaw + pose.yawExtra, 0);
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

    // Paw targets in rig space: an idle/gesture pose, blended toward the jelly's sides.
    const pawL = v3(), pawR = v3();
    const idleL = v3(0.0118, 0.025, 0.03), idleR = v3(-0.0118, 0.025, 0.03);
    if (pose.pawTuck) { idleL.add(v3(-0.002, 0.004, 0.002)); idleR.add(v3(0.002, 0.004, 0.002)); }
    if (pose.pawTogether > 0) {
      const low = pose.pawLow ? -0.007 : 0;
      const pat = pose.pawPat * 0.003;
      idleL.lerp(v3(0.0058, 0.031 + low + pat, 0.027), pose.pawTogether);
      idleR.lerp(v3(-0.0058, 0.031 + low + pat, 0.027), pose.pawTogether);
    }
    if (pose.pawCheer > 0) {
      const clap = pose.pawClap * 0.005 * (0.5 + 0.5 * Math.cos(t * 2 * Math.PI * 4));
      idleL.lerp(v3(0.0105 - clap, 0.037, 0.03), pose.pawCheer);
      idleR.lerp(v3(-0.0105 + clap, 0.037, 0.03), pose.pawCheer);
    }
    if (pose.pawWave > 0) {
      idleR.lerp(v3(-0.011 + 0.011 * Math.sin(pose.wave * 2 * Math.PI * 2.8), 0.042, 0.037), pose.pawWave);
      idleL.lerp(v3(0.008, 0.028, 0.029), pose.pawWave);
    }
    if (pose.pawCross > 0) {
      idleL.lerp(v3(-0.0068, 0.033, 0.031), pose.pawCross);
      idleR.lerp(v3(0.0068, 0.0365, 0.029), pose.pawCross);
    }
    if (pose.pawBrace > 0) { // front paws planted on the ground ahead (kick)
      idleL.lerp(v3(0.0112, 0.0075, 0.035), pose.pawBrace);
      idleR.lerp(v3(-0.0112, 0.0075, 0.035), pose.pawBrace);
    }
    if (pose.pawMode > 0) {
      pawL.copy(pose.pawL).applyMatrix4(this._rootInv);
      pawR.copy(pose.pawR).applyMatrix4(this._rootInv);
      pawL.lerp(idleL, 1 - pose.pawMode); pawR.lerp(idleR, 1 - pose.pawMode);
    } else { pawL.copy(idleL); pawR.copy(idleR); }

    // Body reach effort from how far forward / low the paws go.
    const reachZ = Math.max(pawL.z, pawR.z), reachLow = Math.max(0, 0.034 - Math.min(pawL.y, pawR.y));
    const far = clamp01((reachZ - 0.064) / 0.036);
    const effort = clamp01(far + reachLow * 12 * clamp01((reachZ - 0.064) / 0.02));
    const lean = 0.8 * effort + pose.leanExtra;
    const slide = 0.02 * effort, rise = 0.014 * effort + pose.rise;
    const stretch = pose.stretch * (1 + 0.08 * effort);

    // Base: hop + squash/stretch (volume preserving), feet stay planted.
    const sq = pose.squash;
    R.base.position.y = pose.hopY + pose.perch;
    R.base.scale.set(1 / Math.sqrt(sq), sq, 1 / Math.sqrt(sq));
    if (pose.hopY > 0) { R.footL.position.y += 0.002; R.footR.position.y += 0.002; }
    if (pose.perch || pose.footLiftL || pose.footLiftR) {
      R.footL.position.y += (pose.footLiftL - pose.perch) / sq;
      R.footR.position.y += (pose.footLiftR - pose.perch) / sq;
    }
    if (pose.kickWind > 0 || pose.kickLeg > 0 || pose.thump > 0) this._kickFoot(pose);
    R.hips.position.z += slide;
    R.hips.position.y += rise;
    R.hips.rotation.set(lean, 0, pose.shudder * 0.05 * Math.sin(t * 2 * Math.PI * 16));
    const breath = 1 + 0.011 * pose.breath;
    R.body.scale.set(breath, stretch * (1 + 0.006 * pose.breath), breath);
    R.chest.position.y += (stretch - 1) * 0.034 + 0.0003 * pose.breath;
    R.tail.position.y += (stretch - 1) * 0.008;
    R.collar.position.y -= (stretch - 1) * 0.0215; // outfit collar rides the body surface, not the chest

    // Head: look direction + expression offsets.
    this.rig.skel.updateMatrixWorld(true);
    const lookRig = pose.look.clone().applyMatrix4(this._rootInv);
    const neckWorld = v3().setFromMatrixPosition(R.neck.matrixWorld);
    const toLook = lookRig.sub(neckWorld);
    const yawLook = Math.max(-0.5, Math.min(0.5, Math.atan2(toLook.x, Math.max(0.01, toLook.z))));
    const pitchLook = Math.max(-0.35, Math.min(0.45, -Math.atan2(toLook.y - 0.01, Math.hypot(toLook.x, toLook.z))));
    const headPitch = 0.4 * pitchLook + pose.headPitch - lean * 0.55 + 0.12 * pose.lookDown;
    R.neck.rotation.set(headPitch, yawLook * 0.6 + pose.headYaw, pose.headRoll, "YXZ");
    R.neck.position.y += pose.headUp;
    R.neck.position.z += 0.002 * pose.headUp / 0.007;

    // Bite lunge: move the head so the mouth reaches the bite target
    // (negative lunge = wind-up: pull back & up).
    if (pose.lunge !== 0) {
      this.rig.skel.updateMatrixWorld(true);
      R.neck.position.add(this._chestDelta(pose, pose.lunge));
    }

    // Eyes: squint/half-close by squashing the bead; a full blink, the happy
    // face or a scrunch swaps the bead for an arc ("∪" closed, "∩" happy, "> <").
    const happy = pose.happyEyes, scrunch = pose.scrunch;
    const closed = sstep(0.55, 0.7, pose.blink);
    const arc = Math.max(happy, scrunch, closed);
    const open = Math.max(0.25, 1 - Math.max(pose.blink * 0.8, pose.squint * 0.5)) * (1 + 0.1 * pose.eyesWide);
    for (const e of [R.eyeL, R.eyeR]) e.scale.set(1 + 0.05 * pose.eyesWide, Math.max(0.02, open * (1 - arc)), Math.max(0.02, 1 - arc));
    R.eyeL.position.y -= 0.0006 * pose.lookDown; R.eyeR.position.y -= 0.0006 * pose.lookDown;
    for (const [h, side] of [[R.happyL, 1], [R.happyR, -1]]) {
      h.scale.setScalar(Math.max(1e-3, arc));
      const turn = happy >= Math.max(scrunch, closed) ? 0 : scrunch >= closed ? side * Math.PI / 2 : Math.PI;
      if (turn) h.quaternion.multiply(this._q.setFromAxisAngle(v3(0, 0, 1), turn));
    }
    const mouthOpen = clamp01(pose.mouthOpen);
    const shown = sstep(0, 0.1, mouthOpen); // fully hidden when closed
    R.mouth.scale.set(Math.max(0.02, (0.7 + 0.3 * mouthOpen) * shown), Math.max(0.02, mouthOpen), Math.max(0.02, shown));
    R.jaw.rotation.x = 0.35 * mouthOpen;
    R.jaw.position.x += 0.0004 * pose.chew;
    R.tongue.scale.setScalar(Math.max(1e-3, pose.tongue));
    R.tongue.rotation.x = 0.35 * pose.tongue;
    R.tongue.position.z += 0.0022 * pose.tongue;
    R.muzzle.position.y += 0.0003 * pose.chew;
    R.muzzle.position.x += 0.0003 * pose.chew;
    const puff = 1 + pose.cheekPuff * 0.42;
    R.cheekL.scale.set(puff, 1 + pose.cheekPuff * 0.22, puff);
    R.cheekR.scale.copy(R.cheekL.scale);
    R.cheekL.position.x += 0.0012 * pose.cheekPuff; R.cheekR.position.x -= 0.0012 * pose.cheekPuff;
    R.nose.position.y += 0.00035 * pose.noseTwitch;
    R.nose.scale.set(1 + 0.08 * pose.noseTwitch, 1 - 0.1 * Math.abs(pose.noseTwitch), 1);
    R.tail.rotation.y = pose.tailWag * 0.35 * Math.sin(t * 2 * Math.PI * 4);
    this.fur.u.blush.value = 0.3 + 0.45 * Math.min(1.2, pose.blush);

    // Ears: springs around an expressive target, driven by head acceleration.
    this.rig.skel.updateMatrixWorld(true);
    this._earDynamics(pose, dt);
    if (this._outfitKey) this._outfitDynamics(pose, dt);

    // Arms (IK with plush stretch) after the body/head are posed.
    this.rig.skel.updateMatrixWorld(true);
    this._solveArm(R.shoulderL, R.pawL, pawL);
    this._solveArm(R.shoulderR, R.pawR, pawR);
    this.rig.skel.updateMatrixWorld(true);

    this._uploadBones();
    this._updateShadow(pose);
    this._updateHearts(pose);
    this._updateSparkles(pose);
    this._updateSun();
  }

  // Kicking / thumping hind foot (base space): tucked along the side (wind),
  // stretched back with the sole toward the jelly (leg), or lifted (thump).
  _kickFoot(pose) {
    const k = pose.kickSide >= 0 ? 1 : -1;
    const foot = k > 0 ? this.rig.bones.footL : this.rig.bones.footR;
    const p = foot.position;
    if (pose.kickWind > 0 || pose.kickLeg > 0) {
      const dy = p.y - foot.userData.restPos.y; // perch compensation (fades as the foot lifts)
      const reach = 0.0415, sd = Math.sin(KICK_SIDE), cd = Math.cos(KICK_SIDE);
      p.copy(foot.userData.restPos).lerp(v3(k * 0.0192, 0.0078, 0.001), pose.kickWind).lerp(v3(k * (0.004 + reach * sd), 0.0135, -reach * cd), pose.kickLeg);
      p.y += dy * (1 - Math.max(pose.kickWind, pose.kickLeg));
      const pitch = lerp(lerp(0, 0.55, pose.kickWind), 2.05, pose.kickLeg);
      const turn = lerp(k * 0.25 * pose.kickWind, -k * KICK_SIDE, pose.kickLeg);
      foot.quaternion.copy(foot.userData.restQuat).multiply(this._q.setFromEuler(this._eYXZ.set(pitch, turn, 0)));
      const st = 1 + 0.12 * pose.kickLeg;
      foot.scale.set(1 / Math.sqrt(st), 1 / Math.sqrt(st), st);
    }
    if (pose.thump > 0) {
      p.y += 0.0042 * pose.thump;
      foot.quaternion.multiply(this._q.setFromEuler(this._e.set(-0.35 * pose.thump, 0, 0)));
    }
  }

  // Swinging / fluttering outfit bones (scarf tails, cape hem, wings).
  _outfitDynamics(pose, dt) {
    const R = this.rig.bones, o = this._outfit;
    const local = this._localAcc || v3();
    const air = clamp01(pose.hopY / 0.008);
    if (o.neck === "scarf") {
      // tails lag behind the body; they never swing into it (roll ≥ 0 = outward)
      const sw = this.swings.scarf;
      sw.step(dt, [0.04 + 0.12 * air, 0.1 + 0.15 * air], [local.z * 9, (-local.x - 0.6 * local.y) * 9]);
      R.scarfTail.quaternion.multiply(this._q.setFromEuler(this._e.set(Math.max(-0.25, sw.a[0]), 0, Math.max(0, sw.a[1]))));
    }
    if (o.back === "cape") {
      const sw = this.swings.cape;
      sw.step(dt, [0.03 + 0.22 * air, 0], [(local.z * 0.8 + local.y * 0.35) * 8, -local.x * 6]);
      R.capeHem.quaternion.multiply(this._q.setFromEuler(this._e.set(Math.max(0, sw.a[0]), 0, Math.max(-0.3, Math.min(0.3, sw.a[1])))));
    }
    if (o.back === "wings") {
      // gentle flutter; quick beats while airborne or cheering
      const excited = Math.max(air, pose.hearts >= 0 ? 1 : 0, pose.pawCheer);
      this._wingPhase += dt * 2 * Math.PI * lerp(2.2, 7.5, excited);
      const f = Math.sin(this._wingPhase) * lerp(0.13, 0.42, excited) + 0.05;
      for (const [b, side] of [[R.wingL, 1], [R.wingR, -1]]) {
        b.quaternion.multiply(this._q.setFromEuler(this._e.set(0.04 * Math.sin(this._wingPhase + 0.6), side * f, 0)));
      }
    }
  }

  // Chest-space head offset that brings the mouth to the bite target.
  _chestDelta(pose, amount) {
    const R = this.rig.bones;
    const mouth = this._mouthRig();
    const delta = amount < 0
      ? v3(0, 0.004, -0.008).multiplyScalar(-amount)
      : pose.biteTarget.clone().applyMatrix4(this._rootInv).sub(mouth).multiplyScalar(amount);
    if (delta.length() > pose.lungeMax) delta.setLength(pose.lungeMax);
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
    // Head acceleration in tray space → bunny frame (yaw only).
    const head = v3().setFromMatrixPosition(R.head.matrixWorld).applyMatrix4(this.root.matrix);
    if (s.prevHead && dt > 0) {
      const vel = head.clone().sub(s.prevHead).divideScalar(dt);
      const acc = vel.clone().sub(s.prevVel).divideScalar(dt);
      if (acc.length() > 40) acc.setLength(40);
      s.accel.lerp(acc, 1 - Math.exp(-dt / 0.02));
      s.prevVel.copy(vel);
    }
    s.prevHead = head;
    const local = s.accel.clone().applyAxisAngle(v3(0, 1, 0), -(pose.yaw + pose.yawExtra));
    this._localAcc = local;
    const G = 20; // rad/s² per m/s² of head acceleration
    const forcePitch = (local.z * 0.8 + local.y * 0.55) * G;
    const perk = pose.earPerk, droop = pose.earDroop;
    const wob = pose.earWobble * 60;
    for (let i = 0; i < 2; i += 1) {
      const side = i === 0 ? 1 : -1;
      const idle = 0.035 * Math.sin(s.t * 1.7 + i * 1.3);
      const tilt = i === 0 ? pose.earTilt : -0.3 * pose.earTilt; // one ear flops, the other perks
      const target = [
        -0.14 * perk + 0.55 * droop + idle + 0.45 * tilt,
        -0.12 * pose.earSplay + 0.85 * droop + 0.02 * Math.sin(s.t * 1.1 + i) + 0.35 * Math.max(0, tilt),
        -0.1 * perk + 0.7 * droop + 0.5 * Math.max(0, tilt),
        0.45 * droop,
      ];
      // (earSwing: the head shake's angular acceleration, flops both ears sideways)
      const forceOut = (-local.x * side + 0.3 * local.y) * G + pose.earSwing * 1.6 * side;
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
    const u = pose.hearts, s = this.state;
    if (!(u >= 0) || !s || (s.mood !== "happy" && s.mood !== "special")) { this.hearts.visible = false; return; }
    this.hearts.visible = true;
    const special = s.mood === "special";
    const m = this._m, q = this._q, pos = v3(), scl = v3();
    const top = v3().setFromMatrixPosition(this.rig.bones.head.matrixWorld);
    for (let i = 0; i < 6; i += 1) {
      const t0 = special ? 0.12 + i * 0.13 : 0.12 + i * 0.14;
      const k = (u - t0) / (special ? 1.1 : 0.95);
      const side = [0, 1, -1, 0.55, -0.55, 0.2][i];
      if (k <= 0 || k >= 1 || (!special && i >= 3)) { m.makeScale(0, 0, 0); this.hearts.setMatrixAt(i, m); continue; }
      const spread = special ? 0.024 : 0.016;
      pos.set(top.x + side * spread + 0.004 * Math.sin(k * 9 + i), top.y + 0.026 + (special ? 0.06 : 0.045) * easeOut(k) + (i % 3 === 0 ? 0.006 : 0), top.z + 0.008);
      const sc = 0.0105 * easeOutBack(Math.min(1, k * 4)) * (1 - sstep(0.7, 1, k)) * (i === 0 ? 1.15 : 0.9);
      q.setFromEuler(this._e.set(0, Math.sin(k * 5 + i) * 0.6, side * -0.25));
      scl.setScalar(Math.max(1e-4, sc));
      m.compose(pos, q, scl);
      this.hearts.setMatrixAt(i, m);
    }
    this.hearts.instanceMatrix.needsUpdate = true;
  }

  _updateSparkles(pose) {
    const u = pose.sparkles;
    if (!(u >= 0)) { this.sparkles.visible = false; return; }
    this.sparkles.visible = true;
    const m = this._m, q = this._q, pos = v3(), scl = v3();
    for (let i = 0; i < 10; i += 1) {
      const t0 = 0.08 + (i % 5) * 0.16 + Math.floor(i / 5) * 0.75;
      const k = (u - t0) / 0.5;
      if (k <= 0 || k >= 1) { m.makeScale(0, 0, 0); this.sparkles.setMatrixAt(i, m); continue; }
      const a = i * 2.39996 + 0.4;
      const r = 0.036 + 0.012 * ((i * 0.618) % 1);
      pos.set(Math.sin(a) * r, 0.025 + 0.075 * ((i * 0.37) % 1) + 0.008 * k, Math.cos(a) * r * 0.7 + 0.01);
      q.setFromEuler(this._e.set(0, 0, k * 2.5 + i));
      scl.setScalar(Math.max(1e-4, 0.0055 * Math.sin(Math.PI * k) * (0.8 + 0.4 * ((i * 0.53) % 1))));
      m.compose(pos, q, scl);
      this.sparkles.setMatrixAt(i, m);
    }
    this.sparkles.instanceMatrix.needsUpdate = true;
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

function defaultPose() {
  return {
    pos: v3(), yaw: 0, yawExtra: 0, appear: 1, hopY: 0, squash: 1,
    stretch: 1, leanExtra: 0, rise: 0, breath: 0, shudder: 0,
    look: v3(), headPitch: 0, headYaw: 0, headRoll: 0, headUp: 0, lookDown: 0,
    lunge: 0, lungeMax: 0.022, biteTarget: v3(),
    pawMode: 0, pawL: v3(), pawR: v3(), pawTuck: 0, pawTogether: 0, pawCheer: 0, pawClap: 0, pawPat: 0, pawLow: 0,
    pawWave: 0, wave: 0, pawCross: 0,
    earPerk: 0, earSplay: 0, earDroop: 0, earWobble: 0, earTilt: 0,
    blink: 0, squint: 0, eyesWide: 0, happyEyes: 0, scrunch: 0,
    mouthOpen: 0, chew: 0, cheekPuff: 0, blush: 0, noseTwitch: 0, tailWag: 0, tongue: 0,
    hearts: -1, sparkles: -1,
    kickWind: 0, kickLeg: 0, kickSide: 1, thump: 0, pawBrace: 0, earSwing: 0, perch: 0, footLiftL: 0, footLiftR: 0,
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
    else if (k === "yaw" || k === "yawExtra") o[k] = angleLerp(from, v, t);
    else if (k === "hearts" || k === "sparkles" || k === "wave") o[k] = v;
    else o[k] = lerp(from, v, t);
  }
  return o;
}
