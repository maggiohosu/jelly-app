// Rare gems: pure-JS geometry (no three.js import, so it runs in Node tests and
// in the SVG icon generator).
//
// 25 rare gems in five families. Every gem is a list of parts:
//   smooth — indexed mesh with smooth normals (SDF surface nets with exact
//            gradient normals, or parametric lathes/tori/tubes with welded
//            normals); shaded by the glossy jelly/candy/glass material.
//   facet  — flat-shaded convex(-ish) polyhedron; shaded by the raytraced
//            crystal material, which intersects THIS PART's own convex
//            planes (support planes of its facet normals). Concave charms
//            (crown, swan, bear …) are composed of many such parts, so no
//            hole or notch is ever filled by one big hull.
//
// rareShapeData(i) merges the parts into one interleaved-free set of arrays,
// centred on the bounding-box centre and scaled so the longest extent is
// RARE_SIZE, ready for a single BufferGeometry with two groups
// (0 = smooth triangles, 1 = facet triangles).
//
// Per-vertex part data (constant over a part, so interpolation is exact):
//   rareColor (vec3)  linear RGB of the part
//   rareA     (vec4)  smooth: [pattern, patternU, patternV, thickness (m)]
//                     facet:  [planeOffset, planeCount, ior, iridescence]
//   rareB     (vec4)  smooth: [turbidity, glitter, sheen, silverGlitter]
//                     facet:  [absorption scale, 0, 0, 1]
// planeOffset indexes data.planes (gem-local; the renderer adds a base to the
// facet vertices, i.e. those from data.facetVertexStart on).

export const RARE_SIZE = 0.0075 * 1.5;
export const RARE_TRIANGLE_BUDGET = 3000;
/**
 * Convex planes of all 25 gems together (vec4 each) live in one uniform
 * block; 896 × 16 B = 14 KB stays under WebGL2's 16 KB minimum block size.
 */
export const RARE_PLANE_BUDGET = 896;

export const RARE_PATTERN = Object.freeze({ none: 0, swirl: 1, stripes: 2, seeds: 3, segments: 4, opal: 5 });

export const RARE_FAMILIES = Object.freeze([
  Object.freeze({ id: "puffy", label: "말랑" }),
  Object.freeze({ id: "crystal", label: "크리스탈" }),
  Object.freeze({ id: "charm", label: "참" }),
  Object.freeze({ id: "candy", label: "캔디" }),
  Object.freeze({ id: "fruit", label: "유리 과일" }),
]);

export const RARE_GEM_INFO = Object.freeze([
  ["capsule", "캡슐", "puffy", "#f48aa6"],
  ["clover", "클로버", "puffy", "#ff9a2e"],
  ["donut", "도넛", "puffy", "#b39af0"],
  ["cloud", "구름", "puffy", "#ff7a6b"],
  ["triangle", "세모", "puffy", "#3a9af0"],
  ["opal", "오팔", "crystal", "#d3d6ea"],
  ["cube", "큐브", "crystal", "#e9eefb"],
  ["brilliant", "브릴리언트", "crystal", "#7b86ee"],
  ["ring", "반지", "crystal", "#eef2f8"],
  ["twist", "꼬임리본", "crystal", "#f1f3f9"],
  ["butterfly", "나비", "charm", "#f4a3c4"],
  ["crown", "왕관", "charm", "#f4a3c4"],
  ["rose", "장미", "charm", "#f4a3c4"],
  ["bear", "곰돌이", "charm", "#f4a3c4"],
  ["swan", "백조", "charm", "#f4a3c4"],
  ["gummybear", "곰젤리", "candy", "#f0477a"],
  ["lollipop", "막대사탕", "candy", "#ff8fc8"],
  ["candycane", "지팡이사탕", "candy", "#e8304a"],
  ["ringpop", "반지사탕", "candy", "#a66ee0"],
  ["jellybean", "젤리빈", "candy", "#e9406f"],
  ["strawberry", "딸기", "fruit", "#f5e6ec"],
  ["cherry", "체리", "fruit", "#ff2d8a"],
  ["mandarin", "귤", "fruit", "#ff9a1e"],
  ["rainbowapple", "무지개사과", "fruit", "#f27ba0"],
  ["blueberry", "블루베리", "fruit", "#93b9e4"],
].map(([id, label, family, color]) => Object.freeze({ id, label, family, color })));

export const RARE_TIER_INFO = Object.freeze([
  Object.freeze({ id: "glitter", label: "글리터" }),
  Object.freeze({ id: "gold", label: "금빛" }),
  Object.freeze({ id: "rainbow", label: "무지개빛" }),
]);

// ---------------------------------------------------------------------------
// Vector helpers
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;
const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vscale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vlen = (a) => Math.hypot(a[0], a[1], a[2]);
const vnorm = (a) => { const l = vlen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const vlerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const dist2 = (a, b) => { const x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2]; return x * x + y * y + z * z; };
const spow = (x, e) => Math.sign(x) * Math.pow(Math.abs(x), e);

export function hexToRgb01(hex) {
  const v = parseInt(String(hex).replace("#", "").padEnd(6, "0").slice(0, 6), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/**
 * Affine placer: scale (per axis), then rotate Z, X, Y, then translate.
 * `.normal(n)` maps a normal through the same transform.
 */
function placer({ scale = 1, sx = scale, sy = scale, sz = scale, rotZ = 0, rotX = 0, rotY = 0, at = [0, 0, 0] } = {}) {
  const cz = Math.cos(rotZ), snz = Math.sin(rotZ);
  const cx = Math.cos(rotX), snx = Math.sin(rotX);
  const cy = Math.cos(rotY), sny = Math.sin(rotY);
  const rot = (x, y, z) => {
    [x, y] = [x * cz - y * snz, x * snz + y * cz];
    [y, z] = [y * cx - z * snx, y * snx + z * cx];
    [x, z] = [x * cy + z * sny, -x * sny + z * cy];
    return [x, y, z];
  };
  const f = (p) => { const r = rot(p[0] * sx, p[1] * sy, p[2] * sz); return [r[0] + at[0], r[1] + at[1], r[2] + at[2]]; };
  f.normal = (n) => vnorm(rot(n[0] / sx, n[1] / sy, n[2] / sz));
  return f;
}

/** Placer from an orthonormal right-handed basis (local x → U, y → V, z → W). */
function basisPlacer(origin, U, V, W) {
  const f = (p) => [
    origin[0] + U[0] * p[0] + V[0] * p[1] + W[0] * p[2],
    origin[1] + U[1] * p[0] + V[1] * p[1] + W[1] * p[2],
    origin[2] + U[2] * p[0] + V[2] * p[1] + W[2] * p[2],
  ];
  f.normal = (n) => vnorm([U[0] * n[0] + V[0] * n[1] + W[0] * n[2], U[1] * n[0] + V[1] * n[1] + W[1] * n[2], U[2] * n[0] + V[2] * n[1] + W[2] * n[2]]);
  return f;
}

// ---------------------------------------------------------------------------
// Smooth meshes: { pos: [[x,y,z]], uv: [[u,v]], tri: [[a,b,c]], nrm?: [[x,y,z]] }
// ---------------------------------------------------------------------------

/** Parametric grid surface fn(u, v) on [0,1]², seam/pole vertices duplicated. */
function grid(fn, nu, nv, uvFn = null) {
  const pos = [], uv = [], tri = [];
  for (let j = 0; j <= nv; j += 1) {
    for (let i = 0; i <= nu; i += 1) {
      const u = i / nu, v = j / nv;
      const p = fn(u, v);
      pos.push(p);
      uv.push(uvFn ? uvFn(u, v, p) : [u, v]);
    }
  }
  const W = nu + 1;
  const push = (a, b, c) => {
    if (vlen(vcross(vsub(pos[b], pos[a]), vsub(pos[c], pos[a]))) > 1e-10) tri.push([a, b, c]);
  };
  for (let j = 0; j < nv; j += 1) {
    for (let i = 0; i < nu; i += 1) {
      const a = j * W + i, b = a + 1, c = a + W + 1, d = a + W;
      if (dist2(pos[a], pos[c]) <= dist2(pos[b], pos[d])) { push(a, b, c); push(a, c, d); } else { push(a, b, d); push(b, c, d); }
    }
  }
  return { pos, uv, tri };
}

/** Lathe about +Y; profile(v) → [r, y] from the top pole (v = 0) to the bottom pole (v = 1). */
function latheSmooth(profile, nu, nv, uvFn = null) {
  return grid((u, v) => {
    const [r, y] = profile(v);
    const a = TAU * u;
    return [r * Math.cos(a), y, -r * Math.sin(a)];
  }, nu, nv, uvFn);
}

/** Torus about +Z; section(b) → [radial offset, axial offset]; R may depend on u. */
function torusSmooth(R, section, nu, nv) {
  return grid((u, v) => {
    const a = TAU * u;
    const [dr, dz] = section(TAU * v);
    const rr = (typeof R === "function" ? R(u) : R) + dr;
    return [rr * Math.cos(a), rr * Math.sin(a), dz];
  }, nu, nv);
}

/**
 * Tube along path(t), t ∈ [0,1], with an elliptical section (radius(t) → [ra, rb]
 * along the parallel-transported N/B axes, rotated by twist(t)) and optional
 * hemispherical end caps. uvFn(t, around, arcLength, totalLength) → [u, v].
 */
function tubeSmooth(path, { radius, nu = 12, nv = 40, caps = 5, twist = () => 0, up = [0, 0, 1], uvFn = null } = {}) {
  const S = 240;
  const P = [], T = [], N = [], L = [0];
  for (let i = 0; i <= S; i += 1) P.push(path(i / S));
  for (let i = 0; i <= S; i += 1) {
    T.push(vnorm(vsub(P[Math.min(S, i + 1)], P[Math.max(0, i - 1)])));
    if (i > 0) L.push(L[i - 1] + vlen(vsub(P[i], P[i - 1])));
  }
  let n0 = vsub(up, vscale(T[0], vdot(up, T[0])));
  if (vlen(n0) < 1e-6) n0 = Math.abs(T[0][0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  N.push(vnorm(vsub(n0, vscale(T[0], vdot(n0, T[0])))));
  for (let i = 1; i <= S; i += 1) N.push(vnorm(vsub(N[i - 1], vscale(T[i], vdot(N[i - 1], T[i])))));
  const total = L[S];
  const frame = (t) => {
    const x = clamp(t, 0, 1) * S, i = Math.min(S - 1, Math.floor(x)), f = x - i;
    const p = vlerp(P[i], P[i + 1], f), tg = vnorm(vlerp(T[i], T[i + 1], f));
    let nn = vlerp(N[i], N[i + 1], f);
    nn = vnorm(vsub(nn, vscale(tg, vdot(nn, tg))));
    return { p, t: tg, n: nn, b: vcross(tg, nn), s: L[i] + (L[i + 1] - L[i]) * f };
  };
  const rings = [];
  const ring = (t, centre, scale, sLen) => rings.push({ t, centre, scale, sLen });
  const f0 = frame(0), f1 = frame(1);
  const [ra0, rb0] = radius(0), [ra1, rb1] = radius(1);
  const rc0 = (ra0 + rb0) / 2, rc1 = (ra1 + rb1) / 2;
  for (let k = 0; k < caps; k += 1) {
    const a = (Math.PI / 2) * k / caps;
    ring(0, vsub(f0.p, vscale(f0.t, rc0 * Math.cos(a))), Math.sin(a), -rc0 * Math.cos(a));
  }
  for (let j = 0; j <= nv; j += 1) { const t = j / nv; const fr = frame(t); ring(t, fr.p, 1, fr.s); }
  for (let k = caps - 1; k >= 0; k -= 1) {
    const a = (Math.PI / 2) * k / caps;
    ring(1, vadd(f1.p, vscale(f1.t, rc1 * Math.cos(a))), Math.sin(a), total + rc1 * Math.cos(a));
  }
  return grid((u, v) => {
    const r = rings[Math.round(v * (rings.length - 1))];
    const fr = frame(r.t);
    const [ra, rb] = radius(r.t);
    const tw = twist(r.t), ct = Math.cos(tw), st = Math.sin(tw);
    const nn = vadd(vscale(fr.n, ct), vscale(fr.b, st)), bb = vadd(vscale(fr.n, -st), vscale(fr.b, ct));
    const a = TAU * u;
    return vadd(r.centre, vadd(vscale(nn, ra * r.scale * Math.cos(a)), vscale(bb, rb * r.scale * Math.sin(a))));
  }, nu, rings.length - 1, (u, v) => {
    const r = rings[Math.round(v * (rings.length - 1))];
    return uvFn ? uvFn(r.t, u, r.sLen, total) : [u, r.t];
  });
}

// --- signed distance fields + surface nets --------------------------------

const sdSphere = (p, c, r) => vlen(vsub(p, c)) - r;
function sdEllipsoid(p, c, r) {
  const q = [(p[0] - c[0]) / r[0], (p[1] - c[1]) / r[1], (p[2] - c[2]) / r[2]];
  const k0 = vlen(q);
  const k1 = vlen([q[0] / r[0], q[1] / r[1], q[2] / r[2]]);
  return k1 < 1e-9 ? -Math.min(r[0], r[1], r[2]) : (k0 * (k0 - 1)) / k1;
}
const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };

/**
 * Naive surface nets of sdf < 0 inside [min, max] at cell size `cell`, then a
 * few Newton steps put every vertex on the zero set; normals = ∇sdf.
 */
function surfaceNets(sdf, min, max, cell) {
  const lo = min.map((x) => x - cell * 1.5);
  const [nx, ny, nz] = [0, 1, 2].map((k) => Math.ceil((max[k] - min[k] + cell * 3) / cell) + 1);
  const sxy = nx * ny;
  const field = new Float64Array(sxy * nz);
  const q = [0, 0, 0];
  for (let k = 0; k < nz; k += 1) for (let j = 0; j < ny; j += 1) for (let i = 0; i < nx; i += 1) {
    q[0] = lo[0] + i * cell; q[1] = lo[1] + j * cell; q[2] = lo[2] + k * cell;
    field[i + nx * j + sxy * k] = sdf(q);
  }
  // Cell (i,j,k) has its vertex index at the node index of its min corner.
  const cellIndex = new Int32Array(sxy * nz).fill(-1);
  const pos = [];
  const CO = [0, 1, nx, nx + 1, sxy, sxy + 1, sxy + nx, sxy + nx + 1];
  const CX = [0, 1, 0, 1, 0, 1, 0, 1], CY = [0, 0, 1, 1, 0, 0, 1, 1], CZ = [0, 0, 0, 0, 1, 1, 1, 1];
  const EA = [0, 2, 4, 6, 0, 1, 4, 5, 0, 1, 2, 3], EB = [1, 3, 5, 7, 2, 3, 6, 7, 4, 5, 6, 7];
  const vals = new Float64Array(8);
  for (let k = 0; k < nz - 1; k += 1) for (let j = 0; j < ny - 1; j += 1) for (let i = 0; i < nx - 1; i += 1) {
    const base = i + nx * j + sxy * k;
    let inside = 0;
    for (let c = 0; c < 8; c += 1) { const v = field[base + CO[c]]; vals[c] = v; if (v < 0) inside += 1; }
    if (inside === 0 || inside === 8) continue;
    let sx = 0, sy = 0, sz = 0, m = 0;
    for (let e = 0; e < 12; e += 1) {
      const a = EA[e], b = EB[e], va = vals[a], vb = vals[b];
      if ((va < 0) === (vb < 0)) continue;
      const t = va / (va - vb);
      sx += CX[a] + (CX[b] - CX[a]) * t; sy += CY[a] + (CY[b] - CY[a]) * t; sz += CZ[a] + (CZ[b] - CZ[a]) * t;
      m += 1;
    }
    cellIndex[base] = pos.length;
    pos.push([lo[0] + (i + sx / m) * cell, lo[1] + (j + sy / m) * cell, lo[2] + (k + sz / m) * cell]);
  }
  const tri = [];
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) [b, d] = [d, b];
    if (dist2(pos[a], pos[c]) <= dist2(pos[b], pos[d])) tri.push([a, b, c], [a, c, d]); else tri.push([a, b, d], [b, c, d]);
  };
  const C = cellIndex;
  for (let k = 1; k < nz - 1; k += 1) for (let j = 1; j < ny - 1; j += 1) for (let i = 0; i < nx - 1; i += 1) {
    const n0 = i + nx * j + sxy * k, a = field[n0], b = field[n0 + 1];
    if ((a < 0) === (b < 0)) continue;
    quad(C[n0 - nx - sxy], C[n0 - sxy], C[n0], C[n0 - nx], a >= 0);
  }
  for (let k = 1; k < nz - 1; k += 1) for (let j = 0; j < ny - 1; j += 1) for (let i = 1; i < nx - 1; i += 1) {
    const n0 = i + nx * j + sxy * k, a = field[n0], b = field[n0 + nx];
    if ((a < 0) === (b < 0)) continue;
    quad(C[n0 - 1 - sxy], C[n0 - 1], C[n0], C[n0 - sxy], a >= 0);
  }
  for (let k = 0; k < nz - 1; k += 1) for (let j = 1; j < ny - 1; j += 1) for (let i = 1; i < nx - 1; i += 1) {
    const n0 = i + nx * j + sxy * k, a = field[n0], b = field[n0 + sxy];
    if ((a < 0) === (b < 0)) continue;
    quad(C[n0 - 1 - nx], C[n0 - nx], C[n0], C[n0 - 1], a >= 0);
  }
  const h = cell * 0.02;
  const g = [0, 0, 0], p1 = [0, 0, 0];
  const grad = (p) => {
    for (let a = 0; a < 3; a += 1) {
      p1[0] = p[0]; p1[1] = p[1]; p1[2] = p[2];
      p1[a] = p[a] + h; const f1 = sdf(p1);
      p1[a] = p[a] - h; const f0 = sdf(p1);
      g[a] = (f1 - f0) / (2 * h);
    }
    return g;
  };
  const nrm = [];
  for (let v = 0; v < pos.length; v += 1) {
    const p = pos[v];
    for (let it = 0; it < 3; it += 1) {
      const d = sdf(p);
      if (Math.abs(d) < cell * 1e-4) break;
      grad(p);
      const g2 = g[0] * g[0] + g[1] * g[1] + g[2] * g[2];
      if (g2 < 1e-12) break;
      let k = d / g2;
      const sl = Math.abs(k) * Math.sqrt(g2);
      if (sl > cell * 0.6) k *= cell * 0.6 / sl;
      p[0] -= g[0] * k; p[1] -= g[1] * k; p[2] -= g[2] * k;
    }
    grad(p);
    nrm.push(vnorm(g));
  }
  // Drop slivers and folds created by the projection (tiny triangles whose
  // face turned against the surface normal in tight crevices).
  const kept = tri.filter(([a, b, c]) => {
    const f = vcross(vsub(pos[b], pos[a]), vsub(pos[c], pos[a]));
    const area2 = vlen(f);
    if (area2 <= cell * cell * 1e-4) return false;
    const facing = vdot(f, vadd(vadd(nrm[a], nrm[b]), nrm[c])) / area2;
    return facing > -0.3 || area2 > cell * cell * 0.05;
  });
  return { pos, nrm, uv: pos.map(() => [0, 0]), tri: kept };
}

/**
 * Surface nets at a fixed cell size (pre-fitted per shape so the build is a
 * single pass); coarsened only if it would ever exceed the triangle budget.
 */
function sdfMesh(sdf, min, max, cell, budget = RARE_TRIANGLE_BUDGET - 150) {
  let mesh = surfaceNets(sdf, min, max, cell);
  while (mesh.tri.length > budget) {
    cell *= Math.sqrt(mesh.tri.length / budget) * 1.02;
    mesh = surfaceNets(sdf, min, max, cell);
  }
  return mesh;
}

function transformMesh(mesh, xf) {
  return {
    pos: mesh.pos.map(xf),
    nrm: mesh.nrm ? mesh.nrm.map((n) => xf.normal(n)) : undefined,
    uv: mesh.uv,
    tri: mesh.tri,
  };
}

// ---------------------------------------------------------------------------
// Faceted parts (triangle soup with outward hints), as in gems.js
// ---------------------------------------------------------------------------

class Facets {
  constructor() { this.tris = []; }

  add(a, b, c, hint) {
    const n = vcross(vsub(b, a), vsub(c, a));
    if (vlen(n) < 1e-9) return;
    if (hint) {
      const h = typeof hint === "function" ? hint(vscale(vadd(vadd(a, b), c), 1 / 3)) : hint;
      if (vdot(n, h) < 0) { this.tris.push([a, c, b]); return; }
    }
    this.tris.push([a, b, c]);
  }

  quad(a, b, c, d, hint, flip = false) {
    if (flip) { this.add(a, b, d, hint); this.add(b, c, d, hint); } else { this.add(a, b, c, hint); this.add(a, c, d, hint); }
  }

  merge(part, xf = (p) => p) {
    for (const [a, b, c] of part.tris) this.tris.push([xf(a), xf(b), xf(c)]);
    return this;
  }
}

function zipRings(f, A, pa, B, pb, hint) {
  const N = A.length;
  for (let i = 0; i < N; i += 1) {
    const j = (i + 1) % N;
    if (pa === pb) f.quad(A[i], A[j], B[j], B[i], hint);
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

/** 2D convex hull (monotone chain), counter-clockwise. */
function convex2(points) {
  const p = points.map((q) => [q[0], q[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i -= 1) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

/**
 * Faceted tent over a 2D outline in the XY plane: crown rings toward an apex
 * (or flat table) on +Z, pavilion rings toward a culet on −Z. With a convex
 * outline, phase-0 rings and apex/culet within the ring slopes it is convex.
 */
function tent(outline, { center = null, crown = [], apex = 0.25, table = false, pavilion = [], culet = -0.2 } = {}) {
  const N = outline.length;
  const c = center ?? polygonCentroid(outline);
  const girdle = outline.map((p) => [p[0], p[1], p[2] ?? 0]);
  const f = new Facets();
  const ringPoints = (ring) => girdle.map((a, i) => {
    const b = girdle[(i + 1) % N];
    const base = ring.phase === 0.5 ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : [a[0], a[1]];
    return [c[0] + (base[0] - c[0]) * ring.s, c[1] + (base[1] - c[1]) * ring.s, ring.h];
  });
  const side = (rings, tip, flat, sign) => {
    const hint = [0, 0, sign];
    let prev = girdle, phase = 0;
    for (const ring of rings) {
      const pts = ringPoints(ring);
      zipRings(f, prev, phase, pts, ring.phase ?? 0, hint);
      prev = pts; phase = ring.phase ?? 0;
    }
    const centre = flat ? [c[0], c[1], prev.reduce((s, p) => s + p[2], 0) / N] : [c[0], c[1], tip];
    for (let i = 0; i < N; i += 1) f.add(prev[i], prev[(i + 1) % N], centre, hint);
  };
  side(crown, apex, table, 1);
  side(pavilion, culet, false, -1);
  return f;
}

/** Faceted prism (frustum) between two points with an n-gon section, capped. */
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

/** Convex hull of a small point set (brute force), as facets with polygon faces fanned. */
function hullFacets(points) {
  const eps = 1e-7;
  const planes = [];
  const n = points.length;
  for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) for (let k = j + 1; k < n; k += 1) {
    let nn = vcross(vsub(points[j], points[i]), vsub(points[k], points[i]));
    const len = vlen(nn);
    if (len < 1e-9) continue;
    nn = vscale(nn, 1 / len);
    let d = vdot(nn, points[i]);
    let pos = false, neg = false;
    for (let m = 0; m < n && !(pos && neg); m += 1) {
      const s = vdot(nn, points[m]) - d;
      if (s > eps) pos = true; else if (s < -eps) neg = true;
    }
    if (pos && neg) continue;
    if (pos) { nn = vscale(nn, -1); d = -d; }
    if (!planes.some((p) => vdot(p.n, nn) > 1 - 1e-7 && Math.abs(p.d - d) < 1e-6)) planes.push({ n: nn, d });
  }
  const f = new Facets();
  for (const { n: nn, d } of planes) {
    const on = [];
    for (const p of points) if (Math.abs(vdot(nn, p) - d) < 1e-6 && !on.some((q) => dist2(p, q) < 1e-14)) on.push(p);
    if (on.length < 3) continue;
    const c = vscale(on.reduce((s, p) => vadd(s, p), [0, 0, 0]), 1 / on.length);
    const ref = Math.abs(nn[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = vnorm(vcross(nn, ref)), w = vcross(nn, u);
    on.sort((p, q) => Math.atan2(vdot(vsub(p, c), w), vdot(vsub(p, c), u)) - Math.atan2(vdot(vsub(q, c), w), vdot(vsub(q, c), u)));
    for (let m = 1; m + 1 < on.length; m += 1) f.add(on[0], on[m], on[m + 1], nn);
  }
  return f;
}

/** Faceted ellipsoid: poles + `rings` latitude rings of `sides` points (alternating phase). */
function facetBall(rx, ry, rz, sides = 8, rings = 3) {
  const pts = [[0, ry, 0], [0, -ry, 0]];
  for (let k = 0; k < rings; k += 1) {
    const lat = -Math.PI / 2 + Math.PI * (k + 1) / (rings + 1);
    const phase = (k % 2) * 0.5;
    for (let i = 0; i < sides; i += 1) {
      const a = TAU * (i + phase) / sides;
      pts.push([rx * Math.cos(lat) * Math.cos(a), ry * Math.sin(lat), rz * Math.cos(lat) * Math.sin(a)]);
    }
  }
  return hullFacets(pts);
}

const mirrorX = (p) => [-p[0], p[1], p[2]];
function mirrored(part) {
  const f = new Facets();
  for (const [a, b, c] of part.tris) f.tris.push([mirrorX(a), mirrorX(c), mirrorX(b)]);
  return f;
}
const placed = (part, xf) => new Facets().merge(part, xf);

// Round brilliant (gems.js): table on +Y, 41 planes.
function brilliantFacets() {
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
    f.add(T[i], T[j], tableC, up);
    f.add(T[i], T[j], S[i], radial);
    f.add(T[i], S[h], G[i], radial);
    f.add(T[i], G[i], S[i], radial);
    f.add(S[i], G[i], G[j], radial);
    f.add(culet, L[h], G[i], radial);
    f.add(culet, G[i], L[i], radial);
    f.add(G[i], G[j], L[i], radial);
  }
  return f;
}

// ---------------------------------------------------------------------------
// Part constructors
// ---------------------------------------------------------------------------

const smooth = (mesh, color, style = {}) => ({ kind: "smooth", mesh, color, style });
const facet = (facets, color, style = {}) => ({ kind: "facet", facets, color, style });

const JELLY = { turbidity: 0.58 };
const GLASS = { turbidity: 0.05 };
const CANDY = { turbidity: 0.38, glitter: 1 };
const STEM = { turbidity: 0.85 };

// ---------------------------------------------------------------------------
// ① puffy
// ---------------------------------------------------------------------------

function capsuleGem() {
  const r = 0.25, half = 0.28;
  const mesh = tubeSmooth((t) => [-half + 2 * half * t, 0, 0], { radius: () => [r * 0.9, r], nu: 32, nv: 10, caps: 10, up: [0, 0, 1] });
  return [smooth(mesh, "#f48aa6", JELLY)];
}

function cloverGem() {
  const lobes = [[0.37, 0], [-0.37, 0], [0, 0.37], [0, -0.37]];
  const zs = 0.8;
  const sdf = (p) => {
    const q = [p[0], p[1], p[2] / zs];
    let d = vlen(q) - 0.27;
    for (const [x, y] of lobes) d = smin(d, sdEllipsoid(q, [x, y, 0], [0.31 + 0.03 * Math.abs(x) / 0.37, 0.31 + 0.03 * Math.abs(y) / 0.37, 0.31]), 0.14);
    return d * zs;
  };
  return [smooth(sdfMesh(sdf, [-0.75, -0.75, -0.3], [0.75, 0.75, 0.3], 0.0612), "#ff9a2e", JELLY)];
}

function donutGem() {
  const mesh = torusSmooth(0.5, (b) => [0.31 * Math.cos(b), 0.31 * 0.9 * Math.sin(b)], 44, 26);
  return [smooth(mesh, "#b39af0", JELLY)];
}

function cloudGem() {
  const blobs = [
    [[-0.42, 0.14, 0], [0.32, 0.3, 0.24]],
    [[0.02, 0.32, 0], [0.34, 0.32, 0.26]],
    [[0.45, 0.12, 0], [0.3, 0.3, 0.23]],
    [[0.28, -0.26, 0], [0.32, 0.27, 0.23]],
    [[-0.3, -0.24, 0], [0.3, 0.27, 0.22]],
    [[0, 0, 0], [0.5, 0.36, 0.26]],
  ];
  const sdf = (p) => {
    let d = Infinity;
    for (const [c, r] of blobs) d = smin(d === Infinity ? 1e3 : d, sdEllipsoid(p, c, r), 0.13);
    return d;
  };
  return [smooth(sdfMesh(sdf, [-0.8, -0.6, -0.32], [0.8, 0.7, 0.32], 0.0624), "#ff7a6b", JELLY)];
}

function sdEquilateralTriangle(x, y, r) {
  const k = Math.sqrt(3);
  let px = Math.abs(x) - r, py = y + r / k;
  if (px + k * py > 0) { const nx = (px - k * py) / 2, ny = (-k * px - py) / 2; px = nx; py = ny; }
  px -= clamp(px, -2 * r, 0);
  return -Math.hypot(px, py) * Math.sign(py);
}

function triangleGem() {
  const rr = 0.2;
  const sdf = (p) => {
    const d2 = sdEquilateralTriangle(p[0], p[1] + 0.02, 0.4) - 0.11;
    const h = 0.22 + 0.07 * smoothstep(0, 0.3, -d2);
    const wx = d2 + rr, wy = Math.abs(p[2]) - (h - rr);
    return Math.min(Math.max(wx, wy), 0) + Math.hypot(Math.max(wx, 0), Math.max(wy, 0)) - rr;
  };
  return [smooth(sdfMesh(sdf, [-0.65, -0.55, -0.32], [0.65, 0.75, 0.32], 0.0442), "#3a9af0", JELLY)];
}

// ---------------------------------------------------------------------------
// ② crystal
// ---------------------------------------------------------------------------

function opalGem() {
  const mesh = grid((u, v) => {
    const th = Math.PI * v, ph = TAU * u, s = Math.sin(th), c = Math.cos(th);
    return [0.5 * s * Math.cos(ph), 0.36 * s * Math.sin(ph), c > 0 ? 0.25 * c : 0.11 * c];
  }, 40, 24);
  return [smooth(mesh, "#d3d6ea", { turbidity: 0.7, pattern: RARE_PATTERN.opal })];
}

function cubeGem() {
  const s = 0.5, c = 0.41, pts = [];
  for (const a of [-1, 1]) for (const b of [-1, 1]) for (const d of [-1, 1]) {
    pts.push([a * s, b * c, d * c], [a * c, b * s, d * c], [a * c, b * c, d * s]);
  }
  return [facet(hullFacets(pts), "#e9eefb", { ior: 1.55, irid: 1, absorb: 3, maxPlanes: 26 })];
}

function brilliantGem() {
  return [facet(placed(brilliantFacets(), placer({ rotX: Math.PI / 2 })), "#7b86ee", { ior: 2.0, maxPlanes: 41 })];
}

function ringGem() {
  const mesh = torusSmooth(0.5, (b) => [0.085 * spow(Math.cos(b), 0.55), 0.15 * spow(Math.sin(b), 0.55)], 60, 18);
  return [smooth(transformMesh(mesh, placer({ rotX: 1.12, rotZ: 0.38 })), "#eef2f8", GLASS)];
}

function twistGem() {
  const mesh = tubeSmooth((t) => {
    const a = TAU * 0.95 * (t - 0.5);
    return [0.3 * Math.sin(a), 0.52 - 1.04 * t, 0.2 * Math.cos(a)];
  }, { radius: () => [0.17, 0.056], nu: 14, nv: 68, caps: 6, twist: (t) => Math.PI * 1.1 * t, up: [0, 0, 1] });
  return [smooth(mesh, "#f1f3f9", { turbidity: 0.06 })];
}

// ---------------------------------------------------------------------------
// ③ pink crystal charms (faceted, composed of convex parts)
// ---------------------------------------------------------------------------

const PINK = "#f4a3c4", PINK_DEEP = "#e48bb6", PINK_LAV = "#e7a6dc", PINK_PALE = "#f8bfd6";
// Charm parts use the default size-relative absorption (see assemble), so thin
// wings and chunky bodies reach a similar pastel depth.
const charm = (facets, color, style = {}) => facet(facets, color, style);

function wingTent(points) {
  return tent(convex2(points), { crown: [{ s: 0.55, h: 0.07, phase: 0 }], apex: 0.11, pavilion: [{ s: 0.55, h: -0.05, phase: 0 }], culet: -0.08 });
}

function butterflyGem() {
  const parts = [];
  const upper = wingTent([[0.04, 0.02], [0.2, 0.3], [0.45, 0.58], [0.75, 0.7], [0.95, 0.6], [0.98, 0.38], [0.8, 0.15], [0.45, 0.0]]);
  const lower = wingTent([[0.05, -0.03], [0.32, -0.06], [0.55, -0.2], [0.6, -0.42], [0.48, -0.6], [0.3, -0.58], [0.12, -0.35]]);
  const up = placed(upper, placer({ rotY: -0.28, at: [0.03, 0.02, 0] }));
  const lo = placed(lower, placer({ rotY: -0.22, at: [0.02, 0, 0.01] }));
  const antenna = prism([0.02, 0.33, 0.03], [0.17, 0.62, -0.01], 0.016, 4, 0.012);
  const tip = placed(facetBall(0.034, 0.034, 0.034, 5, 1), placer({ at: [0.17, 0.63, -0.01] }));
  for (const [part, color, style] of [[up, PINK, {}], [lo, PINK_LAV, {}], [antenna, PINK_DEEP, { maxPlanes: 6 }], [tip, PINK_DEEP, { maxPlanes: 8 }]]) {
    parts.push(charm(part, color, style), charm(mirrored(part), color, style));
  }
  parts.push(charm(placed(facetBall(0.065, 0.3, 0.065, 6, 4), placer({ at: [0, -0.1, 0.03] })), PINK_DEEP, { maxPlanes: 12 }));
  parts.push(charm(placed(facetBall(0.075, 0.075, 0.07, 6, 2), placer({ at: [0, 0.27, 0.03] })), PINK_DEEP, { maxPlanes: 8 }));
  return parts;
}

function crownGem() {
  const parts = [];
  const around = (r, a, y) => [r * Math.sin(a), y, r * Math.cos(a)];
  const section = [[0.36, -0.5], [0.47, -0.5], [0.51, -0.43], [0.47, -0.35], [0.36, -0.35]];
  const segments = 8;
  for (let k = 0; k < segments; k += 1) {
    const a0 = TAU * k / segments - 0.02, a1 = TAU * (k + 1) / segments + 0.02;
    const pts = [];
    for (const a of [a0, a1]) for (const [r, y] of section) pts.push(around(r, a, y));
    parts.push(charm(hullFacets(pts), PINK, { maxPlanes: 7 }));
  }
  const spike = (h, w) => tent(convex2([[-w, 0], [w, 0], [w * 0.42, h * 0.62], [0, h], [-w * 0.42, h * 0.62]]), { crown: [], apex: 0.05, pavilion: [], culet: -0.04 });
  for (let k = 0; k < 5; k += 1) {
    const a = TAU * k / 5;
    const xf = placer({ rotX: 0.2, rotY: a, at: around(0.43, a, -0.38) });
    parts.push(charm(placed(spike(0.56, 0.13), xf), k === 0 ? PINK_PALE : PINK, { maxPlanes: 10 }));
    const top = xf([0, 0.6, 0]);
    parts.push(charm(placed(facetBall(0.052, 0.052, 0.052, 6, 2), placer({ at: top })), PINK_LAV, { maxPlanes: 8 }));
    const b = a + TAU / 10;
    parts.push(charm(placed(spike(0.3, 0.09), placer({ rotX: 0.15, rotY: b, at: around(0.43, b, -0.38) })), PINK, { maxPlanes: 10 }));
  }
  parts.push(charm(placed(facetBall(0.06, 0.08, 0.035, 6, 2), placer({ at: [0, -0.425, 0.52] })), "#c58ff0", { maxPlanes: 10 }));
  return parts;
}

function roseGem() {
  const parts = [];
  const outline = convex2([[-0.11, 0], [0.11, 0], [0.2, 0.15], [0.19, 0.31], [0.08, 0.42], [-0.08, 0.42], [-0.19, 0.31], [-0.2, 0.15]]);
  const petal = tent(outline, { crown: [], apex: 0.045, pavilion: [], culet: -0.03 });
  // Inner petals stand up and wrap the bud; outer ones open out flat.
  const ringsDef = [
    { n: 3, r: 0.05, tilt: 0.22, scale: 0.62, z: 0.17, color: PINK_DEEP, phase: 0.15 },
    { n: 5, r: 0.13, tilt: 0.5, scale: 0.84, z: 0.11, color: PINK, phase: 0.55 },
    { n: 7, r: 0.22, tilt: 0.85, scale: 1.0, z: 0.04, color: PINK_PALE, phase: 0.05 },
    { n: 8, r: 0.31, tilt: 1.2, scale: 1.08, z: -0.04, color: PINK_LAV, phase: 0.5 },
  ];
  for (const ring of ringsDef) {
    for (let k = 0; k < ring.n; k += 1) {
      const phi = TAU * (k + ring.phase) / ring.n;
      const rdir = [Math.cos(phi), Math.sin(phi), 0];
      const V = vnorm(vadd(vscale([0, 0, 1], Math.cos(ring.tilt)), vscale(rdir, Math.sin(ring.tilt))));
      const U = [-Math.sin(phi), Math.cos(phi), 0];
      const W = vcross(U, V);
      const xf = basisPlacer(vadd(vscale(rdir, ring.r), [0, 0, ring.z]), U, V, W);
      parts.push(charm(placed(petal, (p) => xf(vscale(p, ring.scale))), ring.color, { maxPlanes: 8 }));
    }
  }
  parts.push(charm(placed(facetBall(0.085, 0.085, 0.16, 6, 2), placer({ rotZ: 0.4, at: [0, 0, 0.2] })), "#ee93bb", { maxPlanes: 10 }));
  return parts;
}

function bearGem() {
  const parts = [];
  const ball = (r, sides, rings, xf, color, style = {}) => parts.push(charm(placed(facetBall(r[0], r[1], r[2], sides, rings), xf), color, { maxPlanes: 10, ...style }));
  ball([0.29, 0.26, 0.25], 10, 3, placer({ at: [0, 0.36, 0] }), PINK, { maxPlanes: 16 });
  for (const s of [-1, 1]) {
    ball([0.1, 0.1, 0.06], 7, 2, placer({ at: [s * 0.22, 0.58, -0.04] }), PINK_LAV);
    ball([0.032, 0.036, 0.025], 6, 1, placer({ at: [s * 0.1, 0.41, 0.225] }), "#2a1822", { absorb: 0.02, maxPlanes: 8 });
    ball([0.09, 0.16, 0.09], 6, 2, placer({ rotZ: s * 0.55, at: [s * 0.27, -0.03, 0.06] }), PINK);
    ball([0.12, 0.11, 0.15], 7, 2, placer({ at: [s * 0.17, -0.38, 0.1] }), PINK);
  }
  ball([0.12, 0.085, 0.08], 7, 2, placer({ at: [0, 0.28, 0.2] }), PINK_PALE);
  ball([0.046, 0.032, 0.03], 6, 1, placer({ at: [0, 0.325, 0.275] }), "#2a1822", { absorb: 0.02, maxPlanes: 8 });
  ball([0.28, 0.3, 0.24], 10, 3, placer({ at: [0, -0.12, 0] }), PINK, { maxPlanes: 16 });
  return parts;
}

function swanGem() {
  const parts = [];
  parts.push(charm(placed(facetBall(0.42, 0.2, 0.22, 10, 3), placer({ rotZ: 0.08, at: [0.05, -0.25, 0] })), PINK, { maxPlanes: 16 }));
  parts.push(charm(placed(facetBall(0.13, 0.06, 0.08, 6, 2), placer({ rotZ: 0.65, at: [0.44, -0.12, 0] })), PINK_LAV, { maxPlanes: 8 }));
  const wing = tent(convex2([[-0.26, -0.04], [0.28, -0.08], [0.44, 0.1], [0.36, 0.28], [0.05, 0.2]]), { crown: [{ s: 0.55, h: 0.035, phase: 0 }], apex: 0.055, pavilion: [], culet: -0.04 });
  parts.push(charm(placed(wing, placer({ rotX: -0.25, at: [0.1, -0.16, 0.14] })), PINK_LAV, { maxPlanes: 10 }));
  parts.push(charm(placed(wing, placer({ sz: -1, rotX: 0.25, at: [0.1, -0.16, -0.14] })), PINK_LAV, { maxPlanes: 10 }));
  const neck = [[-0.3, -0.17, 0], [-0.42, 0.05, 0], [-0.36, 0.28, 0], [-0.24, 0.42, 0]];
  const radii = [0.07, 0.06, 0.05, 0.045];
  for (let i = 0; i + 1 < neck.length; i += 1) {
    const a = neck[i], b = neck[i + 1], dir = vnorm(vsub(b, a));
    parts.push(charm(prism(vsub(a, vscale(dir, 0.02)), vadd(b, vscale(dir, 0.02)), radii[i], 6, radii[i + 1]), PINK, { maxPlanes: 8 }));
    if (i > 0) parts.push(charm(placed(facetBall(radii[i] * 1.02, radii[i] * 1.02, radii[i] * 1.02, 6, 1), placer({ at: a })), PINK, { maxPlanes: 8 }));
  }
  parts.push(charm(placed(facetBall(0.105, 0.072, 0.068, 7, 2), placer({ rotZ: -0.35, at: [-0.27, 0.46, 0] })), PINK, { maxPlanes: 10 }));
  parts.push(charm(prism([-0.33, 0.45, 0], [-0.49, 0.38, 0], 0.032, 5, 0.008), "#ef7f9f", { maxPlanes: 7 }));
  parts.push(charm(placed(facetBall(0.018, 0.018, 0.018, 5, 1), placer({ at: [-0.29, 0.49, 0.06] })), "#2a1822", { absorb: 0.02, maxPlanes: 6 }));
  return parts;
}

// ---------------------------------------------------------------------------
// ④ resin candy
// ---------------------------------------------------------------------------

function gummybearGem() {
  const E = (c, r) => (p) => sdEllipsoid(p, c, r);
  const prims = [
    [E([0, 0.42, 0], [0.3, 0.26, 0.2]), 0.07],
    [E([0.25, 0.64, -0.02], [0.105, 0.1, 0.085]), 0.05],
    [E([-0.25, 0.64, -0.02], [0.105, 0.1, 0.085]), 0.05],
    [E([0, 0.33, 0.13], [0.11, 0.085, 0.08]), 0.05],
    [E([0, -0.06, 0], [0.3, 0.33, 0.21]), 0.06],
    [E([0.3, 0.08, 0.04], [0.12, 0.14, 0.11]), 0.05],
    [E([-0.3, 0.08, 0.04], [0.12, 0.14, 0.11]), 0.05],
    [E([0.19, -0.38, 0.05], [0.15, 0.13, 0.14]), 0.05],
    [E([-0.19, -0.38, 0.05], [0.15, 0.13, 0.14]), 0.05],
    [E([0, -0.1, 0.1], [0.17, 0.17, 0.13]), 0.05],
  ];
  const sdf = (p) => {
    let d = prims[0][0](p);
    for (let i = 1; i < prims.length; i += 1) d = smin(d, prims[i][0](p), prims[i][1]);
    return d;
  };
  return [smooth(sdfMesh(sdf, [-0.48, -0.56, -0.26], [0.48, 0.78, 0.26], 0.0498), "#f0477a", CANDY)];
}

function lollipopGem() {
  const R = 0.42, e = 0.085, Rin = R - e;
  const rowsF = 9, rowsE = 8, rowsB = 6, nv = rowsF + rowsE + rowsB;
  const profile = (v) => {
    const row = v * nv;
    if (row <= rowsF) { const r = Rin * (row / rowsF); return [r, e + 0.018 * (1 - (r / Rin) ** 2)]; }
    if (row <= rowsF + rowsE) { const th = Math.PI / 2 - Math.PI * (row - rowsF) / rowsE; return [Rin + e * Math.cos(th), e * Math.sin(th)]; }
    const r = Rin * (1 - (row - rowsF - rowsE) / rowsB); return [r, -e - 0.01 * (1 - (r / Rin) ** 2)];
  };
  const disc = latheSmooth(profile, 48, nv, (u, v, p) => [p[0] / R, -p[2] / R]);
  const discPart = smooth(transformMesh(disc, placer({ rotX: Math.PI / 2, at: [0, 0.16, 0] })), "#ffffff", { turbidity: 0.42, glitter: 0.7, pattern: RARE_PATTERN.swirl });
  const stick = tubeSmooth((t) => [0, -0.12 - 0.84 * t, 0], { radius: () => [0.056, 0.056], nu: 12, nv: 8, caps: 4, up: [0, 0, 1] });
  return [discPart, smooth(stick, "#f6f0e6", { turbidity: 0.12, glitter: 1 })];
}

function candycaneGem() {
  const straight = 0.8, R = 0.21, extra = 0.55;
  const total = straight + R * (Math.PI + extra);
  const path = (t) => {
    const s = t * total;
    if (s <= straight) return [-R, -0.6 + s, 0];
    const phi = Math.PI - (s - straight) / R;
    return [R * Math.cos(phi), -0.6 + straight + R * Math.sin(phi), 0];
  };
  const pitch = 0.3;
  const mesh = tubeSmooth(path, {
    radius: () => [0.078, 0.078], nu: 14, nv: 80, caps: 5, up: [0, 0, 1],
    uvFn: (t, around, sLen) => [sLen / pitch + around, t],
  });
  return [smooth(mesh, "#e8304a", { ...CANDY, pattern: RARE_PATTERN.stripes })];
}

function ringpopGem() {
  const purple = "#a66ee0";
  const ring = torusSmooth(0.27, (b) => [0.075 * Math.cos(b), 0.075 * Math.sin(b)], 40, 16);
  const puck = latheSmooth((v) => {
    const rows = 14, row = v * rows;
    const R = 0.25, e = 0.05;
    if (row <= 4) return [(R - e) * row / 4, e];
    if (row <= 10) { const th = Math.PI / 2 - Math.PI * (row - 4) / 6; return [R - e + e * Math.cos(th), e * Math.sin(th)]; }
    return [(R - e) * (1 - (row - 10) / 4), -e];
  }, 36, 14);
  const octagon = [];
  for (let i = 0; i < 8; i += 1) octagon.push([0.23 * Math.cos(TAU * (i + 0.5) / 8), 0.23 * Math.sin(TAU * (i + 0.5) / 8)]);
  const gem = tent(octagon, { center: [0, 0], crown: [{ s: 0.74, h: 0.12, phase: 0 }], table: false, apex: 0.3, pavilion: [{ s: 0.55, h: -0.1, phase: 0 }], culet: -0.2 });
  return [
    smooth(transformMesh(ring, placer({ at: [0, -0.52, 0] })), purple, { turbidity: 0.5 }),
    smooth(transformMesh(puck, placer({ at: [0, -0.18, 0] })), purple, { turbidity: 0.5 }),
    facet(placed(gem, placer({ rotX: -Math.PI / 2, at: [0, -0.05, 0] })), "#ff8fc0", { ior: 1.9, maxPlanes: 24 }),
  ];
}

function jellybeanGem() {
  const zs = 0.74;
  const sdf = (p) => {
    const q = [p[0], p[1], p[2] / zs];
    let d = sdSphere(q, [0.07, 0.3, 0], 0.25);
    d = smin(d, sdSphere(q, [-0.12, 0.02, 0], 0.28), 0.22);
    d = smin(d, sdSphere(q, [0.02, -0.29, 0], 0.31), 0.22);
    return d * zs;
  };
  return [smooth(sdfMesh(sdf, [-0.48, -0.66, -0.26], [0.42, 0.6, 0.26], 0.0459), "#e9406f", CANDY)];
}

// ---------------------------------------------------------------------------
// ⑤ glass fruit
// ---------------------------------------------------------------------------

function leafTube(phi, { r0 = 0.04, len = 0.32, y0 = 0.3, droop = 0.12, arch = 0.05, width = 0.075, thick = 0.022, nu = 8, nv = 9 } = {}) {
  const rdir = [Math.cos(phi), 0, -Math.sin(phi)];
  const tangent = [-Math.sin(phi), 0, -Math.cos(phi)];
  return tubeSmooth((t) => vadd(vscale(rdir, r0 + len * t), [0, y0 + arch * Math.sin(Math.PI * t) - droop * t * t, 0]), {
    radius: (t) => [width * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.75)), 0.7) + 0.002, thick * Math.pow(Math.sin(Math.PI * t), 0.5) + 0.002],
    nu, nv, caps: 0, up: tangent,
  });
}

function mergeMeshes(meshes) {
  const out = { pos: [], uv: [], tri: [] };
  for (const m of meshes) {
    const base = out.pos.length;
    out.pos.push(...m.pos); out.uv.push(...m.uv);
    for (const [a, b, c] of m.tri) out.tri.push([a + base, b + base, c + base]);
  }
  return out;
}

function strawberryGem() {
  const body = latheSmooth((v) => {
    const r = 0.44 * Math.pow(Math.sin(Math.PI * Math.pow(v, 0.6)), 0.8) * (1 - 0.35 * v);
    return [r, 0.3 - 0.95 * v];
  }, 30, 26);
  const teal = "#4fb8a2";
  const leaves = [];
  for (let k = 0; k < 6; k += 1) leaves.push(leafTube(TAU * (k + 0.25) / 6, { y0: 0.29 }));
  const stem = tubeSmooth((t) => [0.02 * t, 0.27 + 0.17 * t, 0], { radius: () => [0.032, 0.032], nu: 8, nv: 4, caps: 3, up: [0, 0, 1] });
  return [
    smooth(body, "#f5e6ec", { turbidity: 0.08, pattern: RARE_PATTERN.seeds }),
    smooth(mergeMeshes(leaves), teal, { turbidity: 0.5 }),
    smooth(stem, teal, { turbidity: 0.6 }),
  ];
}

function cherryGem() {
  const body = latheSmooth((v) => {
    const th = Math.PI * v;
    const r = 0.42 * Math.sin(th) * (1 + 0.04 * Math.sin(2 * th));
    const y = 0.38 * Math.cos(th) - 0.13 * Math.exp(-((th / 0.33) ** 2)) + 0.03 * Math.exp(-(((Math.PI - th) / 0.3) ** 2));
    return [r, y];
  }, 40, 28);
  const b0 = [0, 0.24, 0], b1 = [0.02, 0.62, 0], b2 = [0.2, 0.9, -0.03];
  const stem = tubeSmooth((t) => {
    const s = 1 - t;
    return [0, 1, 2].map((k) => s * s * b0[k] + 2 * s * t * b1[k] + t * t * b2[k]);
  }, { radius: (t) => [0.03 - 0.006 * t, 0.03 - 0.006 * t], nu: 8, nv: 16, caps: 3, up: [0, 0, 1] });
  return [smooth(body, "#ff2d8a", { turbidity: 0.36 }), smooth(stem, "#3d9a36", STEM)];
}

function mandarinGem() {
  const n = 9;
  const body = grid((u, v) => {
    const th = Math.PI * v, ph = TAU * u;
    const seg = (u * n) % 1;
    const bulge = Math.pow(Math.sin(Math.PI * seg), 0.35);
    const k = 1 - 0.055 * (1 - bulge) * Math.pow(Math.sin(th), 0.6);
    const r = 0.5 * Math.sin(th) * k;
    const y = (0.42 * Math.cos(th) - 0.05 * Math.exp(-((th / 0.3) ** 2)) + 0.03 * Math.exp(-(((Math.PI - th) / 0.3) ** 2))) * (0.97 + 0.03 * k);
    return [r * Math.cos(ph), y, -r * Math.sin(ph)];
  }, 45, 26, (u, v) => [u * n, v]);
  const calyx = latheSmooth((v) => [0.075 * Math.sin(Math.PI * v), 0.03 * Math.cos(Math.PI * v)], 12, 6);
  const nub = tubeSmooth((t) => [0, 0.38 + 0.07 * t, 0], { radius: () => [0.022, 0.022], nu: 8, nv: 3, caps: 3, up: [0, 0, 1] });
  const tilt = placer({ rotX: 0.35 });
  return [
    smooth(transformMesh(body, tilt), "#ff9a1e", { turbidity: 0.45, pattern: RARE_PATTERN.segments }),
    smooth(transformMesh(mergeMeshes([transformMesh(calyx, placer({ at: [0, 0.375, 0] })), nub]), tilt), "#5d8a2e", STEM),
  ];
}

function rainbowappleGem() {
  const body = latheSmooth((v) => {
    const th = Math.PI * v;
    let r = 0.5 * Math.sin(th) * (1 + 0.08 * Math.cos(th));
    r *= 1 - 0.12 * Math.pow(Math.max(0, -Math.cos(th)), 2);
    const y = 0.44 * Math.cos(th) - 0.15 * Math.exp(-((th / 0.42) ** 2)) + 0.07 * Math.exp(-(((Math.PI - th) / 0.4) ** 2));
    return [r, y];
  }, 40, 30);
  const stem = tubeSmooth((t) => [0.06 * t * t, 0.27 + 0.29 * t, 0], { radius: (t) => [0.032 - 0.006 * t, 0.032 - 0.006 * t], nu: 8, nv: 6, caps: 3, up: [0, 0, 1] });
  return [smooth(body, "#f27ba0", { turbidity: 0.34, sheen: 1 }), smooth(stem, "#7a4a2a", STEM)];
}

function blueberryGem() {
  const body = latheSmooth((v) => {
    const th = Math.PI * v;
    return [0.5 * Math.sin(th), 0.42 * Math.cos(th) - 0.07 * Math.exp(-((th / 0.38) ** 2))];
  }, 36, 24);
  const lobe = (u) => Math.pow(Math.max(0, Math.cos(5 * TAU * u)), 2);
  const crown = grid((u, v) => {
    const a = TAU * u, b = TAU * v;
    const R = 0.1 + 0.055 * lobe(u);
    const rr = R + 0.032 * Math.cos(b);
    return [rr * Math.cos(a), 0.355 + 0.026 * Math.sin(b) + 0.03 * lobe(u) + 0.02 * (R - 0.1) / 0.055, -rr * Math.sin(a)];
  }, 60, 8);
  const centre = latheSmooth((v) => [0.085 * Math.sin(Math.PI * v), 0.34 + 0.018 * Math.cos(Math.PI * v)], 12, 6);
  const tilt = placer({ rotX: 0.5 });
  const dark = "#27304f";
  return [
    smooth(transformMesh(body, tilt), "#93b9e4", { turbidity: 0.86, glitter: 0.5, silver: 1 }),
    smooth(transformMesh(mergeMeshes([crown, centre]), tilt), dark, { turbidity: 0.9 }),
  ];
}

const BUILDERS = [
  capsuleGem, cloverGem, donutGem, cloudGem, triangleGem,
  opalGem, cubeGem, brilliantGem, ringGem, twistGem,
  butterflyGem, crownGem, roseGem, bearGem, swanGem,
  gummybearGem, lollipopGem, candycaneGem, ringpopGem, jellybeanGem,
  strawberryGem, cherryGem, mandarinGem, rainbowappleGem, blueberryGem,
];

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function signedVolume(pos, tri) {
  let v = 0;
  for (const [a, b, c] of tri) v += vdot(pos[a], vcross(pos[b], pos[c]));
  return v / 6;
}

/** Smooth normals: area-weighted face normals accumulated over welded positions. */
function weldedNormals(pos, tri) {
  const key = (p) => `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)},${Math.round(p[2] * 1e5)}`;
  const acc = new Map();
  const keys = pos.map(key);
  for (const [a, b, c] of tri) {
    const n = vcross(vsub(pos[b], pos[a]), vsub(pos[c], pos[a]));
    for (const i of [a, b, c]) {
      const k = keys[i];
      const s = acc.get(k);
      if (s) { s[0] += n[0]; s[1] += n[1]; s[2] += n[2]; } else acc.set(k, n.slice());
    }
  }
  return keys.map((k) => vnorm(acc.get(k) ?? [0, 0, 1]));
}

/**
 * Convex planes of a facet part: one support plane per distinct facet
 * normal (exact hull planes when the part is convex; a tight enclosing
 * polytope otherwise), merged down to `maxPlanes` like gems.js.
 */
function partPlanes(tris, maxPlanes) {
  const pts = [];
  for (const t of tris) for (const p of t) pts.push(p);
  let planes = [];
  for (const [a, b, c] of tris) {
    const raw = vcross(vsub(b, a), vsub(c, a));
    const area = vlen(raw) / 2;
    if (area < 1e-12) continue;
    const n = vscale(raw, 1 / (2 * area));
    const match = planes.find((p) => vdot(p.n0, n) > 0.9998);
    if (match) { match.sum = vadd(match.sum, vscale(n, area)); match.area += area; } else planes.push({ n0: n, sum: vscale(n, area), area });
  }
  const support = (n) => { let d = -Infinity; for (const p of pts) d = Math.max(d, vdot(n, p)); return d; };
  planes = planes.map((p) => { const n = vnorm(p.sum); return { n, d: support(n), area: p.area }; });
  while (planes.length > maxPlanes) {
    let best = Infinity, bi = 0, bj = 1;
    for (let i = 0; i < planes.length; i += 1) for (let j = i + 1; j < planes.length; j += 1) {
      const cost = (1 - vdot(planes[i].n, planes[j].n)) * Math.min(planes[i].area, planes[j].area);
      if (cost < best) { best = cost; bi = i; bj = j; }
    }
    const a = planes[bi], b = planes[bj];
    const n = vnorm(vadd(vscale(a.n, a.area), vscale(b.n, b.area)));
    planes.splice(bj, 1);
    planes[bi] = { n, d: support(n), area: a.area + b.area };
  }
  return planes;
}

function assemble(index, parts) {
  const info = RARE_GEM_INFO[index];
  // Orient every part outward (closed parts: positive signed volume).
  for (const part of parts) {
    if (part.kind === "smooth") {
      if (signedVolume(part.mesh.pos, part.mesh.tri) < 0) part.mesh.tri = part.mesh.tri.map(([a, b, c]) => [a, c, b]);
    } else {
      const tris = part.facets.tris;
      let v = 0;
      for (const [a, b, c] of tris) v += vdot(a, vcross(b, c));
      if (v < 0) part.facets.tris = tris.map(([a, b, c]) => [a, c, b]);
    }
  }
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const grow = (p) => { for (let k = 0; k < 3; k += 1) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); } };
  for (const part of parts) {
    if (part.kind === "smooth") part.mesh.pos.forEach(grow); else for (const t of part.facets.tris) t.forEach(grow);
  }
  const centre = vscale(vadd(min, max), 0.5);
  const scale = RARE_SIZE / Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const toM = (p) => vscale(vsub(p, centre), scale);

  const P = [], Nn = [], C = [], A = [], B = [], I = [];
  const outParts = [];
  let vertex = 0;
  let planesOut = [];
  const pushVertex = (p, n, col, a, b) => { P.push(p[0], p[1], p[2]); Nn.push(n[0], n[1], n[2]); C.push(col[0], col[1], col[2]); A.push(a[0], a[1], a[2], a[3]); B.push(b[0], b[1], b[2], b[3]); };
  const linear = (hex) => hexToRgb01(hex).map(srgbToLinear);
  const groups = [];

  // Smooth parts first (group 0), then facet parts (group 1).
  let facetVertexStart = 0;
  for (const kind of ["smooth", "facet"]) {
    const start = I.length;
    if (kind === "facet") facetVertexStart = vertex;
    for (const part of parts) {
      if (part.kind !== kind) continue;
      const col = linear(part.color);
      const s = part.style;
      const startIndex = I.length;
      if (kind === "smooth") {
        const m = part.mesh;
        const pos = m.pos.map(toM);
        const nrm = m.nrm ?? weldedNormals(pos, m.tri);
        const pmin = [Infinity, Infinity, Infinity], pmax = [-Infinity, -Infinity, -Infinity];
        for (const p of pos) for (let k = 0; k < 3; k += 1) { pmin[k] = Math.min(pmin[k], p[k]); pmax[k] = Math.max(pmax[k], p[k]); }
        const thick = s.thick !== undefined ? s.thick * scale : 0.5 * Math.min(pmax[0] - pmin[0], pmax[1] - pmin[1], pmax[2] - pmin[2]);
        const base = vertex;
        pos.forEach((p, i) => {
          const uv = m.uv[i] ?? [0, 0];
          pushVertex(p, nrm[i], col, [s.pattern ?? 0, uv[0], uv[1], thick], [s.turbidity ?? 0.5, s.glitter ?? 0, s.sheen ?? 0, s.silver ?? 0]);
        });
        vertex += pos.length;
        for (const [a, b, c] of m.tri) I.push(base + a, base + b, base + c);
        outParts.push({ kind, color: part.color, start: startIndex, count: I.length - startIndex, thickness: thick });
      } else {
        const tris = part.facets.tris.map((t) => t.map(toM));
        const planes = partPlanes(tris, s.maxPlanes ?? 12);
        // Absorption depth follows the part's own thickness unless given, so a
        // thin wing and a chunky body of the same colour read alike.
        const fmin = [Infinity, Infinity, Infinity], fmax = [-Infinity, -Infinity, -Infinity];
        for (const t of tris) for (const p of t) for (let k = 0; k < 3; k += 1) { fmin[k] = Math.min(fmin[k], p[k]); fmax[k] = Math.max(fmax[k], p[k]); }
        const thinnest = Math.min(fmax[0] - fmin[0], fmax[1] - fmin[1], fmax[2] - fmin[2]);
        const absorb = s.absorb ?? clamp((1.6 * thinnest) / RARE_SIZE, 0.15, 1.2);
        const offset = planesOut.length;
        planesOut = planesOut.concat(planes);
        for (const t of tris) {
          const n = vnorm(vcross(vsub(t[1], t[0]), vsub(t[2], t[0])));
          for (const p of t) pushVertex(p, n, col, [offset, planes.length, s.ior ?? 2.0, s.irid ?? 0], [absorb, 0, 0, 1]);
          I.push(vertex, vertex + 1, vertex + 2);
          vertex += 3;
        }
        outParts.push({ kind, color: part.color, start: startIndex, count: I.length - startIndex, planeOffset: offset, planeCount: planes.length });
      }
    }
    if (I.length > start) groups.push({ start, count: I.length - start, materialIndex: kind === "smooth" ? 0 : 1 });
  }

  const positions = new Float32Array(P);
  let radius = 0;
  for (let i = 0; i < positions.length; i += 3) radius = Math.max(radius, Math.hypot(positions[i], positions[i + 1], positions[i + 2]));
  const planes = new Float32Array(planesOut.length * 4);
  planesOut.forEach((p, i) => planes.set([p.n[0], p.n[1], p.n[2], p.d], i * 4));
  const bmin = [Infinity, Infinity, Infinity], bmax = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k += 1) { bmin[k] = Math.min(bmin[k], positions[i + k]); bmax[k] = Math.max(bmax[k], positions[i + k]); }
  return {
    index,
    id: info.id,
    positions,
    normals: new Float32Array(Nn),
    colors: new Float32Array(C),
    partA: new Float32Array(A),
    partB: new Float32Array(B),
    indices: vertex < 65536 ? new Uint16Array(I) : new Uint32Array(I),
    groups,
    parts: outParts,
    planes,
    planeCount: planesOut.length,
    vertexCount: vertex,
    /** Vertices from here on belong to facet parts (rareA.x = plane offset). */
    facetVertexStart,
    triangles: I.length / 3,
    radius,
    bounds: { min: bmin, max: bmax },
  };
}

const cache = new Map();

/** Geometry arrays for rare gem `index` (cached; treat as read-only). */
export function rareShapeData(index) {
  const i = Math.min(BUILDERS.length - 1, Math.max(0, index | 0));
  let data = cache.get(i);
  if (!data) { data = assemble(i, BUILDERS[i]()); cache.set(i, data); }
  return data;
}

// ---------------------------------------------------------------------------
// SVG icon: front silhouettes per part (rasterised coverage → marching
// squares → simplified paths), gradient-shaded, with the tier treatment.
// ---------------------------------------------------------------------------

const ICON = 48, PAD = 3.5, GRID = 72;
const iconCache = new Map();

const mixRgb = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const css = (c) => `#${c.map((x) => Math.round(clamp(x, 0, 1) * 255).toString(16).padStart(2, "0")).join("")}`;
const fmt = (x) => String(Math.round(x * 10) / 10);

function coverage(data, part, project) {
  const G = GRID + 1;
  const field = new Float32Array(G * G);
  const { positions, indices } = data;
  let zsum = 0, zn = 0;
  for (let t = part.start; t < part.start + part.count; t += 3) {
    const v = [indices[t], indices[t + 1], indices[t + 2]].map((i) => project(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]));
    // Screen y points down, so front-facing (normal z > 0) triangles have a
    // negative screen-space area; back faces never extend the silhouette.
    const area = (v[1][0] - v[0][0]) * (v[2][1] - v[0][1]) - (v[2][0] - v[0][0]) * (v[1][1] - v[0][1]);
    if (area > -1e-9) continue;
    zsum += v[0][2] + v[1][2] + v[2][2]; zn += 3;
    const x0 = Math.max(0, Math.floor(Math.min(v[0][0], v[1][0], v[2][0]))), x1 = Math.min(GRID, Math.ceil(Math.max(v[0][0], v[1][0], v[2][0])));
    const y0 = Math.max(0, Math.floor(Math.min(v[0][1], v[1][1], v[2][1]))), y1 = Math.min(GRID, Math.ceil(Math.max(v[0][1], v[1][1], v[2][1])));
    for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) {
      const w0 = (v[1][0] - x) * (v[2][1] - y) - (v[2][0] - x) * (v[1][1] - y);
      const w1 = (v[2][0] - x) * (v[0][1] - y) - (v[0][0] - x) * (v[2][1] - y);
      const w2 = (v[0][0] - x) * (v[1][1] - y) - (v[1][0] - x) * (v[0][1] - y);
      if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0)) field[y * G + x] = 1;
    }
  }
  // Light blur so the contour is smooth, then contour at 0.5.
  const out = new Float32Array(G * G);
  for (let y = 0; y < G; y += 1) for (let x = 0; x < G; x += 1) {
    let s = 0, w = 0;
    for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
      const xx = x + dx, yy = y + dy;
      const k = dx === 0 && dy === 0 ? 4 : (dx === 0 || dy === 0 ? 2 : 1);
      s += (xx >= 0 && yy >= 0 && xx < G && yy < G ? field[yy * G + xx] : 0) * k; w += k;
    }
    out[y * G + x] = s / w;
  }
  return { field: out, z: zn ? zsum / zn : 0 };
}

function contours(field) {
  const G = GRID + 1;
  const f = (x, y) => field[y * G + x];
  const segs = [];
  const point = (key) => {
    const [kind, x, y] = key.split(",").map(Number);
    if (kind === 0) { const a = f(x, y), b = f(x + 1, y); return [x + (0.5 - a) / (b - a), y]; }
    const a = f(x, y), b = f(x, y + 1); return [x, y + (0.5 - a) / (b - a)];
  };
  for (let y = 0; y < GRID; y += 1) for (let x = 0; x < GRID; x += 1) {
    const c = [f(x, y) >= 0.5, f(x + 1, y) >= 0.5, f(x + 1, y + 1) >= 0.5, f(x, y + 1) >= 0.5];
    const e = [`0,${x},${y}`, `1,${x + 1},${y}`, `0,${x},${y + 1}`, `1,${x},${y}`]; // top, right, bottom, left
    const idx = (c[0] ? 1 : 0) | (c[1] ? 2 : 0) | (c[2] ? 4 : 0) | (c[3] ? 8 : 0);
    const table = {
      1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]], 6: [[0, 2]], 7: [[3, 2]], 8: [[2, 3]], 9: [[2, 0]],
      11: [[2, 1]], 12: [[1, 3]], 13: [[1, 0]], 14: [[0, 3]],
    };
    if (idx === 5 || idx === 10) {
      // Saddle: the centre value decides which corner pair stays connected.
      const centre = (f(x, y) + f(x + 1, y) + f(x + 1, y + 1) + f(x, y + 1)) / 4 >= 0.5;
      const cut13 = [[0, 1], [2, 3]], cut02 = [[3, 0], [1, 2]];
      const pairs = idx === 5 ? (centre ? cut13 : cut02) : (centre ? cut02 : cut13);
      for (const [a, b] of pairs) segs.push([e[a], e[b]]);
    } else if (table[idx]) for (const [a, b] of table[idx]) segs.push([e[a], e[b]]);
  }
  const byKey = new Map();
  segs.forEach((s, i) => { for (const k of s) { if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(i); } });
  const used = new Uint8Array(segs.length);
  const loops = [];
  for (let i = 0; i < segs.length; i += 1) {
    if (used[i]) continue;
    used[i] = 1;
    const keys = [segs[i][0], segs[i][1]];
    for (;;) {
      const last = keys[keys.length - 1];
      const next = (byKey.get(last) || []).find((j) => !used[j]);
      if (next === undefined) break;
      used[next] = 1;
      keys.push(segs[next][0] === last ? segs[next][1] : segs[next][0]);
    }
    if (keys.length > 3) loops.push(keys.map(point));
  }
  return loops;
}

function simplify(points, tol) {
  if (points.length < 4) return points;
  const rdp = (pts) => {
    if (pts.length < 3) return pts;
    const a = pts[0], b = pts[pts.length - 1];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1e-9;
    let best = -1, bi = 0;
    for (let i = 1; i < pts.length - 1; i += 1) {
      const d = Math.abs((pts[i][0] - a[0]) * dy - (pts[i][1] - a[1]) * dx) / len;
      if (d > best) { best = d; bi = i; }
    }
    if (best <= tol) return [a, b];
    const l = rdp(pts.slice(0, bi + 1)), r = rdp(pts.slice(bi));
    return l.slice(0, -1).concat(r);
  };
  let far = 0, fd = -1;
  for (let i = 1; i < points.length; i += 1) { const d = dist2([...points[0], 0], [...points[i], 0]); if (d > fd) { fd = d; far = i; } }
  const a = rdp(points.slice(0, far + 1)), b = rdp(points.slice(far).concat([points[0]]));
  return a.slice(0, -1).concat(b.slice(0, -1));
}

const iconBases = new Map();

// Tier-independent part of an icon: part paths, silhouette and sparkle spots.
function iconBase(i) {
  let base = iconBases.get(i);
  if (base) return base;
  const data = rareShapeData(i);
  const { min, max } = data.bounds;
  const span = Math.max(max[0] - min[0], max[1] - min[1]);
  const s = (ICON - PAD * 2) / span;
  const ox = ICON / 2 - ((min[0] + max[0]) / 2) * s, oy = ICON / 2 + ((min[1] + max[1]) / 2) * s;
  const g = GRID / ICON;
  const project = (x, y, z) => [(ox + x * s) * g, (oy - y * s) * g, z];
  // Group parts by colour (same colour → one path), sorted back to front.
  const groups = new Map();
  for (const part of data.parts) {
    const cov = coverage(data, part, project);
    const prev = groups.get(part.color);
    if (prev) { for (let k = 0; k < prev.field.length; k += 1) prev.field[k] = Math.max(prev.field[k], cov.field[k]); prev.z = Math.max(prev.z, cov.z); } else groups.set(part.color, { color: part.color, ...cov });
  }
  const list = [...groups.values()].sort((a, b) => a.z - b.z);
  const union = new Float32Array((GRID + 1) * (GRID + 1));
  const toPath = (loops) => loops.map((l) => `M${l.map(([x, y]) => `${fmt(x / g)} ${fmt(y / g)}`).join("L")}Z`).join("");
  const paths = [];
  for (const grp of list) {
    for (let m = 0; m < union.length; m += 1) union[m] = Math.max(union[m], grp.field[m]);
    const loops = contours(grp.field).map((l) => simplify(l, 0.45 * g));
    if (loops.length) paths.push({ color: grp.color, d: toPath(loops) });
  }
  const silhouette = toPath(contours(union).map((l) => simplify(l, 0.45 * g)));
  // Deterministic sparkle spots inside the silhouette.
  const inside = (x, y) => { const gx = Math.round(x * g), gy = Math.round(y * g); return gx >= 0 && gy >= 0 && gx <= GRID && gy <= GRID && union[gy * (GRID + 1) + gx] > 0.75; };
  let seed = 1234567 + i * 7919;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const spots = [];
  for (let tries = 0; tries < 400 && spots.length < 16; tries += 1) {
    const x = PAD + rnd() * (ICON - 2 * PAD), y = PAD + rnd() * (ICON - 2 * PAD);
    if (inside(x, y)) spots.push([x, y, rnd()]);
  }
  base = { paths, silhouette, spots };
  iconBases.set(i, base);
  return base;
}

/**
 * Small SVG (48×48) of rare gem `index` in its own colours, with the tier
 * treatment: 0 glitter (white sparkles), 1 gold (gold rim + flecks),
 * 2 rainbow (iridescent sheen + rainbow rim).
 */
export function rareIconSVG(index, tier = 0) {
  const i = Math.min(BUILDERS.length - 1, Math.max(0, index | 0));
  const t = Math.min(2, Math.max(0, tier | 0));
  const key = `${i}|${t}`;
  const cached = iconCache.get(key);
  if (cached) return cached;
  const { paths, silhouette, spots: allSpots } = iconBase(i);
  const spots = allSpots.slice(0, t === 2 ? 16 : 13);
  const id = `rg${i}t${t}`;
  let defs = "", body = "";
  paths.forEach(({ color, d }, k) => {
    const base = hexToRgb01(color);
    const light = mixRgb(base, [1, 1, 1], 0.55), deep = base.map((c) => c * 0.72);
    defs += `<linearGradient id="${id}g${k}" x1="0.2" y1="0" x2="0.8" y2="1"><stop offset="0" stop-color="${css(light)}"/><stop offset="0.55" stop-color="${css(base)}"/><stop offset="1" stop-color="${css(deep)}"/></linearGradient>`;
    body += `<path d="${d}" fill="url(#${id}g${k})" fill-rule="evenodd" stroke="${css(mixRgb(deep, [0.25, 0.2, 0.3], 0.25))}" stroke-width="0.9" stroke-linejoin="round"/>`;
  });
  let over = `<ellipse cx="${fmt(ICON * 0.38)}" cy="${fmt(ICON * 0.3)}" rx="${fmt(ICON * 0.16)}" ry="${fmt(ICON * 0.08)}" transform="rotate(-28 ${fmt(ICON * 0.38)} ${fmt(ICON * 0.3)})" fill="#fff" opacity="0.5"/>`;
  let rim = "";
  const star = (x, y, r, fill) => `<path d="M${fmt(x)} ${fmt(y - r)}L${fmt(x + r * 0.28)} ${fmt(y - r * 0.28)}L${fmt(x + r)} ${fmt(y)}L${fmt(x + r * 0.28)} ${fmt(y + r * 0.28)}L${fmt(x)} ${fmt(y + r)}L${fmt(x - r * 0.28)} ${fmt(y + r * 0.28)}L${fmt(x - r)} ${fmt(y)}L${fmt(x - r * 0.28)} ${fmt(y - r * 0.28)}Z" fill="${fill}"/>`;
  const rainbow = ["#ff6b8b", "#ffb347", "#fff275", "#7be0a0", "#6cc6ff", "#b388ff"];
  if (t === 0) {
    over += spots.map(([x, y, r]) => `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${fmt(0.35 + r * 0.45)}" fill="#fff" opacity="${fmt(0.55 + r * 0.45)}"/>`).join("");
    over += spots.slice(0, 3).map(([x, y, r]) => star(x, y, 2.6 + r * 1.6, "#fff")).join("");
  } else if (t === 1) {
    defs += `<linearGradient id="${id}gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff6c4"/><stop offset="0.45" stop-color="#f2c14e"/><stop offset="1" stop-color="#b8801e"/></linearGradient>`;
    over = `<rect width="${ICON}" height="${ICON}" fill="#ffcf5a" opacity="0.18"/>` + over;
    over += spots.map(([x, y, r]) => `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${fmt(0.4 + r * 0.5)}" fill="${r > 0.5 ? "#ffe9a0" : "#e8b13c"}"/>`).join("");
    over += spots.slice(0, 3).map(([x, y, r]) => star(x, y, 2.6 + r * 1.6, "#fff4c2")).join("");
    rim = `<path d="${silhouette}" fill="none" stroke="url(#${id}gold)" stroke-width="1.6" stroke-linejoin="round"/>`;
  } else {
    defs += `<linearGradient id="${id}rb" x1="0" y1="0" x2="1" y2="1">${rainbow.map((c, k) => `<stop offset="${fmt(k / (rainbow.length - 1))}" stop-color="${c}"/>`).join("")}</linearGradient>`;
    over = `<rect width="${ICON}" height="${ICON}" fill="url(#${id}rb)" opacity="0.32"/>` + over;
    over += spots.map(([x, y, r], k) => `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${fmt(0.4 + r * 0.5)}" fill="${rainbow[k % rainbow.length]}"/>`).join("");
    over += spots.slice(0, 4).map(([x, y, r]) => star(x, y, 2.6 + r * 1.8, "#fff")).join("");
    rim = `<path d="${silhouette}" fill="none" stroke="url(#${id}rb)" stroke-width="1.6" stroke-linejoin="round"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ICON} ${ICON}" width="${ICON}" height="${ICON}" aria-hidden="true">`
    + `<defs>${defs}<clipPath id="${id}c"><path d="${silhouette}"/></clipPath></defs>`
    + body
    + `<g clip-path="url(#${id}c)">${over}</g>`
    + rim
    + `</svg>`;
  iconCache.set(key, svg);
  return svg;
}
