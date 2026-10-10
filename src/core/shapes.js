// Jelly shapes: the original flower plus five signed-distance shapes that are
// turned into soft-body cages by the isosurface-stuffing mesher
// (shape-mesher.js). Pure JS (no three.js) so it runs in the physics Worker.
//
// Units: shapes are modelled in millimetres (y up, front = +z, flat bottom at
// y = 10 mm) and the cages come out in metres with the bottom at exactly 0.010.
//
//   SHAPES             frozen list { id, label, level } (unlock level)
//   makeShapeCage(id)  → { pos, tets, boundary, totalVolume } (cached per id;
//                        "flower" is makeFlowerCage() unchanged)
//   shapeLook(id)      → { dye, fx, glitter, pearls, decor } (cached per id;
//                        dye/fx take REST cage coordinates in metres)
//   shapeStats(id)     → mesher statistics (nodes, tets, quality …)
//   buildShapeCage(id) → a fresh, uncached cage (determinism tests)
//   shapeSDF(id)       → the shape's signed distance (model mm, world frame)
//   shapeMotions(id)   → null or the idle-motion data of the animal shapes
//                        (interval, moves, model axes, soft body regions in
//                        rest cage metres; motionWeight() weighs a point)
//
// Every shape is tuned on the real SoftBody (tests/shapes.test.mjs): a flat
// seat under the centre of mass so a bounce cannot tip it over, no feature
// thinner than ~2 lattice cells, 95–135 cm³ like the flower, and colours
// strong enough for the app's absorption over the view depth (jelly-view.js:
// tint ≈ exp(−σ · depth · 0.82), depth ≈ 20–40 mm).

import { makeFlowerCage, makeSurfaceStencils, evaluateSurface, computeVertexNormals } from "./cage.js";
import { meshSDF } from "./shape-mesher.js";

export const SHAPES = Object.freeze([
  Object.freeze({ id: "flower", label: "꽃", level: 1 }),
  Object.freeze({ id: "pudding", label: "푸딩", level: 2 }),
  Object.freeze({ id: "cake", label: "케이크", level: 4 }),
  Object.freeze({ id: "bear", label: "곰젤리", level: 6 }),
  Object.freeze({ id: "cat", label: "고양이", level: 8 }),
  Object.freeze({ id: "bird", label: "새", level: 10 }),
]);

// ------------------------------------------------------------------ SDF kit (mm)
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;
const mix3 = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
function smin(a, b, k) {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}
const smax = (a, b, k) => -smin(-a, -b, k);
const sphere = (x, y, z, c, r) => Math.hypot(x - c[0], y - c[1], z - c[2]) - r;
// Quilez's ellipsoid bound (good near the surface, which is all the mesher needs)
function ellipsoid(x, y, z, c, r) {
  const px = (x - c[0]) / r[0], py = (y - c[1]) / r[1], pz = (z - c[2]) / r[2];
  const k0 = Math.hypot(px, py, pz), k1 = Math.hypot(px / r[0], py / r[1], pz / r[2]);
  return k1 > 1e-12 ? k0 * (k0 - 1) / k1 : -Math.min(r[0], r[1], r[2]);
}
// Quilez's round cone between spheres (a, r1) and (b, r2)
function roundCone(x, y, z, a, b, r1, r2) {
  const bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2];
  const l2 = bax * bax + bay * bay + baz * baz, rr = r1 - r2, a2 = l2 - rr * rr, il2 = 1 / l2;
  const pax = x - a[0], pay = y - a[1], paz = z - a[2];
  const yy = pax * bax + pay * bay + paz * baz, zz = yy - l2;
  const qx = pax * l2 - bax * yy, qy = pay * l2 - bay * yy, qz = paz * l2 - baz * yy;
  const x2 = qx * qx + qy * qy + qz * qz, y2 = yy * yy * l2, z2 = zz * zz * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(zz) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
  if (Math.sign(yy) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
  return (Math.sqrt(x2 * a2 * il2) + yy * rr) * il2 - r1;
}
function roundBox(x, y, z, c, half, r) {
  const qx = Math.abs(x - c[0]) - half[0] + r, qy = Math.abs(y - c[1]) - half[1] + r, qz = Math.abs(z - c[2]) - half[2] + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - r;
}
// exact 2D distance to a polygon (Quilez), negative inside
function polygon2(px, py, v) {
  let d = (px - v[0][0]) ** 2 + (py - v[0][1]) ** 2, s = 1;
  for (let i = 0, j = v.length - 1; i < v.length; j = i, i++) {
    const ex = v[j][0] - v[i][0], ey = v[j][1] - v[i][1], wx = px - v[i][0], wy = py - v[i][1];
    const t = clamp((wx * ex + wy * ey) / (ex * ex + ey * ey), 0, 1);
    const bx = wx - ex * t, by = wy - ey * t;
    d = Math.min(d, bx * bx + by * by);
    const c1 = py >= v[i][1], c2 = py < v[j][1], c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * Math.sqrt(d);
}
// Yaw (about +y, radians) and an offset in the local frame (used to centre the
// footprint): world = Ry(yaw)·(local + t), in mm.
function frame(yaw, t = [0, 0, 0]) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return {
    toLocal(x, y, z, out) { out[0] = c * x - s * z - t[0]; out[1] = y - t[1]; out[2] = s * x + c * z - t[2]; return out; },
    toWorld(p) { const x = p[0] + t[0], z = p[2] + t[2]; return [c * x + s * z, p[1] + t[1], -s * x + c * z]; },
    dirToWorld(d) { return [c * d[0] + s * d[2], d[1], -s * d[0] + c * d[2]]; },
  };
}
const FLOOR = 10;                                   // mm: flat bottom of every shape
const floorCut = (d, y, k = 3) => smax(d, FLOOR - y, k);
const BUDGET = { maxNodes: 930, maxTets: 3720, floorSnap: 0.3 };

// ------------------------------------------------------------------ shapes
// Each shape: sdf (world mm), mesher settings, look in local coordinates.

// 1) 푸딩 — bundt jelly mould: 8 rounded flutes, wider at the base, crown of
// rounded lobes around a shallow dip. Pink, deeper toward the top.
function makePudding() {
  const N = 8, sector = 2 * Math.PI / N;
  const fluteA = [24.5, 12, 0], fluteB = [17.5, 46, 0], rA = 10.6, rB = 9.2;
  const nb = [Math.cos(sector), Math.sin(sector)];
  const sdfLocal = (x, y, z) => {
    const r = Math.hypot(x, z);
    let th = Math.atan2(z, x);
    th -= sector * Math.round(th / sector);          // fold into the nearest flute's sector
    const lx = r * Math.cos(th), lz = Math.abs(r * Math.sin(th));
    const f0 = roundCone(lx, y, lz, fluteA, fluteB, rA, rB);
    // neighbour flute (rotated by one sector toward +z)
    const nx = lx * nb[0] + lz * nb[1], nz = -lx * nb[1] + lz * nb[0];
    const f1 = roundCone(nx, y, nz, fluteA, fluteB, rA, rB);
    let d = smin(f0, f1, 3.2);
    // core with a rounded top just below the crown → shallow centre dip
    const core = roundBox(x, y, z, [0, 26, 0], [19, 22.5, 19], 6);
    const coreRound = Math.max(r - 19, Math.abs(y - 26) - 22.5);
    d = smin(d, Math.max(core, coreRound), 4.5);
    return floorCut(d, y, 2.5);
  };
  return {
    sdf: sdfLocal,
    mesh: { h: 6.6, bounds: [-37, 8, -37, 37, 58, 37], origin: [0, 10, 0], ...BUDGET },
    look: () => ({
      dye: (x, y) => mix3([3, 26, 13], [5, 72, 34], smoothstep(16, 52, y)),
      fx: null, glitter: 0, pearls: 0,
      decor: [],
    }),
  };
}

// 2) 케이크 — rainbow cake slice (rounded wedge) with a cherry on top.
function makeCake() {
  const L = 78, halfW = 31, H = 44, R = 6.5;              // tip-to-back, back half width, height, edge radius
  const beta = Math.asin(halfW / L);
  // inset sector polygon (offset by R) in the slice plane: u along the tip→back axis, w across
  const apex = R / Math.sin(beta), Ri = L - R;
  const tanB = Math.tan(beta), off = R / Math.cos(beta);
  // side lines w = ±(u·tanβ − off); intersect with the circle u² + w² = Ri²
  const A = 1 + tanB * tanB, B = -2 * tanB * off, C = off * off - Ri * Ri;
  const uEnd = (-B + Math.sqrt(B * B - 4 * A * C)) / (2 * A), wEnd = uEnd * tanB - off;
  const gEnd = Math.atan2(wEnd, uEnd);
  const poly = [[apex, 0]];
  const K = 12;
  for (let i = 0; i <= K; i++) { const g = -gEnd + 2 * gEnd * i / K; poly.push([Ri * Math.cos(g), Ri * Math.sin(g)]); }
  // centre the slice: circumcentre of tip and back corners on the axis
  const cu = (L * L) / (2 * L * Math.cos(beta));
  const yaw = -80 * Math.PI / 180;                      // tip toward −x (a little toward the camera)
  const F = frame(0, [0, 0, 0]);
  const dirTip = [Math.sin(yaw), 0, Math.cos(yaw)], dirSide = [Math.cos(yaw), 0, -Math.sin(yaw)];
  // world → slice coordinates: u = (cu) − dot(p, dirTip) … tip at u = 0
  const toSlice = (x, z) => [cu - (x * dirTip[0] + z * dirTip[2]), x * dirSide[0] + z * dirSide[2]];
  const yc = FLOOR + H / 2;
  const sdf = (x, y, z) => {
    const [u, w] = toSlice(x, z);
    const d2 = polygon2(u, w, poly);
    const qx = d2, qy = Math.abs(y - yc) - (H / 2 - R);
    return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - R;
  };
  const fromSlice = (u, w, y) => {
    const a = cu - u;            // along dirTip
    return [a * dirTip[0] + w * dirSide[0], y, a * dirTip[2] + w * dirSide[2]];
  };
  // Horizontal rainbow layers (σ, 1/m) bottom → top. The dye lives on the
  // cage nodes; the mesher lines the wall nodes up in rows every h/2 = 3.4 mm
  // (smoothing.levels), each band spans two rows and its edges fall midway
  // between rows, so the layers come out straight and crisp. σ is strong because the app absorbs over
  // the view depth (~25 mm), not a fixed 55 mm.
  const bands = [
    [FLOOR, [2.5, 12, 8]],             // clear pink base
    [15.1, [72, 17, 2.5]],             // sky blue
    [21.9, [44, 6, 48]],               // green
    [28.7, [1.2, 5, 62]],              // yellow
    [35.5, [0.8, 27, 60]],             // orange
    [42.3, [1.5, 36, 16]],             // pink
    [49.1, [15, 32, 3]],               // lavender top
  ];
  const dye = (x, Y) => {
    let s = bands[0][1];
    for (let i = 1; i < bands.length; i++) s = mix3(s, bands[i][1], smoothstep(bands[i][0] - 0.6, bands[i][0] + 0.6, Y));
    return s;
  };
  return {
    sdf, frame: F,
    mesh: { h: 6.8, bounds: [-46, 8, -46, 46, 56, 46], origin: [0, 10, 0], ...BUDGET, smoothing: { levels: { y0: FLOOR, step: 3.4, tol: 1.3, maxSlope: 0.5 } } },
    look: (anchor) => ({
      dye, fx: null, glitter: 60, pearls: 0,
      decor: [
        anchor({ kind: "cherry", from: fromSlice(L * 0.70, 0, FLOOR + H - 6), dir: [0, 1, 0], upHint: dirTip.map((v) => -v), scale: 0.0075 }),
      ],
    }),
  };
}

// 3) 곰젤리 — seated chubby gummy bear (2.jpg): a big round head (the upper
// ~55 %) with round ears, overhanging a round belly; short arms at the sides
// and two big round feet sticking forward under the chin. Lavender purple.
function makeBear() {
  const sdf = (x, y, z) => {
    const ax = Math.abs(x);
    // proportions tuned on the real SoftBody: lower and the head bobs, higher
    // or further forward/back and a bounce tips the soft body over
    const head = ellipsoid(ax, y, z, [0, 44, 4], [29.2, 17.5, 24.5]);
    const ear = ellipsoid(ax, y, z, [20.5, 57.5, 0.6], [8.9, 8.2, 9.3]);
    const body = ellipsoid(ax, y, z, [0, 26, 0], [24.3, 16, 21.7]);
    // the sitting bottom: a wide, low pad (flat base ~50 × 50 mm) that keeps
    // the heavy head from rocking the soft body over when it bounces
    const seat = ellipsoid(ax, y, z, [0, 13.5, 0.6], [26.5, 7.5, 26.2]);
    const belly = ellipsoid(ax, y, z, [0, 25, 8], [17.8, 12.5, 16.5]);
    const arm = ellipsoid(ax, y, z, [24.3, 29, 8], [9.1, 10.5, 10]);
    const foot = ellipsoid(ax, y, z, [14.6, 16.5, 18.8], [12.4, 9.5, 14.2]);
    let d = smin(body, seat, 5);
    d = smin(d, belly, 4);
    d = smin(d, foot, 3);
    d = smin(d, arm, 2.5);
    d = smin(d, head, 5);                // a soft crease under the cheeks, but a thick neck
    d = smin(d, ear, 4.5);
    return floorCut(d, y, 3);
  };
  const face = (x, y, dir) => ({ from: [x, y, 0], dir: dir || [0, 0, 1] });
  return {
    sdf,
    mesh: { h: 6.6, bounds: [-38, 8, -32, 38, 70, 36], origin: [0, 10, 0], ...BUDGET },
    // idle motion (world.js MOVES): every 5 s a 꿀 핥기 (lick). Region: the
    // big round head with its ears (the belly, arms, feet and seat stay).
    motions: {
      interval: 5, moves: ["lick"],
      regions: {
        head: [
          { c: [0, 46, 4], r: [30, 16.5, 25.5], inner: 0.45 },
          { c: [-20.5, 57.5, 0.6], r: [11, 11, 11], inner: 0.5 },
          { c: [20.5, 57.5, 0.6], r: [11, 11, 11], inner: 0.5 },
        ],
      },
    },
    look: (anchor) => ({
      dye: () => [16, 34, 4],
      fx: null, glitter: 0, pearls: 0,
      decor: [
        anchor({ kind: "eye", ...face(-10.8, 47.5, [-0.12, 0, 1]), scale: 0.003 }),
        anchor({ kind: "eye", ...face(10.8, 47.5, [0.12, 0, 1]), scale: 0.003 }),
        anchor({ kind: "nose", ...face(0, 43.2), scale: 0.002, color: "#3a2440" }),
        anchor({ kind: "mouth", ...face(0, 40.2), scale: 0.0028 }),
        // the tongue (hidden: only the lick shows it), pivot in the open mouth
        anchor({ kind: "tongue", ...face(0, 37.5), scale: 0.0032, hidden: true }),
        anchor({ kind: "blush", ...face(-16, 42.5, [-0.2, -0.05, 1]), scale: 0.0046 }),
        anchor({ kind: "blush", ...face(16, 42.5, [0.2, -0.05, 1]), scale: 0.0046 }),
        // the round ears' inner circles (2.jpg: ring ears)
        anchor({ kind: "blush", from: [-20.5, 57.5, 0.6], dir: [-0.15, 0.1, 1], scale: 0.0042, color: "#9a72d0" }),
        anchor({ kind: "blush", from: [20.5, 57.5, 0.6], dir: [0.15, 0.1, 1], scale: 0.0042, color: "#9a72d0" }),
      ],
    }),
  };
}

// 4) 고양이 — strawberry jelly cat: a round dome (the cat's head, seen from
// the front) with two pointed ears on top and two small round front paws
// peeking out at the foot of the face, standing in a thick scalloped skirt
// (a jelly mould's wavy rim). Clear strawberry pink, deeper toward the ear
// tips; strawberry halves set inside (decor material points, not gems); a
// dot-eyed ω face with whiskers. The skirt is a fat ring (≈ 2 lattice cells
// thick, not a floor flange: a thin one turned inside out under bites in v7).
function makeCat() {
  const F = frame(0);
  // dome: the upper half of an ellipsoid standing on the floor (a little
  // flatter front-to-back, its centre a little behind the footprint's)
  const DOME_C = [0, FLOOR, -1.5], DOME_R = [32, 39, 30];
  // skirt: a ring (tube radius RIM_T, centre RIM_Y) round the dome's foot
  // whose radius waves RIM_N times around (± RIM_A): the scallops
  const RIM_R = 31, RIM_T = 7.4, RIM_Y = FLOOR + 3.6, RIM_N = 10, RIM_A = 2.8;
  const ears = [-1, 1].map((s) => ({ a: [s * 15.5, FLOOR + 30.5, -3.3], b: [s * 23, FLOOR + 50, -3.3] }));
  const EAR_R = [9.4, 3.6], EAR_FLAT = 1.15;
  const paws = [-1, 1].map((s) => [s * 10, FLOOR + 12.5, 29.5]);
  const PAW_R = [7.5, 6.8, 7.5];
  // flattened round cone (thinner front-to-back)
  const ear = (e, x, y, z) => roundCone(x, y, (z - e.a[2]) * EAR_FLAT + e.a[2], e.a, e.b, EAR_R[0], EAR_R[1]);
  const sdf = (x, y, z) => {
    let d = ellipsoid(x, y, z, DOME_C, DOME_R);
    const dx = x - DOME_C[0], dz = z - DOME_C[2], rho = Math.hypot(dx, dz), th = Math.atan2(dz, dx);
    // (the waving radius makes this only roughly a distance, |∇| ≈ 1 ± A·N/R:
    // fine for the mesher, which needs the zero set)
    d = smin(d, Math.hypot(rho - (RIM_R + RIM_A * Math.cos(RIM_N * th)), y - RIM_Y) - RIM_T, 6);
    for (const e of ears) d = smin(d, ear(e, x, y, z), 3);
    for (const p of paws) d = smin(d, ellipsoid(x, y, z, p, PAW_R), 2.5);
    return floorCut(d, y, 3);
  };
  // how far up an ear a point is (0 at the dome … 1 at the tip)
  const earT = (x, y, z) => {
    let k = 0;
    for (const e of ears) {
      const ax = e.b[0] - e.a[0], ay = e.b[1] - e.a[1], t = ((x - e.a[0]) * ax + (y - e.a[1]) * ay) / (ax * ax + ay * ay);
      if (ear(e, x, y, z) < 3) k = Math.max(k, clamp(t, 0, 1));
    }
    return k;
  };
  const PINK = [2.3, 23.5, 16.5], DEEP = [3.8, 48, 31];
  return {
    sdf, frame: F,
    mesh: { h: 6.75, bounds: [-44, 8, -44, 44, 64, 44], origin: [0, 10, 0], ...BUDGET },
    // idle motions (world.js MOVES): every 5 s a yawn or a 냥냥펀치. Regions
    // are soft ellipsoids (model mm): the head = the upper dome with both
    // ears (the skirt and the paws stay), each front paw.
    motions: {
      interval: 5, moves: ["yawn", "punch"],
      regions: {
        head: [
          { c: [0, FLOOR + 33, -1.5], r: [32, 19, 30], inner: 0.45 },
          ...ears.map((e) => ({ c: [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2, e.a[2]], r: [10, 15, 9], inner: 0.5 })),
        ],
        pawL: [{ c: paws[0], r: [10, 8.5, 10], inner: 0.35 }],
        pawR: [{ c: paws[1], r: [10, 8.5, 10], inner: 0.35 }],
      },
    },
    look: (anchor) => ({
      dye: (x, y, z) => mix3(PINK, DEEP, smoothstep(0.3, 1, earT(x, y, z))),
      fx: null, glitter: 0, pearls: 0,
      decor: [
        anchor({ kind: "eye", from: [-10.5, FLOOR + 25, 0], dir: [-0.2, 0.05, 1], scale: 0.0027 }),
        anchor({ kind: "eye", from: [10.5, FLOOR + 25, 0], dir: [0.2, 0.05, 1], scale: 0.0027 }),
        anchor({ kind: "mouth", from: [0, FLOOR + 20.5, 0], dir: [0, -0.1, 1], scale: 0.0032, color: "#1d1216" }),
        // whiskers fan outward (+x of the piece): the left set is the right
        // one turned half a turn about the normal (up = −y)
        anchor({ kind: "whisker", from: [-12.5, FLOOR + 21, 0], dir: [-0.3, -0.05, 1], up: [0, -1, 0], scale: 0.0048 }),
        anchor({ kind: "whisker", from: [12.5, FLOOR + 21, 0], dir: [0.3, -0.05, 1], up: [0, 1, 0], scale: 0.0048 }),
        // strawberry halves set a few mm under the surface, off-centre (the
        // cheeks, the top): cut face out, or (flip) the seeded skin
        anchor.inside({ kind: "strawberry", from: [-17, FLOOR + 14, 0], dir: [-0.5, -0.1, 1], depth: 4.5, up: [0.4, 1, 0], scale: 0.0052 }),
        anchor.inside({ kind: "strawberry", from: [18, FLOOR + 16, 0], dir: [0.55, -0.05, 1], depth: 4.5, flip: true, up: [-0.5, 1, 0], scale: 0.005 }),
        anchor.inside({ kind: "strawberry", from: [-12, FLOOR + 33, 0], dir: [-0.35, 0.9, 0.7], depth: 4.5, flip: true, up: [0.6, 1, 0], scale: 0.0048 }),
        anchor.inside({ kind: "strawberry", from: [10, FLOOR + 35, 0], dir: [0.3, 1, 0.6], depth: 4.5, up: [-0.7, 0.4, -1], scale: 0.0046 }),
        anchor.inside({ kind: "strawberry", from: [-24, FLOOR + 14, -14], dir: [-1, 0.1, -0.2], depth: 4.5, up: [0.2, 1, 0], scale: 0.005 }),
      ],
    }),
  };
}

// 5) 새 — plump round iridescent bird (4.jpg), shown nearly in profile: beak
// toward the front-left, the near wing and the fan tail toward the camera.
// A big round body, a round head on the front-top behind a soft crease, a
// raised wing on each side and a fan tail angled up at the back.
function makeBird() {
  const yaw = -60 * Math.PI / 180;                       // local +z (beak) → world front-left
  const F = frame(yaw, [0, 0, 5]);
  const headC = [0, 48, 15.5], headR = 16.5;
  // fan tail: three round cones from deep in the back, angled up
  const tailBase = [0, 37, -19];
  const tailDirs = [-0.36, 0, 0.36].map((sx) => { const d = [sx, Math.sin(52 * Math.PI / 180), -Math.cos(52 * Math.PI / 180)]; const l = Math.hypot(...d); return d.map((v) => v / l); });
  const tailLen = 22;
  const tailEnds = tailDirs.map((d) => [tailBase[0] + d[0] * tailLen, tailBase[1] + d[1] * tailLen, tailBase[2] + d[2] * tailLen]);
  // wing: an ellipsoid on each side, pitched so its rear end rises
  const wc = Math.cos(-0.42), ws = Math.sin(-0.42);
  const WING_C = [25, 36.5, -8], WING_R = [7.5, 12, 18];
  const wingLocal = (ax, ly, lz) => { const wy = ly - WING_C[1], wz = lz - WING_C[2]; return [ax - WING_C[0], wc * wy - ws * wz, ws * wy + wc * wz]; };
  const wing = (ax, ly, lz) => ellipsoid(...wingLocal(ax, ly, lz), [0, 0, 0], WING_R);
  // normalised ellipsoid radius (1 on the wing's surface): the wing's colour patch
  const wingK = (ax, ly, lz) => { const w = wingLocal(ax, ly, lz); return Math.hypot(w[0] / WING_R[0], w[1] / WING_R[1], w[2] / WING_R[2]); };
  const p = [0, 0, 0];
  const sdf = (x, y, z) => {
    F.toLocal(x, y, z, p);
    const [lx, ly, lz] = p, ax = Math.abs(lx);
    let d = ellipsoid(ax, ly, lz, [0, 30.5, -1.5], [27, 22.5, 29]);
    d = smin(d, ellipsoid(ax, ly, lz, [0, 26.5, 8], [22.5, 17, 21.5]), 6);     // round chest
    d = smin(d, ellipsoid(ax, ly, lz, [0, 14.5, 0.5], [22, 6.5, 25.5]), 6);  // a flat seat under the centre of mass (and under the chest)
    d = smin(d, sphere(ax, ly, lz, headC, headR), 4.5);                        // head behind a soft crease
    d = smin(d, wing(ax, ly, lz), 2.5);
    let tl = Infinity;
    for (const e of tailEnds) tl = smin(tl, roundCone(lx, ly, lz, tailBase, e, 7, 5.4), 4);
    d = smin(d, tl, 5);
    return floorCut(d, ly, 3);
  };
  const W = (q) => F.toWorld(q);
  const D = (q) => F.dirToWorld(q);
  const eyeDir = (sx) => { const d = [sx * 0.8, 0.18, 0.55]; const l = Math.hypot(...d); return d.map((v) => v / l); };
  const look = (anchor) => {
    const q = [0, 0, 0];
    const blue = [44, 24, 2.5], lilac = [14, 30, 4], white = [1.5, 3.2, 2.6], pink = [2, 34, 13], peach = [1.2, 16, 46], wingBlue = [40, 20, 2], gold = [1, 14, 62];
    return {
      dye: (x, y, z) => {
        F.toLocal(x, y, z, q);
        const [lx, ly, lz] = q, ax = Math.abs(lx);
        // golden-peach belly → pink body
        let s = mix3(peach, pink, smoothstep(18, 32, ly + 0.15 * lz));
        // lilac sheen along the top of the back, a lavender-blue cap on the head
        s = mix3(s, lilac, smoothstep(40, 50, ly) * 0.8);
        const headness = 1 - smoothstep(headR + 1, headR + 8, Math.hypot(lx, ly - headC[1], lz - headC[2]));
        s = mix3(s, blue, headness * smoothstep(44, 51, ly + 0.3 * (lz - headC[2])));
        // pale face / cheek under the eye
        const cheek = 1 - smoothstep(6, 12, Math.hypot(ax * 0.5, ly - 44, lz - 24));
        s = mix3(s, white, cheek * 0.85);
        // blue wings with a golden trailing edge, blue tail
        const wk = wingK(ax, ly, lz);
        s = mix3(s, wingBlue, 1 - smoothstep(1.05, 1.3, wk));
        const wingRear = smoothstep(-13, -22, lz) * (1 - smoothstep(1.05, 1.3, wk));
        s = mix3(s, gold, wingRear * 0.9);
        // the thin fan tail needs a strong colour to show over its short light path
        const tail = smoothstep(-20, -27, lz) * smoothstep(38, 46, ly);
        s = mix3(s, [92, 40, 4], tail);
        return s;
      },
      fx: () => [0.8, 0],
      glitter: 80, pearls: 0,
      decor: [
        anchor({ kind: "eye", from: W(headC), dir: D(eyeDir(-1)), scale: 0.0026 }),
        anchor({ kind: "eye", from: W(headC), dir: D(eyeDir(1)), scale: 0.0026 }),
        anchor({ kind: "beak", from: W(headC), dir: D([0, -0.1, 1]), up: D([0, 1, 0]), scale: 0.005, color: "#7d8fe0" }),
      ],
    };
  };
  // idle motions (world.js MOVES): every 7 s a failed little flight (flap,
  // two hops, plop) or a happy 짹짹짹. Regions: the head, each wing (the
  // pitched ellipsoid's bump plus a margin), the fan tail.
  const motions = {
    interval: 7, moves: ["flap", "chirp"],
    regions: {
      head: [{ c: [0, 49, 16], r: [19, 18, 19.5], inner: 0.5 }],
      wingL: [{ c: [-WING_C[0], WING_C[1], WING_C[2]], r: [11, 15.5, 21], inner: 0.35 }],
      wingR: [{ c: [WING_C[0], WING_C[1], WING_C[2]], r: [11, 15.5, 21], inner: 0.35 }],
      tail: [{ c: [0, 48, -30], r: [16, 13, 12], inner: 0.4 }],
    },
  };
  return { sdf, frame: F, mesh: { h: 6.6, bounds: [-46, 8, -46, 46, 68, 46], origin: [0, 10, 0], ...BUDGET }, look, motions };
}

const BUILDERS = { pudding: makePudding, cake: makeCake, bear: makeBear, cat: makeCat, bird: makeBird };
const defs = new Map(), cages = new Map(), looks = new Map(), stats = new Map();
const def = (id) => {
  if (!BUILDERS[id]) throw new Error(`unknown shape "${id}"`);
  if (!defs.has(id)) defs.set(id, BUILDERS[id]());
  return defs.get(id);
};

export function shapeSDF(id) { return def(id).sdf; }

// Mass-weighted mean σ (1/m) of each shape's signature colour over its cage:
// what the world's meanDye reads for a fresh jelly of that shape (an order's
// starting colour). Precomputed so the main thread never meshes a shape just
// to write an order; tests/shapes.test.mjs checks it against the cage.
const SIGNATURE_SIGMA = Object.freeze({
  pudding: [3.746, 43.151, 20.83], cake: [21.627, 18.758, 31.53], bear: [16, 34, 4], cat: [2.315, 23.741, 16.643], bird: [13.533, 24.717, 19.624],
});
export function signatureSigma(id) { return SIGNATURE_SIGMA[id] ? SIGNATURE_SIGMA[id].slice() : null; }

export function makeShapeCage(id) {
  if (id === "flower") {
    if (!cages.has(id)) cages.set(id, makeFlowerCage());
    return cages.get(id);
  }
  if (!cages.has(id)) {
    const d = def(id);
    const { cage, stats: s } = meshSDF(d.sdf, d.mesh);
    cages.set(id, cage); stats.set(id, s);
  }
  return cages.get(id);
}

// A fresh, uncached build (tests use it to check determinism).
export function buildShapeCage(id) {
  if (id === "flower") return makeFlowerCage();
  const d = def(id);
  return meshSDF(d.sdf, d.mesh).cage;
}

export function shapeStats(id) { makeShapeCage(id); return stats.get(id) || null; }

// ------------------------------------------------------------------ decor anchoring
// Decorations are drawn on top of the jelly, so they are anchored ON the
// rendered surface: the cage boundary after the app's two Loop subdivisions
// (makeSurfaceStencils + evaluateSurface on the rest cage), which lies a little
// inside the cage on convex parts. u = where a ray from the design point along
// its direction leaves that surface, n = the surface's (vertex-interpolated)
// normal there.
function renderedSurface(cage) {
  const st = makeSurfaceStencils(cage);
  const P = new Float32Array(st.vertexCount * 3), N = new Float32Array(st.vertexCount * 3);
  evaluateSurface(st, cage.pos, P);
  computeVertexNormals(P, st.indices, N);
  return { P, N, I: st.indices };
}

// Line (o + t·d, |t| ≤ maxT) against the triangle mesh: the crossing from
// inside to outside nearest to o (Möller–Trumbore, exit faces only).
function rayExit(o, d, { P, I }, maxT) {
  let best = null;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
    const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det >= -1e-18) continue;                 // only faces seen from inside (outward normal along d)
    const inv = 1 / det, sx = o[0] - P[a], sy = o[1] - P[a + 1], sz = o[2] - P[a + 2];
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
    if (v < -1e-9 || u + v > 1 + 1e-9) continue;
    const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (tt < -maxT || tt > maxT) continue;
    if (!best || Math.abs(tt) < Math.abs(best.t)) best = { t: tt, tri: t, u: 1 - u - v, v: u, w: v };
  }
  return best;
}

function makeAnchor(id) {
  const sdf = def(id).sdf, cage = makeShapeCage(id), surf = renderedSurface(cage), bottom = stats.get(id).bottom;
  const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const orient = (n, hint) => {
    // 'up': the tangent closest to the hint (default +y), exactly orthonormal to n
    let k = hint[0] * n[0] + hint[1] * n[1] + hint[2] * n[2];
    let uvec = [hint[0] - n[0] * k, hint[1] - n[1] * k, hint[2] - n[2] * k];
    if (Math.hypot(...uvec) < 1e-6) { k = n[2]; uvec = [-n[0] * k, -n[1] * k, 1 - n[2] * k]; }
    uvec = norm(uvec);
    k = uvec[0] * n[0] + uvec[1] * n[1] + uvec[2] * n[2];
    return norm([uvec[0] - n[0] * k, uvec[1] - n[1] * k, uvec[2] - n[2] * k]);
  };
  // the design surface point: march from `from` (mm) along d to the SDF zero set
  const surfacePoint = (from, d) => {
    let t0 = 0, t1 = 0;
    const at = (t) => sdf(from[0] + d[0] * t, from[1] + d[1] * t, from[2] + d[2] * t);
    if (at(0) < 0) { t1 = 0.25; while (at(t1) < 0 && t1 < 80) { t0 = t1; t1 += 0.25; } }
    else { t0 = -0.25; while (at(t0) > 0 && t0 > -80) { t1 = t0; t0 -= 0.25; } }
    for (let i = 0; i < 50; i++) { const m = (t0 + t1) / 2; if (at(m) < 0) t0 = m; else t1 = m; }
    return [from[0] + d[0] * t0, from[1] + d[1] * t0, from[2] + d[2] * t0];
  };
  // hidden: drawn only while an idle motion shows it (the bear's tongue)
  const anchor = ({ kind, from, dir, up, upHint, scale, color, hidden }) => {
    const d = norm(dir), s = surfacePoint(from, d);
    // the rendered surface along the same ray (metres)
    const q = [s[0] * 0.001, (s[1] - bottom) * 0.001 + 0.010, s[2] * 0.001];
    const hit = rayExit(q, d, surf, 0.006);
    if (!hit) throw new Error(`${id}: ${kind} anchor misses the rendered surface`);
    const { P, N, I } = surf, ia = I[hit.tri] * 3, ib = I[hit.tri + 1] * 3, ic = I[hit.tri + 2] * 3;
    const u = [0, 1, 2].map((k) => P[ia + k] * hit.u + P[ib + k] * hit.v + P[ic + k] * hit.w);
    const n = norm([0, 1, 2].map((k) => N[ia + k] * hit.u + N[ib + k] * hit.v + N[ic + k] * hit.w));
    const out = { kind, u, n, up: orient(n, up || upHint || [0, 1, 0]), scale };
    if (color) out.color = color;
    if (hidden) out.hidden = true;
    return out;
  };
  // A piece set INSIDE the jelly (the cat's strawberries): `depth` mm under
  // the surface point found from `from` along `dir`, lying parallel to the
  // surface there: its +Z = the outward SDF normal (flip: inward, its back
  // toward the viewer), +Y = up. The whole piece (a disc of its size round
  // the centre) must stay ≥ 1 mm inside. u is the piece's centre (not on
  // the surface); inside: true tells the renderer / tests so.
  anchor.inside = ({ kind, from, dir, depth, flip, up, scale, color }) => {
    const s = surfacePoint(from, norm(dir)), e = 0.2;
    const g = norm([0, 1, 2].map((k) => { const a = s.slice(), b = s.slice(); a[k] += e; b[k] -= e; return sdf(...a) - sdf(...b); }));
    const c = s.map((v, k) => v - g[k] * depth);
    const n = flip ? g.map((v) => -v) : g, yv = orient(n, up || [0, 1, 0]);
    const xv = [yv[1] * n[2] - yv[2] * n[1], yv[2] * n[0] - yv[0] * n[2], yv[0] * n[1] - yv[1] * n[0]], R = scale * 1000;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2, p = c.map((v, k) => v + R * (Math.cos(a) * xv[k] + Math.sin(a) * yv[k]));
      if (!(sdf(...p) < -1)) throw new Error(`${id}: ${kind} under ${from} pokes out (${sdf(...p).toFixed(1)} mm)`);
    }
    // and its domed back (≈ 0.75 × its size along −Z; flipped: toward the surface)
    const back = c.map((v, k) => v - n[k] * 0.75 * R);
    if (!(sdf(...back) < -0.5)) throw new Error(`${id}: ${kind} under ${from}: its back pokes out (${sdf(...back).toFixed(1)} mm)`);
    const out = { kind, u: [c[0] * 0.001, (c[1] - bottom) * 0.001 + 0.010, c[2] * 0.001], n, up: yv, scale, inside: true };
    if (color) out.color = color;
    return out;
  };
  return anchor;
}

// ------------------------------------------------------------------ idle motions
// shapeMotions(id) → null (no idle motions) or, cached and frozen:
//   { interval: s between motion starts, moves: [names] (world.js MOVES),
//     axes: { side, up, face } — the model's +x / +y / +z (+z = the face /
//            beak direction) as unit vectors of the rest cage frame,
//     regions: { name: [part…] } — a region is the union (max weight) of soft
//            ellipsoid parts { c: centre (rest cage m), axes: [x, y, z] unit
//            vectors, r: [rx, ry, rz] (m), inner: full weight within this
//            fraction of the ellipsoidal radius, smooth falloff to 0 at 1 } }
// Same frame conversion as the decor anchors (model mm → cage metres).
const motionsCache = new Map();
export function shapeMotions(id) {
  if (id === "flower" || !BUILDERS[id]) return null;
  if (!motionsCache.has(id)) {
    const d = def(id), m = d.motions;
    if (!m) { motionsCache.set(id, null); return null; }
    makeShapeCage(id);
    const bottom = stats.get(id).bottom, F = d.frame || frame(0);
    const toCage = (q) => { const w = F.toWorld(q); return [w[0] * 0.001, (w[1] - bottom) * 0.001 + 0.010, w[2] * 0.001]; };
    const axes = [F.dirToWorld([1, 0, 0]), [0, 1, 0], F.dirToWorld([0, 0, 1])];
    const regions = {};
    for (const [name, parts] of Object.entries(m.regions)) {
      regions[name] = Object.freeze(parts.map((p) => Object.freeze({ c: toCage(p.c), axes, r: p.r.map((v) => v * 0.001), inner: p.inner ?? 0.4 })));
    }
    motionsCache.set(id, Object.freeze({
      interval: m.interval, moves: Object.freeze(m.moves.slice()),
      axes: Object.freeze({ side: axes[0], up: axes[1], face: axes[2] }), regions: Object.freeze(regions),
    }));
  }
  return motionsCache.get(id);
}

// Weight (0..1) of a rest-cage point (m) in a shapeMotions region.
export function motionWeight(parts, x, y, z) {
  let w = 0;
  for (const p of parts) {
    const dx = x - p.c[0], dy = y - p.c[1], dz = z - p.c[2];
    let k = 0;
    for (let a = 0; a < 3; a++) { const ax = p.axes[a], q = (dx * ax[0] + dy * ax[1] + dz * ax[2]) / p.r[a]; k += q * q; }
    k = Math.sqrt(k);
    if (k >= 1) continue;
    w = Math.max(w, 1 - smoothstep(p.inner, 1, k));
  }
  return w;
}

export function shapeLook(id) {
  if (id === "flower") return { dye: null, fx: null, glitter: 0, pearls: 0, decor: [] };
  if (!looks.has(id)) {
    const d = def(id);
    const look = d.look(makeAnchor(id));
    // the shapes' look functions are written in model millimetres; the
    // contract takes cage rest coordinates in metres
    const bottom = stats.get(id).bottom;
    const local = (fn) => fn ? (x, y, z) => fn(x * 1000, (y - 0.010) * 1000 + bottom, z * 1000) : null;
    looks.set(id, Object.freeze({ dye: local(look.dye), fx: local(look.fx), glitter: look.glitter | 0, pearls: look.pearls | 0, decor: Object.freeze(look.decor.map((o) => Object.freeze(o))) }));
  }
  return looks.get(id);
}
