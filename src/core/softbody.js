// XPBD compressible neo-Hookean soft body.
// Numerics follow the softbody-jelly example from threejs-awesome-graphics-agent-skills
// (MIT, Copyright (c) 2026 Scott Sun). This port keeps every arithmetic expression and
// its evaluation order, but stores elements in flat typed arrays and inlines the
// deformation gradient so the 240 Hz loop does not allocate. tests/golden.test.mjs
// checks bit-for-bit equality against the original module.
//
// App additions (off by default, so the default path stays identical):
//   - gravity vector (device tilt) instead of a fixed -Y gravity
//   - a circular tray wall that keeps the body on screen
//   - per-mode floor friction override
//   - directional impulse for shake gestures
//   - impact reporting for sound
//   - grab weights from a shell hit, point evaluation inside a tet (gems)

import { determinant, inverse3, makeFlowerCage, makeSurfaceStencils, evaluateSurface, computeVertexNormals, computeBounds } from "./cage.js";

export const JELLY_DEFAULTS = Object.freeze({
  density: 1050,
  shear: 600,
  bulk: 65000,
  damping: 3,
  gravity: 9.81,
  step: 1 / 240,
  iterations: 3,
  staticFriction: 0.65,
  dynamicFriction: 0.42,
  restitution: 0.065,
  floor: 0.00015,
  maxGrabForce: 2.8,
});

export class SoftBody {
  constructor(options = {}) {
    this.params = { ...JELLY_DEFAULTS, ...options.params };
    const cage = options.cage || makeFlowerCage();
    this.cage = cage;
    const P = this.params;
    this.x = cage.pos.slice(); this.rest = cage.pos.slice();
    this.previous = this.x.slice(); this.velocity = new Float64Array(this.x.length);
    const nodeCount = this.x.length / 3;
    this.nodeCount = nodeCount;
    this.mass = new Float64Array(nodeCount); this.inverseMass = new Float64Array(nodeCount);
    this.contact = new Float64Array(nodeCount);
    this.wallContact = new Uint8Array(nodeCount);

    const E = cage.tets.length;
    this.elementCount = E;
    this.ids = new Int32Array(E * 4);
    this.offsets = new Int32Array(E * 4);
    this.volumes = new Float64Array(E);
    this.gradients = new Float64Array(E * 12);
    this.lambdaD = new Float64Array(E);
    this.lambdaH = new Float64Array(E);
    this.lambdaB = new Float64Array(E);
    this.bg = new Float64Array(12);

    for (let e = 0; e < E; e++) {
      const tet = cage.tets[e];
      const [a, b, c, d] = tet.map((v) => v * 3), p = this.rest;
      const dm = [p[b] - p[a], p[c] - p[a], p[d] - p[a], p[b + 1] - p[a + 1], p[c + 1] - p[a + 1], p[d + 1] - p[a + 1], p[b + 2] - p[a + 2], p[c + 2] - p[a + 2], p[d + 2] - p[a + 2]];
      const volume = determinant(...dm) / 6, inv = inverse3(dm);
      const g = this.gradients, o = e * 12;
      for (let k = 0; k < 3; k++) {
        g[o + 3 + k] = inv[k]; g[o + 6 + k] = inv[3 + k]; g[o + 9 + k] = inv[6 + k];
        g[o + k] = -inv[k] - inv[3 + k] - inv[6 + k];
      }
      this.volumes[e] = volume;
      for (let v = 0; v < 4; v++) { this.ids[e * 4 + v] = tet[v]; this.offsets[e * 4 + v] = tet[v] * 3; }
      for (const i of tet) this.mass[i] += P.density * volume / 4;
    }
    for (let i = 0; i < nodeCount; i++) this.inverseMass[i] = 1 / this.mass[i];
    this.totalMass = this.mass.reduce((a, b) => a + b, 0);

    this.grab = null; this.extraGrabs = [];
    this.sleeping = false; this.quietTime = 0; this.grounded = false; this.internalRms = 0; this.rigidRms = 0;

    // App extensions. null gravityVector = original fixed -Y gravity.
    this.gravityVector = null;
    this.wallRadius = 0;        // 0 = no wall (original behaviour)
    this.frictionOverride = null; // {staticFriction, dynamicFriction}
    this.impact = 0;            // max downward contact speed since last read (m/s)
    this.wallImpact = 0;

    this.stencils = options.stencils || makeSurfaceStencils(cage);
    this.positions = new Float32Array(this.stencils.vertexCount * 3);
    this.normals = new Float32Array(this.stencils.vertexCount * 3);
    this.bounds = new Float64Array(6);
    this.center = [0, 0, 0];
    this.updateSurface();
  }

  get indices() { return this.stencils.indices; }

  // Equivalent to the original solveElastic(); F is inlined.
  solveElastic(e, h) {
    const x = this.x, g = this.gradients, o = e * 12, off = this.offsets, b4 = e * 4;
    const invMass = this.inverseMass, ids = this.ids;
    let a = 0, b = 0, c = 0, d = 0, ee = 0, ff = 0, gg = 0, hh = 0, ii = 0;
    const p0 = off[b4];
    for (let v = 1; v < 4; v++) {
      const i = off[b4 + v], j = o + v * 3;
      const dx = x[i] - x[p0], dy = x[i + 1] - x[p0 + 1], dz = x[i + 2] - x[p0 + 2];
      a += dx * g[j]; b += dx * g[j + 1]; c += dx * g[j + 2];
      d += dy * g[j]; ee += dy * g[j + 1]; ff += dy * g[j + 2];
      gg += dz * g[j]; hh += dz * g[j + 1]; ii += dz * g[j + 2];
    }
    let norm = 0;
    norm += a * a; norm += b * b; norm += c * c; norm += d * d; norm += ee * ee;
    norm += ff * ff; norm += gg * gg; norm += hh * hh; norm += ii * ii;
    norm = Math.sqrt(norm); if (norm < 1e-12) return;

    const c0 = ee * ii - ff * hh, c1 = ff * gg - d * ii, c2 = d * hh - ee * gg;
    const c3 = c * hh - b * ii, c4 = a * ii - c * gg, c5 = b * gg - a * hh;
    const c6 = b * ff - c * ee, c7 = c * d - a * ff, c8 = a * ee - b * d;
    const J = a * c0 + b * c1 + c * c2;
    const P = this.params, volume = this.volumes[e];
    const alphaD = 1 / (P.shear * volume * h * h), alphaH = 1 / (P.bulk * volume * h * h);
    let dd = alphaD, hhMass = alphaH, dh = 0;
    // Unrolled per-vertex projection; accumulation order matches the original k-loop.
    const v0 = ids[b4], v1 = ids[b4 + 1], v2 = ids[b4 + 2], v3 = ids[b4 + 3];
    const w0 = invMass[v0], w1 = invMass[v1], w2 = invMass[v2], w3 = invMass[v3];
    let gx = g[o], gy = g[o + 1], gz = g[o + 2];
    const d00 = (a * gx + b * gy + c * gz) / norm, d01 = (d * gx + ee * gy + ff * gz) / norm, d02 = (gg * gx + hh * gy + ii * gz) / norm;
    const h00 = c0 * gx + c1 * gy + c2 * gz, h01 = c3 * gx + c4 * gy + c5 * gz, h02 = c6 * gx + c7 * gy + c8 * gz;
    dd += w0 * d00 * d00; hhMass += w0 * h00 * h00; dh += w0 * d00 * h00;
    dd += w0 * d01 * d01; hhMass += w0 * h01 * h01; dh += w0 * d01 * h01;
    dd += w0 * d02 * d02; hhMass += w0 * h02 * h02; dh += w0 * d02 * h02;
    gx = g[o + 3]; gy = g[o + 4]; gz = g[o + 5];
    const d10 = (a * gx + b * gy + c * gz) / norm, d11 = (d * gx + ee * gy + ff * gz) / norm, d12 = (gg * gx + hh * gy + ii * gz) / norm;
    const h10 = c0 * gx + c1 * gy + c2 * gz, h11 = c3 * gx + c4 * gy + c5 * gz, h12 = c6 * gx + c7 * gy + c8 * gz;
    dd += w1 * d10 * d10; hhMass += w1 * h10 * h10; dh += w1 * d10 * h10;
    dd += w1 * d11 * d11; hhMass += w1 * h11 * h11; dh += w1 * d11 * h11;
    dd += w1 * d12 * d12; hhMass += w1 * h12 * h12; dh += w1 * d12 * h12;
    gx = g[o + 6]; gy = g[o + 7]; gz = g[o + 8];
    const d20 = (a * gx + b * gy + c * gz) / norm, d21 = (d * gx + ee * gy + ff * gz) / norm, d22 = (gg * gx + hh * gy + ii * gz) / norm;
    const h20 = c0 * gx + c1 * gy + c2 * gz, h21 = c3 * gx + c4 * gy + c5 * gz, h22 = c6 * gx + c7 * gy + c8 * gz;
    dd += w2 * d20 * d20; hhMass += w2 * h20 * h20; dh += w2 * d20 * h20;
    dd += w2 * d21 * d21; hhMass += w2 * h21 * h21; dh += w2 * d21 * h21;
    dd += w2 * d22 * d22; hhMass += w2 * h22 * h22; dh += w2 * d22 * h22;
    gx = g[o + 9]; gy = g[o + 10]; gz = g[o + 11];
    const d30 = (a * gx + b * gy + c * gz) / norm, d31 = (d * gx + ee * gy + ff * gz) / norm, d32 = (gg * gx + hh * gy + ii * gz) / norm;
    const h30 = c0 * gx + c1 * gy + c2 * gz, h31 = c3 * gx + c4 * gy + c5 * gz, h32 = c6 * gx + c7 * gy + c8 * gz;
    dd += w3 * d30 * d30; hhMass += w3 * h30 * h30; dh += w3 * d30 * h30;
    dd += w3 * d31 * d31; hhMass += w3 * h31 * h31; dh += w3 * d31 * h31;
    dd += w3 * d32 * d32; hhMass += w3 * h32 * h32; dh += w3 * d32 * h32;

    const rd = -norm - alphaD * this.lambdaD[e];
    const rh = -(J - 1 - P.shear / P.bulk) - alphaH * this.lambdaH[e];
    const denominator = dd * hhMass - dh * dh;
    if (Math.abs(denominator) < 1e-20) return;
    const dlD = (rd * hhMass - rh * dh) / denominator;
    const dlH = (rh * dd - rd * dh) / denominator;
    this.lambdaD[e] += dlD; this.lambdaH[e] += dlH;

    let i = off[b4];
    x[i] += w0 * (dlD * d00 + dlH * h00); x[i + 1] += w0 * (dlD * d01 + dlH * h01); x[i + 2] += w0 * (dlD * d02 + dlH * h02);
    i = off[b4 + 1];
    x[i] += w1 * (dlD * d10 + dlH * h10); x[i + 1] += w1 * (dlD * d11 + dlH * h11); x[i + 2] += w1 * (dlD * d12 + dlH * h12);
    i = off[b4 + 2];
    x[i] += w2 * (dlD * d20 + dlH * h20); x[i + 1] += w2 * (dlD * d21 + dlH * h21); x[i + 2] += w2 * (dlD * d22 + dlH * h22);
    i = off[b4 + 3];
    x[i] += w3 * (dlD * d30 + dlH * h30); x[i + 1] += w3 * (dlD * d31 + dlH * h31); x[i + 2] += w3 * (dlD * d32 + dlH * h32);
  }

  // Equivalent to the original solveBarrier() + project(..., 'lambdaB', true).
  solveBarrier(e) {
    const x = this.x, g = this.gradients, o = e * 12, off = this.offsets, b4 = e * 4;
    let a = 0, b = 0, c = 0, d = 0, ee = 0, ff = 0, gg = 0, hh = 0, ii = 0;
    const p0 = off[b4];
    for (let v = 1; v < 4; v++) {
      const i = off[b4 + v], j = o + v * 3;
      const dx = x[i] - x[p0], dy = x[i + 1] - x[p0 + 1], dz = x[i + 2] - x[p0 + 2];
      a += dx * g[j]; b += dx * g[j + 1]; c += dx * g[j + 2];
      d += dy * g[j]; ee += dy * g[j + 1]; ff += dy * g[j + 2];
      gg += dz * g[j]; hh += dz * g[j + 1]; ii += dz * g[j + 2];
    }
    const c0 = ee * ii - ff * hh, c1 = ff * gg - d * ii, c2 = d * hh - ee * gg;
    const c3 = c * hh - b * ii, c4 = a * ii - c * gg, c5 = b * gg - a * hh;
    const c6 = b * ff - c * ee, c7 = c * d - a * ff, c8 = a * ee - b * d;
    const J = a * c0 + b * c1 + c * c2;
    if (J >= .16 && this.lambdaB[e] === 0) return;
    const out = this.bg;
    for (let v = 0; v < 4; v++) {
      const j = v * 3, g0 = g[o + j], g1 = g[o + j + 1], g2 = g[o + j + 2];
      out[j] = c0 * g0 + c1 * g1 + c2 * g2;
      out[j + 1] = c3 * g0 + c4 * g1 + c5 * g2;
      out[j + 2] = c6 * g0 + c7 * g1 + c8 * g2;
    }
    // project(e, J-.16, compliance 0, 'lambdaB', inequality)
    const w = this.inverseMass, ids = this.ids;
    const C = J - .16, compliance = 0;
    let denom = compliance;
    for (let v = 0; v < 4; v++) { const j = 3 * v; denom += w[ids[b4 + v]] * (out[j] ** 2 + out[j + 1] ** 2 + out[j + 2] ** 2); }
    if (denom < 1e-16) return;
    const lambda = this.lambdaB[e];
    let delta = (-C - compliance * lambda) / denom;
    delta = Math.max(0, lambda + delta) - lambda;
    this.lambdaB[e] = lambda + delta;
    for (let v = 0; v < 4; v++) {
      const j = v * 3, i = off[b4 + v], s = w[ids[b4 + v]] * delta;
      x[i] += s * out[j]; x[i + 1] += s * out[j + 1]; x[i + 2] += s * out[j + 2];
    }
  }

  // grab = {ids:Int32Array, weights:Float64Array, target:[x,y,z], point:[x,y,z], lambda:Float64Array(3)}
  solveGrab(h) {
    if (this.grab) this.solveGrabOne(this.grab, h);
    for (const g of this.extraGrabs) this.solveGrabOne(g, h);
  }

  // App extension: extraGrabs = more fingers, each its own force-limited constraint.
  solveGrabOne(grab, h) {
    const p = grab.point, ids = grab.ids, weights = grab.weights, n = ids.length;
    p[0] = 0; p[1] = 0; p[2] = 0;
    let denominator = 0;
    for (let k = 0; k < n; k++) {
      const id = ids[k], weight = weights[k];
      p[0] += this.x[id * 3] * weight; p[1] += this.x[id * 3 + 1] * weight; p[2] += this.x[id * 3 + 2] * weight;
      denominator += this.inverseMass[id] * weight * weight;
    }
    const alpha = 1 / (90 * h * h); denominator += alpha;
    const limit = this.params.maxGrabForce * h * h;
    for (let axis = 0; axis < 3; axis++) {
      const C = p[axis] - grab.target[axis];
      const dl = (-C - alpha * grab.lambda[axis]) / denominator;
      const next = Math.max(-limit, Math.min(limit, grab.lambda[axis] + dl));
      const change = next - grab.lambda[axis]; grab.lambda[axis] = next;
      for (let k = 0; k < n; k++) this.x[ids[k] * 3 + axis] += this.inverseMass[ids[k]] * weights[k] * change;
    }
  }

  // One fixed step = beginStep → iterate × iterations → endStep (the original
  // loop, unchanged in arithmetic; split so callers can add constraints between
  // iterations).
  step(h) {
    if (!this.beginStep(h)) return;
    for (let iteration = 0; iteration < this.params.iterations; iteration++) this.iterate(h, iteration);
    this.endStep(h);
  }

  beginStep(h) {
    if (this.grab || this.extraGrabs.length) this.wake();
    if (this.sleeping) return false;
    const P = this.params;
    const x = this.x, v = this.velocity, old = this.previous, n = this.nodeCount;
    old.set(x); this.contact.fill(0);
    const gv = this.gravityVector;
    if (gv) {
      for (let i = 0; i < n; i++) {
        const j = i * 3; v[j] += gv[0] * h; v[j + 1] += gv[1] * h; v[j + 2] += gv[2] * h;
        x[j] += v[j] * h; x[j + 1] += v[j + 1] * h; x[j + 2] += v[j + 2] * h;
      }
    } else {
      for (let i = 0; i < n; i++) {
        const j = i * 3; v[j + 1] -= P.gravity * h;
        x[j] += v[j] * h; x[j + 1] += v[j + 1] * h; x[j + 2] += v[j + 2] * h;
      }
    }
    this.lambdaD.fill(0); this.lambdaH.fill(0); this.lambdaB.fill(0);
    if (this.grab) this.grab.lambda.fill(0);
    for (const g of this.extraGrabs) g.lambda.fill(0);
    if (this.wallRadius > 0) this.wallContact.fill(0);
    return true;
  }

  iterate(h, iteration) {
    const P = this.params, x = this.x, n = this.nodeCount;
    const E = this.elementCount, R = this.wallRadius;
    const reverse = (iteration & 1) !== 0;
    for (let k = 0; k < E; k++) {
      const e = reverse ? E - 1 - k : k;
      this.solveElastic(e, h); this.solveBarrier(e);
    }
    this.solveGrab(h);
    for (let i = 0; i < n; i++) {
      const j = i * 3;
      if (x[j + 1] < P.floor) {
        this.contact[i] += P.floor - x[j + 1]; x[j + 1] = P.floor;
      }
    }
    if (R > 0) {
      const R2 = R * R;
      for (let i = 0; i < n; i++) {
        const j = i * 3, px = x[j], pz = x[j + 2], r2 = px * px + pz * pz;
        if (r2 > R2) { const s = R / Math.sqrt(r2); x[j] = px * s; x[j + 2] = pz * s; this.wallContact[i] = 1; }
      }
    }
  }

  endStep(h) {
    const P = this.params;
    const x = this.x, v = this.velocity, old = this.previous, n = this.nodeCount, R = this.wallRadius;
    const staticFriction = this.frictionOverride ? this.frictionOverride.staticFriction : P.staticFriction;
    const dynamicFriction = this.frictionOverride ? this.frictionOverride.dynamicFriction : P.dynamicFriction;
    let impact = this.impact, wallImpact = this.wallImpact;
    for (let i = 0; i < n; i++) {
      const j = i * 3, normal = this.contact[i], incoming = v[j + 1];
      if (normal > 0) {
        const dx = x[j] - old[j], dz = x[j + 2] - old[j + 2], tangent = Math.hypot(dx, dz);
        const friction = tangent < staticFriction * normal ? 1 : Math.min(1, dynamicFriction * normal / (tangent + 1e-20));
        x[j] -= dx * friction; x[j + 2] -= dz * friction;
      }
      if (R > 0 && this.wallContact[i]) {
        const radial = (v[j] * x[j] + v[j + 2] * x[j + 2]) / R;
        if (radial > wallImpact) wallImpact = radial;
      }
      v[j] = (x[j] - old[j]) / h; v[j + 1] = (x[j + 1] - old[j + 1]) / h; v[j + 2] = (x[j + 2] - old[j + 2]) / h;
      if (normal > 0 && incoming < 0) {
        if (-incoming > impact) impact = -incoming;
        const bounce = incoming < -.18 ? -incoming * P.restitution : 0;
        v[j + 1] = Math.max(v[j + 1], bounce);
      }
    }
    this.impact = impact; this.wallImpact = wallImpact;
    this.applyDamping(h);

    this.grounded = false;
    for (let i = 0; i < n; i++) if (this.contact[i] > 0) { this.grounded = true; break; }
    this.quietTime = !this.grab && !this.extraGrabs.length && this.grounded && this.rigidRms < .004 && this.internalRms < .021 ? this.quietTime + h : 0;
    if (this.quietTime > .45) {
      this.sleeping = true;
      v.fill(0); this.internalRms = this.rigidRms = 0;
      old.set(x);
    }
  }

  // Current position of a material point given by tet + barycentrics.
  pointInTet(e, bary, out) {
    const x = this.x, ids = this.ids, b4 = e * 4;
    out[0] = 0; out[1] = 0; out[2] = 0;
    for (let v = 0; v < 4; v++) { const j = ids[b4 + v] * 3, w = bary[v]; out[0] += x[j] * w; out[1] += x[j + 1] * w; out[2] += x[j + 2] * w; }
    return out;
  }

  wake() {
    this.sleeping = false;
    this.quietTime = 0;
  }

  applyDamping(h) {
    const x = this.x, v = this.velocity, mass = this.mass, total = this.totalMass;
    if (total <= 0) return;
    let cx = 0, cy = 0, cz = 0, vx = 0, vy = 0, vz = 0;
    for (let i = 0; i < mass.length; i++) {
      const j = i * 3, w = mass[i];
      cx += x[j] * w; cy += x[j + 1] * w; cz += x[j + 2] * w;
      vx += v[j] * w; vy += v[j + 1] * w; vz += v[j + 2] * w;
    }
    cx /= total; cy /= total; cz /= total;
    vx /= total; vy /= total; vz /= total;

    let ixx = 0, iyy = 0, izz = 0, ixy = 0, ixz = 0, iyz = 0, lx = 0, ly = 0, lz = 0;
    for (let i = 0; i < mass.length; i++) {
      const j = i * 3, w = mass[i], rx = x[j] - cx, ry = x[j + 1] - cy, rz = x[j + 2] - cz;
      const ux = v[j] - vx, uy = v[j + 1] - vy, uz = v[j + 2] - vz;
      ixx += w * (ry * ry + rz * rz); iyy += w * (rx * rx + rz * rz); izz += w * (rx * rx + ry * ry);
      ixy -= w * rx * ry; ixz -= w * rx * rz; iyz -= w * ry * rz;
      lx += w * (ry * uz - rz * uy); ly += w * (rz * ux - rx * uz); lz += w * (rx * uy - ry * ux);
    }

    let wx = 0, wy = 0, wz = 0;
    const det = determinant(ixx, ixy, ixz, ixy, iyy, iyz, ixz, iyz, izz);
    if (Math.abs(det) > 1e-18) {
      const inv = inverse3([ixx, ixy, ixz, ixy, iyy, iyz, ixz, iyz, izz]);
      wx = inv[0] * lx + inv[1] * ly + inv[2] * lz;
      wy = inv[3] * lx + inv[4] * ly + inv[5] * lz;
      wz = inv[6] * lx + inv[7] * ly + inv[8] * lz;
    }

    const decay = Math.exp(-Math.max(0, this.params.damping) * h);
    let internal2 = 0, rigid2 = 0;
    for (let i = 0; i < mass.length; i++) {
      const j = i * 3, w = mass[i], rx = x[j] - cx, ry = x[j + 1] - cy, rz = x[j + 2] - cz;
      const rigidX = vx + wy * rz - wz * ry;
      const rigidY = vy + wz * rx - wx * rz;
      const rigidZ = vz + wx * ry - wy * rx;
      const dx = (v[j] - rigidX) * decay, dy = (v[j + 1] - rigidY) * decay, dz = (v[j + 2] - rigidZ) * decay;
      const dampedRigidX = rigidX * decay, dampedRigidY = rigidY * decay, dampedRigidZ = rigidZ * decay;
      v[j] = dampedRigidX + dx; v[j + 1] = dampedRigidY + dy; v[j + 2] = dampedRigidZ + dz;
      internal2 += w * (dx * dx + dy * dy + dz * dz);
      rigid2 += w * (dampedRigidX * dampedRigidX + dampedRigidY * dampedRigidY + dampedRigidZ * dampedRigidZ);
    }
    this.internalRms = Math.sqrt(internal2 / total);
    this.rigidRms = Math.sqrt(rigid2 / total);
  }

  // Surface positions, normals, bounds and mass centre (original updateSurface()).
  updateSurface() {
    evaluateSurface(this.stencils, this.x, this.positions);
    computeVertexNormals(this.positions, this.stencils.indices, this.normals);
    computeBounds(this.positions, this.bounds);
    const c = this.center; c[0] = 0; c[1] = 0; c[2] = 0;
    for (let i = 0; i < this.nodeCount; i++) {
      const w = this.mass[i] / this.totalMass;
      c[0] += this.x[i * 3] * w; c[1] += this.x[i * 3 + 1] * w; c[2] += this.x[i * 3 + 2] * w;
    }
  }

  energy() {
    let E = 0;
    for (let i = 0; i < this.nodeCount; i++) { const j = i * 3; E += .5 * this.mass[i] * (this.velocity[j] ** 2 + this.velocity[j + 1] ** 2 + this.velocity[j + 2] ** 2); }
    return E;
  }

  volumeRatio() {
    const x = this.x, g = this.gradients, off = this.offsets;
    let volume = 0;
    for (let e = 0; e < this.elementCount; e++) {
      const o = e * 12, b4 = e * 4, p0 = off[b4];
      const f = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      for (let v = 1; v < 4; v++) {
        const i = off[b4 + v], j = o + v * 3;
        const dx = x[i] - x[p0], dy = x[i + 1] - x[p0 + 1], dz = x[i + 2] - x[p0 + 2];
        f[0] += dx * g[j]; f[1] += dx * g[j + 1]; f[2] += dx * g[j + 2];
        f[3] += dy * g[j]; f[4] += dy * g[j + 1]; f[5] += dy * g[j + 2];
        f[6] += dz * g[j]; f[7] += dz * g[j + 1]; f[8] += dz * g[j + 2];
      }
      volume += determinant(...f) * this.volumes[e];
    }
    return volume / this.cage.totalVolume;
  }

  reset(lift = 0) {
    this.x.set(this.rest);
    if (lift) for (let i = 1; i < this.x.length; i += 3) this.x[i] += lift;
    this.previous.set(this.x); this.velocity.fill(0); this.grab = null; this.extraGrabs = [];
    this.grounded = false; this.internalRms = this.rigidRms = 0; this.wake();
    this.updateSurface();
  }

  nudge() {
    if (this.grab) return;
    this.wake();
    for (let i = 0; i < this.nodeCount; i++) {
      const j = i * 3, dy = this.x[j + 1] - this.center[1];
      this.velocity[j] += .095 + dy * 3; this.velocity[j + 1] += .12; this.velocity[j + 2] += .025;
    }
  }

  // Shake impulse: horizontal push (m/s) plus a vertical pop and a little spin.
  impulse(vx, vy, vz) {
    if (this.grab || this.extraGrabs.length) return;
    this.wake();
    for (let i = 0; i < this.nodeCount; i++) {
      const j = i * 3, dy = this.x[j + 1] - this.center[1];
      this.velocity[j] += vx * (1 + dy * 30); this.velocity[j + 1] += vy; this.velocity[j + 2] += vz * (1 + dy * 30);
    }
  }

  // ---------------------------------------------------------------- plasticity
  // App extension (slime texture). Off by default: the original jelly is purely
  // elastic. With plastic flow on, each tet's rest shape creeps toward its
  // current (rotation-free) shape at `flow` 1/s, so a stretch or a sag stays,
  // and recovers toward the original rest shape at `recover` 1/s — a slime
  // that keeps the shape you pull it into and slowly rounds back into a
  // blob. Rest volumes are preserved (det of each rest shape is kept).
  setPlastic(flow = 0, recover = 0, yieldStrain = 0) {
    if (!this.restDm0) {
      const E = this.elementCount, p = this.rest, ids = this.ids;
      this.restDm0 = new Float64Array(E * 9);
      for (let e = 0; e < E; e++) {
        const a = ids[e * 4] * 3, b = ids[e * 4 + 1] * 3, c = ids[e * 4 + 2] * 3, d = ids[e * 4 + 3] * 3, o = e * 9, m = this.restDm0;
        m[o] = p[b] - p[a]; m[o + 1] = p[c] - p[a]; m[o + 2] = p[d] - p[a];
        m[o + 3] = p[b + 1] - p[a + 1]; m[o + 4] = p[c + 1] - p[a + 1]; m[o + 5] = p[d + 1] - p[a + 1];
        m[o + 6] = p[b + 2] - p[a + 2]; m[o + 7] = p[c + 2] - p[a + 2]; m[o + 8] = p[d + 2] - p[a + 2];
      }
      this.restDm = this.restDm0.slice();
      this.gradients0 = this.gradients.slice();
      this.plasticStrain = 0;
    }
    this.plastic = flow > 0 || recover > 0 ? { flow, recover, yieldStrain } : null;
    if (!this.plastic) { this.restDm.set(this.restDm0); this.gradients.set(this.gradients0); this.plasticStrain = 0; }
  }

  // Advance plastic flow by dt (call at ~30 Hz). Returns the mean deviation of
  // the rest shapes from the original (0 = original jelly).
  plasticStep(dt) {
    const P = this.plastic; if (!P || !this.restDm) return 0;
    const E = this.elementCount, x = this.x, ids = this.ids, g = this.gradients, M0 = this.restDm0, M = this.restDm;
    const kf = Math.min(0.5, P.flow * dt), kr = Math.min(0.5, P.recover * dt);
    const S = this.plasticScratch ||= { F: new Float64Array(9), R: new Float64Array(9), U: new Float64Array(9), N: new Float64Array(9), I: new Float64Array(9), D: new Float64Array(9) };
    const { F, R, U, N, I, D } = S;
    let dev = 0, ref = 0;
    for (let e = 0; e < E; e++) {
      const o = e * 9;
      if (kf > 0) {
        const a = ids[e * 4] * 3, b = ids[e * 4 + 1] * 3, c = ids[e * 4 + 2] * 3, d = ids[e * 4 + 3] * 3;
        D[0] = x[b] - x[a]; D[1] = x[c] - x[a]; D[2] = x[d] - x[a];
        D[3] = x[b + 1] - x[a + 1]; D[4] = x[c + 1] - x[a + 1]; D[5] = x[d + 1] - x[a + 1];
        D[6] = x[b + 2] - x[a + 2]; D[7] = x[c + 2] - x[a + 2]; D[8] = x[d + 2] - x[a + 2];
        if (!inv3into(M, o, I)) continue;
        mul3(D, I, F);
        if (!polar3(F, R, I)) continue;
        // U = Rᵀ F − I (right stretch, material frame); rest ← (I + kf·U) rest
        let un = 0;
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
          const u = R[i] * F[j] + R[3 + i] * F[3 + j] + R[6 + i] * F[6 + j] - (i === j ? 1 : 0);
          U[i * 3 + j] = u; un += u * u;
        }
        // Bingham-like yield: only the strain beyond the yield point flows.
        un = Math.sqrt(un);
        if (un > P.yieldStrain) {
          const k = kf * (un - P.yieldStrain) / un;
          for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
            N[i * 3 + j] = M[o + i * 3 + j] + k * (U[i * 3] * M[o + j] + U[i * 3 + 1] * M[o + 3 + j] + U[i * 3 + 2] * M[o + 6 + j]);
          }
        } else for (let k = 0; k < 9; k++) N[k] = M[o + k];
      } else for (let k = 0; k < 9; k++) N[k] = M[o + k];
      let diff = 0;
      for (let k = 0; k < 9; k++) { N[k] += (M0[o + k] - N[k]) * kr; diff += Math.abs(N[k] - M[o + k]); }
      if (diff > 1e-9) {
        const det0 = det3(M0, o), det = det3(N, 0);
        if (det > det0 * 0.05) {
          const sc = Math.cbrt(det0 / det);
          for (let k = 0; k < 9; k++) M[o + k] = N[k] * sc;
          if (inv3into(M, o, I)) {
            const go = e * 12;
            for (let k = 0; k < 3; k++) {
              g[go + 3 + k] = I[k]; g[go + 6 + k] = I[3 + k]; g[go + 9 + k] = I[6 + k];
              g[go + k] = -I[k] - I[3 + k] - I[6 + k];
            }
          }
        }
      }
      for (let k = 0; k < 9; k++) { dev += Math.abs(M[o + k] - M0[o + k]); ref += Math.abs(M0[o + k]); }
    }
    this.plasticStrain = ref > 0 ? dev / ref : 0;
    return this.plasticStrain;
  }

  // Bounce: an upward launch with a squash — the bottom pushes off harder
  // than the top, so the jelly stretches up and lands with a wobble.
  bounce(vy, vx = 0, vz = 0) {
    this.wake();
    const b = this.bounds, h = Math.max(1e-4, b[4] - b[1]);
    for (let i = 0; i < this.nodeCount; i++) {
      const j = i * 3, t = (this.x[j + 1] - b[1]) / h;
      this.velocity[j] += vx; this.velocity[j + 1] += vy * (1.12 - 0.24 * t); this.velocity[j + 2] += vz;
    }
  }

  isFinite() {
    for (let i = 0; i < this.x.length; i++) if (!Number.isFinite(this.x[i]) || !Number.isFinite(this.velocity[i]) || Math.abs(this.x[i]) > 3) return false;
    return true;
  }

  // Cage-node weights for a surface triangle hit (original beginGrab weight build).
  grabWeights(a, b, c, ba, bb, bc) {
    const { offsets, ids, weights } = this.stencils;
    const map = new Map();
    for (const [surfaceId, bary] of [[a, ba], [b, bb], [c, bc]]) {
      for (let k = offsets[surfaceId]; k < offsets[surfaceId + 1]; k++) {
        map.set(ids[k], (map.get(ids[k]) || 0) + weights[k] * bary);
      }
    }
    const list = [...map].filter(([, w]) => w > 1e-8);
    const sum = list.reduce((t, [, w]) => t + w, 0);
    if (!Number.isFinite(sum) || sum <= 0) return null;
    for (const pair of list) pair[1] /= sum;
    return { ids: Int32Array.from(list.map((p) => p[0])), weights: Float64Array.from(list.map((p) => p[1])) };
  }
}

// 3×3 row-major helpers for plasticity (allocation-free).
function det3(m, o) {
  return m[o] * (m[o + 4] * m[o + 8] - m[o + 5] * m[o + 7]) - m[o + 1] * (m[o + 3] * m[o + 8] - m[o + 5] * m[o + 6]) + m[o + 2] * (m[o + 3] * m[o + 7] - m[o + 4] * m[o + 6]);
}
function inv3into(m, o, out) {
  const a = m[o], b = m[o + 1], c = m[o + 2], d = m[o + 3], e = m[o + 4], f = m[o + 5], g = m[o + 6], h = m[o + 7], i = m[o + 8];
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g, det = a * A + b * B + c * C;
  if (!(Math.abs(det) > 1e-30)) return false;
  const s = 1 / det;
  out[0] = A * s; out[1] = (c * h - b * i) * s; out[2] = (b * f - c * e) * s;
  out[3] = B * s; out[4] = (a * i - c * g) * s; out[5] = (c * d - a * f) * s;
  out[6] = C * s; out[7] = (b * g - a * h) * s; out[8] = (a * e - b * d) * s;
  return true;
}
function mul3(a, b, out) {
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return out;
}
// Rotation of the polar decomposition F = R U (Higham iteration R ← ½(R + R⁻ᵀ)).
function polar3(F, R, tmp) {
  for (let k = 0; k < 9; k++) R[k] = F[k];
  for (let it = 0; it < 8; it++) {
    if (!inv3into(R, 0, tmp)) return false;
    let change = 0;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const next = 0.5 * (R[i * 3 + j] + tmp[j * 3 + i]);
      change += Math.abs(next - R[i * 3 + j]); R[i * 3 + j] = next;
    }
    if (change < 1e-5) break;
  }
  return true;
}

// Original updateGrabTarget(): eases the constraint target toward the finger.
export function easeGrabTarget(target, rawTarget, h) {
  const dx = rawTarget[0] - target[0], dy = rawTarget[1] - target[1], dz = rawTarget[2] - target[2];
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (distance > 0) {
    const s = Math.min(1 - Math.exp(-32 * h), 0.65 * h / distance);
    target[0] += dx * s; target[1] += dy * s; target[2] += dz * s;
  }
}

// Finger target limits. Without a tray this is the original ±0.13 m box; with a
// tray the horizontal target stays 8 mm inside the wall so a drag cannot crush
// the body against it.
export function clampGrabTarget(target, wallRadius = 0) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  let x = clamp(target[0], -0.13, 0.13), z = clamp(target[2], -0.13, 0.13);
  const y = clamp(target[1], 0.002, 0.145);
  if (wallRadius > 0) {
    const limit = wallRadius - 0.008, r = Math.hypot(x, z);
    if (r > limit) { x *= limit / r; z *= limit / r; }
  }
  target[0] = x; target[1] = y; target[2] = z;
  return target;
}
