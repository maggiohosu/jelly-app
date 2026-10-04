// Crystal "charm" gems that sit inside the jellies.
//
// Each gem is a small flat-shaded faceted mesh whose fragment shader treats the
// mesh as its own optical volume (a TSL port of the raytraced-diamond material
// from threejs-awesome-graphics-agent-skills, MIT, Copyright (c) 2026 Scott Sun):
//
//   front facet → exact Fresnel split → reflected ray samples an analytic studio
//   environment; refracted ray (per-channel IOR = dispersion) is followed inside
//   the gem for a bounded number of bounces. The exit facet is found against the
//   gem's CONVEX-HULL planes (uniform vec4 array, n·x = d), which is exact for
//   convex cuts and a close approximation for the notched ones. At every
//   internal hit the Fresnel-transmitted part leaves the gem (refracted, sampled
//   from the environment, Beer-Lambert tinted by the gem colour over the path
//   so far) and the reflected part (all of it under total internal reflection)
//   keeps bouncing.
//
// No textures, no storage buffers, no compute: uniforms + Loop/If only, so the
// same material runs on the WebGPU backend and on the WebGL2 fallback. The
// shader code is identical for all nine shapes of one quality tier (only uniform
// values differ), so the renderer compiles one program per tier, not per shape.
//
// Gems are OPAQUE (depthWrite, no blending) so the jelly's physical
// transmission, which only sees opaque objects drawn before it, refracts them.

import * as THREE from "three/webgpu";
import { ConvexHull } from "three/addons/math/ConvexHull.js";
import {
  Break,
  Fn,
  If,
  Loop,
  cameraPosition,
  clamp,
  cos,
  dot,
  exp,
  float,
  log,
  max,
  mix,
  modelWorldMatrix,
  modelWorldMatrixInverse,
  normalGeometry,
  normalize,
  positionGeometry,
  reflect,
  select,
  smoothstep,
  sqrt,
  uniform,
  uniformArray,
  vec3,
  vec4,
} from "three/tsl";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Longest extent of every gem in metres (a jelly is ~5 cm wide). */
export const GEM_SIZE = 0.0075;

export const GEM_SHAPES = Object.freeze([
  { id: "heart", label: "하트" },
  { id: "diamond", label: "다이아" },
  { id: "star", label: "별" },
  { id: "drop", label: "물방울" },
  { id: "moon", label: "달" },
  { id: "sakura", label: "벚꽃" },
  { id: "candy", label: "사탕" },
  { id: "bow", label: "리본" },
  { id: "apple", label: "사과" },
].map(Object.freeze));

export const GEM_COLORS = Object.freeze([
  { id: "pink", label: "핑크", hex: "#f4a3c4" },
  { id: "lavender", label: "라벤더", hex: "#c8b2f2" },
  { id: "sky", label: "하늘", hex: "#a6d2f5" },
  { id: "mint", label: "민트", hex: "#a6e8cc" },
  { id: "peach", label: "피치", hex: "#ffc3a3" },
  { id: "clear", label: "투명", hex: "#eef1f8" },
].map(Object.freeze));

/** Quality tiers: dispersion channels × internal bounces. */
export const GEM_TIERS = Object.freeze({
  high: Object.freeze({ channels: 3, bounces: 3 }),
  mid: Object.freeze({ channels: 3, bounces: 2 }),
  low: Object.freeze({ channels: 1, bounces: 2 }),
});

const MAX_PLANES = 48;
const MAX_GEMS = 24;
const STATE_STRIDE = 10;

// Optics. Crystal look: a little below diamond, strong fire.
const IOR = 2.0;
const IOR_SPREAD = 0.035; // R = IOR − spread, B = IOR + spread
// Path length (m) over which the transmitted light takes exactly the gem colour.
const ABSORB_DEPTH = GEM_SIZE * 0.6;
// Energy still trapped after the bounce budget escapes along its last direction.
const TRAPPED_ESCAPE = 0.85;
// Luminance the soft emission adds at glow = 1 (linear, before tone mapping).
const GLOW_LUMINANCE = 0.28;

// Environment frame (world space). The sun light travels along LIGHT_DIRECTION
// (same as stage.js), so the brightest panel sits at −LIGHT_DIRECTION.
const TO_SUN = new THREE.Vector3(0.6123724357, 0.5, -0.6123724357).normalize();

// ---------------------------------------------------------------------------
// Small pure-JS vector helpers (geometry is built without THREE so the SVG icon
// generator can reuse it without a renderer).
// ---------------------------------------------------------------------------

const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vscale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vlen = (a) => Math.hypot(a[0], a[1], a[2]);
const vnorm = (a) => { const l = vlen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const vlerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const TAU = Math.PI * 2;

/** Triangle soup with outward-orientation fixing by a hint direction. */
class Facets {
  constructor() { this.tris = []; }

  // hint: outward direction (array) or function(centroid) → direction.
  add(a, b, c, hint) {
    const n = vcross(vsub(b, a), vsub(c, a));
    if (vlen(n) < 1e-7) return;
    if (hint) {
      const h = typeof hint === "function" ? hint(vscale(vadd(vadd(a, b), c), 1 / 3)) : hint;
      if (vdot(n, h) < 0) { this.tris.push([a, c, b]); return; }
    }
    this.tris.push([a, b, c]);
  }

  quad(a, b, c, d, hint, flip = false) {
    if (flip) { this.add(a, b, d, hint); this.add(b, c, d, hint); } else { this.add(a, b, c, hint); this.add(a, c, d, hint); }
  }

  // Append another part through an orientation-preserving transform.
  merge(part, xf = (p) => p) {
    for (const [a, b, c] of part.tris) this.tris.push([xf(a), xf(b), xf(c)]);
    return this;
  }
}

// Zip two closed rings of equal length N. Ring vertices sit at parameter
// positions i + phase (phase 0 or 0.5) along the outline.
function zipRings(f, A, pa, B, pb, hint, zig = false) {
  const N = A.length;
  for (let i = 0; i < N; i += 1) {
    const j = (i + 1) % N;
    if (pa === pb) f.quad(A[i], A[j], B[j], B[i], hint, zig && (i & 1) === 1);
    else if (pb > pa) { f.add(A[i], A[j], B[i], hint); f.add(B[i], A[j], B[j], hint); }
    else { f.add(B[i], B[j], A[i], hint); f.add(A[i], B[j], A[j], hint); }
  }
}

function polygonCentroid(points) {
  let area = 0, cx = 0, cy = 0;
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i], q = points[(i + 1) % points.length];
    const cr = p[0] * q[1] - q[0] * p[1];
    area += cr; cx += (p[0] + q[0]) * cr; cy += (p[1] + q[1]) * cr;
  }
  if (Math.abs(area) < 1e-9) return [points[0][0], points[0][1]];
  return [cx / (3 * area), cy / (3 * area)];
}

/**
 * Faceted tent: a 2D outline (the girdle, in the XY plane, z = 0 unless the
 * point carries its own z) → crown rings radiating toward an apex or a flat
 * table on +Z, and a pavilion toward a culet on −Z. The outline must be
 * star-shaped about `center`.
 *
 * ring: { s: scale toward centre, h: height (number or (i) => number), phase: 0 | 0.5 }
 */
function tent(outline, { center = null, crown = [], apex = 0.25, table = false, pavilion = [], culet = -0.2, zig = false } = {}) {
  const N = outline.length;
  const c = center ?? polygonCentroid(outline);
  const girdle = outline.map((p) => [p[0], p[1], p[2] ?? 0]);
  const f = new Facets();
  const ringPoints = (ring) => {
    const pts = [];
    for (let i = 0; i < N; i += 1) {
      const a = girdle[i], b = girdle[(i + 1) % N];
      const base = ring.phase === 0.5 ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : [a[0], a[1]];
      const h = typeof ring.h === "function" ? ring.h(i) : ring.h;
      pts.push([c[0] + (base[0] - c[0]) * ring.s, c[1] + (base[1] - c[1]) * ring.s, h]);
    }
    return pts;
  };
  const side = (rings, tip, flat, sign) => {
    const hint = [0, 0, sign];
    let prev = girdle, phase = 0;
    for (const ring of rings) {
      const pts = ringPoints(ring);
      zipRings(f, prev, phase, pts, ring.phase, hint, zig);
      prev = pts; phase = ring.phase;
    }
    const centre = flat ? [c[0], c[1], prev.reduce((s, p) => s + p[2], 0) / N] : [c[0], c[1], tip];
    for (let i = 0; i < N; i += 1) f.add(prev[i], prev[(i + 1) % N], centre, hint);
  };
  side(crown, apex, table, 1);
  side(pavilion, culet, false, -1);
  return f;
}

/**
 * Lathe about +Y: rings { r, y, phase } from top to bottom, closed by a top
 * point (`top` = y) and a bottom point (`bottom` = y). `sides` facets around,
 * optional depth squash on Z.
 */
function lathe(rings, { sides = 10, top, bottom, squash = 1 } = {}) {
  const f = new Facets();
  const radial = (p) => [p[0], 0, p[2]];
  const pts = rings.map((ring) => {
    const out = [];
    for (let i = 0; i < sides; i += 1) {
      const a = TAU * (i + ring.phase) / sides;
      out.push([ring.r * Math.cos(a), ring.y, -ring.r * Math.sin(a) * squash]);
    }
    return out;
  });
  for (let k = 0; k + 1 < pts.length; k += 1) zipRings(f, pts[k], rings[k].phase, pts[k + 1], rings[k + 1].phase, radial);
  const first = pts[0], last = pts[pts.length - 1];
  for (let i = 0; i < sides; i += 1) {
    const j = (i + 1) % sides;
    f.add(first[i], first[j], [0, top, 0], [0, 1, 0]);
    f.add(last[i], last[j], [0, bottom, 0], [0, -1, 0]);
  }
  return f;
}

/** Prism (tube) between two points with an n-gon section, capped. */
function prism(a, b, radius, n = 5, radiusB = radius) {
  const f = new Facets();
  const axis = vnorm(vsub(b, a));
  const ref = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = vnorm(vcross(axis, ref)), w = vcross(axis, u);
  const ring = (p, r, k) => vadd(p, vadd(vscale(u, r * Math.cos(TAU * k / n)), vscale(w, r * Math.sin(TAU * k / n))));
  const A = [], B = [];
  for (let k = 0; k < n; k += 1) { A.push(ring(a, radius, k)); B.push(ring(b, radiusB, k)); }
  const mid = vscale(vadd(a, b), 0.5);
  const out = (p) => { const d = vsub(p, mid); return vsub(d, vscale(axis, vdot(d, axis))); };
  zipRings(f, A, 0, B, 0, out);
  for (let k = 0; k < n; k += 1) {
    f.add(A[k], A[(k + 1) % n], a, vscale(axis, -1));
    f.add(B[k], B[(k + 1) % n], b, axis);
  }
  return f;
}

// 2D/3D affine helpers for placing parts.
function placer({ scale = 1, sx = scale, sy = scale, sz = scale, rotZ = 0, rotX = 0, rotY = 0, at = [0, 0, 0] } = {}) {
  const cz = Math.cos(rotZ), snz = Math.sin(rotZ);
  const cx = Math.cos(rotX), snx = Math.sin(rotX);
  const cy = Math.cos(rotY), sny = Math.sin(rotY);
  return (p) => {
    let x = p[0] * sx, y = p[1] * sy, z = p[2] * sz;
    [x, y] = [x * cz - y * snz, x * snz + y * cz];
    [y, z] = [y * cx - z * snx, y * snx + z * cx];
    [x, z] = [x * cy + z * sny, -x * sny + z * cy];
    return [x + at[0], y + at[1], z + at[2]];
  };
}
const mirrorX = (p) => [-p[0], p[1], p[2]];
// Mirroring flips orientation; swap two vertices back.
function mirrored(part) {
  const f = new Facets();
  for (const [a, b, c] of part.tris) f.tris.push([mirrorX(a), mirrorX(c), mirrorX(b)]);
  return f;
}

// ---------------------------------------------------------------------------
// Shapes (unit-ish coordinates, front face toward +Z, up = +Y)
// ---------------------------------------------------------------------------

function heartShape() {
  const N = 18, outline = [];
  for (let k = 0; k < N; k += 1) {
    const t = -TAU * k / N; // counter-clockwise from the notch
    const s = Math.sin(t);
    outline.push([16 * s * s * s / 17, (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) / 17]);
  }
  return tent(outline, {
    center: [0, -0.12],
    crown: [{ s: 0.74, h: 0.15, phase: 0.5 }, { s: 0.4, h: 0.26, phase: 0 }],
    apex: 0.31,
    pavilion: [{ s: 0.58, h: -0.2, phase: 0.5 }],
    culet: -0.33,
  });
}

// Round brilliant (axis +Y, table up): octagonal girdle, 8 stars, 8 planar bezel
// kites, 8 upper-girdle, 8 planar pavilion-main kites, 8 lower-girdle → 41 planes.
function diamondShape() {
  const rt = 0.56, hc = 0.32, rs = 0.8, hp = 0.84, rl = 0.5;
  const c22 = Math.cos(Math.PI / 8);
  const ys = hc * (1 - rs * c22) / (1 - rt);
  const yl = -hp * (1 - rl * c22);
  const at = (r, a, y) => [r * Math.cos(a), y, -r * Math.sin(a)];
  const T = [], S = [], G = [], L = [];
  for (let i = 0; i < 8; i += 1) {
    const a = TAU * i / 8, b = a + Math.PI / 8;
    T.push(at(rt, a, hc)); G.push(at(1, a, 0)); S.push(at(rs, b, ys)); L.push(at(rl, b, yl));
  }
  const f = new Facets();
  const up = [0, 1, 0];
  const radial = (p) => [p[0], 0, p[2]];
  const tableC = [0, hc, 0], culet = [0, -hp, 0];
  for (let i = 0; i < 8; i += 1) {
    const j = (i + 1) % 8, h = (i + 7) % 8;
    f.add(T[i], T[j], tableC, up); // table
    f.add(T[i], T[j], S[i], radial); // star
    f.add(T[i], S[h], G[i], radial); // bezel kite (two coplanar halves)
    f.add(T[i], G[i], S[i], radial);
    f.add(S[i], G[i], G[j], radial); // upper girdle
    f.add(culet, L[h], G[i], radial); // pavilion main kite
    f.add(culet, G[i], L[i], radial);
    f.add(G[i], G[j], L[i], radial); // lower girdle
  }
  return f;
}

function starShape() {
  const outline = [];
  for (let k = 0; k < 10; k += 1) {
    const a = Math.PI / 2 + TAU * k / 10;
    const r = k % 2 === 0 ? 1 : 0.47;
    outline.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return tent(outline, {
    center: [0, 0],
    crown: [{ s: 0.5, h: (i) => (i % 2 === 0 ? 0.2 : 0.15), phase: 0 }],
    apex: 0.33,
    pavilion: [{ s: 0.5, h: (i) => (i % 2 === 0 ? -0.13 : -0.1), phase: 0 }],
    culet: -0.22,
    zig: true,
  });
}

function dropShape() {
  const N = 14, outline = [];
  for (let k = 0; k < N; k += 1) {
    const t = TAU * k / N;
    const x = 0.72 * Math.sin(t) * Math.pow(Math.sin(t / 2), 0.85);
    outline.push([x, Math.cos(t)]);
  }
  return tent(outline, {
    center: [0, -0.3],
    crown: [{ s: 0.66, h: 0.17, phase: 0.5 }, { s: 0.3, h: 0.27, phase: 0 }],
    table: true,
    pavilion: [{ s: 0.55, h: -0.2, phase: 0.5 }],
    culet: -0.33,
  });
}

function moonShape() {
  const c = [0.43, 0.08], r = 0.83, K = 14;
  const cl = Math.hypot(c[0], c[1]);
  const k0 = (1 + cl * cl - r * r) / 2;
  const alpha = Math.atan2(c[1], c[0]), beta = Math.acos(k0 / cl);
  const thA = alpha + beta, thB = alpha + TAU - beta;
  const hornA = [Math.cos(thA), Math.sin(thA)], hornB = [Math.cos(thB), Math.sin(thB)];
  const phA = Math.atan2(hornA[1] - c[1], hornA[0] - c[0]);
  let phB = Math.atan2(hornB[1] - c[1], hornB[0] - c[0]);
  while (phB < phA) phB += TAU;
  const O = [], I = [], T = [], B = [];
  for (let k = 0; k <= K; k += 1) {
    const t = k / K;
    const th = thA + (thB - thA) * t, ph = phA + (phB - phA) * t;
    const o = [Math.cos(th), Math.sin(th), 0];
    const i = [c[0] + r * Math.cos(ph), c[1] + r * Math.sin(ph), 0];
    const w = Math.hypot(o[0] - i[0], o[1] - i[1]);
    const fr = k === 0 || k === K ? 0.5 : 0.5 + (k % 2 ? 0.12 : -0.12);
    const top = vlerp(o, i, fr); top[2] = 0.46 * w;
    const bot = vlerp(o, i, 0.5); bot[2] = -0.32 * w;
    O.push(o); I.push(i); T.push(top); B.push(bot);
  }
  const f = new Facets();
  for (let k = 0; k < K; k += 1) {
    const z = (k & 1) === 1;
    f.quad(O[k], O[k + 1], T[k + 1], T[k], [0, 0, 1], z);
    f.quad(T[k], T[k + 1], I[k + 1], I[k], [0, 0, 1], !z);
    f.quad(O[k], O[k + 1], B[k + 1], B[k], [0, 0, -1], !z);
    f.quad(B[k], B[k + 1], I[k + 1], I[k], [0, 0, -1], z);
  }
  // Tilt like the reference crescent (horns up-right / down-right).
  return new Facets().merge(f, placer({ rotZ: -0.12 }));
}

function sakuraShape() {
  const f = new Facets();
  // One notched petal pointing +Y, faceted toward its own centre.
  const petal = tent([
    [0, 0.02], [0.38, 0.5], [0.35, 0.8], [0.16, 0.96], [0, 0.87], [-0.16, 0.96], [-0.35, 0.8], [-0.38, 0.5],
  ], {
    center: [0, 0.56],
    crown: [{ s: 0.52, h: 0.17, phase: 0.5 }],
    apex: 0.23,
    pavilion: [],
    culet: -0.15,
  });
  for (let k = 0; k < 5; k += 1) f.merge(petal, placer({ rotX: 0.16, rotZ: TAU * k / 5 }));
  const pistil = [];
  for (let k = 0; k < 6; k += 1) pistil.push([0.17 * Math.cos(TAU * k / 6), 0.17 * Math.sin(TAU * k / 6)]);
  f.merge(tent(pistil, { center: [0, 0], crown: [], apex: 0.3, pavilion: [], culet: -0.13 }));
  return f;
}

function candyShape() {
  const f = new Facets();
  const N = 10, centre = [];
  for (let k = 0; k < N; k += 1) {
    const a = TAU * (k + 0.5) / N;
    centre.push([0.43 * Math.cos(a), 0.4 * Math.sin(a)]);
  }
  f.merge(tent(centre, {
    center: [0, 0],
    crown: [{ s: 0.78, h: 0.17, phase: 0.5 }, { s: 0.48, h: 0.27, phase: 0 }],
    table: true,
    pavilion: [{ s: 0.62, h: -0.18, phase: 0.5 }],
    culet: -0.3,
  }));
  // Wrapper wing: pinched at the centre, fanned and scalloped at the end, with
  // pleats (alternating girdle heights) radiating from the pinch.
  const wing = tent([
    [0.3, 0.08, 0], [0.55, 0.24, 0.02], [0.86, 0.46, 0.04], [0.98, 0.36, -0.03], [0.93, 0.18, 0.04], [1.0, 0.0, -0.03],
    [0.93, -0.18, 0.04], [0.98, -0.36, -0.03], [0.86, -0.46, 0.04], [0.55, -0.24, 0.02], [0.3, -0.08, 0],
  ], {
    center: [0.5, 0],
    crown: [{ s: 0.5, h: 0.13, phase: 0.5 }],
    apex: 0.16,
    pavilion: [],
    culet: -0.12,
  });
  f.merge(wing);
  f.merge(mirrored(wing));
  return new Facets().merge(f, placer({ rotZ: 0.38 }));
}

function bowShape() {
  const f = new Facets();
  // Loop (right side; mirrored for the left). Narrow at the knot, round outside.
  const loop = tent([
    [0.1, 0.07], [0.32, 0.36], [0.6, 0.58], [0.86, 0.6], [1.0, 0.42], [0.98, 0.14],
    [0.86, -0.1], [0.6, -0.2], [0.32, -0.16], [0.1, -0.06],
  ], {
    center: [0.55, 0.15],
    crown: [{ s: 0.5, h: 0.2, phase: 0.5 }],
    apex: 0.24,
    pavilion: [],
    culet: -0.16,
  });
  // Tail: ribbon hanging down-right with a V-notched end.
  const tail = tent([
    [0.04, -0.06], [0.2, -0.14], [0.66, -0.78], [0.5, -0.76], [0.42, -0.95], [0.12, -0.5], [0.0, -0.2],
  ], {
    center: [0.25, -0.42],
    crown: [{ s: 0.45, h: 0.12, phase: 0.5 }],
    apex: 0.14,
    pavilion: [],
    culet: -0.1,
  });
  f.merge(loop).merge(mirrored(loop)).merge(tail).merge(mirrored(tail));
  const knot = [];
  for (let k = 0; k < 8; k += 1) {
    const a = TAU * (k + 0.5) / 8;
    knot.push([0.17 * Math.sign(Math.cos(a)) * Math.pow(Math.abs(Math.cos(a)), 0.6), 0.03 + 0.19 * Math.sign(Math.sin(a)) * Math.pow(Math.abs(Math.sin(a)), 0.6)]);
  }
  f.merge(tent(knot, { center: [0, 0.03], crown: [{ s: 0.6, h: 0.27, phase: 0.5 }], apex: 0.32, pavilion: [], culet: -0.22 }));
  return f;
}

function appleShape() {
  const f = new Facets();
  f.merge(lathe([
    { r: 0.3, y: 0.74, phase: 0 },
    { r: 0.72, y: 0.66, phase: 0.5 },
    { r: 0.97, y: 0.3, phase: 0 },
    { r: 0.93, y: -0.16, phase: 0.5 },
    { r: 0.66, y: -0.58, phase: 0 },
    { r: 0.3, y: -0.76, phase: 0.5 },
  ], { sides: 10, top: 0.56, bottom: -0.7 }));
  f.merge(prism([0, 0.6, 0], [0.1, 1.04, 0], 0.05, 5, 0.04));
  const leaf = tent([
    [0, 0], [0.24, 0.2], [0.55, 0.26], [0.82, 0.15], [1, 0], [0.82, -0.12], [0.55, -0.22], [0.24, -0.17],
  ], { center: [0.46, 0.02], crown: [], apex: 0.08, pavilion: [], culet: -0.06 });
  f.merge(leaf, placer({ scale: 0.56, rotZ: 0.55, rotX: -0.35, at: [0.1, 0.92, 0.02] }));
  return f;
}

const SHAPE_BUILDERS = [heartShape, diamondShape, starShape, dropShape, moonShape, sakuraShape, candyShape, bowShape, appleShape];

// Cached shape data in metres, centred at the volume centroid, longest extent
// = GEM_SIZE: { positions: Float32Array (9 per triangle), normals, radius }.
const shapeCache = new Map();

function shapeData(index) {
  let data = shapeCache.get(index);
  if (data) return data;
  const tris = SHAPE_BUILDERS[index]().tris;
  // Volume centroid (signed tetrahedra; parts overlap slightly, which is fine).
  let vol = 0; const cen = [0, 0, 0];
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const [a, b, c] of tris) {
    const v = vdot(a, vcross(b, c)) / 6;
    vol += v;
    for (let k = 0; k < 3; k += 1) cen[k] += (a[k] + b[k] + c[k]) * v / 4;
    for (const p of [a, b, c]) for (let k = 0; k < 3; k += 1) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
  }
  const centre = Math.abs(vol) > 1e-9 ? vscale(cen, 1 / vol) : vscale(vadd(min, max), 0.5);
  const scale = GEM_SIZE / Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const positions = new Float32Array(tris.length * 9);
  const normals = new Float32Array(tris.length * 9);
  let radius = 0;
  tris.forEach((tri, t) => {
    const p = tri.map((v) => vscale(vsub(v, centre), scale));
    const n = vnorm(vcross(vsub(p[1], p[0]), vsub(p[2], p[0])));
    for (let k = 0; k < 3; k += 1) {
      positions.set(p[k], t * 9 + k * 3);
      normals.set(n, t * 9 + k * 3);
      radius = Math.max(radius, vlen(p[k]));
    }
  });
  data = { positions, normals, radius, triangles: tris.length };
  shapeCache.set(index, data);
  return data;
}

// ---------------------------------------------------------------------------
// Convex-hull planes (n·x = d, outward n), reduced to ≤ MAX_PLANES
// ---------------------------------------------------------------------------

function hullPlanes(positions) {
  const seen = new Map(), points = [];
  for (let i = 0; i < positions.length; i += 3) {
    const key = `${Math.round(positions[i] * 1e7)},${Math.round(positions[i + 1] * 1e7)},${Math.round(positions[i + 2] * 1e7)}`;
    if (seen.has(key)) continue;
    seen.set(key, true);
    points.push(new THREE.Vector3(positions[i], positions[i + 1], positions[i + 2]));
  }
  const hull = new ConvexHull().setFromPoints(points);
  const eps = GEM_SIZE * 1e-4;
  let planes = [];
  for (const face of hull.faces) {
    const n = [face.normal.x, face.normal.y, face.normal.z];
    const match = planes.find((p) => vdot(p.n, n) > 0.99995 && Math.abs(p.d - face.constant) < eps);
    if (match) match.area += face.area;
    else planes.push({ n, d: face.constant, area: face.area });
  }
  // Agglomerate the cheapest pair (similar normals, small facets) until within
  // budget. The merged plane is the support plane of the area-weighted normal,
  // so the reduced polytope still contains the gem.
  while (planes.length > MAX_PLANES) {
    let best = Infinity, bi = 0, bj = 1;
    for (let i = 0; i < planes.length; i += 1) for (let j = i + 1; j < planes.length; j += 1) {
      const cost = (1 - vdot(planes[i].n, planes[j].n)) * Math.min(planes[i].area, planes[j].area);
      if (cost < best) { best = cost; bi = i; bj = j; }
    }
    const a = planes[bi], b = planes[bj];
    const n = vnorm(vadd(vscale(a.n, a.area), vscale(b.n, b.area)));
    let d = -Infinity;
    for (const p of points) d = Math.max(d, n[0] * p.x + n[1] * p.y + n[2] * p.z);
    planes.splice(bj, 1);
    planes[bi] = { n, d, area: a.area + b.area };
  }
  const out = new Float32Array(planes.length * 4);
  planes.forEach((p, i) => out.set([p.n[0], p.n[1], p.n[2], p.d], i * 4));
  return out;
}

// ---------------------------------------------------------------------------
// TSL optics
// ---------------------------------------------------------------------------

// Exact unpolarised dielectric Fresnel n1 → n2; 1 past the critical angle.
const fresnelDielectric = /*@__PURE__*/ Fn(([cosI, n1, n2]) => {
  const eta = n1.div(n2);
  const sinT2 = eta.mul(eta).mul(float(1).sub(cosI.mul(cosI)));
  const cosT = sqrt(float(1).sub(sinT2).max(1e-6));
  const rs = n1.mul(cosI).sub(n2.mul(cosT)).div(n1.mul(cosI).add(n2.mul(cosT)));
  const rp = n2.mul(cosI).sub(n1.mul(cosT)).div(n2.mul(cosI).add(n1.mul(cosT)));
  return select(sinT2.greaterThanEqual(1.0), float(1.0), rs.mul(rs).add(rp.mul(rp)).mul(0.5).clamp(0.0, 1.0));
}).setLayout({
  name: "gemFresnel",
  type: "float",
  inputs: [{ name: "cosI", type: "float" }, { name: "n1", type: "float" }, { name: "n2", type: "float" }],
});

// Refraction that never returns a zero vector (under TIR the result is a
// finite grazing direction; callers weight it by 1 − F = 0 there).
const refractSafe = /*@__PURE__*/ Fn(([I, N, eta]) => {
  const c = dot(N, I).negate();
  const k = float(1).sub(eta.mul(eta).mul(float(1).sub(c.mul(c))));
  return normalize(I.mul(eta).add(N.mul(eta.mul(c).sub(sqrt(k.max(0.0))))));
}).setLayout({
  name: "gemRefract",
  type: "vec3",
  inputs: [{ name: "I", type: "vec3" }, { name: "N", type: "vec3" }, { name: "eta", type: "float" }],
});

const v3 = (v) => vec3(v.x, v.y, v.z);
const dir3 = (x, y, z) => v3(new THREE.Vector3(x, y, z).normalize());
// Soft disc light: angular radius `radius` (rad), feathered by `soft`.
const disc = (d, axis, radius, soft) => smoothstep(Math.cos(radius + soft), Math.cos(radius), dot(d, axis));

/**
 * Analytic studio environment (world direction → linear HDR radiance).
 * Cool sky-ish top, lavender-grey horizon, warm floor bounce, a dark flag on
 * the viewer side (crown contrast), a pastel iridescent pink → lavender → sky
 * hue drift by direction (holographic look), a warm key panel at the sun
 * (HDR, drives bloom), four soft boxes and three tiny hot glints for twinkle.
 * The sun direction mirrors stage.js LIGHT_DIRECTION; keep them in sync.
 */
const gemEnvironment = /*@__PURE__*/ Fn(([d]) => {
  const y = d.y;
  const sky = mix(vec3(0.6, 0.6, 0.7), vec3(0.86, 0.92, 1.08), smoothstep(0.08, 0.9, y));
  const floor = mix(vec3(0.62, 0.58, 0.56), vec3(0.74, 0.66, 0.58), smoothstep(-0.08, -0.7, y));
  const base = mix(floor, sky, smoothstep(-0.1, 0.1, y))
    // dark flag toward the viewer side: contrast for the table/crown
    .mul(float(1.0).sub(disc(d, dir3(0.0, 0.25, 1.0), 0.35, 0.3).mul(0.5)));
  // Iridescent drift: weights of a 3-colour cyclic palette (weights sum to 1.5).
  const h = dot(d, vec3(1.7, 0.9, 1.25)).add(d.y.mul(d.x).mul(1.6));
  const w = cos(h.mul(2.2).sub(vec3(0.0, 2.0944, 4.18879))).mul(0.5).add(0.5);
  const tint = vec3(1.0, 0.68, 0.86).mul(w.x).add(vec3(0.8, 0.7, 1.0).mul(w.y)).add(vec3(0.64, 0.86, 1.0).mul(w.z)).div(1.5);
  const sunDot = dot(d, v3(TO_SUN));
  const key = smoothstep(Math.cos(0.2), Math.cos(0.09), sunDot).mul(13.0)
    .add(sunDot.max(0).pow(10).mul(0.9));
  const boxes = disc(d, dir3(0.25, 0.85, 0.47), 0.3, 0.1).mul(2.8)
    .add(disc(d, dir3(-0.62, 0.55, 0.56), 0.22, 0.08).mul(3.2))
    .add(disc(d, dir3(0.75, 0.15, 0.1), 0.25, 0.1).mul(2.4))
    .add(disc(d, dir3(-0.55, 0.35, -0.75), 0.2, 0.08).mul(2.4));
  const glints = disc(d, dir3(-0.15, 0.97, -0.2), 0.045, 0.03)
    .add(disc(d, dir3(0.85, 0.25, 0.46), 0.05, 0.03))
    .add(disc(d, dir3(-0.9, 0.1, -0.1), 0.05, 0.03)).mul(9.0);
  return base.mul(tint).add(vec3(1.0, 0.95, 0.86).mul(key)).add(mix(vec3(1.0), tint, 0.5).mul(boxes)).add(glints);
}).setLayout({ name: "gemEnvironment", type: "vec3", inputs: [{ name: "d", type: "vec3" }] });

function createGemMaterial(planes, tier) {
  const { channels, bounces } = GEM_TIERS[tier];
  const planeCount = planes.length / 4;
  const planeVectors = [];
  for (let i = 0; i < MAX_PLANES; i += 1) {
    planeVectors.push(i < planeCount
      ? new THREE.Vector4(planes[i * 4], planes[i * 4 + 1], planes[i * 4 + 2], planes[i * 4 + 3])
      : new THREE.Vector4(0, 0, 1, 1));
  }
  // A fixed name keeps the generated WGSL identical for every shape, so the
  // WebGPU backend shares one pipeline per tier (GLSL names buffers by id).
  const planeArray = uniformArray(planeVectors, "vec4").setName("gemHullPlanes");
  const planeCountU = uniform(planeCount, "int");
  const gemColor = uniform(new THREE.Color(1, 1, 1)).onObjectUpdate(({ object }, self) => {
    const c = object.userData.gemColor;
    if (c && c.isColor) self.value.copy(c);
  });
  const glow = uniform(0).onObjectUpdate(({ object }) => object.userData.glow ?? 0);

  const shade = Fn(() => {
    const camLocal = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1.0)).xyz;
    const p0 = positionGeometry.toVar();
    const n0 = normalize(normalGeometry).toVar();
    const v = normalize(p0.sub(camLocal)).toVar();
    const toWorld = (d) => normalize(modelWorldMatrix.mul(vec4(d, 0.0)).xyz);
    const cosI = dot(v, n0).negate().max(1e-4).toVar();
    // Beer-Lambert extinction from the gem colour (already linear).
    const sigma = log(max(gemColor, vec3(0.03))).negate().div(ABSORB_DEPTH).toVar();

    const outRadiance = vec3(0).toVar();
    // Front-surface reflection.
    const fr = fresnelDielectric(cosI, float(1.0), float(IOR));
    outRadiance.addAssign(gemEnvironment(toWorld(reflect(v, n0))).mul(fr));

    Loop({ start: 0, end: channels, type: "int", name: "ch", condition: "<" }, ({ ch }) => {
      const ior = (channels === 1 ? float(IOR) : float(IOR).add(float(ch).sub(1.0).mul(IOR_SPREAD))).toVar();
      const mask = (channels === 1
        ? vec3(1.0)
        : vec3(select(ch.equal(0), 1.0, 0.0), select(ch.equal(1), 1.0, 0.0), select(ch.equal(2), 1.0, 0.0))).toVar();
      const d = refractSafe(v, n0, float(1.0).div(ior)).toVar();
      const p = vec3(p0).toVar();
      const throughput = float(1.0).sub(fresnelDielectric(cosI, float(1.0), ior)).toVar();
      const travelled = float(0.0).toVar();
      const radiance = vec3(0.0).toVar();

      Loop({ start: 0, end: bounces, type: "int", name: "bounce", condition: "<" }, () => {
        // Nothing left worth tracing (two non-TIR exits leave ~1 %).
        If(throughput.lessThan(0.03), () => { Break(); });
        const tMin = float(1.0).toVar();
        const nHit = vec3(0.0, 0.0, 1.0).toVar();
        Loop({ start: 0, end: planeCountU, type: "int", name: "pl", condition: "<" }, ({ pl }) => {
          const plane = planeArray.element(pl);
          const dn = dot(d, plane.xyz);
          const t = plane.w.sub(dot(p, plane.xyz)).div(dn.max(1e-5));
          const hit = dn.greaterThan(1e-5).and(t.lessThan(tMin));
          tMin.assign(select(hit, t, tMin));
          nHit.assign(select(hit, plane.xyz, nHit));
        });
        tMin.assign(clamp(tMin, 0.0, GEM_SIZE * 2.0));
        p.addAssign(d.mul(tMin));
        travelled.addAssign(tMin);
        const cosX = dot(d, nHit).max(1e-4);
        const fx = fresnelDielectric(cosX, ior, float(1.0)).toVar();
        const exitDir = refractSafe(d, nHit.negate(), ior);
        const transmittance = exp(sigma.mul(travelled).negate());
        radiance.addAssign(gemEnvironment(toWorld(exitDir)).mul(transmittance).mul(throughput.mul(float(1.0).sub(fx))));
        throughput.mulAssign(fx);
        d.assign(reflect(d, nHit));
      });
      // Light still bouncing after the budget leaves along its last direction.
      radiance.addAssign(gemEnvironment(toWorld(d)).mul(exp(sigma.mul(travelled).negate())).mul(throughput.mul(TRAPPED_ESCAPE)));
      outRadiance.addAssign(radiance.mul(mask));
    });

    // Soft coloured emission when the gem "radiates" (glow = state × slider):
    // the squared pastel colour is the saturated hue; a little stronger where
    // the facet faces the viewer, so the light seems to come from inside.
    // Normalised to a fixed luminance so every colour (even 'clear') glows alike.
    const hue = gemColor.mul(gemColor).toVar();
    const hueLum = dot(hue, vec3(0.2126, 0.7152, 0.0722)).max(0.05);
    const emission = hue.mul(glow.mul(cosI.mul(0.45).add(0.55)).mul(GLOW_LUMINANCE).div(hueLum));
    outRadiance.addAssign(emission);
    return outRadiance;
  });

  const material = new THREE.MeshBasicNodeMaterial({ side: THREE.FrontSide, transparent: false, depthWrite: true, depthTest: true });
  material.name = `GemCrystal:${tier}`;
  material.colorNode = shade();
  return material;
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

/**
 * Builds the nine gem shapes. Each entry: { id, label, geometry, material,
 * radius (bounding sphere, m), planes (Float32Array vec4 n.xyz,d with n·x = d,
 * local), triangles }. Materials are built lazily per quality tier and cached.
 */
export function createGemLibrary({ quality = "high" } = {}) {
  const shapes = GEM_SHAPES.map((info, index) => {
    const data = shapeData(index);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(data.positions.slice(), 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(data.normals.slice(), 3));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), data.radius);
    geometry.computeBoundingBox();
    geometry.name = `Gem:${info.id}`;
    return {
      id: info.id,
      label: info.label,
      geometry,
      material: null,
      radius: data.radius,
      planes: hullPlanes(data.positions),
      triangles: data.triangles,
    };
  });
  const cache = new Map();
  let current = null;

  function setQuality(tier) {
    const id = GEM_TIERS[tier] ? tier : "high";
    if (id === current) return;
    let materials = cache.get(id);
    if (!materials) {
      materials = shapes.map((shape) => createGemMaterial(shape.planes, id));
      cache.set(id, materials);
    }
    shapes.forEach((shape, i) => { shape.material = materials[i]; });
    current = id;
  }

  function dispose() {
    for (const materials of cache.values()) for (const m of materials) m.dispose();
    cache.clear();
    for (const shape of shapes) shape.geometry.dispose();
    current = null;
  }

  setQuality(quality);
  return {
    shapes,
    get quality() { return current; },
    setQuality,
    dispose,
  };
}

// ---------------------------------------------------------------------------
// Layer: pooled meshes driven by a flat state array
// ---------------------------------------------------------------------------

export class GemLayer {
  constructor(parent, library) {
    this.parent = parent;
    this.library = library;
    this.glowScale = 1;
    this.colors = GEM_COLORS.map((c) => new THREE.Color(c.hex));
    this.meshes = [];
    const first = library.shapes[0];
    for (let i = 0; i < MAX_GEMS; i += 1) {
      const mesh = new THREE.Mesh(first.geometry, first.material);
      mesh.name = "Gem";
      mesh.visible = false;
      mesh.userData.gemColor = new THREE.Color(1, 1, 1);
      mesh.userData.glow = 0;
      this.meshes.push(mesh);
      parent.add(mesh);
    }
  }

  // states: 10 floats per gem — shapeIndex, colorIndex, px, py, pz, qx, qy, qz,
  // qw, glow (0..1); parent-local coordinates.
  update(states, count) {
    const shapes = this.library.shapes;
    const n = Math.max(0, Math.min(count | 0, MAX_GEMS, Math.floor(states.length / STATE_STRIDE)));
    for (let i = 0; i < n; i += 1) {
      const o = i * STATE_STRIDE;
      const mesh = this.meshes[i];
      const shape = shapes[Math.min(shapes.length - 1, Math.max(0, states[o] | 0))];
      const color = this.colors[Math.min(this.colors.length - 1, Math.max(0, states[o + 1] | 0))];
      if (mesh.geometry !== shape.geometry) mesh.geometry = shape.geometry;
      if (mesh.material !== shape.material) mesh.material = shape.material;
      mesh.userData.gemColor.copy(color);
      mesh.position.set(states[o + 2], states[o + 3], states[o + 4]);
      mesh.quaternion.set(states[o + 5], states[o + 6], states[o + 7], states[o + 8]).normalize();
      const glow = states[o + 9];
      mesh.userData.glow = (glow > 0 ? Math.min(glow, 1) : 0) * this.glowScale;
      mesh.visible = true;
    }
    for (let i = n; i < MAX_GEMS; i += 1) this.meshes[i].visible = false;
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
// SVG icon (front view of the real facet geometry, painter-sorted)
// ---------------------------------------------------------------------------

const iconCache = new Map();

function hexToRgb(hex) {
  const v = parseInt(String(hex).replace("#", "").padEnd(6, "0").slice(0, 6), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
const mixRgb = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const rgbCss = (c) => `rgb(${c.map((x) => Math.round(Math.min(255, Math.max(0, x)))).join(",")})`;

const fmt = (x) => { const r = Math.round(x * 10) / 10; return String(r); };

/** SVG markup (48×48) of a pastel faceted icon of the shape. */
export function gemIconSVG(shapeIndex, colorHex = GEM_COLORS[0].hex) {
  const index = Math.min(SHAPE_BUILDERS.length - 1, Math.max(0, shapeIndex | 0));
  const key = `${index}|${colorHex}`;
  const cached = iconCache.get(key);
  if (cached) return cached;
  const { positions, normals } = shapeData(index);
  const size = 48, pad = 3.5;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]); maxX = Math.max(maxX, positions[i]);
    minY = Math.min(minY, positions[i + 1]); maxY = Math.max(maxY, positions[i + 1]);
  }
  const s = (size - pad * 2) / Math.max(maxX - minX, maxY - minY);
  const ox = size / 2 - (minX + maxX) / 2 * s, oy = size / 2 + (minY + maxY) / 2 * s;
  const base = hexToRgb(colorHex);
  // Saturated "deep" tone of the pastel; near-white colours get a cool slate.
  let deep = base.map((c) => Math.max(0, c - (255 - c) * 1.05));
  if (0.2126 * deep[0] + 0.7152 * deep[1] + 0.0722 * deep[2] > 190) deep = mixRgb(deep, [150, 160, 200], 0.55);
  const lav = hexToRgb("#c8b2f2"), sky = hexToRgb("#a6d2f5");
  const light = vnorm([-0.5, 0.62, 0.6]);
  const half = vnorm(vadd(light, [0, 0, 1]));
  const faces = [];
  let best = null;
  for (let t = 0; t < positions.length / 9; t += 1) {
    const n = [normals[t * 9], normals[t * 9 + 1], normals[t * 9 + 2]];
    if (n[2] < 0.03) continue;
    const xs = [], ys = [], zs = [];
    for (let k = 0; k < 3; k += 1) {
      const o = t * 9 + k * 3;
      xs.push(ox + positions[o] * s); ys.push(oy - positions[o + 1] * s); zs.push(positions[o + 2]);
    }
    // Shade by facet tilt (front-facing facets differ mostly in tilt).
    const lit = Math.max(0, Math.min(1, 0.55 + 1.05 * (n[0] * light[0] + n[1] * light[1]) + 0.15 * (n[2] - 0.8)));
    const spec = Math.pow(Math.max(0, vdot(half, n)), 40);
    // Facet ramp: deep → pastel → white, with a lavender/sky drift by facet tilt.
    let col = lit < 0.5 ? mixRgb(deep, base, lit * 2) : mixRgb(base, [255, 255, 255], (lit - 0.5) * 1.5);
    col = mixRgb(col, n[0] < 0 ? lav : sky, 0.28 * Math.abs(n[0]) * (1 - spec));
    col = mixRgb(col, [255, 255, 255], Math.min(1, spec * 1.4));
    const d = `${fmt(xs[0])},${fmt(ys[0])} ${fmt(xs[1])},${fmt(ys[1])} ${fmt(xs[2])},${fmt(ys[2])}`;
    const face = { z: (zs[0] + zs[1] + zs[2]) / 3, d, fill: rgbCss(col), score: lit + spec, cx: (xs[0] + xs[1] + xs[2]) / 3, cy: (ys[0] + ys[1] + ys[2]) / 3 };
    if (!best || face.score > best.score) best = face;
    faces.push(face);
  }
  faces.sort((a, b) => a.z - b.z);
  const outline = rgbCss(mixRgb(deep, [90, 80, 120], 0.15));
  let silhouette = "", body = "";
  for (const f of faces) {
    silhouette += `M${f.d.replace(/ /g, "L")}Z`;
    body += `<polygon points="${f.d}" fill="${f.fill}"/>`;
  }
  const sx = best ? best.cx : size * 0.35, sy = best ? best.cy : size * 0.3;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">`
    + `<path d="${silhouette}" fill="${outline}" stroke="${outline}" stroke-width="1.5" stroke-linejoin="round"/>`
    + `<g stroke="rgba(255,255,255,0.4)" stroke-width="0.3" stroke-linejoin="round">${body}</g>`
    + `<path d="M${fmt(sx)} ${fmt(sy - 4)}l0.9 3.1 3.1 0.9-3.1 0.9-0.9 3.1-0.9-3.1-3.1-0.9 3.1-0.9z" fill="#fff"/>`
    + `</svg>`;
  iconCache.set(key, svg);
  return svg;
}
