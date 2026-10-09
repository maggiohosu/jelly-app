// JellyWorld: the original flower jelly on a tray, paint drops and gems.
//
// - The body is the original XPBD SoftBody (golden-tested numerics).
// - Colour: every cage node carries the jelly's absorption coefficients
//   σ = (σR, σG, σB) in 1/m. A paint drop adds pigment around the impact
//   (σ adds linearly with dye concentration — Beer-Lambert), water dilutes it,
//   and a pigment-conserving diffusion over cage edges spreads the colour,
//   faster while the jelly is stirred. Yellow + blue therefore makes green,
//   and the settled colour is exactly proportional to the amounts dropped.
// - Gems live in the undeformed cage coordinates; they follow the
//   deformation, stay suspended at rest, wander while the jelly is shaken,
//   keep their radius inside the body and knock into each other (clinks).

import { SoftBody, easeGrabTarget, clampGrabTarget } from "./softbody.js";
import { makeSurfaceStencils, makeTetLocator } from "./cage.js";
import { makeShapeCage, shapeLook, shapeMotions, motionWeight, SHAPES } from "./shapes.js";

// Absorption (1/m) of a saturated paint swirl; mixing adds σ.
export const PAINTS = Object.freeze([
  { id: "red", label: "빨강", hex: "#e8414f", sigma: [4.6, 72, 66] },
  { id: "yellow", label: "노랑", hex: "#f6c834", sigma: [3.0, 8.2, 80] },
  { id: "blue", label: "파랑", hex: "#3c6fe0", sigma: [80, 40, 4.6] },
  { id: "pink", label: "분홍", hex: "#f27aa8", sigma: [3.0, 34, 20] },
  { id: "purple", label: "보라", hex: "#9b5de5", sigma: [23, 66, 6.4] },
  { id: "sky", label: "하늘", hex: "#5cc6f2", sigma: [34, 8.2, 1.5] },
  { id: "water", label: "물", hex: "#e6f3fa", sigma: null },
  // unlocked by the bunny's friendship level (UI decides what is shown)
  { id: "orange", label: "주황", hex: "#ff9a3c", sigma: [2.2, 22, 74] },
  { id: "lime", label: "연두", hex: "#9be04a", sigma: [40, 4.0, 70] },
  { id: "pearl", label: "금펄", hex: "#e8c15a", sigma: [3.5, 9.0, 40], pearl: 1 },
  { id: "glow", label: "야광", hex: "#b8ff8a", sigma: [26, 2.5, 30], glow: 1 },
]);
// Additives dropped like paint (glitter flakes inside, star candies on the surface).
export const ADDITIVES = Object.freeze([
  { id: "glitter", label: "글리터", hex: "#ffd76a" },
  { id: "stars", label: "별사탕", hex: "#ffb3d1" },
]);
// Starting colours (the original flavours, plus an almost clear jelly).
export const BASES = Object.freeze({ berry: [5, 46, 23], mint: [40, 8, 20], honey: [5, 17, 58], clear: [0.8, 0.5, 0.6] });

const DROP_FRACTION = 0.015;      // one drop = 1.5 % of the jelly volume of paint
const PAINT_STRENGTH = 3;         // paint is a concentrate: 3× the swatch absorption (≈4.5 % per drop once mixed)
const WATER_STRENGTH = 0.06;      // one water drop removes ~6 % of the pigment (locally)
const DROP_RADIUS = 0.009;        // m, Gaussian footprint of a fresh drop
const SIGMA_MAX = 420;            // safety clamp per channel
const GEM_CLINK_SPEED = 0.02;     // m/s relative speed for an audible knock
const GEM_RATTLE = 9;             // m/s² jolt that rattles a gem
const GEM_WANDER = 0.03;          // m/s random drift at full stirring
// 슬랑이 (crunchy slime): much softer and stickier, flows into the shape it is
// pulled into (plastic), sags, then slowly rounds back into a blob.
const SLIME = Object.freeze({ shear: 0.32, damping: 6.5, friction: 1.7, flow: 1.6, recover: 0.13, yieldStrain: 0.2, holdTime: 2.5, awake: 30, beads: 180, beadRadius: 0.0021 });
const PLASTIC_HZ = 30;
const RARE_CAPACITY = 8;           // big rare gems per jelly
const GLITTER_MAX = 360, STARS_MAX = 36;

// Decorations (faces, cherry, beak…) of the shaped jellies; index = kind id
// sent to the renderer (render/decor.js DECOR_KINDS has the same order).
// A bunny bite: the whole jelly × scale (linear), the bitten spot caves in to
// `factor` (linear) within `radius`, never below `minScale` in total.
export const BITE = Object.freeze({ radius: 0.014, factor: 0.5, minScale: 0.35, scale: 0.87 });
// Append only: eyeClosed / eyeHappy / mouthOpen / beakOpen are the
// expressions the idle motions swap in (same anchor, same scale).
export const DECOR_KINDS = Object.freeze(["eye", "nose", "mouth", "blush", "muzzle", "earInner", "cherry", "beak", "eyeClosed", "eyeHappy", "mouthOpen", "beakOpen"]);
// Decorations are drawn on top of the jelly (render/decor.js overlay pass), so
// they anchor ON the rendered surface; shapes.js projects anchors onto it.
const DECOR_INSET = 0;

// ---------------------------------------------------------------- idle motions
// The animal shapes act on their own (shapes.js shapeMotions: interval,
// moves, soft regions). A move is a script in the shape's model axes
// (side = +x, up = +y, face = +z toward the face / beak, millimetres):
//   regions  { region: force limit (N) } — the regions it drives
//   drive(t, set)  set(region, side, up, face, on = 1): the region centre's
//                  offset from where it was when the move started, at time t,
//                  and how firmly it is held there (0..1; a region not set
//                  is free — it never anchors the jelly against another one)
//   face(t, show)  show(decorName, kind, scale×): expressions at time t
//                  (anything not shown is its normal self)
//   cues     [{ t, cue, index, hop?: m/s, plop?: m/s }] → "motionCue"
//            events for sound sync (+ a hop: an upward push from the
//            floor; a plop: the top squashes down onto the seat)
// Each region is pulled along its script like a muscle: a PD servo on its
// weighted centre relative to the jelly's centre of mass (in the jelly's
// orientation at the start) plus the script's own acceleration
// (feed-forward). The reaction is spread over the whole jelly, so the net
// force is zero: it acts in place and stays where it is.
// stiffness: N/m of a region's hold; slime: its moves are smaller (× slime)
// and it barely gets off the tray (hops / plops × slimeHop); recenter (m/s)
// and homeRange (m): see recenter()
const MOTION = Object.freeze({ stiffness: 900, slime: 0.8, slimeHop: 0.5, recenter: 0.002, homeRange: 0.008, slip: 0.3 });
const SLIPPERY = Object.freeze({ staticFriction: 0.05, dynamicFriction: 0.05 });
const KIND = Object.freeze(Object.fromEntries(DECOR_KINDS.map((k, i) => [k, i])));
const smooth01 = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
// 0 → 1 over [a, a + rise], 1 → 0 over [b, b + fall]
const env = (t, a, rise, b, fall) => smooth01((t - a) / rise) * (1 - smooth01((t - b) / fall));
// a quick out-and-back stroke from t0: out in `out` s, back in `back` s
const stroke = (t, t0, out, back) => (t < t0 ? 0 : t < t0 + out ? smooth01((t - t0) / out) : 1 - smooth01((t - t0 - out) / back));
const PUNCH_AT = [0.1, 0.34, 0.58, 0.82];
const CHIRP_AT = [0.12, 0.56, 1.0];
const HOP_AT = [0.36, 0.9];
const PLOP_AT = 1.5;
export const MOVES = Object.freeze({
  // 하품: the head stretches up and a little back, slowly (eyes shut, the
  // mouth opens wide and closes), then a little stretch of the whole cat.
  yawn: {
    duration: 1.8, regions: { head: 1.8, pawL: 0.6, pawR: 0.6, haunch: 1.2, tail: 0.5 },
    drive(t, set) {
      const e = env(t, 0.05, 0.6, 1.1, 0.5), s = env(t, 1.15, 0.3, 1.45, 0.33);
      set("head", 0, 10 * e, -2 * e, env(t, 0, 0.15, 1.5, 0.15));
      const on = env(t, 1.08, 0.12, 1.66, 0.14);
      if (on > 0) {
        set("pawL", 0, 0, 3 * s, on); set("pawR", 0, 0, 3 * s, on);
        set("haunch", 3.5 * s, 3 * s, 0, on);
        set("tail", 0, 3 * s, 0, on);
      }
    },
    face(t, show) {
      if (t > 0.12 && t < 1.55) show("eye", KIND.eyeClosed, 1);
      if (t > 0.2 && t < 1.5) show("mouth", KIND.mouthOpen, 0.6 + 2 * smooth01((t - 0.2) / 0.55) - 2 * smooth01((t - 1.12) / 0.38));
    },
    cues: [{ t: 0.2, cue: "open", index: 0 }, { t: 1.2, cue: "stretch", index: 0 }],
  },
  // 냥냥펀치: the front paws jab forward (toward the face side) and up,
  // alternately, twice each; squinting ^^ eyes, a small open mouth.
  punch: {
    duration: 1.1, regions: { pawL: 0.6, pawR: 0.6, head: 1.2 },
    drive(t, set) {
      // each jab: lifted first and set down last, so the paw does not
      // scrape (and creep) along the tray
      const L = [0, 0], Rr = [0, 0];
      PUNCH_AT.forEach((t0, k) => {
        const a = k % 2 ? Rr : L;
        a[0] += stroke(t, t0, 0.07, 0.24); a[1] += stroke(t, t0 + 0.012, 0.065, 0.1);
      });
      const on = env(t, 0.04, 0.06, 1.0, 0.08), e = env(t, 0.02, 0.12, 0.95, 0.13);
      set("pawL", -2.5 * L[1], 7 * L[0], 5 * L[1], on);
      set("pawR", 2.5 * Rr[1], 7 * Rr[0], 5 * Rr[1], on);
      set("head", 0, -1 * e, 2 * e, e);
    },
    face(t, show) {
      if (t > 0.04 && t < 1.04) { show("eye", KIND.eyeHappy, 1); show("mouth", KIND.mouthOpen, 1.1); }
    },
    cues: PUNCH_AT.map((t0, index) => ({ t: t0 + 0.07, cue: "punch", index })),
  },
  // 아기새의 날갯짓: the wings flap fast (≈ 9 Hz), two little hops that do not
  // take off, then it gives up and plops down onto its seat (squash), happy.
  flap: {
    duration: 2.2, regions: { wingL: 0.8, wingR: 0.8, tail: 0.5, head: 0.8 },
    drive(t, set) {
      const e = env(t, 0.04, 0.1, 1.38, 0.12), w = Math.sin(2 * Math.PI * 9 * (t - 0.04));
      const up = 5 * w * e, out = 2 * e * (0.5 + 0.5 * w);
      set("wingL", -out, up, 0, e); set("wingR", out, up, 0, e);
      set("tail", 0, 2.5 * e + 1.2 * w * e, 0, e);
      set("head", 0, 2 * e, 0, e);
    },
    face(t, show) {
      if (t > PLOP_AT + 0.02 && t < 2.15) show("eye", KIND.eyeHappy, 1);
    },
    cues: [
      { t: 0.04, cue: "flap", index: 0 },
      ...HOP_AT.map((t0, index) => ({ t: t0, cue: "hop", index, hop: 0.38 })),
      { t: PLOP_AT, cue: "plop", index: 0, plop: 0.34 },
    ],
  },
  // 짹짹짹: three chirps — the beak opens with a little head bob — with
  // smiling eyes the whole time.
  chirp: {
    duration: 1.6, regions: { head: 1, tail: 0.5 },
    drive(t, set) {
      let b = 0;
      for (const t0 of CHIRP_AT) b += stroke(t, t0 - 0.02, 0.08, 0.18);
      const on = env(t, 0.04, 0.08, 1.4, 0.15);
      set("head", 0, 2.5 * b, 1.5 * b, on);
      set("tail", 0, 1.8 * b, 0, on);
    },
    face(t, show) {
      if (t > 0.05 && t < 1.5) show("eye", KIND.eyeHappy, 1);
      for (const t0 of CHIRP_AT) if (t >= t0 && t < t0 + 0.18) show("beak", KIND.beakOpen, 1);
    },
    cues: CHIRP_AT.map((t0, index) => ({ t: t0, cue: "chirp", index })),
  },
});

const types = new Map();
function makeType(id = "flower") {
  if (types.has(id)) return types.get(id);
  const t = buildType(id);
  types.set(id, t);
  return t;
}
function buildType(id) {
  const cage = makeShapeCage(id);
  const stencils = makeSurfaceStencils(cage);
  const locator = makeTetLocator(cage, 0.004);
  const edgeSet = new Set(), edges = [];
  for (const t of cage.tets) for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
    const a = Math.min(t[i], t[j]), b = Math.max(t[i], t[j]), k = a * 100000 + b;
    if (!edgeSet.has(k)) { edgeSet.add(k); edges.push(a, b); }
  }
  let cx = 0, cy = 0, cz = 0;
  const n = cage.pos.length / 3;
  for (let i = 0; i < n; i++) { cx += cage.pos[i * 3]; cy += cage.pos[i * 3 + 1]; cz += cage.pos[i * 3 + 2]; }
  const vertexTri = new Int32Array(stencils.vertexCount).fill(-1);
  for (let t = 0; t < stencils.indices.length / 3; t++) for (let k = 0; k < 3; k++) if (vertexTri[stencils.indices[t * 3 + k]] < 0) vertexTri[stencils.indices[t * 3 + k]] = t;
  // idle-motion regions: smooth per-node weights from the REST positions
  // (material points, so a region follows its part of the jelly however it moves)
  const motions = shapeMotions(id);
  let regions = null, seat = null;
  if (motions) {
    regions = {};
    const low = [];
    for (let i = 0; i < n; i++) if (cage.pos[i * 3 + 1] < 0.0101 + 0.0015) low.push(i);
    seat = Int32Array.from(low);
    for (const [name, parts] of Object.entries(motions.regions)) {
      // anchor: the jelly around the region (the same ellipsoids, larger),
      // where the drive's reaction goes — a muscle pulls between the two
      const around = parts.map((p) => ({ ...p, r: p.r.map((v) => v * 1.8), inner: 0.3 }));
      const ids = [], ws = [], aIds = [], as = [];
      for (let i = 0; i < n; i++) {
        // the seat's floor nodes are never pushed: shoved along the tray they
        // can fold flat and stay stuck that way (static friction)
        const x = cage.pos[i * 3], y = cage.pos[i * 3 + 1], z = cage.pos[i * 3 + 2], off = smooth01((y - 0.0101) / 0.01);
        const w0 = motionWeight(parts, x, y, z), w = w0 * off;
        if (w > 0.01) { ids.push(i); ws.push(w); }
        const a = (motionWeight(around, x, y, z) - w0) * off;
        if (a > 0.01) { aIds.push(i); as.push(a); }
      }
      regions[name] = { ids: Int32Array.from(ids), w: Float64Array.from(ws), anchor: Int32Array.from(aIds), a: Float64Array.from(as) };
    }
  }
  return { id, cage, stencils, locator, vertexTri, edges: Int32Array.from(edges), centroid: [cx / n, cy / n, cz / n], look: shapeLook(id), motions, regions, seat };
}

export class JellyWorld {
  constructor({ wallRadius = 0.075, base = "berry", gemCapacity = 24, texture = "jelly", shape = "flower" } = {}) {
    this.texture = texture === "slime" ? "slime" : "jelly";
    this.shape = SHAPES.some((x) => x.id === shape) ? shape : "flower";
    this.wallRadius = wallRadius;
    this.type = makeType(this.shape);
    this.gemCapacity = gemCapacity;
    this.params = { shear: 600, damping: 3, friction: 1 };
    this.gravityVector = null; this.frictionOverride = null;
    this.step = 1 / 240; this.accumulator = 0;
    this.events = [];
    this.nextGemId = 1;
    this.grabs = new Map();
    this.motionsEnabled = true;     // idle motions of the animal shapes (main turns them off while the bunny visits)
    this.reset(base);
  }

  // A new jelly. plain: the base colour even on a shaped jelly (no signature
  // dye); its decorations, glitter, pearls and sheen stay. Emits "reset" with
  // the rare gems that were still in the old jelly (main refunds them unless
  // the jelly was just eaten).
  reset(base = this.base || "berry", lift = 0, plain = false) {
    const t = this.type;
    const rare = (this.gems || []).filter((g) => g.rare).map((g) => ({ index: g.shape, tier: g.tier }));
    this.motion = null; this.motionClock = 0; this.motionHome = null;
    this.plain = Boolean(plain);
    const body = new SoftBody({ cage: t.cage, stencils: t.stencils, params: this.bodyParams() });
    body.wallRadius = this.wallRadius;
    body.gravityVector = this.gravityVector;
    body.frictionOverride = this.frictionOverride;
    this.body = body;
    this.plasticClock = 0; this.lastTouch = this.time || 0;
    this.applyTexture();
    this.dye = new Float64Array(body.nodeCount * 3);
    this.shellDye = new Float32Array(t.stencils.vertexCount * 3);
    this.fx = new Float64Array(body.nodeCount * 2);          // per node: pearl, glow (0..~1)
    this.shellFx = new Float32Array(t.stencils.vertexCount * 2);
    this.additives = { glitter: [], stars: [] };
    this.additiveVersion = (this.additiveVersion || 0) + 1;
    this.eatenBeads = null;
    this.pearls = null; this.eatenPearls = null;
    this.decor = [];
    this.decorVersion = (this.decorVersion || 0) + 1;
    this.meanDye = [0, 0, 0];
    this.meanFx = [0, 0];
    this.gems = [];
    this.grabs = new Map(); this.grabbing = false;
    this.falling = [];
    this.accumulator = 0;
    this.setBase(base);
    this.applyLook();
    if (lift) body.reset(lift);
    this.restCenter = massCenter(body.rest, body.mass, body.totalMass);
    this.events.push({ type: "reset", rare });
  }

  setBase(base) {
    // a σ triple (a shape's signature colour from an order) or a BASES id
    const sigma = Array.isArray(base) ? base : BASES[base] || BASES.berry;
    this.base = Array.isArray(base) ? this.base || "berry" : BASES[base] ? base : "berry";
    for (let i = 0; i < this.body.nodeCount; i++) this.dye.set(sigma, i * 3);
    this.lookDye = null;
    this.fx?.fill(0);
    this.dyeVersion = (this.dyeVersion || 0) + 1;
    this.dyeActive = false;
    this.updateMeanDye();
  }

  bodyParams() {
    const slime = this.texture === "slime";
    const shear = this.params.shear * (slime ? SLIME.shear : 1);
    const damping = slime ? Math.max(this.params.damping, SLIME.damping) : this.params.damping;
    const friction = this.params.friction * (slime ? SLIME.friction : 1);
    return { shear, damping, staticFriction: 0.65 * friction, dynamicFriction: 0.42 * friction };
  }

  // ---------------------------------------------------------------- shape
  // A new shape = a new jelly (paint, gems and additives start over).
  setShape(id, base = this.base, plain = false) {
    if (!SHAPES.some((x) => x.id === id)) return;
    this.shape = id;
    this.type = makeType(id);
    this.beads = null;
    this.reset(base, 0, plain);
    this.events.push({ type: "shape", shape: id });
  }

  // The shape's signature look: colour field, pearl/glow, glitter, pearls and
  // decorations (eyes, nose, cherry…), all as material points of this cage.
  applyLook() {
    const look = this.type.look, pos = this.type.cage.pos, n = this.body.nodeCount;
    if (!look) return;
    if (look.dye && !this.plain) {
      for (let i = 0; i < n; i++) {
        const d = look.dye(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
        for (let c = 0; c < 3; c++) this.dye[i * 3 + c] = Math.max(0, Math.min(SIGMA_MAX, Number(d[c]) || 0));
      }
      // the signature pattern (cake layers, the bird's cap and wings) stays
      // put: only paint dropped on top of it diffuses (see diffuseDye)
      this.lookDye = this.dye.slice();
      this.dyeVersion++;
      this.updateMeanDye();
    }
    if (look.fx) {
      for (let i = 0; i < n; i++) {
        const f = look.fx(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
        this.fx[i * 2] = Math.max(0, Math.min(4, Number(f[0]) || 0));
        this.fx[i * 2 + 1] = Math.max(0, Math.min(4, Number(f[1]) || 0));
      }
      this.dyeVersion++;
      this.updateMeanDye();
    }
    if (look.glitter > 0) this.fillAdditive("glitter", Math.min(GLITTER_MAX, look.glitter));
    if (look.pearls > 0) this.pearls = this.makePoints(look.pearls, 0.0016, () => 5);   // 5 = pearl (render/beads.js PEARL_COLOR)
    this.decor = [];
    const L = this.type.locator;
    for (const d of look.decor || []) {
      const kind = DECOR_KINDS.indexOf(d.kind);
      if (kind < 0) continue;
      const inset = DECOR_INSET;
      let e = -1, u = null;
      for (let k = 0; k < 8 && e < 0; k++) {
        const depth = inset + k * 0.0006;
        u = [d.u[0] - d.n[0] * depth, d.u[1] - d.n[1] * depth, d.u[2] - d.n[2] * depth];
        e = L.locate(u[0], u[1], u[2]);
      }
      if (e < 0) continue;
      // rest frame: local +Z = outward normal, +Y = up (orthogonalised)
      const z = norm3(d.n), upDot = dot3(d.up, z);
      const y = norm3([d.up[0] - z[0] * upDot, d.up[1] - z[1] * upDot, d.up[2] - z[2] * upDot]);
      const x = cross3(y, z);
      const q0 = quatFromBasis(x, y, z, [0, 0, 0, 1]);
      const rgb = d.color ? hexToRgb(d.color) : [-1, -1, -1];
      // name: the designed kind; show / mul: an expression swapped in by a motion (−1 = none) and its scale
      this.decor.push({ kind, name: d.kind, show: -1, mul: 1, tet: e, bary: L.bary.slice(), q0, scale: d.scale || 0.003, rgb, quat: q0.slice() });
    }
  }

  // Uniformly spread material points (pearls) through the body.
  makePoints(count, radius, colorOf) {
    const L = this.type.locator, bnd = L.bounds;
    const tets = new Int32Array(count), bary = new Float64Array(count * 4), color = new Uint8Array(count);
    let n = 0, seed = 12345;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let tries = 0; n < count && tries < count * 60; tries++) {
      const u = [bnd[0] + rnd() * (bnd[3] - bnd[0]), bnd[1] + rnd() * (bnd[4] - bnd[1]), bnd[2] + rnd() * (bnd[5] - bnd[2])];
      if (!this.gemFits(u, radius)) continue;
      const e = L.locate(u[0], u[1], u[2]);
      tets[n] = e; bary.set(L.bary, n * 4); color[n] = colorOf(n); n++;
    }
    return { count: n, tets, bary, color };
  }

  // Glitter spread through the whole body (shape looks).
  fillAdditive(kind, count) {
    const list = this.additives[kind], L = this.type.locator, bnd = L.bounds;
    let seed = 777;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let tries = 0; list.length < count && tries < count * 40; tries++) {
      const u = [bnd[0] + rnd() * (bnd[3] - bnd[0]), bnd[1] + rnd() * (bnd[4] - bnd[1]), bnd[2] + rnd() * (bnd[5] - bnd[2])];
      if (!this.gemFits(u, 0.0008)) continue;
      const e = L.locate(u[0], u[1], u[2]);
      if (e < 0) continue;
      list.push({ tet: e, bary: L.bary.slice(), variant: Math.floor(rnd() * 4), spin: rnd() });
    }
    this.additiveVersion++;
  }

  // 12 floats per decoration: kind, x, y, z, qx, qy, qz, qw, scale, r, g, b (r < 0 = kind default).
  decorCount() { return this.decor.length; }
  decorStates(out) {
    const body = this.body, p = [0, 0, 0], bary = [0, 0, 0, 0], q = this.scratchDecorQ ||= [0, 0, 0, 1];
    for (let i = 0; i < this.decor.length; i++) {
      const d = this.decor[i], o = i * 12;
      bary[0] = d.bary[0]; bary[1] = d.bary[1]; bary[2] = d.bary[2]; bary[3] = d.bary[3];
      body.pointInTet(d.tet, bary, p);
      tetRotation(body, d.tet, q);
      slerpInto(d.quat, quatMultiply(q, d.q0, this.scratchDecorQ2 ||= [0, 0, 0, 1]), 0.5);
      out[o] = d.show >= 0 ? d.show : d.kind; out[o + 1] = p[0]; out[o + 2] = p[1]; out[o + 3] = p[2];
      out[o + 4] = d.quat[0]; out[o + 5] = d.quat[1]; out[o + 6] = d.quat[2]; out[o + 7] = d.quat[3];
      out[o + 8] = d.scale * d.mul; out[o + 9] = d.rgb[0]; out[o + 10] = d.rgb[1]; out[o + 11] = d.rgb[2];
    }
    return out;
  }

  // ---------------------------------------------------------------- texture
  setTexture(texture) {
    this.texture = texture === "slime" ? "slime" : "jelly";
    this.applyTexture();
    this.body.wake();
    this.events.push({ type: "texture", texture: this.texture });
  }

  applyTexture() {
    const body = this.body;
    Object.assign(body.params, this.bodyParams());
    if (this.texture === "slime") {
      body.setPlastic(SLIME.flow, SLIME.recover, SLIME.yieldStrain);
      if (!this.beads) this.makeBeads();
    } else if (body.plastic) {
      // back to jelly: un-squash quickly (≈ 1 s) instead of snapping
      body.setPlastic(0, 3);
    }
  }

  // Foam beads: fixed material points spread through the slime.
  makeBeads(count = SLIME.beads) {
    const L = this.type.locator, bnd = L.bounds, r = SLIME.beadRadius;
    const tets = new Int32Array(count), bary = new Float64Array(count * 4);
    let n = 0;
    for (let tries = 0; n < count && tries < count * 40; tries++) {
      const u = [bnd[0] + Math.random() * (bnd[3] - bnd[0]), bnd[1] + Math.random() * (bnd[4] - bnd[1]), bnd[2] + Math.random() * (bnd[5] - bnd[2])];
      if (!this.gemFits(u, r)) continue;
      const e = L.locate(u[0], u[1], u[2]);
      tets[n] = e; bary.set(L.bary, n * 4); n++;
    }
    this.beads = { count: n, tets, bary, color: Uint8Array.from({ length: n }, () => Math.floor(Math.random() * 5)) };
  }

  // 4 floats per bead: x, y, z, colour index. Empty unless slime.
  beadCount() {
    return (this.texture === "slime" && this.beads ? this.beads.count : 0) + (this.pearls ? this.pearls.count : 0);
  }
  beadStates(out) {
    const body = this.body, p = [0, 0, 0], bary = [0, 0, 0, 0];
    let n = 0;
    const lists = [];
    if (this.texture === "slime" && this.beads) lists.push([this.beads, this.eatenBeads]);
    if (this.pearls) lists.push([this.pearls, this.eatenPearls]);
    for (const [b, gone] of lists) for (let i = 0; i < b.count; i++) {
      if (gone && gone[i]) continue;
      bary[0] = b.bary[i * 4]; bary[1] = b.bary[i * 4 + 1]; bary[2] = b.bary[i * 4 + 2]; bary[3] = b.bary[i * 4 + 3];
      body.pointInTet(b.tets[i], bary, p);
      out[n * 4] = p[0]; out[n * 4 + 1] = p[1]; out[n * 4 + 2] = p[2]; out[n * 4 + 3] = b.color[i];
      n++;
    }
    return n * 4 < out.length ? out.subarray(0, n * 4) : out;
  }

  // ---------------------------------------------------------------- input
  handle(event) {
    const body = this.body;
    switch (event.type) {
      case "grabStart": {
        const w = body.grabWeights(event.a, event.b, event.c, event.bary[0], event.bary[1], event.bary[2]);
        if (!w) return;
        const id = event.id ?? 0;
        if (!this.grabs.has(id) && this.grabs.size >= 3) return;
        body.wake();
        this.motionHome = null;     // moved on purpose: the idle motions take the new place as home
        const grab = { ...w, target: event.point.slice(), point: event.point.slice(), lambda: new Float64Array(3), raw: event.point.slice(), id };
        this.grabs.set(id, grab);
        this.syncGrabs();
        break;
      }
      case "grabEnd": {
        const ids = event.id === undefined ? [...this.grabs.keys()] : [event.id];
        for (const id of ids) {
          const g = this.grabs.get(id);
          if (!g) continue;
          this.events.push({ type: "release", stretch: Math.hypot(g.point[0] - g.target[0], g.point[1] - g.target[1], g.point[2] - g.target[2]) });
          this.grabs.delete(id);
        }
        this.syncGrabs();
        // Flick: a fast upward release launches the jelly.
        if (event.flick && event.flick > 0.25 && !this.grabs.size) this.bounce(Math.min(1.6, event.flick * 0.9));
        break;
      }
      case "target": {
        const g = this.grabs.get(event.id ?? 0);
        if (g) { g.raw[0] = event.point[0]; g.raw[1] = event.point[1]; g.raw[2] = event.point[2]; clampGrabTarget(g.raw, this.wallRadius); }
        break;
      }
      case "bounce": this.bounce(event.strength); break;
      case "texture": this.setTexture(event.texture); break;
      case "shape": this.setShape(event.shape, event.base, event.plain); break;
      case "nudge": body.nudge(); break;
      case "reset": this.reset(event.base, event.lift || 0, event.plain); break;
      case "motions": this.setMotions(event.enabled); break;
      case "motionNow": this.startMotion(event.name); break;
      case "kick": this.kickAway(event); break;
      case "grabNear": this.grabNear(event); break;
      case "carry":
        // the bunny holds the jelly as a whole (target = centre of mass), null = put down
        if (event.target) { this.body.carry = { target: event.target.slice() }; this.body.wake(); this.lastTouch = this.time || 0; this.motionHome = null; }
        else this.body.carry = null;
        break;
      case "bite": this.bite(event); break;
      case "additive": this.addAdditive(event); break;
      case "base": this.setBase(event.base); break;
      case "gravity":
        this.gravityVector = event.vector; this.frictionOverride = event.friction; this.motionHome = null;
        body.gravityVector = event.vector; body.frictionOverride = event.friction; body.wake();
        break;
      case "params":
        Object.assign(this.params, event.params);
        Object.assign(body.params, this.bodyParams());
        body.wake();
        break;
      case "rate": this.step = 1 / event.hz; this.accumulator = 0; break;
      case "drop": this.drop(event); break;
      case "gemAdd": this.addGemAtSurface(event); break;
      case "gemScatter": this.scatterGems(event); break;
    }
  }

  // Fingers / paws first, then an idle motion's drives (not a touch: grabbing stays false).
  syncGrabs() {
    const list = [...this.grabs.values()];
    this.body.grab = list[0] || null;
    this.body.extraGrabs = this.motion ? list.slice(1).concat(this.motion.active) : list.slice(1);
    this.grabbing = list.length > 0;
  }

  // 통통: launch upward (m/s at the base). Ignored while held by a finger.
  // Mid-air presses are queued and fire on the next touchdown, so tapping
  // repeatedly keeps it bouncing in rhythm instead of rocketing off.
  bounce(strength = 1) {
    if (this.grabbing) return;
    if (!this.body.sleeping && !this.body.grounded) { this.bounceQueued = Math.max(this.bounceQueued || 0, strength); return; }
    this.bounceQueued = 0;
    const v = 0.55 + 0.45 * Math.max(0, Math.min(2, strength));
    this.body.bounce(v, (Math.random() - 0.5) * 0.05, (Math.random() - 0.5) * 0.05);
    this.motionHome = null;
    this.events.push({ type: "bounced", strength });
  }

  // ---------------------------------------------------------------- idle motions
  // A random move of the shape every `interval` s of sim time (start to
  // start), also while held; never while disabled (the timer waits at 0).
  setMotions(enabled) {
    this.motionsEnabled = Boolean(enabled);
    if (!this.motionsEnabled) { this.stopMotion(); this.motionClock = 0; }
  }

  // Sim seconds until the next idle motion starts (null: none pending).
  motionIn() {
    const spec = this.type.motions;
    if (!spec || !this.motionsEnabled || this.motion) return null;
    return Math.max(0, spec.interval - this.motionClock);
  }

  // Time passing while nobody steps the world (the app stops ticking a
  // sleeping jelly; the worker wakes itself when a motion is due): only the
  // motion timer runs.
  idle(seconds) {
    const spec = this.type.motions;
    if (!spec || !this.motionsEnabled || this.motion || !(seconds > 0)) return;
    this.motionClock += seconds;
    if (this.motionClock >= spec.interval - 1e-9) this.startMotion(spec.moves[Math.floor(Math.random() * spec.moves.length)]);
  }

  motionStep(h) {
    const spec = this.type.motions;
    if (!this.motion) {
      if (!this.motionsEnabled) { this.motionClock = 0; return; }
      this.motionClock += h;
      if (this.motionClock < spec.interval - 1e-9) return;
      if (!this.startMotion(spec.moves[Math.floor(Math.random() * spec.moves.length)])) return;
    } else this.motionClock += h;
    this.driveMotion(h);
  }

  // Start a move now (the timer restarts from here). false: not one of this shape's moves.
  startMotion(name) {
    const spec = this.type.motions, move = MOVES[name];
    if (!spec || !move || !spec.moves.includes(name)) return false;
    this.stopMotion();
    this.motionClock = 0;
    const body = this.body, x = body.x;
    body.wake();
    const R = bestRotation(body, this.restCenter), c = massCenter(x, body.mass, body.totalMass);
    const m = { name, move, t: 0, cue: 0, R, regions: [], grabs: [], active: [], gain: this.texture === "slime" ? MOTION.slime : 1 };
    for (const [region, force] of Object.entries(move.regions)) {
      const reg = this.type.regions[region];
      if (!reg || !reg.ids.length) continue;
      // the region's drive: a soft, force-limited constraint on its centre
      // (a finger grab, solved inside the XPBD iterations, so it is stable
      // however stiff); weights ∝ region weight × node mass, so it shifts
      // every node by its region weight (light rim nodes are not flung about)
      const mass = body.mass, wm = Float64Array.from(reg.ids, (id, k) => reg.w[k] * mass[id]), W = wm.reduce((a, b) => a + b, 0);
      for (let k = 0; k < wm.length; k++) wm[k] /= W;
      const g = { ids: reg.ids, weights: wm, target: [0, 0, 0], point: [0, 0, 0], lambda: new Float64Array(3), raw: null, stiffness: MOTION.stiffness * m.gain, maxForce: force };
      const p = weightedPoint(g, x), rel = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
      // where the region sits now, in the jelly's frame (its own sag and any
      // squish stay; the script moves it from there and back)
      const q0 = [R[0] * rel[0] + R[3] * rel[1] + R[6] * rel[2], R[1] * rel[0] + R[4] * rel[1] + R[7] * rel[2], R[2] * rel[0] + R[5] * rel[1] + R[8] * rel[2]];
      g.target = p.slice(); g.point = p.slice();
      let am = 0;
      for (let i = 0; i < reg.anchor.length; i++) am += reg.a[i] * mass[reg.anchor[i]];
      m.regions.push({ name: region, reg, g, q0, off: new Float64Array(3), on: 0, am });
      m.grabs.push(g);
    }
    m.set = (region, side, up, face, on = 1) => { for (const r of m.regions) if (r.name === region) { r.off[0] = side; r.off[1] = up; r.off[2] = face; r.on = on; } };
    // home: where the jelly sits (kept while it only creeps; re-taken after
    // it was moved — touched, kicked, carried, tilted — or a new jelly)
    const seat = this.seatCenter(), home = this.motionHome;
    if (!home || Math.hypot(seat[0] - home[0], seat[1] - home[1]) > MOTION.homeRange) this.motionHome = seat;
    this.motion = m;
    this.syncGrabs();
    this.events.push({ type: "motion", shape: this.shape, name, duration: move.duration });
    return true;
  }

  stopMotion() {
    const m = this.motion;
    if (!m) return;
    this.motion = null;
    if (m.slip) this.body.frictionOverride = this.frictionOverride;
    this.cancelReaction(m);
    this.syncGrabs();
    this.setFace(null, 0);
  }

  // The drives' impulse in the last step (λ / h per constraint, Σ weights =
  // 1) goes back into the jelly around each region (its anchor, ∝ anchor
  // weight × mass): like a muscle, no net force — the jelly acts in place,
  // and the rest of it (a tail, the seat's rim) feels no extra weight.
  cancelReaction(m) {
    const v = this.body.velocity, h = this.step;
    for (const r of m.regions) {
      const L = r.g.lambda;
      if (L[0] !== 0 || L[1] !== 0 || L[2] !== 0) {
        const ids = r.reg.anchor, a = r.reg.a, k = 1 / (h * r.am);
        const jx = L[0] * k, jy = L[1] * k, jz = L[2] * k;
        for (let i = 0; i < ids.length; i++) { const j = ids[i] * 3, f = a[i]; v[j] -= jx * f; v[j + 1] -= jy * f; v[j + 2] -= jz * f; }
      }
      L.fill(0);
    }
  }

  driveMotion(h) {
    const m = this.motion, move = m.move, body = this.body, t = m.t;
    body.wake();
    this.cancelReaction(m);
    if (!this.grabbing) this.recenter(h);
    while (m.cue < move.cues.length && move.cues[m.cue].t <= t) this.motionCue(move.cues[m.cue++]);
    this.setFace(move.face, t);
    if (m.regions.length) {
      const R = m.R, ax = this.type.motions.axes, s = 0.001 * m.gain, c = massCenter(body.x, body.mass, body.totalMass);
      for (const r of m.regions) { r.off.fill(0); r.on = 0; }
      // the script at the end of this step
      move.drive(t + h, m.set);
      m.active.length = 0;
      for (const r of m.regions) {
        if (!(r.on > 0.01)) continue;
        r.g.stiffness = MOTION.stiffness * m.gain * Math.min(1, r.on);
        m.active.push(r.g);
        const d = r.off, q = r.q0;
        // model axes (mm) → rest frame (m), on top of the start offset → the jelly's orientation
        const a = q[0] + (ax.side[0] * d[0] + ax.up[0] * d[1] + ax.face[0] * d[2]) * s;
        const b = q[1] + (ax.side[1] * d[0] + ax.up[1] * d[1] + ax.face[1] * d[2]) * s;
        const e = q[2] + (ax.side[2] * d[0] + ax.up[2] * d[1] + ax.face[2] * d[2]) * s;
        const T = r.g.target;
        T[0] = c[0] + R[0] * a + R[1] * b + R[2] * e;
        T[1] = c[1] + R[3] * a + R[4] * b + R[5] * e;
        T[2] = c[2] + R[6] * a + R[7] * b + R[8] * e;
      }
      this.syncGrabs();
    }
    // the last moment of a move: the seat slips freely for a little while, so
    // floor nodes the move dragged into a folded (inverted) tet can spring
    // back instead of staying stuck by static friction
    if (!m.slip && this.texture === "jelly" && m.t >= move.duration - MOTION.slip) { m.slip = true; body.frictionOverride = SLIPPERY; }
    m.t += h;
    if (m.t >= move.duration) this.stopMotion();
  }

  // Horizontal centre of the seat (the nodes resting on the tray), [x, z].
  seatCenter() {
    const ids = this.type.seat, x = this.body.x, mass = this.body.mass, out = [0, 0];
    let M = 0;
    for (let k = 0; k < ids.length; k++) { const i = ids[k], w = mass[i]; out[0] += x[i * 3] * w; out[1] += x[i * 3 + 2] * w; M += w; }
    out[0] /= M || 1; out[1] /= M || 1;
    return out;
  }

  // The drives cannot move the mass centre (no net force), but rocking and
  // hopping on the tray's friction let a jelly creep a few tenths of a mm per
  // move — over an idle hour it would wander into the rim. While it acts,
  // it is slid back toward its home rigidly and imperceptibly (≤ 2 mm/s,
  // a translation of the whole jelly outside the solver, so friction does
  // not see it). Not while a finger holds it.
  recenter(h) {
    const home = this.motionHome;
    if (!home) return;
    const s = this.seatCenter(), dx = home[0] - s[0], dz = home[1] - s[1], d = Math.hypot(dx, dz);
    if (d < 1e-6) return;
    const k = Math.min(d, MOTION.recenter * h) / d, x = this.body.x;
    for (let i = 0; i < this.body.nodeCount; i++) { x[i * 3] += dx * k; x[i * 3 + 2] += dz * k; }
  }

  motionCue(cue) {
    const body = this.body;
    this.events.push({ type: "motionCue", name: this.motion.name, cue: cue.cue, index: cue.index });
    if (!cue.hop && !cue.plop) return;
    // the height gradient squashes / stretches it like a real hop or plop
    const b = body.bounds, span = Math.max(1e-4, b[4] - b[1]), x = body.x, v = body.velocity, g = this.texture === "slime" ? MOTION.slimeHop : 1;
    if (cue.hop && body.grounded) for (let i = 0; i < body.nodeCount; i++) v[i * 3 + 1] += cue.hop * g * (1.1 - 0.2 * (x[i * 3 + 1] - b[1]) / span);
    if (cue.plop) for (let i = 0; i < body.nodeCount; i++) v[i * 3 + 1] -= cue.plop * g * Math.max(0, (x[i * 3 + 1] - b[1]) / span);
  }

  // Expressions: show(decorName, kind, scale×) for the swaps at time t; every
  // other decoration back to its own kind. A change bumps decorVersion.
  setFace(face, t) {
    const list = this.decor;
    for (const d of list) { d.nextShow = -1; d.nextMul = 1; }
    if (face) face(t, (name, kind, mul) => { for (const d of list) if (d.name === name) { d.nextShow = kind; d.nextMul = mul; } });
    let changed = false;
    for (const d of list) if (d.show !== d.nextShow || d.mul !== d.nextMul) { d.show = d.nextShow; d.mul = d.nextMul; changed = true; }
    if (changed) this.decorVersion++;
  }

  // ---------------------------------------------------------------- kick
  // The bunny's hind-foot kick (★1): the jelly shoots off along `dir` (tray
  // x, z), pops up a little and tumbles forward, bounces and slides across
  // the tray into the rim (wallRadius) and stays there.
  kickAway({ dir = [0, 1], strength = 0.8 } = {}) {
    const body = this.body, x = body.x, v = body.velocity, n = body.nodeCount;
    let dx = Number(dir[0]) || 0, dz = Number(dir[1]) || 0;
    const l = Math.hypot(dx, dz);
    if (l > 1e-9) { dx /= l; dz /= l; } else { dx = 0; dz = 1; }
    const s = Math.max(0, Math.min(1.5, Number(strength) || 0));
    const along = 0.3 + 0.55 * s, pop = 0.3 + 0.35 * s, spin = 4 + 4.5 * s;
    // forward tumble: ω = up × dir (the top runs ahead of the bottom)
    const wx = spin * dz, wz = -spin * dx;
    const c = massCenter(x, body.mass, body.totalMass);
    body.carry = null;
    body.wake();
    this.motionHome = null;
    for (let i = 0; i < n; i++) {
      const j = i * 3, rx = x[j] - c[0], ry = x[j + 1] - c[1], rz = x[j + 2] - c[2];
      v[j] += along * dx - wz * ry; v[j + 1] += pop + wz * rx - wx * rz; v[j + 2] += along * dz + wx * ry;
    }
    this.events.push({ type: "kicked", dir: [dx, dz], strength: s });
  }

  // ---------------------------------------------------------------- bunny
  // Grab the surface point nearest to `point` (the bunny's paws).
  grabNear({ id, point, radius = 0.016, maxForce = 10 }) {
    // a whole patch of surface (a paw is not a fingertip): every surface
    // vertex within `radius` of the nearest one, stencil weights combined
    const P = this.body.positions, st = this.type.stencils;
    let best = -1, bd = Infinity;
    for (let v = 0; v < P.length / 3; v++) {
      const d = (P[v * 3] - point[0]) ** 2 + (P[v * 3 + 1] - point[1]) ** 2 + (P[v * 3 + 2] - point[2]) ** 2;
      if (d < bd) { bd = d; best = v; }
    }
    if (best < 0) return;
    const c = [P[best * 3], P[best * 3 + 1], P[best * 3 + 2]], map = new Map();
    let total = 0;
    for (let v = 0; v < P.length / 3; v++) {
      const d = Math.hypot(P[v * 3] - c[0], P[v * 3 + 1] - c[1], P[v * 3 + 2] - c[2]);
      if (d > radius) continue;
      const wv = 1 - d / radius;
      for (let k = st.offsets[v]; k < st.offsets[v + 1]; k++) map.set(st.ids[k], (map.get(st.ids[k]) || 0) + st.weights[k] * wv);
      total += wv;
    }
    const list = [...map].filter(([, w]) => w > 1e-8), sum = list.reduce((t, [, w]) => t + w, 0);
    if (!(sum > 0)) return;
    const ids = Int32Array.from(list.map((e) => e[0])), weights = Float64Array.from(list.map((e) => e[1] / sum));
    // the constraint acts on the patch's weighted centre
    const x = this.body.x, pt = [0, 0, 0];
    for (let k = 0; k < ids.length; k++) { pt[0] += x[ids[k] * 3] * weights[k]; pt[1] += x[ids[k] * 3 + 1] * weights[k]; pt[2] += x[ids[k] * 3 + 2] * weights[k]; }
    if (!this.grabs.has(id) && this.grabs.size >= 4) return;
    this.body.wake();
    this.motionHome = null;
    this.grabs.set(id, { ids, weights, target: pt.slice(), point: pt.slice(), lambda: new Float64Array(3), raw: pt.slice(), id, maxForce, stiffness: 320 });
    this.syncGrabs();
  }

  // A bite at tray-space `center`: the jelly caves in there, and gems,
  // glitter, star candies and foam beads inside the bite are eaten.
  bite({ center, radius = BITE.radius, factor = BITE.factor, scale = BITE.scale }) {
    // the whole jelly gets smaller (a bite's worth is gone) and the bitten
    // side caves in a little more (gently enough that the tets there do not
    // turn inside out, even bite after bite in one place)
    this.body.scaleRest(scale);
    this.body.shrinkRegion(center, radius, factor, BITE.minScale);
    const r2 = (radius * 0.95) ** 2, inside = (p) => (p[0] - center[0]) ** 2 + (p[1] - center[1]) ** 2 + (p[2] - center[2]) ** 2 < r2;
    const eaten = [];
    this.gems = this.gems.filter((g) => { if (g.fall || !inside(g.wpos)) return true; eaten.push({ shape: g.shape, rare: g.rare, tier: g.tier }); return false; });
    const p = [0, 0, 0], bary = [0, 0, 0, 0];
    const at = (list, i) => { bary[0] = list.bary[i * 4]; bary[1] = list.bary[i * 4 + 1]; bary[2] = list.bary[i * 4 + 2]; bary[3] = list.bary[i * 4 + 3]; return this.body.pointInTet(list.tets[i], bary, p); };
    for (const kind of ["glitter", "stars"]) this.additives[kind] = this.additives[kind].filter((a) => { bary[0] = a.bary[0]; bary[1] = a.bary[1]; bary[2] = a.bary[2]; bary[3] = a.bary[3]; return !inside(this.body.pointInTet(a.tet, bary, p)); });
    this.additiveVersion++;
    if (this.beads) {
      const gone = this.eatenBeads ||= new Uint8Array(this.beads.count);
      for (let i = 0; i < this.beads.count; i++) if (!gone[i] && inside(at(this.beads, i))) gone[i] = 1;
    }
    if (this.pearls) {
      const gone = this.eatenPearls ||= new Uint8Array(this.pearls.count);
      for (let i = 0; i < this.pearls.count; i++) if (!gone[i] && inside(at(this.pearls, i))) gone[i] = 1;
    }
    this.decor = this.decor.filter((d) => { bary[0] = d.bary[0]; bary[1] = d.bary[1]; bary[2] = d.bary[2]; bary[3] = d.bary[3]; return !inside(this.body.pointInTet(d.tet, bary, p)); });
    this.events.push({ type: "bitten", center: center.slice(), eaten });
  }

  // ---------------------------------------------------------------- additives
  // Glitter flakes spread through the jelly around a drop; star candies sit
  // just under the surface. Both are material points (follow the jelly).
  addAdditive({ kind, point }) {
    const list = this.additives[kind];
    if (!list) return;
    const max = kind === "glitter" ? GLITTER_MAX : STARS_MAX, add = kind === "glitter" ? 90 : 9;
    if (list.length >= max) { this.events.push({ type: "additiveFull", kind }); return; }
    // material-space centre: the rest position of the cage node nearest the drop
    const x = this.body.x, rest = this.type.cage.pos, L = this.type.locator;
    let best = 0, bd = Infinity;
    for (let i = 0; i < this.body.nodeCount; i++) {
      const d = (x[i * 3] - point[0]) ** 2 + (x[i * 3 + 1] - point[1]) ** 2 + (x[i * 3 + 2] - point[2]) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    const u0 = [rest[best * 3], rest[best * 3 + 1], rest[best * 3 + 2]];
    const spread = kind === "glitter" ? 0.02 : 0.016;
    let added = 0;
    for (let tries = 0; added < add && list.length < max && tries < add * 30; tries++) {
      const r = spread * Math.cbrt(Math.random()), th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
      const u = [u0[0] + r * Math.sin(ph) * Math.cos(th), u0[1] + r * Math.cos(ph), u0[2] + r * Math.sin(ph) * Math.sin(th)];
      if (kind === "glitter" ? !this.gemFits(u, 0.0008) : (!this.gemFits(u, 0.0014) || this.gemFits(u, 0.0042))) continue;
      const e = L.locate(u[0], u[1], u[2]);
      if (e < 0) continue;
      list.push({ tet: e, bary: L.bary.slice(), variant: Math.floor(Math.random() * (kind === "glitter" ? 4 : 5)), spin: Math.random() });
      added++;
    }
    this.additiveVersion++;
    this.body.wake();
    this.events.push({ type: "additive", kind, count: added, point: point.slice() });
  }

  // 5 floats per additive: x, y, z, kind (0 glitter, 1 star), variant + spin/10.
  additiveCount() { return this.additives.glitter.length + this.additives.stars.length; }
  additiveStates(out) {
    const p = [0, 0, 0], bary = [0, 0, 0, 0];
    let o = 0;
    for (const [kind, list] of [[0, this.additives.glitter], [1, this.additives.stars]]) for (const a of list) {
      bary[0] = a.bary[0]; bary[1] = a.bary[1]; bary[2] = a.bary[2]; bary[3] = a.bary[3];
      this.body.pointInTet(a.tet, bary, p);
      out[o] = p[0]; out[o + 1] = p[1]; out[o + 2] = p[2]; out[o + 3] = kind; out[o + 4] = a.variant + a.spin * 0.1;
      o += 5;
    }
    return out;
  }

  // ---------------------------------------------------------------- simulation
  advance(dt) {
    const wallDelta = Math.min(Math.max(Number(dt) || 0, 0), 0.05);
    this.accumulator += wallDelta;
    let steps = 0, stepped = false;
    const started = performance.now(), body = this.body;
    while (this.accumulator >= this.step && steps < 12) {
      for (const g of this.grabs.values()) easeGrabTarget(g.target, g.raw, this.step);
      if (this.type.motions) this.motionStep(this.step);
      const awake = !body.sleeping || this.grabbing;
      body.step(this.step);
      if (body.plastic && !body.sleeping) {
        this.plasticClock += this.step;
        if (this.plasticClock >= 1 / PLASTIC_HZ) {
          const strain = body.plasticStep(this.plasticClock);
          this.plasticClock = 0;
          if (this.texture === "jelly" && strain < 0.004) body.setPlastic(0, 0);
          else if (this.texture === "slime") {
            // hold the pulled shape for a moment, then slowly round back —
            // awake for at most SLIME.awake s after the last touch, so it can sleep
            const since = this.time - this.lastTouch;
            body.plastic.recover = since > SLIME.holdTime ? SLIME.recover : 0.01;
            if (since < SLIME.awake && strain > 0.03) body.quietTime = 0;
          }
        }
      }
      this.accumulator -= this.step;
      steps++;
      if (awake) stepped = true;
    }
    if (steps === 12) this.accumulator = Math.min(this.accumulator, this.step);
    const elapsed = performance.now() - started;
    if (stepped) {
      if (!body.isFinite()) { this.stopMotion(); body.reset(); this.grabs.clear(); this.grabbing = false; this.events.push({ type: "recovered" }); }
      body.updateSurface();
    }
    if (this.bounceQueued && body.grounded && !this.grabbing) this.bounce(this.bounceQueued);
    this.stepped = stepped;
    this.time = (this.time || 0) + steps * this.step;
    if (this.grabbing) this.lastTouch = this.time;
    if (steps > 0) this.tick(steps * this.step);
    return { steps, elapsed, stepped };
  }

  tick(dt) {
    this.energy = this.body.sleeping ? 0 : this.body.internalRms + this.body.rigidRms;
    this.diffuseDye(dt);
    this.updateGems(dt);
    this.knockGems();
  }

  // ---------------------------------------------------------------- paint
  // A drop lands at tray-space `point` (on the jelly surface).
  drop({ point, paint, amount = 1 }) {
    const p = PAINTS[paint];
    if (!p) return;
    const body = this.body, x = body.x, m = body.mass, n = body.nodeCount, d = this.dye;
    const s2 = 2 * DROP_RADIUS * DROP_RADIUS;
    const w = new Float64Array(n);
    let W = 0;
    for (let i = 0; i < n; i++) {
      const r2 = (x[i * 3] - point[0]) ** 2 + (x[i * 3 + 1] - point[1]) ** 2 + (x[i * 3 + 2] - point[2]) ** 2;
      const wi = Math.exp(-r2 / s2) * m[i];
      w[i] = wi; W += wi;
    }
    if (W <= 0) return;
    if (p.sigma) {
      // pigment mass added: (drop mass) × (concentrate absorption); split by w
      const dose = DROP_FRACTION * amount * body.totalMass * PAINT_STRENGTH;
      for (let i = 0; i < n; i++) {
        if (w[i] < 1e-12 * W) continue;
        const k = dose * w[i] / W / m[i];
        for (let c = 0; c < 3; c++) d[i * 3 + c] = Math.min(SIGMA_MAX, d[i * 3 + c] + p.sigma[c] * k);
        // pearl / glow paints: their effect amount travels with the pigment
        if (p.pearl) this.fx[i * 2] = Math.min(4, this.fx[i * 2] + p.pearl * k / PAINT_STRENGTH * 40);
        if (p.glow) this.fx[i * 2 + 1] = Math.min(4, this.fx[i * 2 + 1] + p.glow * k / PAINT_STRENGTH * 40);
      }
    } else {
      // water: dilute locally (removes pigment, the jelly gets lighter)
      const dose = WATER_STRENGTH * amount * body.totalMass;
      for (let i = 0; i < n; i++) {
        const f = Math.min(0.75, dose * w[i] / W / m[i]);
        for (let c = 0; c < 3; c++) d[i * 3 + c] *= 1 - f;
        if (this.lookDye) for (let c = 0; c < 3; c++) this.lookDye[i * 3 + c] *= 1 - f;
        this.fx[i * 2] *= 1 - f; this.fx[i * 2 + 1] *= 1 - f;
      }
    }
    // The drop's impact: a little downward kick around the landing point.
    const v = body.velocity, kick = 0.11 * amount;
    for (let i = 0; i < n; i++) {
      const f = w[i] / m[i] / (W / body.totalMass);
      if (f > 0.05) v[i * 3 + 1] -= kick * Math.min(1, f * 0.12);
    }
    body.wake();
    this.dyeVersion++;
    this.dyeActive = true;
    this.updateMeanDye();
    this.events.push({ type: "dropped", paint, point: point.slice() });
  }

  // Mass-weighted mean σ (meanDye) and mean [pearl, glow] (meanFx).
  updateMeanDye() {
    const m = this.body.mass, d = this.dye, f = this.fx, M = this.body.totalMass, out = this.meanDye, fx = this.meanFx;
    out[0] = out[1] = out[2] = 0; fx[0] = fx[1] = 0;
    for (let i = 0; i < this.body.nodeCount; i++) {
      const w = m[i] / M;
      out[0] += d[i * 3] * w; out[1] += d[i * 3 + 1] * w; out[2] += d[i * 3 + 2] * w;
      fx[0] += f[i * 2] * w; fx[1] += f[i * 2 + 1] * w;
    }
  }

  // Pigment-conserving diffusion over cage edges; stirring speeds it up.
  // With a signature pattern (lookDye) only the paint on top of it — the
  // difference — diffuses, so the pattern keeps its layers.
  diffuseDye(dt) {
    if (!this.dyeActive) return;
    const edges = this.type.edges, d = this.dye, m = this.body.mass, L = this.lookDye;
    const stir = Math.min(1, this.body.internalRms / 0.08);
    const alpha = Math.min(0.045, (0.18 + 2.2 * stir) * dt);
    let spread = 0;
    for (let k = 0; k < edges.length; k += 2) {
      const i = edges[k], j = edges[k + 1], mij = Math.min(m[i], m[j]) * alpha;
      for (let c = 0; c < 3; c++) {
        const diff = L ? d[j * 3 + c] - L[j * 3 + c] - (d[i * 3 + c] - L[i * 3 + c]) : d[j * 3 + c] - d[i * 3 + c];
        if (diff === 0) continue;
        const flux = diff * mij;
        d[i * 3 + c] += flux / m[i]; d[j * 3 + c] -= flux / m[j];
        if (Math.abs(diff) > spread) spread = Math.abs(diff);
      }
      for (let c = 0; c < 2; c++) {
        const diff = this.fx[j * 2 + c] - this.fx[i * 2 + c];
        if (diff === 0) continue;
        const flux = diff * mij;
        this.fx[i * 2 + c] += flux / m[i]; this.fx[j * 2 + c] -= flux / m[j];
      }
    }
    this.dyeVersion++;
    if (spread < 0.25) this.dyeActive = false;
  }

  // Shell-vertex σ (vec3 per shell vertex) for rendering.
  computeShellDye() {
    const { vertexCount, offsets, ids, weights } = this.type.stencils, d = this.dye, out = this.shellDye;
    for (let i = 0; i < vertexCount; i++) {
      let a = 0, b = 0, c = 0;
      for (let k = offsets[i]; k < offsets[i + 1]; k++) { const j = ids[k] * 3, w = weights[k]; a += d[j] * w; b += d[j + 1] * w; c += d[j + 2] * w; }
      out[i * 3] = a; out[i * 3 + 1] = b; out[i * 3 + 2] = c;
    }
    return out;
  }

  // Shell-vertex (pearl, glow) for rendering.
  computeShellFx() {
    const { vertexCount, offsets, ids, weights } = this.type.stencils, f = this.fx, out = this.shellFx;
    for (let i = 0; i < vertexCount; i++) {
      let a = 0, b = 0;
      for (let k = offsets[i]; k < offsets[i + 1]; k++) { const j = ids[k] * 2, w = weights[k]; a += f[j] * w; b += f[j + 1] * w; }
      out[i * 2] = a; out[i * 2 + 1] = b;
    }
    return out;
  }

  totalPigment() {
    const m = this.body.mass, d = this.dye, out = [0, 0, 0];
    for (let i = 0; i < this.body.nodeCount; i++) for (let c = 0; c < 3; c++) out[c] += m[i] * d[i * 3 + c];
    return out;
  }

  // ---------------------------------------------------------------- gems
  gemFits(u, radius) {
    const L = this.type.locator, rb = radius * 0.85;
    if (L.locate(u[0], u[1], u[2]) < 0) return false;
    return L.locate(u[0] + rb, u[1], u[2]) >= 0 && L.locate(u[0] - rb, u[1], u[2]) >= 0 &&
      L.locate(u[0], u[1] + rb, u[2]) >= 0 && L.locate(u[0], u[1] - rb, u[2]) >= 0 &&
      L.locate(u[0], u[1], u[2] + rb) >= 0 && L.locate(u[0], u[1], u[2] - rb) >= 0;
  }

  pullInside(u, radius) {
    const c = this.type.centroid;
    for (let k = 0; k <= 40; k++) {
      const t = k / 40, p = [u[0] + (c[0] - u[0]) * t, u[1] + (c[1] - u[1]) * t, u[2] + (c[2] - u[2]) * t];
      if (this.gemFits(p, radius) && !this.overlapsGem(p, radius)) return p;
    }
    return null;
  }

  overlapsGem(u, radius) {
    for (const g of this.gems) if (Math.hypot(g.u[0] - u[0], g.u[1] - u[1], g.u[2] - u[2]) < (g.radius + radius) * 0.9) return true;
    return false;
  }

  get rareCount() { let n = 0; for (const g of this.gems) if (g.rare) n++; return n; }

  makeGem(shape, color, radius, u, rare = null) {
    return { id: this.nextGemId++, shape, color, radius, u, rare: Boolean(rare), tier: rare ? rare.tier : 0, wpos: [0, 0, 0], prev: [0, 0, 0], vel: null, quat: [0, 0, 0, 1], qLocal: randomQuat(), glow: 0, rattle: 0, contacts: new Set(), fresh: true };
  }

  // Rare gems: "rareIn" {index, tier} when one is really placed; a rejected
  // rare request names it ({type: "gemFull" | "rareFull", rare: {index, tier}})
  // so main can give back what it deducted when the player dropped it.
  addGemAtSurface({ a, b, c, bary, shape, color, radius = 0.0034, rare = null }) {
    const reject = (type) => this.events.push(rare ? { type, rare: { index: rare.index, tier: rare.tier } } : { type });
    if (this.gems.length >= this.gemCapacity) { reject("gemFull"); return; }
    if (rare && this.rareCount >= RARE_CAPACITY) { reject("rareFull"); return; }
    const u = [0, 0, 0], st = this.type.stencils, pos = this.type.cage.pos;
    for (const [v, w] of [[a, bary[0]], [b, bary[1]], [c, bary[2]]]) {
      for (let k = st.offsets[v]; k < st.offsets[v + 1]; k++) { const j = st.ids[k] * 3, ww = st.weights[k] * w; u[0] += pos[j] * ww; u[1] += pos[j + 1] * ww; u[2] += pos[j + 2] * ww; }
    }
    const inside = this.pullInside(u, radius);
    if (!inside) { reject("gemFull"); return; }
    const gem = this.makeGem(rare ? rare.index : shape, color, radius, inside, rare);
    this.gems.push(gem);
    this.events.push({ type: "gemIn", gem: gem.id, rare: Boolean(rare) });
    // a rare gem really placed: main deducts one from its stock
    if (rare) this.events.push({ type: "rareIn", index: gem.shape, tier: gem.tier });
  }

  // 한 줌 쏟기: gems appear in the air above the jelly, fall, and stick in.
  // Each reserves its final spot (undeformed coords) up front, so capacity and
  // spacing hold; while falling it flies free in tray space.
  scatterGems({ count = 5, shape = -1, color = -1, radius = 0.0034, shapes = 9, colors = 6, rare = null }) {
    const bnd = this.type.locator.bounds;
    let added = 0;
    const rareRef = rare ? { index: rare.index, tier: rare.tier } : null;
    if (rare && this.rareCount >= RARE_CAPACITY) { this.events.push({ type: "rareFull", rare: rareRef, count }); return; }
    const placed = [];
    for (let n = 0; n < count && this.gems.length < this.gemCapacity && !(rare && this.rareCount >= RARE_CAPACITY); n++) {
      for (let tries = 0; tries < 60; tries++) {
        const u = [bnd[0] + Math.random() * (bnd[3] - bnd[0]), bnd[1] + (0.45 + 0.45 * Math.random()) * (bnd[4] - bnd[1]), bnd[2] + Math.random() * (bnd[5] - bnd[2])];
        if (!this.gemFits(u, radius) || this.overlapsGem(u, radius)) continue;
        const gem = this.makeGem(rare ? rare.index : shape >= 0 ? shape : Math.floor(Math.random() * shapes), color >= 0 ? color : Math.floor(Math.random() * colors), radius, u, rare);
        const e = this.type.locator.locate(u[0], u[1], u[2]), T = [0, 0, 0];
        this.body.pointInTet(e, this.type.locator.bary, T);
        const top = this.body.bounds[4];
        gem.fall = {
          pos: [T[0] + (Math.random() - 0.5) * 0.012, top + 0.05 + 0.03 * Math.random() + n * 0.006, T[2] + (Math.random() - 0.5) * 0.012],
          vel: [0, -0.15 * Math.random(), 0], delay: n * 0.07 + Math.random() * 0.05, spin: randomQuat(), sink: -1, from: null,
        };
        gem.wpos = gem.fall.pos.slice(); gem.prev = gem.wpos.slice();
        this.gems.push(gem);
        if (rare) placed.push(gem);
        added++;
        break;
      }
    }
    if (!rare) this.events.push({ type: added ? "gemScatter" : "gemFull", count: added });
    else {
      // rare: the placed ones (rareIn each) and the rest rejected (count = how many)
      if (added) this.events.push({ type: "gemScatter", count: added });
      if (added < count) this.events.push({ type: this.rareCount >= RARE_CAPACITY ? "rareFull" : "gemFull", rare: rareRef, count: count - added });
    }
    for (const gem of placed) this.events.push({ type: "rareIn", index: gem.shape, tier: gem.tier });
  }

  // Falling-gem flight and landing (tray space). Returns true while in flight.
  flyGem(gem, dt) {
    const f = gem.fall, body = this.body, L = this.type.locator;
    const e = L.locate(gem.u[0], gem.u[1], gem.u[2]), T = [0, 0, 0];
    if (e >= 0) body.pointInTet(e, L.bary, T);
    if (f.delay > 0) { f.delay -= dt; gem.glow = 0.6; return true; }
    if (f.sink < 0) {
      const g = this.gravityVector || [0, -9.81, 0];
      for (let k = 0; k < 3; k++) f.vel[k] += g[k] * dt;
      // steer horizontally toward the reserved spot so it lands on it
      f.vel[0] += (T[0] - f.pos[0]) * 40 * dt; f.vel[2] += (T[2] - f.pos[2]) * 40 * dt;
      for (let k = 0; k < 3; k++) f.pos[k] += f.vel[k] * dt;
      slerpInto(gem.quat, quatMultiply(f.spin, gem.quat, this.scratchQ3 ||= [0, 0, 0, 1]), 0.12);
      gem.wpos[0] = f.pos[0]; gem.wpos[1] = f.pos[1]; gem.wpos[2] = f.pos[2];
      gem.glow = 0.8;
      // land when it reaches the jelly's top at this spot (or anything below)
      const surface = Math.min(body.bounds[4], T[1] + 0.02);
      if (f.pos[1] <= surface + gem.radius * 0.3) {
        f.sink = 0; f.from = f.pos.slice();
        const speed = Math.hypot(f.vel[0], f.vel[1], f.vel[2]);
        this.kick(f.pos, Math.min(1.2, 0.35 + speed * 0.5));
        this.events.push({ type: "clink", strength: Math.min(0.9, 0.35 + speed * 0.3), seed: gem.id * 13 + 5 });
        this.events.push({ type: "gemLand", point: f.pos.slice() });
      }
      return true;
    }
    // sink: ease from the landing point into its spot, following the jelly
    f.sink = Math.min(1, f.sink + dt / 0.22);
    const t = 1 - (1 - f.sink) ** 3;
    for (let k = 0; k < 3; k++) gem.wpos[k] = f.from[k] + (T[k] - f.from[k]) * t;
    gem.glow = 1;
    if (f.sink >= 1) { gem.fall = null; gem.fresh = true; return false; }
    return true;
  }

  // A small downward knock on the jelly around a tray-space point.
  kick(point, amount = 1) {
    const body = this.body, x = body.x, v = body.velocity, n = body.nodeCount, s2 = 2 * 0.012 * 0.012;
    for (let i = 0; i < n; i++) {
      const r2 = (x[i * 3] - point[0]) ** 2 + (x[i * 3 + 1] - point[1]) ** 2 + (x[i * 3 + 2] - point[2]) ** 2;
      v[i * 3 + 1] -= 0.09 * amount * Math.exp(-r2 / s2);
    }
    body.wake();
  }

  updateGems(dt) {
    const gems = this.gems, body = this.body, L = this.type.locator;
    if (!gems.length) return;
    const g = this.gravityVector || [0, -9.81, 0], gl = Math.hypot(g[0], g[1], g[2]) || 1;
    // Set gelatin holds inclusions: gems only move relative to the jelly while
    // it is being stirred — a random walk with a slight bias along gravity.
    const stir = Math.min(1, body.internalRms / 0.05);
    if (stir >= 0.02) {
      const step = GEM_WANDER * stir * dt, sink = 0.35 * step;
      for (const gem of gems) {
        const u = gem.u, p = [
          u[0] + (Math.random() * 2 - 1) * step + g[0] / gl * sink,
          u[1] + (Math.random() * 2 - 1) * step + g[1] / gl * sink,
          u[2] + (Math.random() * 2 - 1) * step + g[2] / gl * sink,
        ];
        if (this.gemFits(p, gem.radius)) gem.u = p;
      }
    }
    // Keep gems apart (undeformed coordinates).
    for (let i = 0; i < gems.length; i++) for (let j = i + 1; j < gems.length; j++) {
      const a = gems[i], b = gems[j];
      const dx = a.u[0] - b.u[0], dy = a.u[1] - b.u[1], dz = a.u[2] - b.u[2];
      const d = Math.hypot(dx, dy, dz) || 1e-6, min = (a.radius + b.radius) * 0.98;
      if (d >= min) continue;
      const push = (min - d) / 2 / d;
      const pa = [a.u[0] + dx * push, a.u[1] + dy * push, a.u[2] + dz * push];
      const pb = [b.u[0] - dx * push, b.u[1] - dy * push, b.u[2] - dz * push];
      if (this.gemFits(pa, a.radius)) a.u = pa;
      if (this.gemFits(pb, b.radius)) b.u = pb;
    }
    // World pose follows the containing tet's deformation.
    for (const gem of gems) {
      if (gem.fall && this.flyGem(gem, dt)) { gem.vel = null; continue; }
      const e = L.locate(gem.u[0], gem.u[1], gem.u[2]);
      gem.prev[0] = gem.wpos[0]; gem.prev[1] = gem.wpos[1]; gem.prev[2] = gem.wpos[2];
      if (e < 0) continue;
      body.pointInTet(e, L.bary, gem.wpos);
      if (gem.fresh) { gem.prev[0] = gem.wpos[0]; gem.prev[1] = gem.wpos[1]; gem.prev[2] = gem.wpos[2]; gem.fresh = false; }
      tetRotation(body, e, this.scratchQ ||= [0, 0, 0, 1]);
      slerpInto(gem.quat, quatMultiply(this.scratchQ, gem.qLocal, this.scratchQ2 ||= [0, 0, 0, 1]), 0.4);
      const vx = (gem.wpos[0] - gem.prev[0]) / dt, vy = (gem.wpos[1] - gem.prev[1]) / dt, vz = (gem.wpos[2] - gem.prev[2]) / dt;
      const speed = Math.hypot(vx, vy, vz);
      // A sharp jolt (drop, nudge, snap-back) rattles the gem: a soft ting.
      const jolt = gem.vel ? Math.hypot(vx - gem.vel[0], vy - gem.vel[1], vz - gem.vel[2]) / dt : 0;
      gem.vel = [vx, vy, vz];
      gem.rattle = Math.max(0, gem.rattle - dt);
      if (jolt > GEM_RATTLE && gem.rattle === 0) {
        gem.rattle = 0.22;
        this.events.push({ type: "clink", strength: Math.min(0.7, 0.15 + jolt / 60), seed: gem.id * 7 + Math.floor(jolt) });
      }
      const target = Math.min(1, speed / 0.05);
      gem.glow += (target - gem.glow) * (target > gem.glow ? 0.35 : 0.04);
    }
  }

  // Gems knocking together in world space (the jelly squeezes them closer).
  knockGems() {
    const gems = this.gems;
    for (let i = 0; i < gems.length; i++) for (let j = i + 1; j < gems.length; j++) {
      const a = gems[i], b = gems[j];
      if (a.fall || b.fall) continue;
      const d = Math.hypot(a.wpos[0] - b.wpos[0], a.wpos[1] - b.wpos[1], a.wpos[2] - b.wpos[2]);
      if (d >= (a.radius + b.radius) * 1.02) { if (d > (a.radius + b.radius) * 1.15) { a.contacts.delete(b.id); b.contacts.delete(a.id); } continue; }
      if (a.contacts.has(b.id)) continue;
      a.contacts.add(b.id); b.contacts.add(a.id);
      const rel = a.vel && b.vel ? Math.hypot(a.vel[0] - b.vel[0], a.vel[1] - b.vel[1], a.vel[2] - b.vel[2]) : 0;
      if (rel > GEM_CLINK_SPEED) this.events.push({ type: "clink", strength: Math.min(1, 0.3 + rel / 0.2), seed: a.id * 31 + b.id });
    }
  }

  // 10 floats per gem: shape, color, px, py, pz, qx, qy, qz, qw, glow.
  gemStates(out) {
    const n = this.gems.length;
    for (let i = 0; i < n; i++) {
      const g = this.gems[i], o = i * 10;
      out[o] = g.shape; out[o + 1] = g.rare ? 100 + g.tier : g.color;   // ≥ 100: rare gem, tier = value − 100
      out[o + 2] = g.wpos[0]; out[o + 3] = g.wpos[1]; out[o + 4] = g.wpos[2];
      out[o + 5] = g.quat[0]; out[o + 6] = g.quat[1]; out[o + 7] = g.quat[2]; out[o + 8] = g.quat[3];
      out[o + 9] = g.glow;
    }
    return out;
  }
}

// ------------------------------------------------------------------ helpers
function massCenter(x, mass, total) {
  const c = [0, 0, 0];
  for (let i = 0; i < mass.length; i++) { const w = mass[i] / total; c[0] += x[i * 3] * w; c[1] += x[i * 3 + 1] * w; c[2] += x[i * 3 + 2] * w; }
  return c;
}
function weightedPoint(g, x) {
  const p = [0, 0, 0];
  for (let k = 0; k < g.ids.length; k++) { const j = g.ids[k] * 3, w = g.weights[k]; p[0] += x[j] * w; p[1] += x[j + 1] * w; p[2] += x[j + 2] * w; }
  return p;
}
// Best-fit rotation rest → current (row-major 3×3): the rotation of the polar
// decomposition of Σ m (x − c)(rest − c₀)ᵀ (Higham iteration R ← ½(R + R⁻ᵀ)).
function bestRotation(body, restCenter) {
  const x = body.x, r = body.rest, m = body.mass, n = body.nodeCount;
  const c = massCenter(x, m, body.totalMass), c0 = restCenter;
  const A = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const j = i * 3, w = m[i];
    const a0 = (x[j] - c[0]) * w, a1 = (x[j + 1] - c[1]) * w, a2 = (x[j + 2] - c[2]) * w;
    const b0 = r[j] - c0[0], b1 = r[j + 1] - c0[1], b2 = r[j + 2] - c0[2];
    A[0] += a0 * b0; A[1] += a0 * b1; A[2] += a0 * b2;
    A[3] += a1 * b0; A[4] += a1 * b1; A[5] += a1 * b2;
    A[6] += a2 * b0; A[7] += a2 * b1; A[8] += a2 * b2;
  }
  const f = Math.hypot(...A) / Math.sqrt(3);
  if (!(f > 0)) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const R = A.map((v) => v / f);
  for (let it = 0; it < 30; it++) {
    const [a, b, cc, d, e, ff, g, h, k] = R;
    const det = a * (e * k - ff * h) - b * (d * k - ff * g) + cc * (d * h - e * g);
    if (!(Math.abs(det) > 1e-12)) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    // R⁻ᵀ: the cofactor matrix / det
    const inv = [(e * k - ff * h) / det, (ff * g - d * k) / det, (d * h - e * g) / det, (cc * h - b * k) / det, (a * k - cc * g) / det, (b * g - a * h) / det, (b * ff - cc * e) / det, (cc * d - a * ff) / det, (a * e - b * d) / det];
    let change = 0;
    for (let q = 0; q < 9; q++) { const nv = 0.5 * (R[q] + inv[q]); change += Math.abs(nv - R[q]); R[q] = nv; }
    if (change < 1e-9) break;
  }
  return R;
}
function randomQuat() {
  const u1 = Math.random(), u2 = Math.random() * Math.PI * 2, u3 = Math.random() * Math.PI * 2;
  const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
  return [a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3)];
}

// Rotation part of the tet's deformation gradient (Gram-Schmidt on F's columns).
function tetRotation(body, e, out) {
  const x = body.x, ids = body.ids, b4 = e * 4, pos = body.cage.pos;
  const a = ids[b4] * 3, b = ids[b4 + 1] * 3, c = ids[b4 + 2] * 3, d = ids[b4 + 3] * 3;
  const e1 = [x[b] - x[a], x[b + 1] - x[a + 1], x[b + 2] - x[a + 2]];
  const e2 = [x[c] - x[a], x[c + 1] - x[a + 1], x[c + 2] - x[a + 2]];
  const e3 = [x[d] - x[a], x[d + 1] - x[a + 1], x[d + 2] - x[a + 2]];
  const m = inv3cols([pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]], [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]], [pos[d] - pos[a], pos[d + 1] - pos[a + 1], pos[d + 2] - pos[a + 2]]);
  if (!m) { out[0] = out[1] = out[2] = 0; out[3] = 1; return out; }
  const F = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) F[row * 3 + col] = e1[row] * m[col] + e2[row] * m[3 + col] + e3[row] * m[6 + col];
  let c0 = norm([F[0], F[3], F[6]]);
  const c1raw = [F[1], F[4], F[7]], k = dot(c0, c1raw);
  const c1 = norm([c1raw[0] - c0[0] * k, c1raw[1] - c0[1] * k, c1raw[2] - c0[2] * k]);
  return quatFromBasis(c0, c1, cross(c0, c1), out);
}
// Inverse of the matrix whose columns are a, b, c (row-major result).
function inv3cols(a, b, c) {
  const det = a[0] * (b[1] * c[2] - c[1] * b[2]) - b[0] * (a[1] * c[2] - c[1] * a[2]) + c[0] * (a[1] * b[2] - b[1] * a[2]);
  if (Math.abs(det) < 1e-24) return null;
  const s = 1 / det;
  return [
    (b[1] * c[2] - c[1] * b[2]) * s, (c[0] * b[2] - b[0] * c[2]) * s, (b[0] * c[1] - c[0] * b[1]) * s,
    (c[1] * a[2] - a[1] * c[2]) * s, (a[0] * c[2] - c[0] * a[2]) * s, (c[0] * a[1] - a[0] * c[1]) * s,
    (a[1] * b[2] - b[1] * a[2]) * s, (b[0] * a[2] - a[0] * b[2]) * s, (a[0] * b[1] - b[0] * a[1]) * s,
  ];
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dot3 = dot;
const norm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function hexToRgb(hex) { const v = parseInt(String(hex).replace("#", ""), 16); return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]; }
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
function quatFromBasis(x, y, z, out) {
  const m00 = x[0], m01 = y[0], m02 = z[0], m10 = x[1], m11 = y[1], m12 = z[1], m20 = x[2], m21 = y[2], m22 = z[2];
  const tr = m00 + m11 + m22;
  if (tr > 0) { const s = 0.5 / Math.sqrt(tr + 1); out[3] = 0.25 / s; out[0] = (m21 - m12) * s; out[1] = (m02 - m20) * s; out[2] = (m10 - m01) * s; }
  else if (m00 > m11 && m00 > m22) { const s = 2 * Math.sqrt(1 + m00 - m11 - m22); out[3] = (m21 - m12) / s; out[0] = 0.25 * s; out[1] = (m01 + m10) / s; out[2] = (m02 + m20) / s; }
  else if (m11 > m22) { const s = 2 * Math.sqrt(1 + m11 - m00 - m22); out[3] = (m02 - m20) / s; out[0] = (m01 + m10) / s; out[1] = 0.25 * s; out[2] = (m12 + m21) / s; }
  else { const s = 2 * Math.sqrt(1 + m22 - m00 - m11); out[3] = (m10 - m01) / s; out[0] = (m02 + m20) / s; out[1] = (m12 + m21) / s; out[2] = 0.25 * s; }
  return out;
}
function quatMultiply(a, b, out) {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3], bx = b[0], by = b[1], bz = b[2], bw = b[3];
  out[0] = aw * bx + ax * bw + ay * bz - az * by;
  out[1] = aw * by - ax * bz + ay * bw + az * bx;
  out[2] = aw * bz + ax * by - ay * bx + az * bw;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}
function slerpInto(q, target, t) {
  const sign = q[0] * target[0] + q[1] * target[1] + q[2] * target[2] + q[3] * target[3] < 0 ? -1 : 1;
  for (let i = 0; i < 4; i++) q[i] += (target[i] * sign - q[i]) * t;
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  for (let i = 0; i < 4; i++) q[i] /= l;
}
