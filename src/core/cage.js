// Flower-shaped tetrahedral cage and Loop-subdivision stencils.
// Geometry construction is copied from the threejs-awesome-graphics-agent-skills
// softbody-jelly example (MIT, Copyright (c) 2026 Scott Sun) without numeric
// changes; it is split out here so it can run inside a Web Worker without three.js.

export function determinant(a, b, c, d, e, f, g, h, i) {
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}

export function inverse3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const det = determinant(a, b, c, d, e, f, g, h, i);
  if (Math.abs(det) < 1e-24) throw new Error("Degenerate rest element.");
  const s = 1 / det;
  return [(e * i - f * h) * s, (c * h - b * i) * s, (b * f - c * e) * s,
    (f * g - d * i) * s, (a * i - c * g) * s, (c * d - a * f) * s,
    (d * h - e * g) * s, (b * g - a * h) * s, (a * e - b * d) * s];
}

// Default options reproduce the original flower exactly (golden tests). The app
// also builds a smaller two-jelly flower and a round "piece" blob from it.
export const FLOWER_DEFAULTS = Object.freeze({ latticeRadius: 6, layers: 5, radius: .032, base: .010, height: .042, dome: .0024, lobe5: .19, lobe10: .018, scale: 1 });

export function makeFlowerCage(options = {}) {
  const { latticeRadius, layers, radius: R, base: Y0, height: H, dome: D, lobe5: L5, lobe10: L10, scale } = { ...FLOWER_DEFAULTS, ...options };
  const planar = [], index = new Map(), ringOrder = new Map(), xyz = [], triangles = [], tets = [];
  const key = (q, r) => q + "," + r;

  for (let q = -latticeRadius; q <= latticeRadius; q++) for (let r = -latticeRadius; r <= latticeRadius; r++) {
    if (Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) > latticeRadius) continue;
    index.set(key(q, r), planar.length);
    planar.push([q, r]);
  }

  const walk = [[-1, 1], [-1, 0], [0, -1], [1, -1], [1, 0], [0, 1]];
  for (let ring = 1; ring <= latticeRadius; ring++) {
    let q = ring, r = 0, ordinal = 0;
    for (const [dq, dr] of walk) for (let step = 0; step < ring; step++) {
      ringOrder.set(key(q, r), [ring, ordinal++]);
      q += dq; r += dr;
    }
  }

  const neighbours = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]], triKeys = new Set();
  for (const [q, r] of planar) {
    const a = index.get(key(q, r));
    for (let k = 0; k < 6; k++) {
      const [dq0, dr0] = neighbours[k], [dq1, dr1] = neighbours[(k + 1) % 6];
      const kb = key(q + dq0, r + dr0), kc = key(q + dq1, r + dr1);
      if (!index.has(kb) || !index.has(kc)) continue;
      const tri = [a, index.get(kb), index.get(kc)], triKey = tri.slice().sort((x, y) => x - y).join(",");
      if (triKeys.has(triKey)) continue;
      triKeys.add(triKey); triangles.push(tri);
    }
  }

  const perLayer = planar.length;
  for (let layer = 0; layer <= layers; layer++) {
    const t = layer / layers, rounding = .88 + .12 * Math.pow(Math.sin(Math.PI * t), .6);
    for (const [q, r] of planar) {
      if (q === 0 && r === 0) { xyz.push(0, Y0 + t * H, 0); continue; }
      const [ring, ordinal] = ringOrder.get(key(q, r));
      const u = ring / latticeRadius, angle = ordinal / (6 * ring) * Math.PI * 2;
      const lobes = 1 + L5 * Math.cos(5 * angle) + L10 * Math.cos(10 * angle);
      const radius = R * u * lobes * rounding;
      xyz.push(radius * Math.cos(angle), Y0 + t * H + D * (1 - 2 * t) * Math.pow(u, 4), radius * Math.sin(angle));
    }
  }

  for (let l = 0; l < layers; l++) for (const tri of triangles) {
    const sorted = tri.slice().sort((a, b) => a - b);
    const [a, b, c] = sorted.map((v) => v + l * perLayer);
    const A = a + perLayer, B = b + perLayer, C = c + perLayer;
    tets.push([a, b, c, C], [a, b, B, C], [a, A, B, C]);
  }
  if (scale !== 1) for (let i = 0; i < xyz.length; i++) xyz[i] *= scale;
  const pos = new Float64Array(xyz), faceMap = new Map();
  let totalVolume = 0;
  for (const tet of tets) {
    const [a, b, c, d] = tet.map((v) => v * 3);
    let det = determinant(
      pos[b] - pos[a], pos[c] - pos[a], pos[d] - pos[a],
      pos[b + 1] - pos[a + 1], pos[c + 1] - pos[a + 1], pos[d + 1] - pos[a + 1],
      pos[b + 2] - pos[a + 2], pos[c + 2] - pos[a + 2], pos[d + 2] - pos[a + 2],
    );
    if (det < 0) { [tet[1], tet[2]] = [tet[2], tet[1]]; det = -det; }
    if (det < 1e-13 * scale * scale * scale) throw new Error("Invalid tetrahedralisation.");
    totalVolume += det / 6;
    const [ta, tb, tc, td] = tet;
    for (const f of [[ta, tc, tb], [ta, tb, td], [ta, td, tc], [tb, tc, td]]) {
      const fk = f.slice().sort((x, y) => x - y).join(",");
      if (faceMap.has(fk)) faceMap.delete(fk); else faceMap.set(fk, f);
    }
  }
  const boundary = [...faceMap.values()];
  const edgeCounts = new Map();
  for (const f of boundary) for (let i = 0; i < 3; i++) {
    const a = f[i], b = f[(i + 1) % 3], ek = Math.min(a, b) + "," + Math.max(a, b);
    edgeCounts.set(ek, (edgeCounts.get(ek) || 0) + 1);
  }
  if ([...edgeCounts.values()].some((v) => v !== 2)) throw new Error("The optical surface must be watertight.");
  return { pos, tets, boundary, totalVolume };
}

// Point location in the undeformed cage: a uniform grid of tetrahedra plus each
// tet's inverse edge matrix, so barycentric coordinates are one 3x3 multiply.
export function makeTetLocator(cage, cell = 0.004) {
  const pos = cage.pos, tets = cage.tets, n = tets.length;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    minX = Math.min(minX, pos[i]); maxX = Math.max(maxX, pos[i]);
    minY = Math.min(minY, pos[i + 1]); maxY = Math.max(maxY, pos[i + 1]);
    minZ = Math.min(minZ, pos[i + 2]); maxZ = Math.max(maxZ, pos[i + 2]);
  }
  const nx = Math.max(1, Math.ceil((maxX - minX) / cell)), ny = Math.max(1, Math.ceil((maxY - minY) / cell)), nz = Math.max(1, Math.ceil((maxZ - minZ) / cell));
  const inv = new Float64Array(n * 9), cells = Array.from({ length: nx * ny * nz }, () => []);
  for (let e = 0; e < n; e++) {
    const [a, b, c, d] = tets[e].map((v) => v * 3);
    const m = inverse3([pos[b] - pos[a], pos[c] - pos[a], pos[d] - pos[a], pos[b + 1] - pos[a + 1], pos[c + 1] - pos[a + 1], pos[d + 1] - pos[a + 1], pos[b + 2] - pos[a + 2], pos[c + 2] - pos[a + 2], pos[d + 2] - pos[a + 2]]);
    inv.set(m, e * 9);
    let lx = Infinity, ly = Infinity, lz = Infinity, hx = -Infinity, hy = -Infinity, hz = -Infinity;
    for (const q of [a, b, c, d]) { lx = Math.min(lx, pos[q]); hx = Math.max(hx, pos[q]); ly = Math.min(ly, pos[q + 1]); hy = Math.max(hy, pos[q + 1]); lz = Math.min(lz, pos[q + 2]); hz = Math.max(hz, pos[q + 2]); }
    const i0 = Math.max(0, Math.floor((lx - minX) / cell)), i1 = Math.min(nx - 1, Math.floor((hx - minX) / cell));
    const j0 = Math.max(0, Math.floor((ly - minY) / cell)), j1 = Math.min(ny - 1, Math.floor((hy - minY) / cell));
    const k0 = Math.max(0, Math.floor((lz - minZ) / cell)), k1 = Math.min(nz - 1, Math.floor((hz - minZ) / cell));
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (let k = k0; k <= k1; k++) cells[(i * ny + j) * nz + k].push(e);
  }
  const offsets = new Int32Array(cells.length + 1);
  for (let i = 0; i < cells.length; i++) offsets[i + 1] = offsets[i] + cells[i].length;
  const list = new Int32Array(offsets[cells.length]);
  for (let i = 0; i < cells.length; i++) list.set(cells[i], offsets[i]);
  const ids = new Int32Array(n * 4);
  for (let e = 0; e < n; e++) for (let v = 0; v < 4; v++) ids[e * 4 + v] = tets[e][v];
  const bary = new Float64Array(4);
  return {
    bounds: [minX, minY, minZ, maxX, maxY, maxZ], ids, bary,
    // Returns the tet index containing (x,y,z) (barycentrics in .bary) or -1.
    locate(x, y, z, eps = 1e-9) {
      const i = Math.floor((x - minX) / cell), j = Math.floor((y - minY) / cell), k = Math.floor((z - minZ) / cell);
      if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return -1;
      const c = (i * ny + j) * nz + k;
      for (let q = offsets[c]; q < offsets[c + 1]; q++) {
        const e = list[q], o = e * 9, a = ids[e * 4] * 3;
        const dx = x - pos[a], dy = y - pos[a + 1], dz = z - pos[a + 2];
        const l1 = inv[o] * dx + inv[o + 1] * dy + inv[o + 2] * dz;
        const l2 = inv[o + 3] * dx + inv[o + 4] * dy + inv[o + 5] * dz;
        const l3 = inv[o + 6] * dx + inv[o + 7] * dy + inv[o + 8] * dz;
        const l0 = 1 - l1 - l2 - l3;
        if (l0 >= -eps && l1 >= -eps && l2 >= -eps && l3 >= -eps) { bary[0] = l0; bary[1] = l1; bary[2] = l2; bary[3] = l3; return e; }
      }
      return -1;
    },
  };
}

// Two Loop-subdivision passes expressed as weighted stencils over cage nodes,
// then flattened into CSR arrays so the per-frame evaluation allocates nothing.
export function makeSurfaceStencils(cage) {
  const cageIds = [...new Set(cage.boundary.flat())];
  const local = new Map(cageIds.map((v, i) => [v, i]));
  let faces = cage.boundary.map((f) => f.map((v) => local.get(v)));
  let stencils = cageIds.map((v) => [[v, 1]]);

  const blendStencil = (terms) => {
    const weights = new Map();
    for (const [stencil, scale] of terms) for (const [id, w] of stencil)
      weights.set(id, (weights.get(id) || 0) + w * scale);
    return [...weights].filter(([, w]) => Math.abs(w) > 1e-12);
  };

  const subdivide = () => {
    const neighbours = stencils.map(() => new Set()), edges = new Map();
    for (const f of faces) for (let i = 0; i < 3; i++) {
      const a = f[i], b = f[(i + 1) % 3], opposite = f[(i + 2) % 3];
      neighbours[a].add(b); neighbours[b].add(a);
      const ek = Math.min(a, b) + "," + Math.max(a, b);
      if (!edges.has(ek)) edges.set(ek, { a: Math.min(a, b), b: Math.max(a, b), op: [] });
      edges.get(ek).op.push(opposite);
    }
    const next = stencils.map((stencil, i) => {
      const n = neighbours[i].size;
      const beta = (5 / 8 - Math.pow(3 / 8 + Math.cos(2 * Math.PI / n) / 4, 2)) / n;
      return blendStencil([[stencil, 1 - n * beta], ...[...neighbours[i]].map((j) => [stencils[j], beta])]);
    });
    for (const edge of edges.values()) {
      if (edge.op.length !== 2) throw new Error("Non-manifold subdivision edge.");
      edge.index = next.length;
      next.push(blendStencil([[stencils[edge.a], 3 / 8], [stencils[edge.b], 3 / 8],
        [stencils[edge.op[0]], 1 / 8], [stencils[edge.op[1]], 1 / 8]]));
    }
    const edgeIndex = (a, b) => edges.get(Math.min(a, b) + "," + Math.max(a, b)).index;
    const nextFaces = [];
    for (const [a, b, c] of faces) {
      const ab = edgeIndex(a, b), bc = edgeIndex(b, c), ca = edgeIndex(c, a);
      nextFaces.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    stencils = next; faces = nextFaces;
  };
  subdivide();
  subdivide();

  const vertexCount = stencils.length;
  const offsets = new Uint32Array(vertexCount + 1);
  let total = 0;
  for (let i = 0; i < vertexCount; i++) { offsets[i] = total; total += stencils[i].length; }
  offsets[vertexCount] = total;
  const ids = new Uint32Array(total), weights = new Float64Array(total);
  for (let i = 0, k = 0; i < vertexCount; i++) for (const [id, w] of stencils[i]) { ids[k] = id; weights[k] = w; k++; }
  const indices = new Uint32Array(faces.flat());
  return { vertexCount, offsets, ids, weights, indices };
}

// Evaluates stencils into Float32 positions; same accumulation order as the original.
export function evaluateSurface(stencils, x, positions) {
  const { vertexCount, offsets, ids, weights } = stencils;
  for (let i = 0; i < vertexCount; i++) {
    let px = 0, py = 0, pz = 0;
    for (let k = offsets[i], end = offsets[i + 1]; k < end; k++) {
      const j = ids[k] * 3, w = weights[k];
      px += x[j] * w; py += x[j + 1] * w; pz += x[j + 2] * w;
    }
    positions[3 * i] = px; positions[3 * i + 1] = py; positions[3 * i + 2] = pz;
  }
}

// Mirrors BufferGeometry.computeVertexNormals() for indexed geometry, including
// its per-face Float32 accumulation, so optics see the same normals as three.js.
export function computeVertexNormals(positions, indices, normals) {
  normals.fill(0);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const cbx = positions[c] - bx, cby = positions[c + 1] - by, cbz = positions[c + 2] - bz;
    const abx = positions[a] - bx, aby = positions[a + 1] - by, abz = positions[a + 2] - bz;
    const nx = cby * abz - cbz * aby, ny = cbz * abx - cbx * abz, nz = cbx * aby - cby * abx;
    normals[a] += nx; normals[a + 1] += ny; normals[a + 2] += nz;
    normals[b] += nx; normals[b + 1] += ny; normals[b + 2] += nz;
    normals[c] += nx; normals[c + 1] += ny; normals[c + 2] += nz;
  }
  for (let i = 0; i < normals.length; i += 3) {
    const x = normals[i], y = normals[i + 1], z = normals[i + 2];
    const length = Math.sqrt(x * x + y * y + z * z);
    const s = 1 / (length || 1);
    normals[i] = x * s; normals[i + 1] = y * s; normals[i + 2] = z * s;
  }
}

export function computeBounds(positions, out) {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  out[0] = minX; out[1] = minY; out[2] = minZ; out[3] = maxX; out[4] = maxY; out[5] = maxZ;
  return out;
}
