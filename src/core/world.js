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
import { makeFlowerCage, makeSurfaceStencils, makeTetLocator } from "./cage.js";

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
const RARE_CAPACITY = 4;           // big rare gems per jelly
const GLITTER_MAX = 360, STARS_MAX = 36;

function makeType() {
  const cage = makeFlowerCage();
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
  return { cage, stencils, locator, vertexTri, edges: Int32Array.from(edges), centroid: [cx / n, cy / n, cz / n] };
}

export class JellyWorld {
  constructor({ wallRadius = 0.075, base = "berry", gemCapacity = 14, texture = "jelly" } = {}) {
    this.texture = texture === "slime" ? "slime" : "jelly";
    this.wallRadius = wallRadius;
    this.type = makeType();
    this.gemCapacity = gemCapacity;
    this.params = { shear: 600, damping: 3, friction: 1 };
    this.gravityVector = null; this.frictionOverride = null;
    this.step = 1 / 240; this.accumulator = 0;
    this.events = [];
    this.nextGemId = 1;
    this.grabs = new Map();
    this.reset(base);
  }

  reset(base = this.base || "berry", lift = 0) {
    const t = this.type;
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
    this.meanDye = [0, 0, 0];
    this.gems = [];
    this.grabs = new Map(); this.grabbing = false;
    this.falling = [];
    this.accumulator = 0;
    this.setBase(base);
    if (lift) body.reset(lift);
    this.events.push({ type: "reset" });
  }

  setBase(base) {
    const sigma = BASES[base] || BASES.berry;
    this.base = BASES[base] ? base : "berry";
    for (let i = 0; i < this.body.nodeCount; i++) this.dye.set(sigma, i * 3);
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
  beadStates(out) {
    const b = this.beads, body = this.body, p = [0, 0, 0], bary = [0, 0, 0, 0], gone = this.eatenBeads;
    let n = 0;
    for (let i = 0; i < b.count; i++) {
      if (gone && gone[i]) continue;
      bary[0] = b.bary[i * 4]; bary[1] = b.bary[i * 4 + 1]; bary[2] = b.bary[i * 4 + 2]; bary[3] = b.bary[i * 4 + 3];
      body.pointInTet(b.tets[i], bary, p);
      out[n * 4] = p[0]; out[n * 4 + 1] = p[1]; out[n * 4 + 2] = p[2]; out[n * 4 + 3] = b.color[i];
      n++;
    }
    return n < b.count ? out.subarray(0, n * 4) : out;
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
      case "nudge": body.nudge(); break;
      case "reset": this.reset(event.base, event.lift || 0); break;
      case "grabNear": this.grabNear(event); break;
      case "bite": this.bite(event); break;
      case "additive": this.addAdditive(event); break;
      case "base": this.setBase(event.base); break;
      case "gravity":
        this.gravityVector = event.vector; this.frictionOverride = event.friction;
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

  syncGrabs() {
    const list = [...this.grabs.values()];
    this.body.grab = list[0] || null;
    this.body.extraGrabs = list.slice(1);
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
    this.events.push({ type: "bounced", strength });
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
    this.grabs.set(id, { ids, weights, target: pt.slice(), point: pt.slice(), lambda: new Float64Array(3), raw: pt.slice(), id, maxForce, stiffness: 320 });
    this.syncGrabs();
  }

  // A bite at tray-space `center`: the jelly caves in there, and gems,
  // glitter, star candies and foam beads inside the bite are eaten.
  bite({ center, radius = 0.016, factor = 0.2, scale = 0.87 }) {
    // the whole jelly gets smaller (a bite's worth is gone) and the bitten
    // side caves in a little more
    this.body.scaleRest(scale);
    this.body.shrinkRegion(center, radius, factor);
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
      if (!body.isFinite()) { body.reset(); this.grabs.clear(); this.grabbing = false; this.events.push({ type: "recovered" }); }
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

  updateMeanDye() {
    const m = this.body.mass, d = this.dye, M = this.body.totalMass, out = this.meanDye;
    out[0] = out[1] = out[2] = 0;
    for (let i = 0; i < this.body.nodeCount; i++) { const w = m[i] / M; out[0] += d[i * 3] * w; out[1] += d[i * 3 + 1] * w; out[2] += d[i * 3 + 2] * w; }
  }

  // Pigment-conserving diffusion over cage edges; stirring speeds it up.
  diffuseDye(dt) {
    if (!this.dyeActive) return;
    const edges = this.type.edges, d = this.dye, m = this.body.mass;
    const stir = Math.min(1, this.body.internalRms / 0.08);
    const alpha = Math.min(0.045, (0.18 + 2.2 * stir) * dt);
    let spread = 0;
    for (let k = 0; k < edges.length; k += 2) {
      const i = edges[k], j = edges[k + 1], mij = Math.min(m[i], m[j]) * alpha;
      for (let c = 0; c < 3; c++) {
        const diff = d[j * 3 + c] - d[i * 3 + c];
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

  addGemAtSurface({ a, b, c, bary, shape, color, radius = 0.0034, rare = null }) {
    if (this.gems.length >= this.gemCapacity) { this.events.push({ type: "gemFull" }); return; }
    if (rare && this.rareCount >= RARE_CAPACITY) { this.events.push({ type: "rareFull" }); return; }
    const u = [0, 0, 0], st = this.type.stencils, pos = this.type.cage.pos;
    for (const [v, w] of [[a, bary[0]], [b, bary[1]], [c, bary[2]]]) {
      for (let k = st.offsets[v]; k < st.offsets[v + 1]; k++) { const j = st.ids[k] * 3, ww = st.weights[k] * w; u[0] += pos[j] * ww; u[1] += pos[j + 1] * ww; u[2] += pos[j + 2] * ww; }
    }
    const inside = this.pullInside(u, radius);
    if (!inside) { this.events.push({ type: "gemFull" }); return; }
    const gem = this.makeGem(rare ? rare.index : shape, color, radius, inside, rare);
    this.gems.push(gem);
    this.events.push({ type: "gemIn", gem: gem.id, rare: Boolean(rare) });
  }

  // 한 줌 쏟기: gems appear in the air above the jelly, fall, and stick in.
  // Each reserves its final spot (undeformed coords) up front, so capacity and
  // spacing hold; while falling it flies free in tray space.
  scatterGems({ count = 5, shape = -1, color = -1, radius = 0.0034, shapes = 9, colors = 6, rare = null }) {
    const bnd = this.type.locator.bounds;
    let added = 0;
    if (rare && this.rareCount >= RARE_CAPACITY) { this.events.push({ type: "rareFull" }); return; }
    for (let n = 0; n < count && this.gems.length < this.gemCapacity; n++) {
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
        added++;
        break;
      }
    }
    this.events.push({ type: added ? "gemScatter" : "gemFull", count: added });
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
