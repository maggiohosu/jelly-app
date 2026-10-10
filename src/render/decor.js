// Face decorations and toppers for the shaped jellies: bead eyes, noses,
// mouths, blush, cat muzzles / inner ears / whiskers, the cake's cherry, the
// bird's beak, the strawberry halves set inside the cat, and the bear's
// licking tongue. Positions come
// from the app (tray space) every frame.
//
// One InstancedMesh per kind (15 kinds × ≤ 24 instances; hidden kinds cost
// no draw call, so a face is still ≤ 8 draw calls). The
// look of each kind is carried by per-vertex attributes of its geometry and a
// colour per instance, so all kinds share one node graph (three material
// instances: "patches" = blush / muzzle / inner ear, which never write depth,
// so features drawn after them — nose, mouth, eyes — always sit on top;
// "inner" = pieces inside the jelly, always opaque):
//
//   decorA (vec4, per vertex)   x gloss 0..1, y self-glow 0..1,
//                               z soft rim (0 inside … 1 outline; > 0.5 dithers out),
//                               w weight of the fixed tint below (0 = instance colour)
//   decorB (vec4, per vertex)   rgb fixed tint (linear), a albedo gain
//   decorColor (vec3, per instance, linear)
//
// Light: the stage has one sun behind the jelly and no environment map (and
// decor ignores the scene fog), so the
// material brings its own light model (like the bunny): wrapped sun, soft
// hemisphere + front fill (faces never go black), a camera-fixed "studio
// window" reflection (upper left) and a small one lower right — the glossy
// catchlights of bead eyes and the cherry, from any view — plus sun specular
// and a Fresnel rim. No blending anywhere; soft rims are dithered (maskNode).
//
// Modes (constructor option / setOverlay):
//   overlay (default)  decor sits ON the jelly surface and is drawn after the
//                      jelly (transparent list, NoBlending, renderOrder 2/3).
//                      Crisp, true colours, never refracted: three's front-side
//                      transmission samples the opaque pass only, so nothing is
//                      ghosted / magnified / tinted by the whole jelly depth.
//                      Depth is biased 0.7 mm toward the camera (same pixel),
//                      so pieces slightly under the rendered surface still
//                      show; deeper parts / the far side are hidden by it.
//   embedded           opaque; flat pieces are pushed under the surface
//                      (by their own height + 0.3 mm) and seen THROUGH the
//                      jelly — refracted, displaced and tinted like the gems.
//
// Local frame of every decoration: origin = anchor ON the jelly surface,
// +Z = outward surface normal, +Y = the face's up. Unit geometry is scaled by
// `scale` s (metres); footprints:
//   eye       glossy oblate bead, visible radius ≈ s, domes 0.3 s above the anchor
//   nose      rounded inverted triangle, 2 s wide × 1.5 s tall (centre = origin)
//   mouth     short stem + "ω", 1.5 s wide, stroke 0.17 s; origin = stem/ω joint
//   blush     soft oval 2 s × 1.3 s
//   muzzle    soft white two-lobed oval 2 s × 1.45 s
//   earInner  rounded triangle pointing +Y, 1.7 s wide × 2 s tall
//   cherry    radius s, sitting on the surface (origin = bottom contact, +Z up);
//             stem rises ~2.3 s above the cherry top, arcing toward +Y
//   beak      length ≈ s along +Z: base buried at z = −0.25 s, tip at +0.78 s,
//             hooking down a little; thin gold collar, instance-colour top
//             (pulled toward blue-violet), deeper underside
// Expressions (the world swaps them in for a moment during the idle motions,
// at the same anchor and scale as the piece they replace):
//   eyeClosed sleepy closed eye "︶": a curved stroke 1.9 s wide, stroke
//             0.3 s, ends 0.15 s above / middle 0.2 s below the eye's centre
//   eyeHappy  smiling eye "^": an arch 1.8 s wide, top 0.3 s above the centre
//   mouthOpen open mouth under the anchor (the mouth's stem/ω joint): an oval
//             1.1 s wide × 1.2 s tall hanging from it, dark red-brown inside,
//             a pink tongue, the rim in the instance colour (the cat's pink)
//   beakOpen  the beak with its mandibles parted (upper up 24°, lower down
//             29° about the base), the inside of the mouth dark pink
//   (eyeClosed / eyeHappy: instance colour, default the eye's)
//   whisker   one cheek's three whiskers fanning out along +X from the anchor
//             (three strokes 2.2 s long from x = 0, starting 0.32 s apart, ±11° and level), thin dark strokes standing
//             out from the cheek; the other cheek's set is this one turned half a
//             turn about +Z (up = −y), the fan is symmetric under it
//   strawberry  a strawberry half (2 s tall, 1.7 s wide, tip toward −Y) set
//             INSIDE the jelly (world anchor = its centre, not a surface
//             point): +Z = the cut face (pale core, red flesh, a ring of
//             seeds at the edge), −Z = the domed red skin dotted with yellow
//             seeds. Always drawn opaque (the "inner" material, either mode)
//             and seen through the jelly: refracted and tinted like the gems;
//             in overlay mode also a depth-biased copy after the jelly, so a
//             piece just under the front surface reads crisply (see
//             INNER_BIAS); a soft self-glow keeps it juicy, half-clear fruit.
//   tongue    the bear's licking tongue (only while it licks; the world rolls
//             it about +Z to sweep and scales it to poke it out): a rounded
//             glossy pink tongue hanging along −Y from the anchor (its root
//             pivot, the open mouth's middle): 1.2 s wide, root at +0.3 s, tip
//             at −1.45 s, rising off the surface toward the tip (+0.45 s), a
//             darker centre groove; instance colour = the pink. Drawn like a
//             topper (never pushed under the surface).
// Flat pieces are bent to hug a ~32 mm-radius surface at their nominal size.
import * as THREE from "three/webgpu";
import {
  attribute,
  cameraPosition,
  cameraProjectionMatrix,
  cameraWorldMatrix,
  clamp,
  dot,
  float,
  interleavedGradientNoise,
  length,
  mix,
  modelWorldMatrix,
  normalWorld,
  normalize,
  positionLocal,
  positionView,
  positionWorld,
  pow,
  reflect,
  screenCoordinate,
  smoothstep,
  uniform,
  vec3,
  vec4,
} from "three/tsl";

// Append only (world.js DECOR_KINDS has the same order).
export const DECOR_KINDS = Object.freeze(["eye", "nose", "mouth", "blush", "muzzle", "earInner", "cherry", "beak", "eyeClosed", "eyeHappy", "mouthOpen", "beakOpen", "whisker", "strawberry", "tongue"]);
export const DECOR_STRIDE = 12;
export const DECOR_MAX_PER_KIND = 24;
// Default colours (sRGB) used when a state's r < 0.
export const DECOR_DEFAULT_COLORS = Object.freeze({
  eye: "#0e0a12", nose: "#33222a", mouth: "#3b2129", blush: "#ff8fb0",
  muzzle: "#fffafd", earInner: "#ffa9c4", cherry: "#d80c28", beak: "#86aaff",
  eyeClosed: "#0e0a12", eyeHappy: "#0e0a12", mouthOpen: "#c25a74", beakOpen: "#86aaff",
  whisker: "#1a1216", strawberry: "#e8233f", tongue: "#ff7d9c",
});
// Suggested sizes (m) for the contract's reference faces.
export const DECOR_SIZES = Object.freeze({ eye: 0.0028, nose: 0.0016, mouth: 0.003, blush: 0.0045, muzzle: 0.005, earInner: 0.004, cherry: 0.0075, beak: 0.005, eyeClosed: 0.0028, eyeHappy: 0.0028, mouthOpen: 0.0036, beakOpen: 0.005, whisker: 0.0048, strawberry: 0.0046, tongue: 0.0032 });

const PATCH = new Set(["blush", "muzzle", "earInner"]);
const TOPPER = new Set(["cherry", "beak", "beakOpen", "tongue"]);
// Inside the jelly, not on it: opaque in both modes, never offset or flattened.
const INNER = new Set(["strawberry"]);
const SURFACE_RADIUS = 0.032;      // jelly curvature the flat pieces are bent to
const EMBED_GAP = 0.0003;          // embedded mode: jelly left in front of a piece (m)
// Inner pieces' overlay copy: shows within this distance (m) under the
// rendered surface (the cat's strawberries sit 4.5 mm deep, ≈ 4 mm relief).
const INNER_BIAS = 0.0065;

// Sun direction (light travel) in tray space; same as stage.js LIGHT_DIRECTION.
const SUN_TRAVEL = new THREE.Vector3(-0.6123724357, -0.5, 0.6123724357).normalize();

const lin = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const sagOf = (kind) => DECOR_SIZES[kind] / (2 * SURFACE_RADIUS);   // z −= k (x² + y²) in unit space
// Soft-rim attribute: 0 inside, 0.5 → 1 over the outer band (ρ from `start` to 1).
const rimEdge = (rho, start) => (rho <= start ? 0 : 0.5 + (0.5 * (rho - start)) / (1 - start));

// ---- geometry ----------------------------------------------------------------

class Builder {
  constructor() { this.p = []; this.a = []; this.b = []; this.i = []; }
  vertex(p, A, B) { this.p.push(p[0], p[1], p[2]); this.a.push(A[0], A[1], A[2], A[3]); this.b.push(B[0], B[1], B[2], B[3]); return this.p.length / 3 - 1; }
  tri(a, b, c) { this.i.push(a, b, c); }
  // Closed surface: u wraps around (0..1), v runs pole → pole (0..1); both
  // poles collapse to one vertex. f(u, v) → { p, a, b }. Winding is outward
  // when u turns counter-clockwise about the v = 0 pole's outward direction.
  closed(seg, rings, f) {
    const add = (o) => this.vertex(o.p, o.a, o.b);
    const top = add(f(0, 0)), rows = [];
    for (let r = 1; r < rings; r += 1) {
      const row = [];
      for (let s = 0; s < seg; s += 1) row.push(add(f(s / seg, r / rings)));
      rows.push(row);
    }
    const bottom = add(f(0, 1));
    for (let s = 0; s < seg; s += 1) this.tri(top, rows[0][s], rows[0][(s + 1) % seg]);
    for (let r = 0; r < rows.length - 1; r += 1) for (let s = 0; s < seg; s += 1) {
      const a = rows[r][s], b = rows[r][(s + 1) % seg], c = rows[r + 1][(s + 1) % seg], d = rows[r + 1][s];
      this.tri(a, d, c); this.tri(a, c, b);
    }
    const last = rows[rows.length - 1];
    for (let s = 0; s < seg; s += 1) this.tri(last[s], bottom, last[(s + 1) % seg]);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute("decorA", new THREE.Float32BufferAttribute(this.a, 4));
    g.setAttribute("decorB", new THREE.Float32BufferAttribute(this.b, 4));
    g.setIndex(this.i);
    g.computeVertexNormals();
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

// Star-shaped 2D outline from a signed distance function: r(θ) by marching +
// bisection from the origin, then fitted to a half-width × half-height box.
function outlineFromSDF(sdf, seg, halfW, halfH) {
  const pts = [];
  for (let s = 0; s < seg; s += 1) {
    const t = (s / seg) * Math.PI * 2, c = Math.cos(t), si = Math.sin(t);
    let lo = 0, hi = 0.01;
    while (sdf(hi * c, hi * si) < 0 && hi < 8) { lo = hi; hi += 0.01; }
    for (let k = 0; k < 30; k += 1) { const m = (lo + hi) / 2; if (sdf(m * c, m * si) < 0) lo = m; else hi = m; }
    pts.push([lo * c, lo * si]);
  }
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, kx = (2 * halfW) / (x1 - x0), ky = (2 * halfH) / (y1 - y0);
  return { pts, map: (x, y) => [(x - cx) * kx, (y - cy) * ky] };
}

// Puffy flat piece: rim on z = −sag, front dome `front`, back dome `back`.
function puff(B, { outline, front, back, sag = 0, rings = 10, look }) {
  const seg = outline.pts.length;
  B.closed(seg, rings, (u, v) => {
    const s = Math.round(u * seg) % seg;
    const isFront = v <= 0.5;
    const k = isFront ? v / 0.5 : (1 - v) / 0.5;
    const rho = Math.sin((k * Math.PI) / 2);
    const dome = Math.pow(Math.max(0, 1 - Math.pow(rho, 2.4)), 0.42);
    const [px, py] = outline.pts[s];
    const [x, y] = outline.map(px * rho, py * rho);
    const z = (isFront ? front : -back) * dome - sag * (x * x + y * y);
    return { p: [x, y, z], ...look(x, y, isFront ? rho : 1, isFront) };
  });
}

// Tube along a polyline with hemispherical caps (one closed surface).
// up: a vector perpendicular to the curve; squash scales the offset along it.
function tube(B, { pts, radius, up = [0, 0, 1], squash = 1, seg = 10, look }) {
  const n = pts.length;
  const len = [0];
  for (let i = 1; i < n; i += 1) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]));
  const L = len[n - 1];
  const r0 = radius(0), r1 = radius(1);
  const capRings = 5, rings = capRings * 2 + n - 1;
  const tangent = (i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    const t = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l = Math.hypot(...t);
    return t.map((x) => x / l);
  };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  B.closed(seg, rings, (u, v) => {
    const r = Math.round(v * rings);
    let center, T, rad, t;
    if (r <= capRings) {                       // start cap (pole at v = 0)
      const ang = (r / capRings) * (Math.PI / 2);
      T = tangent(0); t = 0;
      const back = -Math.cos(ang) * r0;
      center = [pts[0][0] + T[0] * back, pts[0][1] + T[1] * back, pts[0][2] + T[2] * back];
      rad = Math.sin(ang) * r0;
    } else if (r >= rings - capRings) {        // end cap
      const ang = ((rings - r) / capRings) * (Math.PI / 2);
      T = tangent(n - 1); t = 1;
      const fwd = Math.cos(ang) * r1;
      center = [pts[n - 1][0] + T[0] * fwd, pts[n - 1][1] + T[1] * fwd, pts[n - 1][2] + T[2] * fwd];
      rad = Math.sin(ang) * r1;
    } else {
      const i = r - capRings;
      T = tangent(i); t = len[i] / L;
      center = pts[i]; rad = radius(t);
    }
    // N = up projected off T; Bn = N × T (so N × Bn = −T: outward winding).
    const d = up[0] * T[0] + up[1] * T[1] + up[2] * T[2];
    let N = [up[0] - d * T[0], up[1] - d * T[1], up[2] - d * T[2]];
    const nl = Math.hypot(...N); N = N.map((x) => x / nl);
    const Bn = cross(N, T);
    const th = u * Math.PI * 2, c = Math.cos(th) * rad * squash, s = Math.sin(th) * rad;
    const p = [center[0] + N[0] * c + Bn[0] * s, center[1] + N[1] * c + Bn[1] * s, center[2] + N[2] * c + Bn[2] * s];
    return { p, ...look(t, p) };
  });
}

// Ellipsoid (v = 0 pole at +Z); shape(θ, φ) scales the radius.
function ellipsoid(B, { r = [1, 1, 1], c = [0, 0, 0], seg = 24, rings = 14, shape, look }) {
  B.closed(seg, rings, (u, v) => {
    const th = u * Math.PI * 2, ph = v * Math.PI;
    const k = shape ? shape(th, ph) : 1;
    const p = [c[0] + r[0] * Math.sin(ph) * Math.cos(th) * k, c[1] + r[1] * Math.sin(ph) * Math.sin(th) * k, c[2] + r[2] * Math.cos(ph) * k];
    return { p, ...look(th, ph, p) };
  });
}

// SDFs (2D).
const sdCircle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;
const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
function sdTriangleUp(x, y, r) {      // equilateral, apex up (iq)
  const k = Math.sqrt(3);
  let px = Math.abs(x) - r, py = y + r / k;
  if (px + k * py > 0) { const nx = (px - k * py) / 2, ny = (-k * px - py) / 2; px = nx; py = ny; }
  px -= Math.min(0, Math.max(-2 * r, px));
  return -Math.hypot(px, py) * Math.sign(py);
}

const A_ = (gloss, glow = 0, edge = 0, tintW = 0) => [gloss, glow, edge, tintW];
const B_ = (rgb = [0, 0, 0], gain = 1) => [rgb[0], rgb[1], rgb[2], gain];

function buildEye() {
  const B = new Builder();
  // Oblate glossy bead: about a third of it domes out of the surface.
  ellipsoid(B, { r: [1.04, 1.04, 0.52], c: [0, 0, -0.2], seg: 28, rings: 16, look: () => ({ a: A_(1), b: B_() }) });
  return B.build();
}

function buildNose() {
  const B = new Builder();
  const outline = outlineFromSDF((x, y) => sdTriangleUp(x / 1.18, -y, 0.62) - 0.34, 40, 1, 0.75);
  puff(B, { outline, front: 0.34, back: 0.3, sag: sagOf("nose"), look: () => ({ a: A_(0.72, 0.04), b: B_() }) });
  return B.build();
}

function buildMouth() {
  const B = new Builder();
  const look = () => ({ a: A_(0.3), b: B_() });
  const w = 0.75, depth = 0.34, k = sagOf("mouth"), rad = () => 0.085;
  const at = (x, y) => [x, y, 0.02 - k * (x * x + y * y)];
  // ω: two lobes hanging from the centre, outer tips curling up a little.
  const lobe = (sign) => {
    const pts = [];
    for (let i = 0; i <= 22; i += 1) {
      const a = Math.PI * 1.06 * (i / 22);          // centre (top) → bottom → outer tip
      pts.push(at(sign * (w / 2) * (1 - Math.cos(a)), -depth * Math.sin(a)));
    }
    return pts;
  };
  tube(B, { pts: lobe(1), radius: rad, squash: 0.65, look });
  tube(B, { pts: lobe(-1), radius: rad, squash: 0.65, look });
  tube(B, { pts: [at(0, 0), at(0, 0.12), at(0, 0.24)], radius: rad, squash: 0.65, look });   // philtrum
  return B.build();
}

function buildBlush() {
  const B = new Builder();
  const outline = outlineFromSDF((x, y) => Math.hypot(x, y) - 1, 40, 1, 0.65);
  puff(B, { outline, front: 0.05, back: 0.05, sag: sagOf("blush"), look: (x, y, rho) => ({ a: A_(0.1, 0.45, rimEdge(rho, 0.78), 0), b: B_() }) });
  return B.build();
}

function buildMuzzle() {
  const B = new Builder();
  const sdf = (x, y) => smin(smin(sdCircle(x, y, -0.44, -0.1, 0.6), sdCircle(x, y, 0.44, -0.1, 0.6), 0.3), sdCircle(x, y, 0, 0.16, 0.62), 0.35);
  const outline = outlineFromSDF(sdf, 48, 1, 0.725);
  puff(B, { outline, front: 0.07, back: 0.05, sag: sagOf("muzzle"), look: (x, y, rho) => ({ a: A_(0.22, 0.12, rimEdge(rho, 0.8), 0), b: B_([0, 0, 0], 0.92) }) });
  return B.build();
}

function buildEarInner() {
  const B = new Builder();
  const outline = outlineFromSDF((x, y) => sdTriangleUp(x / 0.95, y, 0.6) - 0.22, 40, 0.85, 1);
  // A touch deeper toward the middle, lighter at the rim.
  puff(B, { outline, front: 0.07, back: 0.05, sag: sagOf("earInner") * 0.5, look: (x, y, rho) => ({ a: A_(0.4, 0.3, rimEdge(rho, 0.78), 0), b: B_([0, 0, 0], 0.86 + 0.14 * rho) }) });
  return B.build();
}

function buildCherry() {
  const B = new Builder();
  const zc = 0.88, squash = 0.94;
  // Body: sphere with a dimple at the top (stem) and a faint one underneath.
  ellipsoid(B, {
    r: [1, 1, squash], c: [0, 0, zc], seg: 30, rings: 20,
    shape: (th, ph) => 1 - 0.22 * Math.exp(-((ph / 0.42) ** 2)) - 0.05 * Math.exp(-(((Math.PI - ph) / 0.4) ** 2)) + 0.025 * Math.sin(ph) * Math.cos(2 * th),
    look: () => ({ a: A_(0.95, 0.24), b: B_([0, 0, 0], 0.62) }),
  });
  // Stem: olive-gold → amber → red-brown tip, rising and arcing toward +Y
  // (the frame's up hint: sideways to the camera for a topper whose +Z is up).
  const top = zc + squash * 0.78;
  const stemPts = [];
  for (let i = 0; i <= 26; i += 1) {
    const t = i / 26;
    stemPts.push([0.08 * Math.sin(t * Math.PI), 0.95 * t * t + 0.06 * t, top - 0.05 + 2.35 * Math.sin((t * Math.PI) / 2) * (1 - 0.12 * t)]);
  }
  const green = lin("#b4b046"), gold = lin("#d9963a"), brown = lin("#962c1c");
  const grad = (t) => {
    const a = smooth(0, 0.55, t), b = smooth(0.7, 0.98, t);
    return green.map((g, k) => g + (gold[k] - g) * a).map((g, k) => g + (brown[k] - g) * b);
  };
  tube(B, { pts: stemPts, radius: (t) => 0.08 - 0.025 * t, up: [1, 0, 0], seg: 9, look: (t) => ({ a: A_(0.45, 0.14, 0, 1), b: B_(grad(t)) }) });
  const tip = stemPts[stemPts.length - 1];
  ellipsoid(B, { r: [0.09, 0.09, 0.075], c: [tip[0], tip[1] + 0.02, tip[2] + 0.02], seg: 10, rings: 6, look: () => ({ a: A_(0.5, 0.08, 0, 1), b: B_(lin("#a3301e")) }) });
  return B.build();
}

function buildBeak() {
  const B = new Builder();
  const gold = lin("#efbf4c"), seam = lin("#1f2a5c"), deep = lin("#4d70e0"), violet = lin("#5466d8");
  B.closed(28, 18, (u, v) => {
    // v: 0 = tip (+Z) … 1 = closed base (inside the head)
    const th = u * Math.PI * 2, t = v, z = 0.78 - 1.03 * t;
    let k = Math.pow(Math.min(1, t / 0.8), 0.78);                               // taper to the tip
    if (t > 0.86) k *= Math.sqrt(Math.max(0, 1 - ((t - 0.86) / 0.14) ** 2));    // close the base
    const hw = 0.38 * k, hh = 0.3 * k;
    // Cross-section: ridged top (rounded diamond), flatter rounded underside.
    const c = Math.cos(th), s = Math.sin(th), n = s > 0 ? 1.35 : 2.4;
    const rr = 1 / Math.pow(Math.abs(c) ** n + Math.abs(s) ** n, 1 / n);
    const x = hw * c * rr, y = hh * s * rr * (s > 0 ? 1.15 : 0.7) - 0.24 * (1 - t) ** 2.2;   // tip hooks down
    // Thin gold collar where the beak leaves the head (z ≈ 0), a dark bill
    // line along the sides, deeper blue lower mandible, and on top the
    // instance colour pulled 35 % toward a mid blue-violet (so even a pale
    // pastel reads as a blue beak at app size, not a white tooth).
    const collar = smooth(0.6, 0.7, t);
    const line = (1 - collar) * 0.75 * Math.exp(-((s / 0.14) ** 2));
    const lower = (1 - collar) * Math.max(smooth(0.05, -0.5, s) * 0.6, smooth(0.3, 0, t) * 0.45);
    let tint = violet, w = 0.35 * (1 - collar);
    if (lower > w) { tint = deep; w = lower; }
    if (line > w) { tint = seam; w = line; }
    if (collar > w) { tint = gold; w = collar; }
    return { p: [x, y, z], a: A_(0.55, 0.06, 0, w), b: B_(tint, collar > 0.5 ? 0.8 : 0.66) };
  });
  return B.build();
}

// A curved stroke for the eye expressions: x from −w/2 to w/2, y = f(x),
// thicker in the middle, hugging the surface like the mouth.
function eyeStroke(kind, f, halfW, thick) {
  const B = new Builder();
  const k = sagOf(kind), pts = [];
  for (let i = 0; i <= 24; i += 1) {
    const x = -halfW + (2 * halfW * i) / 24, y = f(x / halfW);
    pts.push([x, y, 0.05 - k * (x * x + y * y)]);
  }
  tube(B, { pts, radius: (t) => thick * (0.62 + 0.38 * Math.sin(Math.PI * t)), squash: 0.6, look: () => ({ a: A_(0.35), b: B_() }) });
  return B.build();
}
// sleepy closed eye ︶ (ends up, middle down)
const buildEyeClosed = () => eyeStroke("eyeClosed", (u) => 0.15 - 0.35 * (1 - u * u), 0.95, 0.15);
// smiling eye ^ (an arch, slightly pointed)
const buildEyeHappy = () => eyeStroke("eyeHappy", (u) => -0.22 + 0.52 * (1 - Math.pow(Math.abs(u), 1.4)), 0.9, 0.15);

// Shift the vertices added since `from` (Builder positions).
function shiftFrom(B, from, dx, dy, dz) {
  for (let i = from * 3; i < B.p.length; i += 3) { B.p[i] += dx; B.p[i + 1] += dy; B.p[i + 2] += dz; }
}

function buildMouthOpen() {
  const B = new Builder();
  const k = sagOf("mouthOpen"), inside = lin("#4a1222"), tongue = lin("#ff7f9e");
  // the open mouth: an oval hanging from the anchor (the closed mouth's joint)
  const oval = outlineFromSDF((x, y) => Math.hypot(x / 0.55, y / 0.6) - 1, 40, 0.55, 0.6);
  let from = B.p.length / 3;
  puff(B, {
    outline: oval, front: 0.07, back: 0.05, sag: k,
    look: (x, y, rho, front) => (front && rho < 0.8 ? { a: A_(0.25, 0, 0, 1), b: B_(inside, 1) } : { a: A_(0.5, 0.06), b: B_() }),
  });
  shiftFrom(B, from, 0, -0.55, 0);
  // the tongue, a little in front in the lower half
  const tong = outlineFromSDF((x, y) => Math.hypot(x / 0.3, y / 0.19) - 1, 32, 0.3, 0.19);
  from = B.p.length / 3;
  puff(B, { outline: tong, front: 0.06, back: 0.02, sag: k, look: () => ({ a: A_(0.55, 0.12, 0, 1), b: B_(tongue, 1) }) });
  shiftFrom(B, from, 0, -0.83, 0.05);
  return B.build();
}

function buildBeakOpen() {
  const B = new Builder();
  const gold = lin("#efbf4c"), seam = lin("#1f2a5c"), deep = lin("#4d70e0"), violet = lin("#5466d8"), mouth = lin("#7a2c4c"), throat = lin("#3a1022");
  const hinge = 0.02;
  // one mandible: the beak's upper (top) or lower half, closed by a flat inner face
  const mandible = (upper, angle, len) => {
    const from = B.p.length / 3;
    B.closed(28, 18, (u, v) => {
      const th = u * Math.PI * 2, t = v, z = (0.78 - 1.03 * t) * len - 0.25 * (1 - len);
      let k = Math.pow(Math.min(1, t / 0.8), 0.78);
      if (t > 0.86) k *= Math.sqrt(Math.max(0, 1 - ((t - 0.86) / 0.14) ** 2));
      const hw = 0.38 * k, hh = 0.3 * k;
      const c = Math.cos(th), s = Math.sin(th), outer = upper ? s > 0 : s < 0, n = upper ? 1.35 : 2.4;
      const rr = 1 / Math.pow(Math.abs(c) ** n + Math.abs(s) ** n, 1 / n);
      const x = hw * c * rr;
      // outer shell as the closed beak; the inner face nearly flat (a little thickness)
      let y = outer ? hh * s * rr * (upper ? 1.15 : 0.7) : -0.05 * hh * s;
      if (upper) y -= 0.24 * (1 - t) ** 2.2;                    // the hooked tip
      else y -= 0.06 * (1 - t) ** 2;
      const collar = smooth(0.6, 0.7, t);
      let tint, w;
      if (!outer) { tint = mouth; w = 1 - collar; }
      else {
        const line = (1 - collar) * 0.75 * Math.exp(-((s / 0.22) ** 2));
        tint = upper ? violet : deep; w = upper ? 0.35 * (1 - collar) : (1 - collar) * 0.6;
        if (line > w) { tint = seam; w = line; }
      }
      if (collar > w) { tint = gold; w = collar; }
      return { p: [x, y, z], a: A_(outer ? 0.55 : 0.3, 0.06, 0, w), b: B_(tint, collar > 0.5 ? 0.8 : 0.66) };
    });
    // open about the hinge (x axis through y = 0, z = hinge)
    const ca = Math.cos(angle), sa = Math.sin(angle);
    for (let i = from * 3; i < B.p.length; i += 3) {
      const y = B.p[i + 1], z = B.p[i + 2] - hinge;
      B.p[i + 1] = y * ca + z * sa; B.p[i + 2] = hinge + z * ca - y * sa;
    }
  };
  mandible(true, 0.42, 1);
  mandible(false, -0.5, 0.86);
  // the dark throat between the mandibles' bases
  ellipsoid(B, { r: [0.2, 0.13, 0.22], c: [0, -0.02, 0.06], seg: 16, rings: 8, look: () => ({ a: A_(0.2, 0, 0, 1), b: B_(throat, 1) }) });
  return B.build();
}

// One cheek's whiskers: three thin strokes fanning out along +X, tapering,
// nearly straight: like real whiskers they leave the curved cheek and stand
// out from it (bent only a quarter as much as the surface, so a set seen
// from the front still spreads sideways instead of wrapping round the face).
function buildWhisker() {
  const B = new Builder();
  const k = sagOf("whisker") * 0.25, look = () => ({ a: A_(0.35), b: B_() });
  for (const side of [1, 0, -1]) {
    const a = (side * 11 * Math.PI) / 180, pts = [];
    for (let i = 0; i <= 16; i += 1) {
      // three strokes starting a little apart, fanning out (the outer two
      // curving away from the middle one: symmetric under y → −y)
      const r = 2.2 * (i / 16);
      const x = r * Math.cos(a), y = side * 0.32 + r * Math.sin(a) + side * 0.05 * r * r;
      pts.push([x, y, 0.03 - k * (x * x + y * y)]);
    }
    tube(B, { pts, radius: (t) => 0.075 - 0.035 * t, squash: 0.7, seg: 8, look });
  }
  return B.build();
}

// A strawberry half (see the header): cut face +Z, skin −Z, tip toward −Y.
function buildStrawberry() {
  const B = new Builder();
  const skin = lin("#c3122c"), flesh = lin("#f2445c"), core = lin("#ffd3da"), rim = lin("#d81d3a"), seed = lin("#ffe07a");
  const outline = outlineFromSDF((x, y) => smin(sdCircle(x, y, 0, 0.28, 0.78), sdTriangleUp(x / 0.92, -(y + 0.12), 0.66) - 0.22, 0.45), 48, 0.85, 1);
  const BACK = 0.72, FRONT = 0.07;
  const domeOf = (rho) => Math.pow(Math.max(0, 1 - Math.pow(rho, 2.4)), 0.42);
  puff(B, {
    outline, front: FRONT, back: BACK, rings: 12,
    look: (x, y, rho, front) => {
      if (!front) return { a: A_(0.75, 0.5, 0, 1), b: B_(skin, 1) };
      // the cut face: a pale core drawn out along the long axis, red flesh, a red rim
      const c = Math.hypot(x / 0.42, (y - 0.05) / 0.75);
      let col = flesh.map((v, i) => v + (core[i] - v) * (1 - smooth(0.35, 1, c)));
      col = col.map((v, i) => v + (rim[i] - v) * smooth(0.8, 0.97, rho));
      // (the cut face's rim dithers out softly: no sticker edge)
      return { a: A_(0.85, 0.55, rimEdge(rho, 0.86) * 0.8, 1), b: B_(col, 1) };
    },
  });
  // seeds: little sunken yellow beads all over the skin, and a ring of them
  // along the cut face's edge
  const dot = (p, r) => ellipsoid(B, { r: [r, r, r * 0.7], c: p, seg: 6, rings: 4, look: () => ({ a: A_(0.6, 0.45, 0, 1), b: B_(seed, 1) }) });
  const seg = outline.pts.length;
  const onOutline = (th, rho) => { const s2 = Math.round((th / (Math.PI * 2)) * seg) % seg; const [px, py] = outline.pts[(s2 + seg) % seg]; return outline.map(px * rho, py * rho); };
  for (const [rho, n, phase] of [[0.3, 4, 0.4], [0.55, 7, 0.1], [0.78, 10, 0.3]]) for (let i = 0; i < n; i += 1) {
    const th = ((i + phase) / n) * Math.PI * 2, [x, y] = onOutline(th, rho);
    dot([x, y, -BACK * domeOf(rho) + 0.015], 0.055);
  }
  for (let i = 0; i < 14; i += 1) {
    const th = ((i + 0.5) / 14) * Math.PI * 2, [x, y] = onOutline(th, 0.9);
    dot([x, y, FRONT * domeOf(0.9) + 0.004], 0.045);
  }
  return B.build();
}

// The bear's tongue (see the header): a puffy rounded blade from the root
// (+0.3) to the tip (−1.45), a little wider toward the tip, bent to the
// surface and rising off it toward the tip, plus a darker centre groove.
function buildTongue() {
  const B = new Builder();
  const k = sagOf("tongue"), groove = lin("#d9466c");
  const lift = (y) => 0.1 + 0.35 * smooth(0, 1.45, -y);
  const outline = outlineFromSDF((x, y) => Math.hypot(x / (0.5 + 0.12 * smooth(0.5, -0.8, y)), y / 0.875) - 1, 44, 0.6, 0.875);
  const from = B.p.length / 3;
  puff(B, { outline, front: 0.2, back: 0.06, rings: 12, look: () => ({ a: A_(0.62, 0.14), b: B_() }) });
  shiftFrom(B, from, 0, -0.575, 0);
  for (let i = from * 3; i < B.p.length; i += 3) { const x = B.p[i], y = B.p[i + 1]; B.p[i + 2] += lift(y) - k * (x * x + y * y); }
  const pts = [];
  for (let i = 0; i <= 10; i += 1) { const y = -0.2 - 0.85 * (i / 10); pts.push([0, y, lift(y) + 0.19 * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(y + 0.575) / 0.875, 2.4)), 0.42) - k * y * y]); }
  tube(B, { pts, radius: (t) => 0.055 * (1 - 0.6 * t), squash: 0.5, seg: 8, look: () => ({ a: A_(0.4, 0.05, 0, 1), b: B_(groove, 1) }) });
  return B.build();
}

const BUILDERS = {
  eye: buildEye, nose: buildNose, mouth: buildMouth, blush: buildBlush, muzzle: buildMuzzle, earInner: buildEarInner, cherry: buildCherry, beak: buildBeak,
  eyeClosed: buildEyeClosed, eyeHappy: buildEyeHappy, mouthOpen: buildMouthOpen, beakOpen: buildBeakOpen,
  whisker: buildWhisker, strawberry: buildStrawberry, tongue: buildTongue,
};

// ---- material -----------------------------------------------------------------

// veil: a piece seen through a few mm of clear jelly (the inner pieces'
// overlay copy): its colour pulled a fifth of the way toward a pale jelly pink.
function decorShading({ veil = false } = {}) {
  const A = attribute("decorA", "vec4");
  const Bt = attribute("decorB", "vec4");
  const C = attribute("decorColor", "vec3");
  const gloss = A.x, glow = A.y, edge = A.z;

  // Soft rims (blush, muzzle, inner ear): fade toward a pale tone, then dither out.
  const soft = smoothstep(0.5, 1.0, edge);
  const albedo = mix(mix(C, Bt.xyz, A.w).mul(Bt.w), vec3(1, 0.93, 0.95), soft.mul(0.3));

  const N = normalize(normalWorld);
  const V = normalize(cameraPosition.sub(positionWorld));
  const L = normalize(modelWorldMatrix.mul(vec4(SUN_TRAVEL.clone().negate(), 0)).xyz);
  const NdV = clamp(dot(N, V), 0, 1);
  const NdL = dot(N, L);

  // Diffuse: wrapped sun + hemisphere + front fill (irradiance ≈ 1 facing the viewer).
  const sunColor = vec3(1.0, 0.88, 0.7).mul(0.95);
  const sky = vec3(1.04, 1.0, 0.98), ground = vec3(0.5, 0.45, 0.46);
  const hemi = mix(ground, sky, N.y.mul(0.5).add(0.5));
  // Capped so sun-lit tops of light albedos (beak, muzzle) keep their colour
  // under exposure + ACES instead of washing out to white.
  const irradiance = sunColor.mul(clamp(NdL.add(0.3).div(1.3), 0, 1)).add(hemi.mul(0.78)).add(NdV.mul(0.3)).min(1.12);
  let color = albedo.mul(irradiance).mul(float(1).sub(gloss.mul(0.3)));
  // Self-glow, brighter where it faces the viewer (reads like candy translucency).
  color = color.add(albedo.mul(glow).mul(NdV.mul(0.55).add(0.45)));

  // Gloss: camera-fixed studio window (upper left) + small lower-right
  // reflection + a broad soft sheen + sun specular + Fresnel rim.
  const R = reflect(V.negate(), N);
  const keyDir = normalize(cameraWorldMatrix.mul(vec4(-0.48, 0.6, 0.64, 0)).xyz);
  const subDir = normalize(cameraWorldMatrix.mul(vec4(0.42, -0.4, 0.81, 0)).xyz);
  const g2 = gloss.mul(gloss);
  const kd = dot(R, keyDir);
  const keyHi = smoothstep(mix(0.72, 0.915, gloss), mix(0.8, 0.93, gloss), kd).mul(mix(0.15, 2.1, g2));
  const keySoft = smoothstep(0.55, 0.95, kd).mul(g2).mul(0.03);
  const subHi = smoothstep(0.968, 0.98, dot(R, subDir)).mul(g2).mul(1.3);
  const H = normalize(L.add(V));
  const sunSpec = pow(clamp(dot(N, H), 0, 1), mix(16, 220, gloss)).mul(gloss).mul(1.4);
  const rim = pow(float(1).sub(NdV), 3).mul(mix(0.05, 0.13, gloss));
  color = color.add(vec3(keyHi.add(subHi).add(keySoft))).add(sunColor.mul(sunSpec)).add(sky.mul(rim));

  // Ordered-noise dither instead of blending.
  const noise = interleavedGradientNoise(screenCoordinate.xy).mul(0.98).add(0.01);
  // (a dithered veil read as grain at phone sizes: the colour alone does it)
  if (veil) color = mix(color, vec3(1.0, 0.84, 0.9), 0.2);
  const mask = float(1).sub(soft).greaterThan(noise);
  return { color, mask };
}

// Overlay depth bias: the clip position of the vertex moved toward the camera
// along its view ray by `bias` metres (same pixel, nearer depth), so decor that
// ends up a little under the rendered surface (the anchors follow the cage's
// tets, the surface its subdivided boundary; they part slightly when the
// jelly is squashed) still shows, while decor on the far side stays hidden.
function biasedClip(bias) {
  const toward = float(1).sub(bias.div(length(positionView).max(1e-4)));
  return cameraProjectionMatrix.mul(vec4(positionView.mul(toward.max(0.05)), 1));
}

// Grazing views: the parts of a piece that dome above its anchor sink into the
// surface, and the piece shrinks a little, as the anchor's normal turns away
// from the camera — so a bead eye near the jelly's silhouette never pokes out
// past the outline like a sticker. Per instance: decorAnchor (tray xyz of the
// instance origin, w = 1 flatten / 0 keep, toppers) and decorNormal (tray).
// Runs after instancing, so positionLocal is already in tray space here.
function grazingFlatten() {
  const anchor = attribute("decorAnchor", "vec4");
  const n = attribute("decorNormal", "vec3");
  const aWorld = modelWorldMatrix.mul(vec4(anchor.xyz, 1)).xyz;
  const nWorld = normalize(modelWorldMatrix.mul(vec4(n, 0)).xyz);
  const ndv = dot(nWorld, normalize(cameraPosition.sub(aWorld)));
  const d = positionLocal.sub(anchor.xyz);
  const h = dot(d, n).max(0);
  const keep = mix(float(1), smoothstep(0.03, 0.5, ndv).mul(0.88).add(0.12), anchor.w);
  const shrink = mix(float(1), smoothstep(-0.05, 0.32, ndv).mul(0.4).add(0.6), anchor.w);
  return anchor.xyz.add(d.sub(n.mul(h.mul(float(1).sub(keep)))).mul(shrink));
}

function makeMaterial(shading, { patch }) {
  const material = new THREE.MeshBasicNodeMaterial({ side: THREE.FrontSide });
  material.name = patch ? "DecorPatch" : "Decor";
  material.colorNode = shading.color;
  material.maskNode = shading.mask;
  material.positionNode = grazingFlatten();
  material.depthWrite = !patch;
  material.blending = THREE.NoBlending;
  // No scene fog: decor sits on the jelly at the jelly's depth, and the
  // stage's light FogExp2 lifted black bead eyes to grey and turned the
  // cherry salmon.
  material.fog = false;
  return material;
}

// ---- layer --------------------------------------------------------------------

export class DecorLayer {
  /**
   * @param {THREE.Object3D} parent  the tray group (states are in its space)
   * @param {{ overlay?: boolean, lift?: number, depthBias?: number }} [options]
   *   overlay: draw on top of the jelly (default) or embedded under its surface;
   *   lift: extra offset along the surface normal in overlay mode (m);
   *   depthBias: overlay mode — decor this far (m) under the rendered surface still shows
   */
  constructor(parent, { overlay = true, lift = 0.0001, depthBias = 0.0007 } = {}) {
    this.parent = parent;
    this.hidden = false;
    this.disposed = false;
    this._warned = false;
    this.lift = lift;
    this.depthBias = uniform(depthBias);
    this._clip = biasedClip(this.depthBias);
    const shading = decorShading();
    this.materials = { feature: makeMaterial(shading, { patch: false }), patch: makeMaterial(shading, { patch: true }), inner: makeMaterial(shading, { patch: false }) };
    this.materials.inner.name = "DecorInner";
    // The same inner pieces once more, drawn after the jelly like the face
    // (overlay mode only): the transmission's thin-slab refraction samples
    // the backdrop a whole jelly thickness away, so a piece just under a
    // curved surface often does not show through it at all. This copy is
    // depth-tested with a bias of INNER_BIAS (how deep the pieces sit, plus
    // their own relief), so it shows wherever the piece is just under the
    // front surface — crisp, like fruit in clear jelly — and stays hidden
    // where it is deeper (seen from behind: then only the refracted copy).
    // No depth write: the face drawn after it always stays on top.
    this.materials.innerShallow = makeMaterial(decorShading({ veil: true }), { patch: false });
    this.materials.innerShallow.name = "DecorInnerShallow";
    this.materials.innerShallow.transparent = true;
    this.materials.innerShallow.depthWrite = false;
    this.materials.innerShallow.vertexNode = biasedClip(uniform(INNER_BIAS));
    this.shallow = new Map();         // kind id → overlay copy of an inner kind
    this.meshes = [];
    this.defaults = DECOR_KINDS.map((k) => lin(DECOR_DEFAULT_COLORS[k]));
    this.top = new Float32Array(DECOR_KINDS.length);       // highest unit-space z per kind
    DECOR_KINDS.forEach((kind, i) => {
      const geometry = BUILDERS[kind]();
      this.top[i] = geometry.boundingBox.max.z;
      const colors = new THREE.InstancedBufferAttribute(new Float32Array(DECOR_MAX_PER_KIND * 3), 3);
      colors.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute("decorColor", colors);
      for (const [name, size] of [["decorAnchor", 4], ["decorNormal", 3]]) {
        const a = new THREE.InstancedBufferAttribute(new Float32Array(DECOR_MAX_PER_KIND * size), size);
        a.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute(name, a);
      }
      const mesh = new THREE.InstancedMesh(geometry, INNER.has(kind) ? this.materials.inner : PATCH.has(kind) ? this.materials.patch : this.materials.feature, DECOR_MAX_PER_KIND);
      mesh.name = `Decor:${kind}`;
      mesh.count = 0;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      parent.add(mesh);
      this.meshes.push(mesh);
      if (INNER.has(kind)) {
        const copy = new THREE.InstancedMesh(geometry, this.materials.innerShallow, DECOR_MAX_PER_KIND);
        copy.instanceMatrix = mesh.instanceMatrix;
        copy.name = `Decor:${kind}:shallow`;
        copy.count = 0; copy.visible = false; copy.frustumCulled = false; copy.renderOrder = 1;
        parent.add(copy);
        this.shallow.set(i, copy);
      }
    });
    this.counts = new Int32Array(DECOR_KINDS.length);
    this._m = new THREE.Matrix4(); this._p = new THREE.Vector3(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3();
    this._z = new THREE.Vector3(); this._c = new THREE.Color();
    this.setOverlay(overlay);
  }

  get overlay() { return this._overlay; }

  // overlay: drawn after the (transmissive) jelly, never refracted; patches
  // first, features on top. Embedded: opaque, refracted by the jelly.
  setOverlay(on) {
    on = Boolean(on);
    if (on === this._overlay) return;
    this._overlay = on;
    // (the inner pieces stay opaque either way: the jelly's transmission sees them)
    for (const m of [this.materials.feature, this.materials.patch]) { m.transparent = on; m.vertexNode = on ? this._clip : null; m.needsUpdate = true; }
    DECOR_KINDS.forEach((kind, i) => { this.meshes[i].renderOrder = INNER.has(kind) ? 0 : (on ? 2 : 0) + (PATCH.has(kind) ? 0 : 1); });
    if (this.shallow) for (const [kind, copy] of this.shallow) copy.visible = this.counts?.[kind] > 0 && !this.hidden && on;
  }

  // states: Float32Array, stride 12: kindId, px, py, pz, qx, qy, qz, qw, scale, r, g, b
  // (tray space; r < 0 → the kind's default colour; rgb are sRGB 0..1).
  // count is clamped to the whole records in states; records with an unknown
  // kind or a non-finite position / rotation / scale are skipped; more than
  // DECOR_MAX_PER_KIND of one kind are dropped (warned once).
  update(states, count = states ? Math.floor(states.length / DECOR_STRIDE) : 0) {
    if (this.disposed) return;
    const counts = this.counts;
    counts.fill(0);
    count = states ? Math.min(count | 0, Math.floor(states.length / DECOR_STRIDE)) : 0;
    let dropped = 0;
    for (let i = 0; i < count; i += 1) {
      const o = i * DECOR_STRIDE;
      const kind = states[o];
      if (!(kind >= 0 && kind < DECOR_KINDS.length)) continue;
      let finite = true;
      for (let j = 1; j <= 8; j += 1) if (!Number.isFinite(states[o + j])) { finite = false; break; }
      if (!finite) continue;
      const k = counts[kind | 0];
      if (k >= DECOR_MAX_PER_KIND) { dropped += 1; continue; }
      const kindId = kind | 0;
      const mesh = this.meshes[kindId];
      const s = Math.max(1e-6, states[o + 8]);
      this._q.set(states[o + 4], states[o + 5], states[o + 6], states[o + 7]);
      if (this._q.lengthSq() < 1e-12) continue;
      this._q.normalize();
      // Offset along the local normal: a hair outward (overlay), or the piece's
      // own height + a gap inward (embedded; toppers stay put).
      const name = DECOR_KINDS[kindId];
      const off = INNER.has(name) ? 0 : this._overlay ? this.lift : (TOPPER.has(name) ? 0 : -(this.top[kindId] * s + EMBED_GAP));
      this._z.set(0, 0, 1).applyQuaternion(this._q);
      this._p.set(states[o + 1] + this._z.x * off, states[o + 2] + this._z.y * off, states[o + 3] + this._z.z * off);
      this._s.set(s, s, s);
      mesh.setMatrixAt(k, this._m.compose(this._p, this._q, this._s));
      const ga = mesh.geometry.attributes, an = ga.decorAnchor.array, nr = ga.decorNormal.array;
      an[k * 4] = this._p.x; an[k * 4 + 1] = this._p.y; an[k * 4 + 2] = this._p.z; an[k * 4 + 3] = TOPPER.has(name) || INNER.has(name) ? 0 : 1;
      nr[k * 3] = this._z.x; nr[k * 3 + 1] = this._z.y; nr[k * 3 + 2] = this._z.z;
      const attr = ga.decorColor, arr = attr.array, c = k * 3;
      let r, g, b;
      if (!(states[o + 9] >= 0)) [r, g, b] = this.defaults[kindId];
      else { this._c.setRGB(states[o + 9], states[o + 10], states[o + 11], THREE.SRGBColorSpace); r = this._c.r; g = this._c.g; b = this._c.b; }
      if (arr[c] !== r || arr[c + 1] !== g || arr[c + 2] !== b) { arr[c] = r; arr[c + 1] = g; arr[c + 2] = b; attr.needsUpdate = true; }
      counts[kindId] = k + 1;
    }
    if (dropped && !this._warned) { this._warned = true; console.warn(`DecorLayer: ${dropped} decoration(s) over ${DECOR_MAX_PER_KIND} per kind dropped`); }
    for (const [kind, copy] of this.shallow) { copy.count = counts[kind]; copy.visible = counts[kind] > 0 && !this.hidden && this._overlay; }
    for (let kind = 0; kind < this.meshes.length; kind += 1) {
      const mesh = this.meshes[kind], n = counts[kind];
      mesh.count = n;
      mesh.visible = n > 0 && !this.hidden;
      if (n) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.geometry.attributes.decorAnchor.needsUpdate = true;
        mesh.geometry.attributes.decorNormal.needsUpdate = true;
      }
    }
  }

  setHidden(hidden) {
    this.hidden = Boolean(hidden);
    if (this.disposed) return;
    for (let kind = 0; kind < this.meshes.length; kind += 1) this.meshes[kind].visible = this.counts[kind] > 0 && !this.hidden;
    for (const [kind, copy] of this.shallow) copy.visible = this.counts[kind] > 0 && !this.hidden && this._overlay;
  }

  // Triangles per instance of each kind (budgets / tests).
  get triangleCounts() {
    return Object.fromEntries(DECOR_KINDS.map((k, i) => [k, this.meshes[i] ? this.meshes[i].geometry.index.count / 3 : 0]));
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const copy of this.shallow.values()) this.parent.remove(copy);
    this.shallow.clear();
    for (const mesh of this.meshes) { this.parent.remove(mesh); mesh.geometry.dispose(); mesh.dispose?.(); }
    for (const m of Object.values(this.materials)) m.dispose();
    this.meshes = [];
  }
}
