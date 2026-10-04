// CPU optics for the jelly receiver: refractive shadow/contact field and
// view-dependent optical thickness. Ported from RefractiveLightField and
// SurfaceBVH in the softbody-jelly example (MIT, Copyright (c) 2026 Scott Sun).
// Same arithmetic and traversal order; closures, per-triangle arrays and
// recursive traversal are replaced by flat arrays and an explicit stack.
// tests/optics.test.mjs compares the output with the original.

export const LIGHT_DIRECTION = (() => {
  const x = -0.6123724357, y = -0.5, z = 0.6123724357;
  // Vector3.normalize() multiplies by the reciprocal length.
  const s = 1 / (Math.sqrt(x * x + y * y + z * z) || 1);
  return [x * s, y * s, z * s];
})();

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

export class SurfaceBVH {
  constructor(positions, indices) {
    this.p = positions; this.index = indices;
    const triCount = indices.length / 3;
    const centroids = new Float32Array(indices.length);
    for (let t = 0; t < triCount; t++) for (let axis = 0; axis < 3; axis++) {
      centroids[t * 3 + axis] = (positions[indices[t * 3] * 3 + axis] + positions[indices[t * 3 + 1] * 3 + axis] + positions[indices[t * 3 + 2] * 3 + axis]) / 3;
    }
    // Build with the original median split, then flatten (depth-first, left first).
    const nodes = [];
    const build = (ids) => {
      const node = { left: null, right: null, ids: null };
      if (ids.length <= 8) node.ids = ids;
      else {
        const ranges = [0, 1, 2].map((axis) => {
          let lo = Infinity, hi = -Infinity; for (const id of ids) { const x = centroids[id * 3 + axis]; lo = Math.min(lo, x); hi = Math.max(hi, x); } return hi - lo;
        });
        const axis = ranges.indexOf(Math.max(...ranges));
        ids.sort((a, b) => centroids[a * 3 + axis] - centroids[b * 3 + axis]);
        const mid = ids.length >> 1; node.left = build(ids.slice(0, mid)); node.right = build(ids.slice(mid));
      }
      return node;
    };
    const root = build(Array.from({ length: triCount }, (_, i) => i));
    const order = [];
    const flatten = (node) => { const id = order.length; order.push(node); node.id = id; if (!node.ids) { flatten(node.left); flatten(node.right); } };
    flatten(root);
    const n = order.length;
    this.nodeCount = n;
    this.left = new Int32Array(n).fill(-1); this.right = new Int32Array(n).fill(-1);
    this.first = new Int32Array(n); this.count = new Int32Array(n);
    const leafTris = [];
    for (const node of order) {
      if (node.ids) { this.first[node.id] = leafTris.length; this.count[node.id] = node.ids.length; leafTris.push(...node.ids); }
      else { this.left[node.id] = node.left.id; this.right[node.id] = node.right.id; }
    }
    this.leafTris = Int32Array.from(leafTris);
    this.min = new Float64Array(n * 3); this.max = new Float64Array(n * 3);
    this.stack = new Int32Array(128);
    this.result = { t: -1, u: 0, v: 0, distance: 0 };
    this.refit();
  }

  refit() {
    const p = this.p, ix = this.index, min = this.min, max = this.max;
    // Children always have larger ids than parents, so a reverse sweep is post-order.
    for (let node = this.nodeCount - 1; node >= 0; node--) {
      const o = node * 3;
      if (this.left[node] < 0) {
        let mn0 = Infinity, mn1 = Infinity, mn2 = Infinity, mx0 = -Infinity, mx1 = -Infinity, mx2 = -Infinity;
        for (let k = this.first[node], end = k + this.count[node]; k < end; k++) {
          const t = this.leafTris[k];
          for (let c = 0; c < 3; c++) {
            const b = ix[t * 3 + c] * 3, x = p[b], y = p[b + 1], z = p[b + 2];
            mn0 = Math.min(mn0, x); mx0 = Math.max(mx0, x);
            mn1 = Math.min(mn1, y); mx1 = Math.max(mx1, y);
            mn2 = Math.min(mn2, z); mx2 = Math.max(mx2, z);
          }
        }
        min[o] = mn0; min[o + 1] = mn1; min[o + 2] = mn2; max[o] = mx0; max[o + 1] = mx1; max[o + 2] = mx2;
      } else {
        const l = this.left[node] * 3, r = this.right[node] * 3;
        for (let a = 0; a < 3; a++) { min[o + a] = Math.min(min[l + a], min[r + a]); max[o + a] = Math.max(max[l + a], max[r + a]); }
      }
    }
  }

  // Nearest hit beyond 1e-7; returns this.result (reused) or null.
  hit(ox, oy, oz, dx, dy, dz, maxDistance = Infinity) {
    const p = this.p, ix = this.index, min = this.min, max = this.max, stack = this.stack;
    let nearest = maxDistance, found = false, ht = 0, hu = 0, hv = 0;
    let sp = 0; stack[sp++] = 0;
    const adx = Math.abs(dx) < 1e-12, ady = Math.abs(dy) < 1e-12, adz = Math.abs(dz) < 1e-12;
    while (sp > 0) {
      const node = stack[--sp], o = node * 3;
      // slab test with the current nearest distance (original box())
      let lo = 0, hi = nearest, t0, t1, tmp;
      if (adx) { if (ox < min[o] || ox > max[o]) continue; }
      else { t0 = (min[o] - ox) / dx; t1 = (max[o] - ox) / dx; if (t0 > t1) { tmp = t0; t0 = t1; t1 = tmp; } lo = Math.max(lo, t0); hi = Math.min(hi, t1); if (hi < lo) continue; }
      if (ady) { if (oy < min[o + 1] || oy > max[o + 1]) continue; }
      else { t0 = (min[o + 1] - oy) / dy; t1 = (max[o + 1] - oy) / dy; if (t0 > t1) { tmp = t0; t0 = t1; t1 = tmp; } lo = Math.max(lo, t0); hi = Math.min(hi, t1); if (hi < lo) continue; }
      if (adz) { if (oz < min[o + 2] || oz > max[o + 2]) continue; }
      else { t0 = (min[o + 2] - oz) / dz; t1 = (max[o + 2] - oz) / dz; if (t0 > t1) { tmp = t0; t0 = t1; t1 = tmp; } lo = Math.max(lo, t0); hi = Math.min(hi, t1); if (hi < lo) continue; }
      const left = this.left[node];
      if (left >= 0) { stack[sp++] = this.right[node]; stack[sp++] = left; continue; }
      for (let k = this.first[node], end = k + this.count[node]; k < end; k++) {
        const t = this.leafTris[k];
        const a = ix[t * 3] * 3, b = ix[t * 3 + 1] * 3, c = ix[t * 3 + 2] * 3;
        const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
        const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
        const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
        const det = e1x * hx + e1y * hy + e1z * hz; if (Math.abs(det) < 1e-14) continue;
        const inv = 1 / det, sx = ox - p[a], sy = oy - p[a + 1], sz = oz - p[a + 2];
        const u = (sx * hx + sy * hy + sz * hz) * inv; if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv; if (v < 0 || u + v > 1) continue;
        const distance = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (distance > 1e-7 && distance < nearest) { nearest = distance; found = true; ht = t; hu = u; hv = v; }
      }
    }
    if (!found) return null;
    const r = this.result; r.t = ht; r.u = hu; r.v = hv; r.distance = nearest;
    return r;
  }
}

export class ReceiverOptics {
  constructor(positions, normals, indices, size = 192) {
    this.p = positions; this.n = normals; this.indices = indices;
    this.size = size; this.span = .22; this.minSpan = .22; this.maxSpan = .75;
    this.origin = [0, 0];
    this.bvh = new SurfaceBVH(positions, indices);
    this.shadow = new Float32Array(size * size);
    this.contact = new Float32Array(size * size);
    this.blurScratch = new Float32Array(size * size);
    this.shadowBytes = new Uint8Array(size * size * 4);
    this.thickness = new Float32Array(positions.length / 3).fill(.03);
  }

  rasterTriangle(ax0, ay0, bx0, by0, cx0, cy0, buffer, value) {
    const n = this.size, scale = n / this.span, ox = this.origin[0], oy = this.origin[1];
    const ax = (ax0 - ox) * scale, ay = (ay0 - oy) * scale;
    const bx = (bx0 - ox) * scale, by = (by0 - oy) * scale;
    const cx = (cx0 - ox) * scale, cy = (cy0 - oy) * scale;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax); if (Math.abs(area) < 1e-9) return;
    const minX = clamp(Math.floor(Math.min(ax, bx, cx)), 0, n - 1), maxX = clamp(Math.ceil(Math.max(ax, bx, cx)), 0, n - 1);
    const minY = clamp(Math.floor(Math.min(ay, by, cy)), 0, n - 1), maxY = clamp(Math.ceil(Math.max(ay, by, cy)), 0, n - 1);
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const px = x + .5, py = y + .5;
      const u = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area;
      const v = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area;
      if (u >= 0 && v >= 0 && u + v <= 1) { const i = y * n + x; if (value > buffer[i]) buffer[i] = value; }
    }
  }

  blur(buffer) {
    const n = this.size, tmp = this.blurScratch;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      let sum = 0; for (let k = -2; k <= 2; k++) sum += buffer[y * n + clamp(x + k, 0, n - 1)] * (3 - Math.abs(k)); tmp[y * n + x] = sum / 9;
    }
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      let sum = 0; for (let k = -2; k <= 2; k++) sum += tmp[clamp(y + k, 0, n - 1) * n + x] * (3 - Math.abs(k)); buffer[y * n + x] = sum / 9;
    }
  }

  clearTextureBorder(bytes, pixels = 2) {
    const n = this.size;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      if (x >= pixels && x < n - pixels && y >= pixels && y < n - pixels) continue;
      const i = (y * n + x) * 4; bytes[i] = bytes[i + 1] = bytes[i + 2] = 0; bytes[i + 3] = 255;
    }
  }

  // Original update(): refit, fit the field to the footprint, raster shadow and contact.
  updateReceiver() {
    this.bvh.refit(); this.shadow.fill(0); this.contact.fill(0);
    const D0 = LIGHT_DIRECTION[0], D1 = LIGHT_DIRECTION[1], D2 = LIGHT_DIRECTION[2];
    const p = this.p, ix = this.indices;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i], y = p[i + 1], z = p[i + 2];
      const sx = x - y * D0 / D1, sz = z - y * D2 / D1;
      minX = Math.min(minX, x, sx); maxX = Math.max(maxX, x, sx);
      minZ = Math.min(minZ, z, sz); maxZ = Math.max(maxZ, z, sz);
    }
    const guard = .030;
    const required = Math.max(maxX - minX, maxZ - minZ) + guard * 2;
    this.span = clamp(required, this.minSpan, this.maxSpan);
    const centerX = (minX + maxX) / 2, centerZ = (minZ + maxZ) / 2;
    this.origin[0] = centerX - this.span / 2; this.origin[1] = centerZ - this.span / 2;
    for (let t = 0; t < ix.length; t += 3) {
      const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
      this.rasterTriangle(
        p[a] - p[a + 1] * D0 / D1, p[a + 2] - p[a + 1] * D2 / D1,
        p[b] - p[b + 1] * D0 / D1, p[b + 2] - p[b + 1] * D2 / D1,
        p[c] - p[c + 1] * D0 / D1, p[c + 2] - p[c + 1] * D2 / D1,
        this.shadow, 1);
      const height = (p[a + 1] + p[b + 1] + p[c + 1]) / 3;
      if (height < .016) this.rasterTriangle(p[a], p[a + 2], p[b], p[b + 2], p[c], p[c + 2], this.contact, Math.exp(-height / .0028));
    }
    this.blur(this.shadow); this.blur(this.contact);
    const bytes = this.shadowBytes;
    for (let i = 0; i < this.size * this.size; i++) {
      bytes[i * 4] = Math.round(this.shadow[i] * 255);
      bytes[i * 4 + 1] = Math.round(this.contact[i] * 255);
      bytes[i * 4 + 2] = 0; bytes[i * 4 + 3] = 255;
    }
    this.clearTextureBorder(bytes);
  }

  // Original updateViewThickness(camera): refract into the body, trace the first interior hit.
  updateViewThickness(camX, camY, camZ) {
    const p = this.p, n = this.n, thickness = this.thickness;
    const n1 = 1, n2 = 1.35, eta = n1 / n2;
    for (let i = 0; i < p.length; i += 3) {
      let dx = p[i] - camX, dy = p[i + 1] - camY, dz = p[i + 2] - camZ;
      const length = Math.hypot(dx, dy, dz) || 1; dx /= length; dy /= length; dz /= length;
      const nx = n[i], ny = n[i + 1], nz = n[i + 2];
      if (dx * nx + dy * ny + dz * nz > -.01) continue;
      // refractRay(d, n, 1, 1.35) direction only
      const cosine = clamp(-(dx * nx + dy * ny + dz * nz), 0, 1);
      const k = 1 - eta * eta * (1 - cosine * cosine);
      if (k < 0) continue;
      const ct = Math.sqrt(k), a = eta * cosine - ct;
      const rx = eta * dx + a * nx, ry = eta * dy + a * ny, rz = eta * dz + a * nz;
      const hit = this.bvh.hit(p[i] + rx * 2e-6, p[i + 1] + ry * 2e-6, p[i + 2] + rz * 2e-6, rx, ry, rz);
      thickness[i / 3] = hit ? clamp(hit.distance, .0002, .16) : .002;
    }
  }
}
