// Signed-distance shape → tetrahedral soft-body cage (pure JS, Worker-safe).
//
// Method: isosurface stuffing (Labelle & Shewchuk, SIGGRAPH 2007) on a
// body-centred-cubic lattice, then quality-guarded smoothing.
//
//  1. BCC lattice: grid A at o + (i,j,k)·h, grid B at o + (i+½,j+½,k+½)·h.
//     Long edges join axis neighbours of one grid, short edges join an A node
//     to its 8 diagonal B nodes; every lattice tet has 2 long + 4 short edges.
//  2. The SDF (negative inside) is sampled at every node; every edge whose
//     ends have opposite strict signs gets a cut point (Illinois root finder).
//  3. Warping: a node closer to a cut point than α·edge (α_long = 0.24999,
//     α_short = 0.41189) is snapped onto the nearest such cut point and becomes
//     a surface node (value 0). Done simultaneously, so it is order-free and a
//     lattice symmetric about a plane gives a mirror-symmetric mesh.
//  4. Stencils: each lattice tet with −/0/+ labels is kept whole (no +),
//     dropped (no −), or cut into 1–3 tets (or 8 around a Steiner point for a
//     twisted prism). Quads that lie on lattice faces are split by their
//     shorter diagonal (ties by node id), so both lattice tets that share the
//     face agree and the mesh conforms.
//  5. Cleanup: the largest face-connected component kept, pinches (parts
//     touching only at a vertex / edge) cut apart, crowded surface nodes at
//     feature tips merged (short-edge collapses), unused nodes dropped; the
//     boundary must be a closed 2-manifold (every edge in two faces, every
//     vertex link one cycle) or the lattice is shifted and stuffed again.
//  6. Smoothing: boundary nodes relax tangentially and are re-projected onto
//     the zero set (optionally lined up on horizontal levels, for layered
//     colours), interior nodes relax toward their neighbours; a move is kept
//     only if no incident tet inverts and the local minimum dihedral angle
//     stays above a floor (or improves).
//  7. Budget: interior half-edge collapses (deepest first) until the node /
//     tet budget is met — the boundary, and so the rendered surface, is kept.
//  8. Light nodes: a surface node whose tets hold almost no volume (a lone
//     tet at a feature tip, i.e. almost no mass in the soft body) is merged
//     into a surface neighbour. Then units → metres, flat bottom at restY,
//     and the final checks (positive tets, closed manifold, min dihedral).
//
// Deterministic: no randomness and fixed visiting orders, so a given JS
// engine always produces the same cage (engines may differ in the last ulp of
// Math.acos / Math.hypot, which could only nudge a threshold decision).

import { determinant } from "./cage.js";

const ALPHA_LONG = 0.24999, ALPHA_SHORT = 0.41189;

// Tet quality: min / max dihedral angle (degrees) of tet (a,b,c,d) in pos.
// The dihedral angle at the edge shared by faces i and j is acos(−nᵢ·nⱼ) for
// outward unit normals, so only the extreme cosines need an acos.
// Allocation-free: it runs a few hundred thousand times per cage.
const FACE_IDX = Int8Array.from([1, 2, 3, 0, 0, 3, 2, 1, 0, 1, 3, 2, 0, 2, 1, 3]);   // (i, j, k, opposite)
const DIH_IDS = new Int32Array(4), DIH_N = new Float64Array(12);
export function tetDihedrals(pos, a, b, c, d, out = [0, 0]) {
  const P = DIH_IDS, N = DIH_N;
  P[0] = a * 3; P[1] = b * 3; P[2] = c * 3; P[3] = d * 3;
  for (let f = 0; f < 4; f++) {
    const i = P[FACE_IDX[f * 4]], j = P[FACE_IDX[f * 4 + 1]], k = P[FACE_IDX[f * 4 + 2]], o = P[FACE_IDX[f * 4 + 3]];
    const ux = pos[j] - pos[i], uy = pos[j + 1] - pos[i + 1], uz = pos[j + 2] - pos[i + 2];
    const vx = pos[k] - pos[i], vy = pos[k + 1] - pos[i + 1], vz = pos[k + 2] - pos[i + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    // orient away from the opposite vertex
    if (nx * (pos[o] - pos[i]) + ny * (pos[o + 1] - pos[i + 1]) + nz * (pos[o + 2] - pos[i + 2]) > 0) { nx = -nx; ny = -ny; nz = -nz; }
    const l = Math.hypot(nx, ny, nz) || 1e-300;
    N[f * 3] = nx / l; N[f * 3 + 1] = ny / l; N[f * 3 + 2] = nz / l;
  }
  let hi = -2, lo = 2;
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
    const c0 = -(N[i * 3] * N[j * 3] + N[i * 3 + 1] * N[j * 3 + 1] + N[i * 3 + 2] * N[j * 3 + 2]);
    if (c0 > hi) hi = c0; if (c0 < lo) lo = c0;
  }
  out[0] = Math.acos(Math.max(-1, Math.min(1, hi))) * 180 / Math.PI;
  out[1] = Math.acos(Math.max(-1, Math.min(1, lo))) * 180 / Math.PI;
  return out;
}

// Signed 6× volume of tet (a,b,c,d) (positive = cage.js orientation).
export function tetDet(pos, a, b, c, d) {
  a *= 3; b *= 3; c *= 3; d *= 3;
  return determinant(
    pos[b] - pos[a], pos[c] - pos[a], pos[d] - pos[a],
    pos[b + 1] - pos[a + 1], pos[c + 1] - pos[a + 1], pos[d + 1] - pos[a + 1],
    pos[b + 2] - pos[a + 2], pos[c + 2] - pos[a + 2], pos[d + 2] - pos[a + 2],
  );
}

// Normalised aspect ratio: (longest edge / shortest altitude) / that of a
// regular tet (1 = regular, grows for slivers / needles).
export function tetAspect(pos, a, b, c, d) {
  const ids = [a, b, c, d];
  let lmax = 0;
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
    const p = ids[i] * 3, q = ids[j] * 3;
    lmax = Math.max(lmax, Math.hypot(pos[p] - pos[q], pos[p + 1] - pos[q + 1], pos[p + 2] - pos[q + 2]));
  }
  const vol6 = Math.abs(tetDet(pos, a, b, c, d));
  let amax = 0;
  for (const [i, j, k] of [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]]) {
    const p = ids[i] * 3, q = ids[j] * 3, r = ids[k] * 3;
    const ux = pos[q] - pos[p], uy = pos[q + 1] - pos[p + 1], uz = pos[q + 2] - pos[p + 2];
    const vx = pos[r] - pos[p], vy = pos[r + 1] - pos[p + 1], vz = pos[r + 2] - pos[p + 2];
    amax = Math.max(amax, Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx));
  }
  // altitude = 3V / A = vol6 / (2A) with A = |cross|/2 → vol6 / |cross|
  const hmin = vol6 / (amax || 1e-300);
  return (lmax / hmin) / Math.sqrt(1.5);
}

// ------------------------------------------------------------------ stuffing
function stuff(sdf, h, bounds, origin) {
  const [bx0, by0, bz0, bx1, by1, bz1] = bounds;
  const base = [0, 0, 0], dims = [0, 0, 0];
  const lo = [bx0, by0, bz0], hi = [bx1, by1, bz1];
  for (let a = 0; a < 3; a++) {
    base[a] = origin[a] + Math.floor((lo[a] - origin[a]) / h - 1) * h;
    dims[a] = Math.ceil((hi[a] - base[a]) / h) + 1;
  }
  const [nx, ny, nz] = dims;
  const NA = (nx + 1) * (ny + 1) * (nz + 1), NB = nx * ny * nz, NV = NA + NB;
  const Aid = (i, j, k) => (i * (ny + 1) + j) * (nz + 1) + k;
  const Bid = (i, j, k) => NA + (i * ny + j) * nz + k;
  const P = new Float64Array(NV * 3), V = new Float64Array(NV);
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= ny; j++) for (let k = 0; k <= nz; k++) {
    const v = Aid(i, j, k), x = base[0] + i * h, y = base[1] + j * h, z = base[2] + k * h;
    P[v * 3] = x; P[v * 3 + 1] = y; P[v * 3 + 2] = z; V[v] = sdf(x, y, z);
  }
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) {
    const v = Bid(i, j, k), x = base[0] + (i + 0.5) * h, y = base[1] + (j + 0.5) * h, z = base[2] + (k + 0.5) * h;
    P[v * 3] = x; P[v * 3 + 1] = y; P[v * 3 + 2] = z; V[v] = sdf(x, y, z);
  }
  // Lattice neighbours of node v: [u, isLong]
  const neighbours = (v, out) => {
    out.length = 0;
    if (v < NA) {
      const k = v % (nz + 1), j = ((v - k) / (nz + 1)) % (ny + 1), i = (v - k - j * (nz + 1)) / ((nz + 1) * (ny + 1));
      if (i > 0) out.push(Aid(i - 1, j, k), 1); if (i < nx) out.push(Aid(i + 1, j, k), 1);
      if (j > 0) out.push(Aid(i, j - 1, k), 1); if (j < ny) out.push(Aid(i, j + 1, k), 1);
      if (k > 0) out.push(Aid(i, j, k - 1), 1); if (k < nz) out.push(Aid(i, j, k + 1), 1);
      for (let di = -1; di <= 0; di++) for (let dj = -1; dj <= 0; dj++) for (let dk = -1; dk <= 0; dk++) {
        const bi = i + di, bj = j + dj, bk = k + dk;
        if (bi >= 0 && bj >= 0 && bk >= 0 && bi < nx && bj < ny && bk < nz) out.push(Bid(bi, bj, bk), 0);
      }
    } else {
      const w = v - NA, k = w % nz, j = ((w - k) / nz) % ny, i = (w - k - j * nz) / (nz * ny);
      if (i > 0) out.push(Bid(i - 1, j, k), 1); if (i < nx - 1) out.push(Bid(i + 1, j, k), 1);
      if (j > 0) out.push(Bid(i, j - 1, k), 1); if (j < ny - 1) out.push(Bid(i, j + 1, k), 1);
      if (k > 0) out.push(Bid(i, j, k - 1), 1); if (k < nz - 1) out.push(Bid(i, j, k + 1), 1);
      for (let di = 0; di <= 1; di++) for (let dj = 0; dj <= 1; dj++) for (let dk = 0; dk <= 1; dk++) out.push(Aid(i + di, j + dj, k + dk), 0);
    }
    return out;
  };

  // Cut points on sign-changing edges (original node positions), cached by edge key.
  const cuts = new Map();
  const tol = 1e-9 * h;
  const cutPoint = (a, b) => {
    const key = a < b ? a * NV + b : b * NV + a;
    let c = cuts.get(key);
    if (c) return c;
    // orient: n = negative end, p = positive end
    const n = V[a] < 0 ? a : b, p = n === a ? b : a;
    const nx0 = P[n * 3], ny0 = P[n * 3 + 1], nz0 = P[n * 3 + 2];
    const dx = P[p * 3] - nx0, dy = P[p * 3 + 1] - ny0, dz = P[p * 3 + 2] - nz0;
    let t0 = 0, f0 = V[n], t1 = 1, f1 = V[p], side = 0, t = 0.5;
    for (let it = 0; it < 60; it++) {
      t = (t0 * f1 - t1 * f0) / (f1 - f0);
      if (!(t > t0 && t < t1)) t = 0.5 * (t0 + t1);
      const f = sdf(nx0 + dx * t, ny0 + dy * t, nz0 + dz * t);
      if (Math.abs(f) < tol || t1 - t0 < 1e-12) break;
      if (f < 0) { t0 = t; f0 = f; if (side === -1) f1 *= 0.5; side = -1; }
      else { t1 = t; f1 = f; if (side === 1) f0 *= 0.5; side = 1; }
    }
    c = { n, p, t, x: nx0 + dx * t, y: ny0 + dy * t, z: nz0 + dz * t, id: -1 };
    cuts.set(key, c);
    return c;
  };

  // Warping (simultaneous): find each violated node's nearest violating cut point.
  const nb = [];
  const warps = [];
  for (let v = 0; v < NV; v++) {
    const fv = V[v];
    if (fv === 0 || Math.abs(fv) > 2 * h) continue;
    neighbours(v, nb);
    let best = null, bestD = Infinity;
    for (let q = 0; q < nb.length; q += 2) {
      const u = nb[q];
      if (!(fv * V[u] < 0)) continue;
      const c = cutPoint(v, u);
      const frac = c.n === v ? c.t : 1 - c.t;               // fraction of the edge from v
      const alpha = nb[q + 1] ? ALPHA_LONG : ALPHA_SHORT;
      if (frac < alpha) {
        const len = nb[q + 1] ? h : h * Math.sqrt(3) / 2, d = frac * len;
        if (d < bestD || (d === bestD && best && (c.x < best.x || (c.x === best.x && (c.y < best.y || (c.y === best.y && c.z < best.z)))))) { bestD = d; best = c; }
      }
    }
    if (best) warps.push(v, best.x, best.y, best.z);
  }
  for (let q = 0; q < warps.length; q += 4) {
    const v = warps[q];
    P[v * 3] = warps[q + 1]; P[v * 3 + 1] = warps[q + 2]; P[v * 3 + 2] = warps[q + 3]; V[v] = 0;
  }

  // Output vertices: lattice nodes keep their id; cut points and Steiner
  // points are appended.
  const extra = [];               // xyz of appended vertices
  const cutId = (a, b) => {
    const c = cutPoint(a, b);
    if (c.id < 0) { c.id = NV + extra.length / 3; extra.push(c.x, c.y, c.z); }
    return c.id;
  };
  const posOf = (v, out) => {
    if (v < NV) { out[0] = P[v * 3]; out[1] = P[v * 3 + 1]; out[2] = P[v * 3 + 2]; }
    else { const o = (v - NV) * 3; out[0] = extra[o]; out[1] = extra[o + 1]; out[2] = extra[o + 2]; }
    return out;
  };
  const tmpA = [0, 0, 0], tmpB = [0, 0, 0];
  const dist2 = (u, v) => { posOf(u, tmpA); posOf(v, tmpB); return (tmpA[0] - tmpB[0]) ** 2 + (tmpA[1] - tmpB[1]) ** 2 + (tmpA[2] - tmpB[2]) ** 2; };
  // Quad on a lattice face: negatives x,y with cut points cx (on x→p), cy (on y→p).
  // Returns true for diagonal (x, cy), false for (y, cx). Same answer from both sides.
  const quadXcy = (x, y, cx, cy) => {
    const d1 = dist2(x, cy), d2 = dist2(y, cx);
    if (d1 !== d2) return d1 < d2;
    return x < y;
  };
  const tets = [];
  // Prism A0A1A2 / B0B1B2 with quads Qi = (Ai, Ai+1, Bi+1, Bi); flag[i] = 0 → diagonal (Ai, Bi+1), 1 → (Ai+1, Bi)
  const prism = (A, B, flag) => {
    for (let i = 0; i < 3; i++) {
      const im = (i + 2) % 3, ip = (i + 1) % 3, ipp = (i + 2) % 3;
      if (flag[i] === 0 && flag[im] === 1) {         // Ai has two diagonals: Ai–Bi+1, Ai–Bi−1
        tets.push([A[i], B[im], B[i], B[ip]]);
        // pyramid apex Ai, base quad i+1 = (Ai+1, Ai+2, Bi+2, Bi+1)
        if (flag[ip] === 0) tets.push([A[i], A[ip], A[ipp], B[ipp]], [A[i], A[ip], B[ipp], B[ip]]);
        else tets.push([A[i], A[ip], A[ipp], B[ip]], [A[i], A[ipp], B[ipp], B[ip]]);
        return;
      }
      if (flag[i] === 1 && flag[im] === 0) {         // Bi has two diagonals: Ai+1–Bi, Ai−1–Bi
        tets.push([B[i], A[im], A[i], A[ip]]);
        if (flag[ip] === 0) tets.push([B[i], B[ip], B[ipp], A[ip]], [B[i], A[ip], A[ipp], B[ipp]]);
        else tets.push([B[i], B[ip], B[ipp], A[ipp]], [B[i], A[ip], A[ipp], B[ip]]);
        return;
      }
    }
    // twisted prism: Steiner point at the centroid
    let sx = 0, sy = 0, sz = 0;
    for (const v of [...A, ...B]) { posOf(v, tmpA); sx += tmpA[0]; sy += tmpA[1]; sz += tmpA[2]; }
    const s = NV + extra.length / 3;
    extra.push(sx / 6, sy / 6, sz / 6);
    tets.push([s, A[0], A[1], A[2]], [s, B[0], B[1], B[2]]);
    for (let i = 0; i < 3; i++) {
      const ip = (i + 1) % 3;
      if (flag[i] === 0) tets.push([s, A[i], A[ip], B[ip]], [s, A[i], B[ip], B[i]]);
      else tets.push([s, A[i], A[ip], B[i]], [s, A[ip], B[ip], B[i]]);
    }
  };
  const sgn = (v) => (V[v] < 0 ? -1 : V[v] > 0 ? 1 : 0);
  const emit = (q) => {
    const neg = [], zer = [], pos = [];
    for (const v of q) { const s = sgn(v); (s < 0 ? neg : s > 0 ? pos : zer).push(v); }
    if (pos.length === 0) {
      if (neg.length) { tets.push(q.slice()); return; }
      // all four on the surface: keep it if its centre is inside
      let cx = 0, cy = 0, cz = 0;
      for (const v of q) { cx += P[v * 3]; cy += P[v * 3 + 1]; cz += P[v * 3 + 2]; }
      if (sdf(cx / 4, cy / 4, cz / 4) < 0) tets.push(q.slice());
      return;
    }
    if (neg.length === 0) return;
    const nN = neg.length, nP = pos.length;
    if (nN === 1 && nP === 3) {
      const a = neg[0];
      tets.push([a, cutId(a, pos[0]), cutId(a, pos[1]), cutId(a, pos[2])]);
    } else if (nN === 1 && nP === 2) {
      const a = neg[0];
      tets.push([a, zer[0], cutId(a, pos[0]), cutId(a, pos[1])]);
    } else if (nN === 1 && nP === 1) {
      const a = neg[0];
      tets.push([a, zer[0], zer[1], cutId(a, pos[0])]);
    } else if (nN === 2 && nP === 1) {
      const [a, b] = neg, p = pos[0], z = zer[0];
      const cap = cutId(a, p), cbp = cutId(b, p);
      if (quadXcy(a, b, cap, cbp)) tets.push([z, a, b, cbp], [z, a, cbp, cap]);
      else tets.push([z, a, b, cap], [z, b, cbp, cap]);
    } else if (nN === 2 && nP === 2) {
      const [a, b] = neg, [p, r] = pos;
      const cap = cutId(a, p), caq = cutId(a, r), cbp = cutId(b, p), cbq = cutId(b, r);
      // A = (a, cap, caq), B = (b, cbp, cbq); Q0 on face (a,b,p), Q1 the cut quad, Q2 on face (a,b,q)
      const f0 = quadXcy(a, b, cap, cbp) ? 0 : 1;           // (A0,B1)=(a,cbp) ↔ flag 0
      const f2 = quadXcy(a, b, caq, cbq) ? 1 : 0;           // Q2=(A2,A0,B0,B2): flag 0 = (A2,B0)=(caq,b); flag 1 = (A0,B2)=(a,cbq)
      let f1;
      if (f0 === f2) f1 = 1 - f0;
      else f1 = dist2(cap, cbq) <= dist2(caq, cbp) ? 0 : 1;   // Q1=(A1,A2,B2,B1): flag 0 = (A1,B2)=(cap,cbq)
      prism([a, cap, caq], [b, cbp, cbq], [f0, f1, f2]);
    } else if (nN === 3 && nP === 1) {
      const [a, b, c] = neg, p = pos[0];
      const cap = cutId(a, p), cbp = cutId(b, p), ccp = cutId(c, p);
      // Qi = (Ai, Ai+1, Bi+1, Bi) on face (Ai, Ai+1, p); flag 0 = (Ai, Bi+1)
      const f0 = quadXcy(a, b, cap, cbp) ? 0 : 1;
      const f1 = quadXcy(b, c, cbp, ccp) ? 0 : 1;
      const f2 = quadXcy(c, a, ccp, cap) ? 0 : 1;
      prism([a, b, c], [cap, cbp, ccp], [f0, f1, f2]);
    }
  };

  // Lattice tets around every A long edge (each lattice tet has exactly one).
  const q = [0, 0, 0, 0];
  const ring = [0, 0, 0, 0];
  const anyInside = (vs) => { for (const v of vs) if (V[v] <= 0) return true; return false; };
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= ny; j++) for (let k = 0; k <= nz; k++) {
    const a0 = Aid(i, j, k);
    for (let axis = 0; axis < 3; axis++) {
      let a1, okRing = true;
      if (axis === 0) {
        if (i >= nx || j < 1 || j >= ny || k < 1 || k >= nz) continue;
        a1 = Aid(i + 1, j, k);
        ring[0] = Bid(i, j - 1, k - 1); ring[1] = Bid(i, j, k - 1); ring[2] = Bid(i, j, k); ring[3] = Bid(i, j - 1, k);
      } else if (axis === 1) {
        if (j >= ny || i < 1 || i >= nx || k < 1 || k >= nz) continue;
        a1 = Aid(i, j + 1, k);
        ring[0] = Bid(i - 1, j, k - 1); ring[1] = Bid(i, j, k - 1); ring[2] = Bid(i, j, k); ring[3] = Bid(i - 1, j, k);
      } else {
        if (k >= nz || i < 1 || i >= nx || j < 1 || j >= ny) continue;
        a1 = Aid(i, j, k + 1);
        ring[0] = Bid(i - 1, j - 1, k); ring[1] = Bid(i, j - 1, k); ring[2] = Bid(i, j, k); ring[3] = Bid(i - 1, j, k);
      }
      if (!okRing) continue;
      for (let m = 0; m < 4; m++) {
        q[0] = a0; q[1] = a1; q[2] = ring[m]; q[3] = ring[(m + 1) & 3];
        if (!anyInside(q)) continue;
        emit(q);
      }
    }
  }
  const all = new Float64Array(NV * 3 + extra.length);
  all.set(P); all.set(extra, NV * 3);
  return { pos: all, tets, lattice: { NV, NA, h, base, dims } };
}

// ------------------------------------------------------------------ cleanup
const faceKey = (a, b, c) => {
  // sorted triple → string key
  if (a > b) [a, b] = [b, a]; if (b > c) [b, c] = [c, b]; if (a > b) [a, b] = [b, a];
  return a + "," + b + "," + c;
};

function orient(pos, tets) {
  for (const t of tets) if (tetDet(pos, t[0], t[1], t[2], t[3]) < 0) [t[1], t[2]] = [t[2], t[1]];
}

function boundaryFaces(tets) {
  const faceMap = new Map();
  for (const [ta, tb, tc, td] of tets) {
    for (const f of [[ta, tc, tb], [ta, tb, td], [ta, td, tc], [tb, tc, td]]) {
      const fk = faceKey(f[0], f[1], f[2]);
      if (faceMap.has(fk)) faceMap.delete(fk); else faceMap.set(fk, f);
    }
  }
  return [...faceMap.values()];
}

// Keep the largest face-connected component (by volume).
function largestComponent(pos, tets) {
  const parent = tets.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const owner = new Map();
  tets.forEach(([a, b, c, d], e) => {
    for (const f of [[a, b, c], [a, b, d], [a, c, d], [b, c, d]]) {
      const k = faceKey(f[0], f[1], f[2]);
      const o = owner.get(k);
      if (o === undefined) owner.set(k, e); else { const ra = find(o), rb = find(e); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); }
    }
  });
  const vol = new Map();
  tets.forEach((t, e) => { const r = find(e); vol.set(r, (vol.get(r) || 0) + Math.abs(tetDet(pos, ...t))); });
  let best = -1, bestV = -1;
  for (const [r, v] of vol) if (v > bestV) { bestV = v; best = r; }
  return { tets: tets.filter((_, e) => find(e) === best), components: vol.size };
}

// Closed 2-manifold check of an oriented boundary: every edge in exactly two
// faces with opposite directions, every vertex link a single cycle.
export function checkManifold(boundary) {
  const directed = new Map(), problems = [];
  for (const [a, b, c] of boundary) for (const [u, v] of [[a, b], [b, c], [c, a]]) {
    const k = u + ">" + v;
    directed.set(k, (directed.get(k) || 0) + 1);
  }
  for (const [k, n] of directed) {
    const [u, v] = k.split(">");
    if (n !== 1 || directed.get(v + ">" + u) !== 1) problems.push({ kind: "edge", edge: [+u, +v] });
  }
  // vertex links: for each vertex the faces around it, chained by next-edge
  const around = new Map();
  for (const f of boundary) for (let i = 0; i < 3; i++) {
    const v = f[i], a = f[(i + 1) % 3], b = f[(i + 2) % 3];
    if (!around.has(v)) around.set(v, new Map());
    around.get(v).set(a, b);           // link edge a → b
  }
  for (const [v, link] of around) {
    const start = link.keys().next().value;
    let cur = start, steps = 0;
    do { cur = link.get(cur); steps++; } while (cur !== undefined && cur !== start && steps <= link.size);
    if (cur !== start || steps !== link.size) problems.push({ kind: "vertex", vertex: v });
  }
  return problems;
}

// Pinch repair. Where two parts of the solid touch only at a vertex or an
// edge (features thinner than the lattice), the tets around that vertex/edge
// fall into separate fans; all but the largest fan are removed there. Repeats
// until the boundary is a closed 2-manifold (or gives up → caller retries).
function repairPinches(pos, tets, rounds = 24) {
  for (let round = 0; round < rounds; round++) {
    const problems = checkManifold(boundaryFaces(tets));
    if (!problems.length) return { tets, ok: true, rounds: round };
    const drop = new Set();
    const vt = new Map();
    tets.forEach((t, e) => { for (const v of t) { if (!vt.has(v)) vt.set(v, []); vt.get(v).push(e); } });
    for (const pr of problems) {
      const keyVerts = pr.kind === "vertex" ? [pr.vertex] : pr.edge;
      // tets containing all key vertices, grouped by shared faces that contain them
      const T = (vt.get(keyVerts[0]) || []).filter((e) => !drop.has(e) && keyVerts.every((k) => tets[e].includes(k)));
      if (T.length < 2) continue;
      const parent = T.map((_, i) => i);
      const find = (x) => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
      const faceOwner = new Map();
      T.forEach((e, i) => {
        const t = tets[e];
        for (const f of [[t[0], t[1], t[2]], [t[0], t[1], t[3]], [t[0], t[2], t[3]], [t[1], t[2], t[3]]]) {
          if (!keyVerts.every((k) => f.includes(k))) continue;
          const k = faceKey(f[0], f[1], f[2]);
          if (faceOwner.has(k)) { const a = find(faceOwner.get(k)), b = find(i); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); }
          else faceOwner.set(k, i);
        }
      });
      const vol = new Map();
      T.forEach((e, i) => { const r = find(i); vol.set(r, (vol.get(r) || 0) + Math.abs(tetDet(pos, ...tets[e]))); });
      if (vol.size < 2) {
        // one fan whose link is not a disc (a tunnel pinched at this vertex):
        // drop the fan's tets that touch the boundary at this vertex
        continue;
      }
      let best = -1, bestV = -1;
      for (const [r, v] of vol) if (v > bestV) { bestV = v; best = r; }
      T.forEach((e, i) => { if (find(i) !== best) drop.add(e); });
    }
    if (!drop.size) return { tets, ok: false, rounds: round };
    tets = largestComponent(pos, tets.filter((_, e) => !drop.has(e))).tets;
  }
  return { tets, ok: !checkManifold(boundaryFaces(tets)).length, rounds };
}

// Surface edge collapses v → u (u keeps its place on the surface). A collapse
// is applied when the surface link condition holds (u and v share exactly the
// two opposite vertices), every re-coned tet stays positive and above the
// quality floor, no surface triangle flips, and no duplicate tet appears.
// `pick` lists the candidates of a round as groups of directed tries [v, u];
// the best valid try of a group is applied, groups that touch an earlier
// collapse of the same round wait for the next round.
function collapseSurfaceEdges(pos, tets, pick, { floorAngle = 16, maxAngle = 160, rounds = 6 } = {}) {
  const tmp = [0, 0], q4 = [0, 0, 0, 0];
  const quality = (t, v, u) => {
    for (let k = 0; k < 4; k++) q4[k] = t[k] === v ? u : t[k];
    if (tetDet(pos, q4[0], q4[1], q4[2], q4[3]) <= 0) return -1;
    tetDihedrals(pos, q4[0], q4[1], q4[2], q4[3], tmp);
    return tmp[1] > maxAngle ? -1 : tmp[0];
  };
  const normal = (a, b, c) => {
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
    const ux = pos[b * 3] - ax, uy = pos[b * 3 + 1] - ay, uz = pos[b * 3 + 2] - az, vx = pos[c * 3] - ax, vy = pos[c * 3 + 1] - ay, vz = pos[c * 3 + 2] - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz) || 1e-300;
    return [nx / l, ny / l, nz / l];
  };
  let collapsed = 0;
  for (let round = 0; round < rounds; round++) {
    const boundary = boundaryFaces(tets);
    const vt = new Map(), bf = new Map(), bn = new Map();
    tets.forEach((t, e) => { for (const v of t) { if (!vt.has(v)) vt.set(v, []); vt.get(v).push(e); } });
    for (const f of boundary) for (let i = 0; i < 3; i++) {
      const v = f[i];
      if (!bf.has(v)) { bf.set(v, []); bn.set(v, new Set()); }
      bf.get(v).push(f); bn.get(v).add(f[(i + 1) % 3]).add(f[(i + 2) % 3]);
    }
    const groups = pick({ tets, vt, bn });
    if (!groups.length) break;
    const touched = new Set(), dead = new Set();
    let progress = 0;
    for (const tries of groups) {
      if (tries.some(([v, u]) => touched.has(v) || touched.has(u))) continue;
      let best = null;
      for (const [v, u] of tries) {
        if (!bn.has(v) || !bn.has(u)) continue;
        const common = [...bn.get(v)].filter((w) => bn.get(u).has(w));
        if (common.length !== 2) continue;
        const T = vt.get(v).filter((e) => !dead.has(e));
        let qmin = 180, ok = true;
        const keys = new Set(vt.get(u).filter((e) => !dead.has(e)).map((e) => tets[e].slice().sort((x, y) => x - y).join(",")));
        for (const e of T) {
          const t = tets[e];
          if (t.includes(u)) continue;
          const qv = quality(t, v, u);
          if (qv < floorAngle) { ok = false; break; }
          qmin = Math.min(qmin, qv);
          const k = t.map((w) => (w === v ? u : w)).sort((x, y) => x - y).join(",");
          if (keys.has(k)) { ok = false; break; }
          keys.add(k);
        }
        if (!ok) continue;
        for (const f of bf.get(v)) {
          if (f.includes(u)) continue;
          const n0 = normal(f[0], f[1], f[2]);
          const g = f.map((w) => (w === v ? u : w)), n1 = normal(g[0], g[1], g[2]);
          if (n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2] < 0.3) { ok = false; break; }
        }
        if (ok && (!best || qmin > best.q)) best = { v, u, q: qmin, T };
      }
      if (!best) continue;
      const { v, u, T } = best;
      for (const e of T) {
        const t = tets[e];
        if (t.includes(u)) dead.add(e);
        else for (let k = 0; k < 4; k++) if (t[k] === v) t[k] = u;
      }
      touched.add(u); touched.add(v);
      for (const w of bn.get(v)) touched.add(w);
      for (const e of T) for (const w of tets[e]) touched.add(w);
      progress++;
    }
    if (!progress) break;
    tets = tets.filter((_, e) => !dead.has(e));
    collapsed += progress;
  }
  return { tets, collapsed };
}

// Short surface edges: stuffing leaves clusters of near-coincident surface
// nodes at sharp feature tips (cut points crowding into one lattice cell).
function collapseShortSurfaceEdges(pos, tets, minLen, opts) {
  return collapseSurfaceEdges(pos, tets, ({ bn }) => {
    const edges = [];
    for (const [v, set] of bn) for (const u of set) if (u > v) {
      const l = Math.hypot(pos[u * 3] - pos[v * 3], pos[u * 3 + 1] - pos[v * 3 + 1], pos[u * 3 + 2] - pos[v * 3 + 2]);
      if (l < minLen) edges.push([l, v, u]);
    }
    edges.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    return edges.map(([, a, b]) => [[a, b], [b, a]]);
  }, opts);
}

// Light surface nodes: a node whose incident tets hold almost no volume (a
// lone tet at a feature tip) gets almost no mass in the soft body — a finger
// grabbing it pulls nothing, and its stiff, tiny elements stall the solver.
// Each is merged into the surface neighbour that leaves the best tets.
function nodeVolumes(pos, tets, n) {
  const vol = new Float64Array(n);
  for (const t of tets) { const v = tetDet(pos, t[0], t[1], t[2], t[3]) / 24; for (const w of t) vol[w] += v; }
  return vol;
}
function collapseLightNodes(pos, tets, minFraction, opts) {
  return collapseSurfaceEdges(pos, tets, ({ tets: T, bn }) => {
    const vol = nodeVolumes(pos, T, pos.length / 3);
    let total = 0, count = 0;
    for (const v of vol) if (v > 0) { total += v; count++; }
    const limit = minFraction * total / count, light = [];
    for (const [v, set] of bn) if (vol[v] < limit) light.push([vol[v], v, set]);
    light.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return light.map(([, v, set]) => [...set].sort((a, b) => a - b).map((u) => [v, u]));
  }, opts);
}

// ------------------------------------------------------------------ smoothing
function makeQuality(pos, tets) {
  const tmp = [0, 0];
  return (e) => {
    const t = tets[e];
    if (tetDet(pos, t[0], t[1], t[2], t[3]) <= 0) return -1;
    tetDihedrals(pos, t[0], t[1], t[2], t[3], tmp);
    // a single score: min dihedral, penalised if the max gets too obtuse
    return Math.min(tmp[0], (180 - tmp[1]) * 0.75);
  };
}

// levels (optional): { y0, step, tol, maxSlope } — boundary nodes on steep
// walls (|∂f/∂y| / |∇f| < maxSlope) within tol of a level y0 + k·step are
// moved onto it (and back onto the wall horizontally), so the surface rows
// line up with horizontal colour layers.
function smooth(sdf, pos, tets, boundary, { iterations = 8, floorAngle = 16, boundaryLambda = 0.5, interiorLambda = 0.6, project = true, levels = null } = {}) {
  const n = pos.length / 3;
  const incident = Array.from({ length: n }, () => []);
  tets.forEach((t, e) => { for (const v of t) incident[v].push(e); });
  const isB = new Uint8Array(n);
  const bNb = Array.from({ length: n }, () => new Set());
  for (const [a, b, c] of boundary) { isB[a] = isB[b] = isB[c] = 1; bNb[a].add(b).add(c); bNb[b].add(a).add(c); bNb[c].add(a).add(b); }
  const allNb = Array.from({ length: n }, () => new Set());
  for (const t of tets) for (const u of t) for (const v of t) if (u !== v) allNb[u].add(v);
  const quality = makeQuality(pos, tets);
  const grad = (x, y, z, eps, out) => {
    out[0] = (sdf(x + eps, y, z) - sdf(x - eps, y, z)) / (2 * eps);
    out[1] = (sdf(x, y + eps, z) - sdf(x, y - eps, z)) / (2 * eps);
    out[2] = (sdf(x, y, z + eps) - sdf(x, y, z - eps)) / (2 * eps);
    return out;
  };
  const g = [0, 0, 0];
  let span = 0;
  for (const [a, b] of boundary) span += Math.hypot(pos[a * 3] - pos[b * 3], pos[a * 3 + 1] - pos[b * 3 + 1], pos[a * 3 + 2] - pos[b * 3 + 2]);
  span /= Math.max(1, boundary.length);
  const eps = span * 1e-3;
  const projectPoint = (p) => {
    for (let it = 0; it < 6; it++) {
      const f = sdf(p[0], p[1], p[2]);
      if (Math.abs(f) < span * 1e-7) break;
      grad(p[0], p[1], p[2], eps, g);
      const gg = g[0] * g[0] + g[1] * g[1] + g[2] * g[2];
      if (!(gg > 1e-12)) break;
      p[0] -= f * g[0] / gg; p[1] -= f * g[1] / gg; p[2] -= f * g[2] / gg;
    }
    return p;
  };
  const snapLevel = (q) => {
    grad(q[0], q[1], q[2], eps, g);
    const gl = Math.hypot(g[0], g[1], g[2]);
    if (!(gl > 0) || Math.abs(g[1]) / gl > levels.maxSlope) return q;
    const k = Math.round((q[1] - levels.y0) / levels.step), y = levels.y0 + k * levels.step;
    if (Math.abs(q[1] - y) > levels.tol) return q;
    q[1] = y;
    for (let it = 0; it < 6; it++) {                 // back onto the wall, horizontally
      const f = sdf(q[0], q[1], q[2]);
      if (Math.abs(f) < span * 1e-7) break;
      grad(q[0], q[1], q[2], eps, g);
      const hh = g[0] * g[0] + g[2] * g[2];
      if (!(hh > 1e-12)) break;
      q[0] -= f * g[0] / hh; q[2] -= f * g[2] / hh;
    }
    return q;
  };
  // project every boundary node onto the zero set first (Steiner-free, cut
  // points are already on it; snapped nodes too — this just polishes)
  // accept a move if no incident tet inverts and the local quality stays
  // above the floor (or does not get worse); "before" is only needed then
  const tryMove = (v, nx, ny, nz) => {
    const o = v * 3, ox = pos[o], oy = pos[o + 1], oz = pos[o + 2];
    pos[o] = nx; pos[o + 1] = ny; pos[o + 2] = nz;
    let after = Infinity;
    for (const e of incident[v]) { after = Math.min(after, quality(e)); if (after < 0) break; }
    if (after >= floorAngle) return true;
    pos[o] = ox; pos[o + 1] = oy; pos[o + 2] = oz;
    if (!(after > 0)) return false;
    let before = Infinity;
    for (const e of incident[v]) before = Math.min(before, quality(e));
    if (after >= before) { pos[o] = nx; pos[o + 1] = ny; pos[o + 2] = nz; return true; }
    return false;
  };
  const p = [0, 0, 0];
  let moved = 0;
  for (let it = 0; it < iterations; it++) {
    for (let v = 0; v < n; v++) {
      const o = v * 3;
      if (isB[v]) {
        let cx = 0, cy = 0, cz = 0, m = 0;
        for (const u of bNb[v]) { cx += pos[u * 3]; cy += pos[u * 3 + 1]; cz += pos[u * 3 + 2]; m++; }
        if (!m) continue;
        p[0] = pos[o] + boundaryLambda * (cx / m - pos[o]);
        p[1] = pos[o + 1] + boundaryLambda * (cy / m - pos[o + 1]);
        p[2] = pos[o + 2] + boundaryLambda * (cz / m - pos[o + 2]);
        if (project) projectPoint(p);
        if (levels) snapLevel(p);
        if (tryMove(v, p[0], p[1], p[2])) moved++;
      } else {
        let cx = 0, cy = 0, cz = 0, m = 0;
        for (const u of allNb[v]) { cx += pos[u * 3]; cy += pos[u * 3 + 1]; cz += pos[u * 3 + 2]; m++; }
        if (!m) continue;
        p[0] = pos[o] + interiorLambda * (cx / m - pos[o]);
        p[1] = pos[o + 1] + interiorLambda * (cy / m - pos[o + 1]);
        p[2] = pos[o + 2] + interiorLambda * (cz / m - pos[o + 2]);
        if (tryMove(v, p[0], p[1], p[2])) moved++;
      }
    }
  }
  return moved;
}

// ------------------------------------------------------------------ coarsening
// Interior decimation by half-edge collapses v → u (v interior, u any
// neighbour). Removing an interior node and re-coning its star from u is a
// valid re-tiling exactly when every new tet is positively oriented, so the
// boundary (and the rendered surface) is untouched. A collapse is kept only if
// the new tets stay above the quality floor. Deepest nodes go first, and the
// neighbours of a removed node wait for the next pass, which spreads the
// coarsening evenly instead of hollowing one spot.
function coarsenInterior(sdf, pos, tets, isB, { maxNodes, maxTets, floorAngle = 16, maxAngle = 150, passes = 12, lambda = 0.6 } = {}) {
  const n = pos.length / 3;
  const alive = new Uint8Array(tets.length).fill(1);
  const vt = Array.from({ length: n }, () => []);
  tets.forEach((t, e) => { for (const v of t) vt[v].push(e); });
  let nodes = 0, tetCount = tets.length;
  for (let v = 0; v < n; v++) if (vt[v].length) nodes++;
  const tmp = [0, 0];
  const depth = new Float64Array(n);
  for (let v = 0; v < n; v++) depth[v] = isB[v] ? 0 : -sdf(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
  const liveTets = (v) => { const L = vt[v].filter((e) => alive[e]); vt[v] = L; return L; };
  // quality of tet t with vertex v replaced by u (or as is when v < 0)
  const q4 = [0, 0, 0, 0];
  const quality = (t, v, u) => {
    for (let k = 0; k < 4; k++) q4[k] = t[k] === v ? u : t[k];
    if (tetDet(pos, q4[0], q4[1], q4[2], q4[3]) <= 0) return -1;
    tetDihedrals(pos, q4[0], q4[1], q4[2], q4[3], tmp);
    if (tmp[1] > maxAngle) return -1;
    return tmp[0];
  };
  const order = [];
  for (let v = 0; v < n; v++) if (!isB[v] && vt[v].length) order.push(v);
  order.sort((a, b) => depth[b] - depth[a] || a - b);
  let removed = 0;
  const done = () => nodes <= maxNodes && tetCount <= maxTets;
  for (let pass = 0; pass < passes && !done(); pass++) {
    const locked = new Uint8Array(n);
    let progress = 0;
    for (const v of order) {
      if (done()) break;
      if (locked[v] || !vt[v].length) continue;
      const T = liveTets(v);
      if (!T.length) continue;
      const nbs = new Set();
      for (const e of T) for (const w of tets[e]) if (w !== v) nbs.add(w);
      let bestU = -1, bestQ = -1;
      for (const u of nbs) {
        let qmin = 180;
        for (const e of T) {
          const t = tets[e];
          if (t[0] === u || t[1] === u || t[2] === u || t[3] === u) continue;
          const q = quality(t, v, u);
          if (q < qmin) qmin = q;
          if (qmin < floorAngle || qmin <= bestQ) break;
        }
        if (qmin >= floorAngle && qmin > bestQ) { bestQ = qmin; bestU = u; }
      }
      if (bestU < 0) continue;
      for (const e of T) {
        const t = tets[e];
        if (t[0] === bestU || t[1] === bestU || t[2] === bestU || t[3] === bestU) { alive[e] = 0; tetCount--; }
        else { for (let k = 0; k < 4; k++) if (t[k] === v) t[k] = bestU; vt[bestU].push(e); }
      }
      vt[v] = [];
      nodes--; removed++; progress++;
      for (const w of nbs) locked[w] = 1;
    }
    // relax the remaining interior nodes between passes (quality-guarded)
    for (const v of order) {
      if (!vt[v].length) continue;
      const T = liveTets(v);
      const nbs = new Set();
      for (const e of T) for (const w of tets[e]) if (w !== v) nbs.add(w);
      let cx = 0, cy = 0, cz = 0;
      for (const w of nbs) { cx += pos[w * 3]; cy += pos[w * 3 + 1]; cz += pos[w * 3 + 2]; }
      const m = nbs.size, o = v * 3, ox = pos[o], oy = pos[o + 1], oz = pos[o + 2];
      let before = 180;
      for (const e of T) before = Math.min(before, quality(tets[e], -1, -1));
      pos[o] = ox + lambda * (cx / m - ox); pos[o + 1] = oy + lambda * (cy / m - oy); pos[o + 2] = oz + lambda * (cz / m - oz);
      let after = 180;
      for (const e of T) { after = Math.min(after, quality(tets[e], -1, -1)); if (after < 0) break; }
      if (!(after > 0 && after >= Math.min(before, floorAngle + 4))) { pos[o] = ox; pos[o + 1] = oy; pos[o + 2] = oz; }
    }
    if (!progress) break;
  }
  return { tets: tets.filter((_, e) => alive[e]), removed };
}

// ------------------------------------------------------------------ stats
export function cageStats(cage) {
  const { pos, tets, boundary } = cage;
  let minDih = 180, maxDih = 0, worstAspect = 0, minVol = Infinity, maxVol = 0;
  const tmp = [0, 0];
  for (const t of tets) {
    tetDihedrals(pos, t[0], t[1], t[2], t[3], tmp);
    minDih = Math.min(minDih, tmp[0]); maxDih = Math.max(maxDih, tmp[1]);
    worstAspect = Math.max(worstAspect, tetAspect(pos, t[0], t[1], t[2], t[3]));
    const v = tetDet(pos, t[0], t[1], t[2], t[3]) / 6;
    minVol = Math.min(minVol, v); maxVol = Math.max(maxVol, v);
  }
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity, rMax = 0;
  for (let i = 0; i < pos.length; i += 3) {
    x0 = Math.min(x0, pos[i]); x1 = Math.max(x1, pos[i]);
    y0 = Math.min(y0, pos[i + 1]); y1 = Math.max(y1, pos[i + 1]);
    z0 = Math.min(z0, pos[i + 2]); z1 = Math.max(z1, pos[i + 2]);
    rMax = Math.max(rMax, Math.hypot(pos[i], pos[i + 2]));
  }
  const nodeVol = nodeVolumes(pos, tets, pos.length / 3);
  let lightest = Infinity;
  for (const v of nodeVol) lightest = Math.min(lightest, v);
  return {
    nodes: pos.length / 3, tets: tets.length, faces: boundary.length, volume: cage.totalVolume,
    lightestNode: lightest / (cage.totalVolume / (pos.length / 3)),     // min node mass / mean
    minDihedral: minDih, maxDihedral: maxDih, worstAspect, volumeSpread: maxVol / minVol,
    bounds: [x0, y0, z0, x1, y1, z1], footprintRadius: rMax,
  };
}

// Drop unused nodes (renumbering in first-use order, which is deterministic).
function compact(pos, tets) {
  const keep = new Int32Array(pos.length / 3).fill(-1);
  let m = 0;
  for (const t of tets) for (const v of t) if (keep[v] < 0) keep[v] = m++;
  const p2 = new Float64Array(m * 3);
  for (let v = 0; v < keep.length; v++) if (keep[v] >= 0) p2.set(pos.subarray(v * 3, v * 3 + 3), keep[v] * 3);
  return { pos: p2, tets: tets.map((t) => t.map((v) => keep[v])) };
}

// ------------------------------------------------------------------ floor
// Surface nodes hovering just above the flat bottom (the rounded rim where
// the floor meets the side) make flat rim tets that the jelly's own weight
// presses to zero volume — or through it — on the tray. Each such node is
// either put down on the floor or, if that would spoil its tets, lifted to
// `gap` above it; a move is kept only if no incident tet inverts and the
// local quality stays above the floor (or improves). Lowest first.
function snapToFloor(pos, tets, boundary, bottom, gap, { floorAngle = 14 } = {}) {
  const n = pos.length / 3;
  const incident = Array.from({ length: n }, () => []);
  tets.forEach((t, e) => { for (const v of t) incident[v].push(e); });
  const isB = new Uint8Array(n);
  for (const f of boundary) for (const v of f) isB[v] = 1;
  const quality = makeQuality(pos, tets);
  const local = (v) => { let q = Infinity; for (const e of incident[v]) { q = Math.min(q, quality(e)); if (q < 0) break; } return q; };
  const low = [];
  for (let v = 0; v < n; v++) { const dy = pos[v * 3 + 1] - bottom; if (isB[v] && dy > 1e-6 * gap && dy < gap) low.push(v); }
  low.sort((a, b) => pos[a * 3 + 1] - pos[b * 3 + 1] || a - b);
  let moved = 0;
  for (const v of low) {
    const o = v * 3 + 1, y0 = pos[o], before = local(v);
    let best = null;
    for (const y of [bottom, bottom + gap]) {
      pos[o] = y;
      const q = local(v);
      if (q > 0 && (q >= floorAngle || q >= before) && (!best || q > best.q + 1e-9)) best = { y, q };
      if (best && y === bottom && best.q >= floorAngle) break;      // down on the floor is preferred
    }
    pos[o] = best ? best.y : y0;
    if (best) moved++;
  }
  return moved;
}

// ------------------------------------------------------------------ driver
// sdf(x,y,z) in the caller's units (negative inside); `scale` converts those
// units to metres. Options: h (lattice cube edge, caller units), bounds
// [x0,y0,z0,x1,y1,z1], origin (a lattice A node; put symmetry planes through
// it). The lowest nodes (the flat bottom) are snapped to exactly `restY` m.
// Light nodes (incident volume < minNodeMass × the mean) are merged away.
export function meshSDF(sdf, { h, bounds, origin = [0, 0, 0], scale = 0.001, restY = 0.010, smoothing = {}, minDihedral = 8, maxNodes = 0, maxTets = 0, coarsen = {}, shortEdge = 0.32, minNodeMass = 0.025, lightFloor = 14, floorSnap = 0 } = {}) {
  // Stuff; if a pinch cannot be repaired, retry on a horizontally shifted
  // lattice (deterministic sequence; y stays aligned with the flat bottom).
  const shifts = [[0, 0], [0.31, 0.17], [0.13, 0.41], [0.43, 0.29], [0.23, 0.07], [0.07, 0.23]];
  let pos, tets, boundary, components = 0, attempt = 0, repairs = 0, lattice, shortCollapsed = 0;
  for (; attempt < shifts.length; attempt++) {
    const o = [origin[0] + shifts[attempt][0] * h, origin[1], origin[2] + shifts[attempt][1] * h];
    const st = stuff(sdf, h, bounds, o);
    lattice = st.lattice;
    orient(st.pos, st.tets);
    const lc = largestComponent(st.pos, st.tets);
    components = lc.components;
    const rep = repairPinches(st.pos, lc.tets);
    if (!rep.ok) continue;
    repairs = rep.rounds;
    // merge crowded surface nodes (keep the result only if still manifold)
    const sc = collapseShortSurfaceEdges(st.pos, rep.tets.map((t) => t.slice()), shortEdge * h);
    let cleaned = rep.tets;
    if (sc.collapsed && !checkManifold(boundaryFaces(sc.tets)).length) { cleaned = sc.tets; shortCollapsed = sc.collapsed; }
    // compact vertices
    const remap = new Int32Array(st.pos.length / 3).fill(-1);
    let count = 0;
    for (const t of cleaned) for (const v of t) if (remap[v] < 0) remap[v] = count++;
    pos = new Float64Array(count * 3);
    for (let v = 0; v < remap.length; v++) if (remap[v] >= 0) pos.set(st.pos.subarray(v * 3, v * 3 + 3), remap[v] * 3);
    tets = cleaned.map((t) => t.map((v) => remap[v]));
    boundary = boundaryFaces(tets);
    break;
  }
  if (!tets) throw new Error("stuffing produced a non-manifold boundary on every lattice shift");
  let moved = smooth(sdf, pos, tets, boundary, smoothing);
  let removed = 0;
  if (maxNodes || maxTets) {
    const isB = new Uint8Array(pos.length / 3);
    for (const f of boundary) for (const v of f) isB[v] = 1;
    const r = coarsenInterior(sdf, pos, tets, isB, { maxNodes: maxNodes || Infinity, maxTets: maxTets || Infinity, ...coarsen });
    removed = r.removed;
    if (removed) {
      // drop the removed nodes, then polish again
      const keep = new Int32Array(pos.length / 3).fill(-1);
      let m = 0;
      for (const t of r.tets) for (const v of t) if (keep[v] < 0) keep[v] = m++;
      const p2 = new Float64Array(m * 3);
      for (let v = 0; v < keep.length; v++) if (keep[v] >= 0) p2.set(pos.subarray(v * 3, v * 3 + 3), keep[v] * 3);
      pos = p2;
      tets = r.tets.map((t) => t.map((v) => keep[v]));
      boundary = boundaryFaces(tets);
      moved += smooth(sdf, pos, tets, boundary, { ...smoothing, iterations: 4 });
    }
  }
  // merge light surface nodes (lone tets at feature tips) into a neighbour
  let lightCollapsed = 0;
  if (minNodeMass > 0) {
    const lc = collapseLightNodes(pos, tets.map((t) => t.slice()), minNodeMass, { floorAngle: lightFloor });
    if (lc.collapsed && !checkManifold(boundaryFaces(lc.tets)).length) {
      ({ pos, tets } = compact(pos, lc.tets));
      boundary = boundaryFaces(tets);
      lightCollapsed = lc.collapsed;
      moved += smooth(sdf, pos, tets, boundary, { ...smoothing, iterations: 2 });
    }
  }
  // units → metres; flat bottom exactly at restY
  let minY = Infinity;
  for (let i = 1; i < pos.length; i += 3) minY = Math.min(minY, pos[i]);
  const bottom = minY;
  const floorSnapped = floorSnap > 0 ? snapToFloor(pos, tets, boundary, bottom, floorSnap * h, { floorAngle: lightFloor }) : 0;
  for (let i = 0; i < pos.length; i += 3) {
    pos[i] *= scale; pos[i + 2] *= scale;
    const y = pos[i + 1];
    pos[i + 1] = Math.abs(y - bottom) < 1e-6 * h ? restY : restY + (y - bottom) * scale;
  }
  orient(pos, tets);
  let totalVolume = 0;
  for (const t of tets) {
    const det = tetDet(pos, t[0], t[1], t[2], t[3]);
    if (!(det > 1e-16)) throw new Error("Invalid tetrahedralisation.");
    totalVolume += det / 6;
  }
  boundary = boundaryFaces(tets);
  const post = checkManifold(boundary);
  if (post.length) throw new Error(`smoothing broke the boundary (${post.length} defects)`);
  const cage = { pos, tets, boundary, totalVolume };
  const stats = cageStats(cage);
  if (stats.minDihedral < minDihedral) throw new Error(`poor tet quality: min dihedral ${stats.minDihedral.toFixed(2)}°`);
  stats.components = components; stats.smoothingMoves = moved; stats.lattice = lattice.NV; stats.bottom = bottom; stats.collapsed = removed; stats.latticeShift = attempt; stats.pinchRepairs = repairs; stats.shortEdgeCollapses = shortCollapsed; stats.lightCollapses = lightCollapsed; stats.floorSnapped = floorSnapped;
  return { cage, stats };
}
