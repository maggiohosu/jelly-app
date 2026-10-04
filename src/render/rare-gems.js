// Rare gems: 25 shapes × 3 upgrade tiers (글리터 / 금빛 / 무지개빛).
//
// Geometry comes from rare-shapes.js (pure JS). Every gem is ONE BufferGeometry
// with two groups drawn with a shared two-entry material array:
//
//   [0] smooth material — opaque, but reads as glossy translucent jelly, resin
//       candy or glass: fresnel clearcoat reflection of the analytic studio
//       environment (same one the crystal gems use), a sphere-approximated
//       refraction path (entry → chord → exit with Fresnel/TIR) whose length
//       drives Beer-Lambert absorption (saturated core, light rim), a soft
//       translucent scatter term blended in by the part's turbidity, and
//       procedural surface patterns (lollipop swirl, candy-cane stripes,
//       strawberry seeds, mandarin pith lines, opal fire).
//   [1] facet material — the raytraced crystal of gems.js, but every faceted
//       PART has its own convex planes (support planes of its facets), stored
//       in one library-wide uniform buffer; the vertex attribute rareA holds
//       the part's plane range, so composed charms keep their notches/holes.
//
// Per-part data travels in vertex attributes (rareColor, rareA, rareB), so the
// shader code is identical for all 25 gems: 2 programs per quality tier.
// Per-instance data (upgrade tier, glow) comes from mesh.userData through
// object-group uniforms (onObjectUpdate), exactly like GemLayer.
//
// Tier overlays (shared by both materials, applied over the gem's own colour):
//   0 glitter — fine silver-holographic flecks on and inside the body that
//               twinkle with view angle;
//   1 gold    — warm gold body tint, gold-tinted reflections, gold sheen rim,
//               metallic gold flecks and gold rim glints;
//   2 rainbow — thin-film iridescence shifting with view angle, rainbow
//               flecks (densest, brightest) and rainbow rim glints.
//
// Everything is uniforms + attributes + Loop/If, so it runs on WebGPU and on
// the WebGL2 fallback. Materials are OPAQUE (the jelly's transmission refracts
// only opaque objects).

import * as THREE from "three/webgpu";
import {
  Break,
  Fn,
  If,
  Loop,
  abs,
  atan,
  attribute,
  buffer,
  cameraPosition,
  clamp,
  cos,
  dot,
  exp,
  float,
  floor,
  fract,
  int,
  length,
  log,
  max,
  mix,
  modelWorldMatrix,
  modelWorldMatrixInverse,
  normalGeometry,
  normalize,
  positionGeometry,
  pow,
  reflect,
  select,
  sharedUniformGroup,
  sin,
  smoothstep,
  sqrt,
  time,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { GEM_SIZE, GEM_TIERS } from "./gems.js";
import {
  RARE_GEM_INFO,
  RARE_PATTERN,
  RARE_PLANE_BUDGET,
  RARE_SIZE,
  RARE_TIER_INFO,
  rareIconSVG,
  rareShapeData,
} from "./rare-shapes.js";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

export { RARE_SIZE, RARE_PATTERN };
if (Math.abs(RARE_SIZE - GEM_SIZE * 1.5) > 1e-12) throw new Error("RARE_SIZE must be GEM_SIZE × 1.5");

/** The 25 rare gems in order: frozen { id, label, family, color }. */
export const RARE_GEMS = RARE_GEM_INFO;

/** Upgrade tiers: 0 글리터, 1 금빛, 2 무지개빛. */
export const RARE_TIERS = RARE_TIER_INFO;

/** Quality tiers: the crystal raytrace budget of gems.js + fleck layers. */
export const RARE_QUALITY = Object.freeze({
  high: Object.freeze({ ...GEM_TIERS.high, layers: 2 }),
  mid: Object.freeze({ ...GEM_TIERS.mid, layers: 2 }),
  low: Object.freeze({ ...GEM_TIERS.low, layers: 1 }),
});

export const MAX_RARE_GEMS = 8;
const STATE_STRIDE = 10;

const IOR_SMOOTH = 1.45;
const IOR_SPREAD = 0.035; // per unit of (ior − 1): R = ior − spread, B = ior + spread
const ABSORB_DEPTH = RARE_SIZE * 0.5;
const TRAPPED_ESCAPE = 0.85;
const GLOW_LUMINANCE = 0.28;
const LIFT = 1.2; // seen through the jelly the gems lose contrast (gems.js uses 1.22)

const TO_SUN = new THREE.Vector3(0.6123724357, 0.5, -0.6123724357).normalize();

// ---------------------------------------------------------------------------
// TSL helpers (environment kept identical to gems.js)
// ---------------------------------------------------------------------------

const v3 = (v) => vec3(v.x, v.y, v.z);
const dir3 = (x, y, z) => v3(new THREE.Vector3(x, y, z).normalize());
const disc = (d, axis, radius, soft) => smoothstep(Math.cos(radius + soft), Math.cos(radius), dot(d, axis));
const LUMA = vec3(0.2126, 0.7152, 0.0722);
const BOX_A = dir3(0.25, 0.85, 0.47), BOX_B = dir3(-0.62, 0.55, 0.56);

const fresnelDielectric = /*@__PURE__*/ Fn(([cosI, n1, n2]) => {
  const eta = n1.div(n2);
  const sinT2 = eta.mul(eta).mul(float(1).sub(cosI.mul(cosI)));
  const cosT = sqrt(float(1).sub(sinT2).max(1e-6));
  const rs = n1.mul(cosI).sub(n2.mul(cosT)).div(n1.mul(cosI).add(n2.mul(cosT)));
  const rp = n2.mul(cosI).sub(n1.mul(cosT)).div(n2.mul(cosI).add(n1.mul(cosT)));
  return select(sinT2.greaterThanEqual(1.0), float(1.0), rs.mul(rs).add(rp.mul(rp)).mul(0.5).clamp(0.0, 1.0));
}).setLayout({
  name: "rareFresnel",
  type: "float",
  inputs: [{ name: "cosI", type: "float" }, { name: "n1", type: "float" }, { name: "n2", type: "float" }],
});

const refractSafe = /*@__PURE__*/ Fn(([I, N, eta]) => {
  const c = dot(N, I).negate();
  const k = float(1).sub(eta.mul(eta).mul(float(1).sub(c.mul(c))));
  return normalize(I.mul(eta).add(N.mul(eta.mul(c).sub(sqrt(k.max(0.0))))));
}).setLayout({
  name: "rareRefract",
  type: "vec3",
  inputs: [{ name: "I", type: "vec3" }, { name: "N", type: "vec3" }, { name: "eta", type: "float" }],
});

/** Analytic studio environment (world direction → linear HDR), as gems.js. */
const rareEnvironment = /*@__PURE__*/ Fn(([d]) => {
  const y = d.y;
  const sky = mix(vec3(0.6, 0.6, 0.7), vec3(0.86, 0.92, 1.08), smoothstep(0.08, 0.9, y));
  const floorC = mix(vec3(0.62, 0.58, 0.56), vec3(0.74, 0.66, 0.58), smoothstep(-0.08, -0.7, y));
  const base = mix(floorC, sky, smoothstep(-0.1, 0.1, y))
    .mul(float(1.0).sub(disc(d, dir3(0.0, 0.25, 1.0), 0.35, 0.3).mul(0.5)));
  const h = dot(d, vec3(1.7, 0.9, 1.25)).add(d.y.mul(d.x).mul(1.6));
  const w = cos(h.mul(2.2).sub(vec3(0.0, 2.0944, 4.18879))).mul(0.5).add(0.5);
  const tint = vec3(1.0, 0.68, 0.86).mul(w.x).add(vec3(0.8, 0.7, 1.0).mul(w.y)).add(vec3(0.64, 0.86, 1.0).mul(w.z)).div(1.5);
  const sunDot = dot(d, v3(TO_SUN));
  const key = smoothstep(Math.cos(0.2), Math.cos(0.09), sunDot).mul(13.0).add(sunDot.max(0).pow(10).mul(0.9));
  const boxes = disc(d, BOX_A, 0.3, 0.1).mul(2.8)
    .add(disc(d, BOX_B, 0.22, 0.08).mul(3.2))
    .add(disc(d, dir3(0.75, 0.15, 0.1), 0.25, 0.1).mul(2.4))
    .add(disc(d, dir3(-0.55, 0.35, -0.75), 0.2, 0.08).mul(2.4));
  const glints = disc(d, dir3(-0.15, 0.97, -0.2), 0.045, 0.03)
    .add(disc(d, dir3(0.85, 0.25, 0.46), 0.05, 0.03))
    .add(disc(d, dir3(-0.9, 0.1, -0.1), 0.05, 0.03)).mul(9.0);
  return base.mul(tint).add(vec3(1.0, 0.95, 0.86).mul(key)).add(mix(vec3(1.0), tint, 0.5).mul(boxes)).add(glints);
}).setLayout({ name: "rareEnvironment", type: "vec3", inputs: [{ name: "d", type: "vec3" }] });

/** Low-frequency version of the environment (irradiance-ish, for scattering). */
const rareEnvSoft = /*@__PURE__*/ Fn(([d]) => {
  const y = d.y;
  const sky = mix(vec3(0.66, 0.66, 0.76), vec3(0.9, 0.94, 1.06), smoothstep(0.0, 0.9, y));
  const floorC = mix(vec3(0.64, 0.6, 0.58), vec3(0.74, 0.67, 0.6), smoothstep(-0.05, -0.7, y));
  const base = mix(floorC, sky, smoothstep(-0.3, 0.3, y));
  const sun = dot(d, v3(TO_SUN)).mul(0.5).add(0.5).pow(3).mul(1.5);
  const box = dot(d, BOX_A).mul(0.5).add(0.5).pow(4).mul(0.6).add(dot(d, BOX_B).mul(0.5).add(0.5).pow(4).mul(0.5));
  return base.add(vec3(1.0, 0.95, 0.86).mul(sun)).add(vec3(box));
}).setLayout({ name: "rareEnvSoft", type: "vec3", inputs: [{ name: "d", type: "vec3" }] });

/** Hue (0..1, wraps) → fully saturated RGB. */
const hueRGB = /*@__PURE__*/ Fn(([h]) => clamp(abs(fract(vec3(h).add(vec3(1.0, 2.0 / 3.0, 1.0 / 3.0))).mul(6.0).sub(3.0)).sub(1.0), 0.0, 1.0))
  .setLayout({ name: "rareHue", type: "vec3", inputs: [{ name: "h", type: "float" }] });

/**
 * Dave Hoskins' hash33 (sin-free, stable in fp32). Inlined on purpose: a
 * layout function nested in another one is emitted in build order, which can
 * differ between node builders and split one material into two programs.
 */
const hash33 = (p) => {
  const q = fract(p.mul(vec3(0.1031, 0.103, 0.0973)));
  const r = q.add(dot(q, q.yxz.add(33.33)));
  return fract(r.xxy.add(r.yxx).mul(r.zyx));
};

/**
 * One jittered fleck per cell around q (cell units): vec4(mask, rnd.xyz).
 * The surface cuts the 3D cells, so flecks are random-sized dots.
 */
const fleck = /*@__PURE__*/ Fn(([q, radius]) => {
  const cell = floor(q);
  const h = hash33(cell);
  const centre = cell.add(h.mul(0.6).add(0.2));
  const mask = smoothstep(radius, radius.mul(0.45), length(q.sub(centre)));
  return vec4(mask, hash33(cell.add(vec3(17.17, 3.31, 9.73))));
}).setLayout({ name: "rareFleck", type: "vec4", inputs: [{ name: "q", type: "vec3" }, { name: "radius", type: "float" }] });

const GOLD = vec3(1.0, 0.64, 0.2);

// Per-object uniforms (object group): upgrade tier and glow from userData.
function objectUniforms() {
  return {
    tier: uniform(0).onObjectUpdate(({ object }) => object.userData.rareTier ?? 0),
    glow: uniform(0).onObjectUpdate(({ object }) => object.userData.glow ?? 0),
  };
}

/**
 * Tier overlay over a shaded body. Inputs are TSL nodes in gem-local space;
 * `refl` is the front-surface reflection, `body` everything else.
 */
function tierOverlay({ p, n, v, cosI, dIn, depth, body, refl, base, tier, glow, glitter = float(0), silver = float(0), sheen = float(0), layers, toWorld }) {
  const wGlit = clamp(float(1).sub(tier), 0, 1);
  const wGold = clamp(float(1).sub(abs(tier.sub(1))), 0, 1);
  const wRain = clamp(tier.sub(1), 0, 1);
  const rim = pow(float(1).sub(cosI).max(0), 2.0).toVar();
  const reflLum = dot(refl, LUMA).min(3.0).toVar();

  // Thin film: hue shifts with the view angle and drifts across the surface.
  const filmHue = hueRGB(cosI.mul(2.2).add(dot(p, vec3(1.3, 0.8, -1.1)).div(RARE_SIZE).mul(0.9)).add(dot(n, vec3(0.3, 0.5, 0.2)).mul(0.8)));
  const film = filmHue.mul(filmHue).toVar();
  const filmAmt = clamp(wRain.add(sheen.mul(0.85)), 0, 1.4).toVar();

  const reflTint = mix(vec3(1), GOLD.mul(1.6), wGold.mul(0.85)).mul(mix(vec3(1), film.mul(1.8).add(0.2), filmAmt.mul(0.75)));
  const bodyTint = mix(vec3(1), vec3(1.1, 0.98, 0.8), wGold.mul(0.4));
  const out = body.mul(bodyTint).add(refl.mul(reflTint)).toVar();
  // Gold: the silhouette turns to polished metallic gold, lit by the environment.
  const goldRim = smoothstep(0.38, 0.92, float(1).sub(cosI)).mul(wGold);
  out.assign(mix(out, vec3(1.0, 0.58, 0.12).mul(reflLum.mul(0.9).add(0.32)), goldRim.mul(0.8)));
  // Rainbow: iridescent film everywhere, strongest at grazing angles.
  out.addAssign(film.mul(rim.mul(0.9).add(0.16)).mul(reflLum.mul(0.4).add(0.6)).mul(filmAmt));

  // Sparkle of a fleck / flake with random orientation: bright when it mirrors
  // a light toward the viewer, plus a twinkle as the view sweeps its phase.
  const sparkle = (rnd, nS, spread = 1.6) => {
    const fn = normalize(nS.add(rnd.sub(0.5).mul(spread)));
    const rw = toWorld(reflect(v, fn));
    const lobes = pow(max(dot(rw, v3(TO_SUN)), 0), 48).mul(5.0)
      .add(pow(max(dot(rw, BOX_A), 0), 48).mul(2.5))
      .add(pow(max(dot(rw, BOX_B), 0), 48).mul(2.5));
    const tw = pow(max(cos(dot(v, rnd.mul(2).sub(1)).mul(40).add(rnd.x.mul(6.2832)).add(time.mul(rnd.y.mul(1.4)))), 0), 14);
    return lobes.add(tw.mul(2.0));
  };

  // Fine glitter (every tier; colour, density and brightness per tier) and the
  // gem's own built-in glitter (resin candy gold, blueberry frost).
  const density = wGlit.mul(0.62).add(wGold.mul(0.55)).add(wRain.mul(0.8));
  const gain = wGlit.add(wGold.mul(1.2)).add(wRain.mul(1.5));
  const fleckColour = (rnd) => {
    const holo = hueRGB(rnd.z);
    const silverC = mix(vec3(1.0), holo.mul(holo), 0.28);
    const goldC = mix(vec3(0.95, 0.45, 0.06), vec3(1.0, 0.72, 0.26), rnd.z);
    const rainC = holo.mul(holo).mul(1.3).add(0.06);
    const tierC = mix(mix(silverC, goldC, wGold), rainC, wRain).mul(gain);
    const builtinC = mix(vec3(1.0, 0.66, 0.2), vec3(0.9, 0.96, 1.05), silver);
    const isTier = select(rnd.x.lessThan(density), float(1), float(0));
    const isBuiltin = select(rnd.y.lessThan(glitter.mul(0.55)), float(1), float(0)).mul(float(1).sub(isTier));
    return tierC.mul(isTier).add(builtinC.mul(isBuiltin));
  };
  const surface = fleck(p.div(RARE_SIZE / 36), float(0.24));
  out.addAssign(fleckColour(surface.yzw).mul(surface.x.mul(sparkle(surface.yzw, n).mul(1.6).add(0.3))));
  if (layers > 1) {
    const inner = fleck(p.add(dIn.mul(depth)).div(RARE_SIZE / 24).add(vec3(7.3, 1.9, 4.1)), float(0.27));
    out.addAssign(fleckColour(inner.yzw).mul(inner.x.mul(sparkle(inner.yzw, n.negate().mul(0.3).add(dIn.negate())).mul(1.3).add(0.22))).mul(0.65));
  }

  // Big flakes: gold leaf (금빛) or holographic flakes whose hue turns with the
  // view (무지개빛). Glitter tier has none.
  const flakeW = wGold.add(wRain);
  const flake = fleck(p.add(dIn.mul(depth.mul(0.35))).div(RARE_SIZE / 12).add(vec3(2.7, 8.1, 5.3)), float(0.3));
  const fn = normalize(n.add(flake.yzw.sub(0.5).mul(1.2)));
  const holoFlake = hueRGB(flake.w.add(dot(v, fn).mul(2.5)));
  const flakeC = mix(mix(vec3(0.9, 0.42, 0.05), vec3(1.0, 0.7, 0.22), flake.w), holoFlake.mul(holoFlake).mul(1.2).add(0.1), wRain);
  const flakeOn = select(flake.y.lessThan(0.6), float(1), float(0)).mul(flakeW);
  out.addAssign(flakeC.mul(flake.x.mul(flakeOn).mul(sparkle(flake.yzw, n, 1.2).mul(mix(float(0.9), float(1.4), wRain)).add(0.5))));

  // Rim glints (gold / rainbow): bright sparks running along the silhouette.
  const rimF = fleck(p.div(RARE_SIZE / 16).add(vec3(3.1, 5.7, 2.3)), float(0.32));
  const rimMask = rimF.x.mul(smoothstep(0.4, 0.85, float(1).sub(cosI))).mul(flakeW);
  const rimC = mix(vec3(1.0, 0.78, 0.36), hueRGB(rimF.y).mul(0.8).add(0.35), wRain);
  out.addAssign(rimC.mul(rimMask.mul(sparkle(rimF.yzw, n).add(0.8)).mul(1.8)));

  // Glow: soft emission in the part's own hue (normalised luminance); very
  // dark parts (eyes, a blueberry's crown) stay dark.
  const hue = base.mul(base);
  const hueLum = dot(hue, LUMA).max(0.05);
  const lit = smoothstep(0.01, 0.06, dot(base, LUMA));
  out.addAssign(hue.mul(glow.mul(lit).mul(cosI.mul(0.45).add(0.55)).mul(GLOW_LUMINANCE).div(hueLum)));
  return out;
}

const shadingFrame = () => {
  const camLocal = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1.0)).xyz;
  const p = positionGeometry.toVar();
  const v = normalize(p.sub(camLocal)).toVar();
  const toWorld = (d) => normalize(modelWorldMatrix.mul(vec4(d, 0.0)).xyz);
  return { p, v, toWorld };
};

// ---------------------------------------------------------------------------
// Smooth material (jelly / candy / glass)
// ---------------------------------------------------------------------------

function createSmoothMaterial(qualityId) {
  const { layers } = RARE_QUALITY[qualityId];
  const { tier, glow } = objectUniforms();
  const shade = Fn(() => {
    const col = attribute("rareColor", "vec3");
    const A = attribute("rareA", "vec4");
    const B = attribute("rareB", "vec4");
    const { p, v, toWorld } = shadingFrame();
    const n = normalize(normalGeometry).toVar();
    // Interpolated normals can turn away from the viewer at the silhouette.
    n.assign(normalize(n.sub(v.mul(max(dot(n, v).add(0.04), 0.0)))));
    const base = vec3(col).toVar();
    const turb = B.x.toVar();
    const extra = vec3(0).toVar();
    const pattern = A.x;
    const uv = vec2(A.y, A.z);

    If(pattern.greaterThan(0.5).and(pattern.lessThan(1.5)), () => {
      // Lollipop: six candy-coloured spiral arms with white bands between.
      const r = length(uv);
      const s = atan(uv.y, uv.x).div(6.2832).mul(6.0).add(r.mul(4.2));
      const k = fract(s);
      const candy = hueRGB(fract(floor(s).div(6.0)).add(0.02));
      const candyLin = mix(vec3(1.0), candy, 0.88).pow(2.0);
      const white = smoothstep(0.6, 0.68, k).mul(smoothstep(0.99, 0.92, k)).max(smoothstep(0.1, 0.04, r));
      base.assign(mix(candyLin, vec3(0.92, 0.9, 0.93), white));
      turb.assign(mix(turb, 0.14, white));
    }).ElseIf(pattern.greaterThan(1.5).and(pattern.lessThan(2.5)), () => {
      // Candy cane: helical red / clear / green / clear stripes.
      const f = fract(uv.x).mul(4.0);
      const band = floor(f);
      const e = fract(f);
      const soft = smoothstep(0.0, 0.12, e).mul(smoothstep(1.0, 0.88, e));
      const stripe = select(band.lessThan(0.5), base, vec3(0.16, 0.5, 0.08));
      const isColour = select(band.lessThan(0.5).or(band.greaterThan(1.5).and(band.lessThan(2.5))), soft, float(0));
      base.assign(mix(vec3(0.93, 0.9, 0.92), stripe, isColour));
      turb.assign(mix(0.1, turb, isColour));
    }).ElseIf(pattern.greaterThan(2.5).and(pattern.lessThan(3.5)), () => {
      // Strawberry: staggered seed dimples (golden seed, darker dimple rim).
      const row = uv.y.mul(9.0);
      const ri = floor(row);
      const cu = fract(uv.x.mul(10.0).add(ri.mul(0.5))).sub(0.5);
      const cv = fract(row).sub(0.5);
      const d = length(vec2(cu, cv.mul(1.15)));
      const valid = smoothstep(0.1, 0.18, uv.y).mul(smoothstep(0.97, 0.88, uv.y));
      const seed = smoothstep(0.17, 0.1, d).mul(valid);
      const ring = smoothstep(0.3, 0.2, d).sub(seed).max(0).mul(valid);
      base.assign(mix(base, vec3(0.95, 0.62, 0.22), seed.mul(0.9)).mul(float(1).sub(ring.mul(0.3))));
      turb.assign(mix(turb, 0.55, seed));
      extra.assign(vec3(0.9, 0.8, 0.7).mul(ring.mul(0.12)));
    }).ElseIf(pattern.greaterThan(3.5).and(pattern.lessThan(4.5)), () => {
      // Mandarin: pale pith lines along the segment grooves + faint fibres.
      const dseg = abs(fract(uv.x.add(0.5)).sub(0.5));
      const poles = smoothstep(0.03, 0.14, uv.y).mul(smoothstep(0.97, 0.86, uv.y));
      const line = smoothstep(0.085, 0.03, dseg).mul(poles);
      const fibre = smoothstep(0.82, 1.0, sin(uv.x.mul(6.2832 * 2.0).add(uv.y.mul(31.0))).mul(0.5).add(0.5)).mul(0.35).mul(poles);
      const pith = vec3(0.98, 0.86, 0.66);
      const m = clamp(line.add(fibre), 0, 1);
      base.assign(mix(base, pith, m.mul(0.9)));
      turb.assign(mix(turb, 0.9, m));
    }).ElseIf(pattern.greaterThan(4.5), () => {
      // Opal: play-of-colour patches whose hue shifts with the view.
      const q = p.div(RARE_SIZE).mul(9.0);
      const w = sin(q.mul(vec3(1.7, 2.3, 1.9)).add(sin(q.yzx.mul(vec3(2.9, 2.1, 3.3))).mul(1.4)));
      const nse = dot(w, vec3(0.3333));
      const hue = fract(nse.mul(0.6).add(dot(v, n).mul(1.3)).add(q.x.mul(0.04)));
      const patch = smoothstep(0.15, 0.75, abs(sin(q.x.mul(1.3).add(q.y.mul(2.1)).add(nse.mul(3.0)))));
      const fire = hueRGB(hue);
      const vivid = fire.mul(fire).mul(0.85).add(0.06);
      base.assign(mix(base, vivid, patch.mul(0.62)));
      extra.assign(fire.mul(fire).mul(patch.mul(0.4)));
    });

    const thick = A.w.max(1e-5);
    const cosI = dot(n, v).negate().max(1e-3).toVar();
    const F = float(0.04).add(float(0.96).mul(pow(float(1).sub(cosI), 5.0))).toVar();
    const refl = rareEnvironment(toWorld(reflect(v, n))).mul(F).mul(1.25).toVar();

    // Sphere-approximated path: entry → chord → exit (Fresnel / TIR).
    const d1 = refractSafe(v, n, float(1.0 / IOR_SMOOTH)).toVar();
    const cosT = dot(d1, n).negate().max(0.02);
    const pathLen = thick.mul(2.0).mul(cosT);
    const sigma = log(max(base, vec3(0.02))).negate().div(thick.mul(1.25));
    const T = exp(sigma.mul(pathLen).negate()).toVar();
    const n2 = n.sub(d1.mul(dot(n, d1).mul(2.0)));
    const cosE = dot(d1, n2).max(1e-3);
    const F2 = fresnelDielectric(cosE, float(IOR_SMOOTH), float(1.0)).toVar();
    const exitW = toWorld(refractSafe(d1, n2.negate(), float(IOR_SMOOTH)));
    // Scattering media blur what they transmit: turbid jelly/candy sees the
    // soft environment, clear glass the sharp one.
    const seen = mix(rareEnvironment(exitW), rareEnvSoft(exitW), smoothstep(0.25, 0.75, turb));
    const glass = seen.mul(T).mul(float(1).sub(F2)).toVar();
    if (layers > 1) glass.addAssign(rareEnvSoft(toWorld(reflect(d1, n2))).mul(T).mul(T).mul(F2).mul(0.85));

    // Translucent scatter: light from around and through the body, in its colour;
    // the core (facing the viewer) is brighter and more saturated.
    const nW = toWorld(n);
    const sunWrap = clamp(dot(nW, v3(TO_SUN)).add(0.5).div(1.5), 0, 1);
    const irr = rareEnvSoft(nW).mul(0.5).add(rareEnvSoft(toWorld(v)).mul(0.5)).mul(sunWrap.mul(sunWrap).mul(0.5).add(0.75));
    const core = pow(cosI, 1.5);
    const albedo = pow(base, vec3(0.8));
    const scatter = albedo.mul(irr).mul(core.mul(0.55).add(0.42)).add(base.mul(core.mul(0.14)));
    const turbEff = turb.mul(core.mul(0.45).add(0.55));
    // Clear glass on a light studio reads by its dark refracted edges and
    // crisp reflections: darken the rim, sharpen the clearcoat.
    const clear = float(1).sub(smoothstep(0.0, 0.4, turb));
    const edge = smoothstep(0.3, 0.92, float(1).sub(cosI));
    glass.mulAssign(float(1).sub(clear.mul(edge).mul(0.55)));
    refl.mulAssign(clear.mul(0.5).add(1));
    const body = mix(glass, scatter, turbEff).mul(float(1).sub(F)).add(extra.mul(float(0.6).add(dot(refl, LUMA).min(1.5).mul(0.4))));

    return tierOverlay({
      p, n, v, cosI, dIn: d1, depth: thick.mul(0.6), body, refl, base, tier, glow,
      glitter: B.y, silver: B.w, sheen: B.z, layers, toWorld,
    });
  });
  const material = new THREE.MeshBasicNodeMaterial({ side: THREE.FrontSide, transparent: false, depthWrite: true, depthTest: true });
  material.name = `RareSmooth:${qualityId}`;
  // Unlit: the analytic environment is the lighting, so scene lights (e.g. a
  // thumbnail studio's hemisphere light) neither change the look nor add a
  // program variant.
  material.lights = false;
  material.colorNode = shade().mul(LIFT);
  return material;
}

// ---------------------------------------------------------------------------
// Facet material (per-part convex raytrace, as gems.js)
// ---------------------------------------------------------------------------

function createFacetMaterial(qualityId, planes) {
  const { channels, bounces, layers } = RARE_QUALITY[qualityId];
  const { tier, glow } = objectUniforms();
  const shade = Fn(() => {
    const col = attribute("rareColor", "vec3");
    const A = attribute("rareA", "vec4");
    const B = attribute("rareB", "vec4");
    const offset = int(A.x.add(0.5)).toVar();
    const count = int(A.y.add(0.5)).toVar();
    const iorBase = A.z.toVar();
    const irid = A.w.toVar();
    const { p: p0, v, toWorld } = shadingFrame();
    const n0 = normalize(normalGeometry).toVar();
    const cosI = dot(v, n0).negate().max(1e-4).toVar();
    const sigma = log(max(col, vec3(0.03))).negate().div(B.x.mul(ABSORB_DEPTH)).toVar();

    const fr = fresnelDielectric(cosI, float(1.0), iorBase);
    const refl = rareEnvironment(toWorld(reflect(v, n0))).mul(fr).toVar();
    const body = vec3(0).toVar();
    const spread = iorBase.sub(1.0).mul(IOR_SPREAD);

    Loop({ start: 0, end: channels, type: "int", name: "ch", condition: "<" }, ({ ch }) => {
      const ior = (channels === 1 ? iorBase : iorBase.add(float(ch).sub(1.0).mul(spread))).toVar();
      const mask = (channels === 1
        ? vec3(1.0)
        : vec3(select(ch.equal(0), 1.0, 0.0), select(ch.equal(1), 1.0, 0.0), select(ch.equal(2), 1.0, 0.0))).toVar();
      const d = refractSafe(v, n0, float(1.0).div(ior)).toVar();
      const p = vec3(p0).toVar();
      const throughput = float(1.0).sub(fresnelDielectric(cosI, float(1.0), ior)).toVar();
      const travelled = float(0.0).toVar();
      const radiance = vec3(0.0).toVar();

      Loop({ start: 0, end: bounces, type: "int", name: "bounce", condition: "<" }, ({ bounce }) => {
        If(throughput.lessThan(0.03), () => { Break(); });
        const tMin = float(1.0).toVar();
        const nHit = vec3(0.0, 0.0, 1.0).toVar();
        Loop({ start: int(0), end: count, type: "int", name: "pl", condition: "<" }, ({ pl }) => {
          const plane = planes.element(offset.add(pl));
          const dn = dot(d, plane.xyz);
          const t = plane.w.sub(dot(p, plane.xyz)).div(dn.max(1e-5));
          const hit = dn.greaterThan(1e-5).and(t.lessThan(tMin));
          tMin.assign(select(hit, t, tMin));
          nHit.assign(select(hit, plane.xyz, nHit));
        });
        tMin.assign(clamp(tMin, 0.0, RARE_SIZE * 2.0));
        p.addAssign(d.mul(tMin));
        travelled.addAssign(tMin);
        const cosX = dot(d, nHit).max(1e-4);
        const fx = fresnelDielectric(cosX, ior, float(1.0)).toVar();
        const exitDir = refractSafe(d, nHit.negate(), ior);
        const transmittance = exp(sigma.mul(travelled).negate());
        // Iridescent glass (cube): pastel thin-film tint along the path.
        const film = hueRGB(travelled.div(RARE_SIZE).mul(2.2).add(dot(exitDir, vec3(0.5, 0.7, 0.3)).mul(0.6)));
        // Straight-through light stays clear; internally reflected light is tinted.
        const filmTint = mix(vec3(1.0), mix(vec3(1.0), film, 0.6).mul(1.25), irid.mul(select(bounce.greaterThan(0), float(1.0), float(0.12))));
        radiance.addAssign(rareEnvironment(toWorld(exitDir)).mul(transmittance).mul(filmTint).mul(throughput.mul(float(1.0).sub(fx))));
        throughput.mulAssign(fx);
        d.assign(reflect(d, nHit));
      });
      radiance.addAssign(rareEnvironment(toWorld(d)).mul(exp(sigma.mul(travelled).negate())).mul(throughput.mul(TRAPPED_ESCAPE)));
      body.addAssign(radiance.mul(mask));
    });

    return tierOverlay({
      p: p0, n: n0, v, cosI, dIn: refractSafe(v, n0, float(1.0).div(iorBase)), depth: float(RARE_SIZE * 0.12),
      body, refl: refl.mul(float(1).add(irid.mul(0.3))), base: col, tier, glow, layers, toWorld,
    });
  });
  const material = new THREE.MeshBasicNodeMaterial({ side: THREE.FrontSide, transparent: false, depthWrite: true, depthTest: true });
  material.name = `RareFacet:${qualityId}`;
  // Unlit: the analytic environment is the lighting, so scene lights (e.g. a
  // thumbnail studio's hemisphere light) neither change the look nor add a
  // program variant.
  material.lights = false;
  material.colorNode = shade().mul(LIFT);
  return material;
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

const qualityId = (q) => (q === "medium" ? "mid" : RARE_QUALITY[q] ? q : "high");

/**
 * Rare gem library. Geometry is built lazily per gem (first access of
 * `gems[i].geometry` / `radius`, `makeObject`, or the layer), and all gems
 * share one two-entry material array per quality tier ([smooth, facet]).
 *
 * gems[i]: { id, label, family, color, index, radius (bounding sphere, m),
 *            geometry, materials, triangles, planeCount, makeObject(tier) }
 */
export function createRareGemLibrary({ quality = "high" } = {}) {
  // One library-wide uniform buffer holds the convex planes of every faceted
  // part; a shared group uploads it once (and again only when a gem is added).
  const planeData = new Float32Array(RARE_PLANE_BUDGET * 4);
  for (let i = 0; i < RARE_PLANE_BUDGET; i += 1) planeData.set([0, 0, 1, 1], i * 4);
  const hullGroup = sharedUniformGroup("rareHull");
  const planes = buffer(planeData, "vec4", RARE_PLANE_BUDGET).setGroup(hullGroup);
  let planesUsed = 0;

  const built = new Map();
  function build(index) {
    let entry = built.get(index);
    if (entry) return entry;
    const data = rareShapeData(index);
    if (planesUsed + data.planeCount > RARE_PLANE_BUDGET) throw new Error("rare gem plane budget exceeded");
    const base = planesUsed;
    planeData.set(data.planes, base * 4);
    planesUsed += data.planeCount;
    if (data.planeCount) hullGroup.needsUpdate = true;
    const partA = data.partA.slice();
    for (let v = data.facetVertexStart; v < data.vertexCount; v += 1) partA[v * 4] += base;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(data.positions.slice(), 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(data.normals.slice(), 3));
    geometry.setAttribute("rareColor", new THREE.BufferAttribute(data.colors.slice(), 3));
    geometry.setAttribute("rareA", new THREE.BufferAttribute(partA, 4));
    geometry.setAttribute("rareB", new THREE.BufferAttribute(data.partB.slice(), 4));
    geometry.setIndex(new THREE.BufferAttribute(data.indices.slice(), 1));
    for (const g of data.groups) geometry.addGroup(g.start, g.count, g.materialIndex);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), data.radius);
    geometry.computeBoundingBox();
    geometry.name = `RareGem:${data.id}`;
    entry = { geometry, data };
    built.set(index, entry);
    return entry;
  }

  const cache = new Map();
  const materials = [null, null]; // stable array instance shared by every mesh
  let current = null;

  function setQuality(tier) {
    const id = qualityId(tier);
    if (id === current) return;
    let set = cache.get(id);
    if (!set) {
      set = [createSmoothMaterial(id), createFacetMaterial(id, planes)];
      cache.set(id, set);
    }
    materials[0] = set[0];
    materials[1] = set[1];
    current = id;
  }

  function makeObject(index, tier = 0) {
    const i = Math.min(RARE_GEMS.length - 1, Math.max(0, index | 0));
    const mesh = new THREE.Mesh(build(i).geometry, materials);
    mesh.name = `RareGem:${RARE_GEMS[i].id}`;
    mesh.userData.rareIndex = i;
    mesh.userData.rareTier = Math.min(2, Math.max(0, Math.round(tier) || 0));
    mesh.userData.glow = 0;
    return mesh;
  }

  const gems = RARE_GEMS.map((info, index) => ({
    id: info.id,
    label: info.label,
    family: info.family,
    color: info.color,
    index,
    materials,
    get geometry() { return build(index).geometry; },
    get radius() { return build(index).data.radius; },
    get triangles() { return build(index).data.triangles; },
    get planeCount() { return build(index).data.planeCount; },
    makeObject: (tier = 0) => makeObject(index, tier),
  }));

  function dispose() {
    for (const set of cache.values()) for (const m of set) m.dispose();
    cache.clear();
    for (const { geometry } of built.values()) geometry.dispose();
    built.clear();
    planesUsed = 0;
    current = null;
  }

  setQuality(quality);
  return {
    gems,
    materials,
    get quality() { return current; },
    get planesUsed() { return planesUsed; },
    setQuality,
    makeObject,
    /** Builds every gem now (e.g. before a preview), instead of on first use. */
    buildAll() { for (let i = 0; i < RARE_GEMS.length; i += 1) build(i); },
    dispose,
  };
}

// ---------------------------------------------------------------------------
// Layer: pooled meshes driven by a flat state array (same contract as GemLayer)
// ---------------------------------------------------------------------------

export class RareGemLayer {
  constructor(parent, library) {
    this.parent = parent;
    this.library = library;
    this.glowScale = 1;
    this.meshes = [];
    for (let i = 0; i < MAX_RARE_GEMS; i += 1) {
      const mesh = library.makeObject(0, 0);
      mesh.name = "RareGem";
      mesh.visible = false;
      this.meshes.push(mesh);
      parent.add(mesh);
    }
  }

  // states: 10 floats per gem — rareIndex, tier (0..2), px, py, pz, qx, qy, qz,
  // qw, glow (0..1); parent-local coordinates. At most MAX_RARE_GEMS shown.
  update(states, count) {
    const gems = this.library.gems;
    const n = Math.max(0, Math.min(count | 0, MAX_RARE_GEMS, Math.floor(states.length / STATE_STRIDE)));
    for (let i = 0; i < n; i += 1) {
      const o = i * STATE_STRIDE;
      const mesh = this.meshes[i];
      const gem = gems[Math.min(gems.length - 1, Math.max(0, states[o] | 0))];
      const geometry = gem.geometry;
      if (mesh.geometry !== geometry) mesh.geometry = geometry;
      if (mesh.material !== this.library.materials) mesh.material = this.library.materials;
      const tier = Math.round(states[o + 1]);
      mesh.userData.rareTier = tier > 0 ? Math.min(tier, 2) : 0;
      mesh.position.set(states[o + 2], states[o + 3], states[o + 4]);
      mesh.quaternion.set(states[o + 5], states[o + 6], states[o + 7], states[o + 8]).normalize();
      const glow = states[o + 9];
      mesh.userData.glow = (glow > 0 ? Math.min(glow, 1) : 0) * this.glowScale;
      mesh.visible = true;
    }
    for (let i = n; i < MAX_RARE_GEMS; i += 1) this.meshes[i].visible = false;
  }

  setGlowScale(x) {
    this.glowScale = Number.isFinite(x) ? Math.min(Math.max(x, 0), 2) : 1;
  }

  dispose() {
    for (const mesh of this.meshes) mesh.removeFromParent();
    this.meshes.length = 0;
  }
}

// ---------------------------------------------------------------------------
// SVG icon
// ---------------------------------------------------------------------------

/** 48×48 SVG string: the gem's front silhouette in its colours + tier treatment. */
export function rareGemIconSVG(index, tier = 0) {
  return rareIconSVG(index, tier);
}
