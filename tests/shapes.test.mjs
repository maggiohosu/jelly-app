// Jelly shapes (src/core/shapes.js + shape-mesher.js): cage validity and
// budgets, signature looks and decorations, and the real SoftBody under the
// app's stresses (drop, drag, bites, slime, carry) for every shape.
import { SHAPES, makeShapeCage, shapeLook, shapeStats, buildShapeCage, signatureSigma, shapeMotions, motionWeight } from "../src/core/shapes.js";
import { makeFlowerCage, makeSurfaceStencils, makeTetLocator, evaluateSurface, computeVertexNormals } from "../src/core/cage.js";
import { SoftBody, easeGrabTarget, clampGrabTarget } from "../src/core/softbody.js";
import { tetDihedrals, tetAspect, checkManifold } from "../src/core/shape-mesher.js";
import { BITE } from "../src/core/world.js";

let failures = 0;
const check = (label, ok, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`); };
const mm = (v) => (v * 1000).toFixed(1);
const H = 1 / 240, WALL = 0.075;
const NEW = SHAPES.filter((s) => s.id !== "flower").map((s) => s.id);

// ---------------------------------------------------------------- contract
const want = [["flower", "꽃", 1], ["pudding", "푸딩", 2], ["cake", "케이크", 4], ["bear", "곰젤리", 6], ["cat", "고양이", 8], ["bird", "새", 10]];
check("SHAPES lists the six shapes with labels and unlock levels", SHAPES.length === 6 && want.every(([id, label, level], i) => SHAPES[i].id === id && SHAPES[i].label === label && SHAPES[i].level === level));
check("SHAPES and its entries are frozen", Object.isFrozen(SHAPES) && SHAPES.every(Object.isFrozen));
{
  const a = makeShapeCage("flower"), b = makeFlowerCage();
  const same = a.pos.length === b.pos.length && a.pos.every((v, i) => Object.is(v, b.pos[i]))
    && JSON.stringify(a.tets) === JSON.stringify(b.tets) && JSON.stringify(a.boundary) === JSON.stringify(b.boundary) && a.totalVolume === b.totalVolume;
  check("flower is makeFlowerCage() bit for bit", same);
  const L = shapeLook("flower");
  check("flower look is plain", L.dye === null && L.fx === null && L.glitter === 0 && L.pearls === 0 && Array.isArray(L.decor) && L.decor.length === 0);
}
check("cages are cached per id", NEW.every((id) => makeShapeCage(id) === makeShapeCage(id)));
check("unknown shape ids throw", (() => { try { makeShapeCage("nope"); return false; } catch { return true; } })());

// ---------------------------------------------------------------- geometry helpers
function closestOnTri(px, py, pz, P, a, b, c) {
  // Ericson, returns squared distance and the point
  const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
  const abx = P[b * 3] - ax, aby = P[b * 3 + 1] - ay, abz = P[b * 3 + 2] - az;
  const acx = P[c * 3] - ax, acy = P[c * 3 + 1] - ay, acz = P[c * 3 + 2] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let v = 0, w = 0;
  const bpx = px - P[b * 3], bpy = py - P[b * 3 + 1], bpz = pz - P[b * 3 + 2];
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  const cpx = px - P[c * 3], cpy = py - P[c * 3 + 1], cpz = pz - P[c * 3 + 2];
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
  if (d1 <= 0 && d2 <= 0) { v = 0; w = 0; }
  else if (d3 >= 0 && d4 <= d3) { v = 1; w = 0; }
  else if (vc <= 0 && d1 >= 0 && d3 <= 0) { v = d1 / (d1 - d3); w = 0; }
  else if (d6 >= 0 && d5 <= d6) { v = 0; w = 1; }
  else if (vb <= 0 && d2 >= 0 && d6 <= 0) { v = 0; w = d2 / (d2 - d6); }
  else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); v = 1 - w; }
  else { const den = 1 / (va + vb + vc); v = vb * den; w = vc * den; }
  const qx = ax + abx * v + acx * w, qy = ay + aby * v + acy * w, qz = az + abz * v + acz * w;
  return { d2: (qx - px) ** 2 + (qy - py) ** 2 + (qz - pz) ** 2, u: 1 - v - w, v, w };
}
function nearestOnMesh(p, P, tris) {
  let best = null;
  for (let t = 0; t < tris.length; t += 3) {
    const r = closestOnTri(p[0], p[1], p[2], P, tris[t], tris[t + 1], tris[t + 2]);
    if (!best || r.d2 < best.d2) { best = r; best.t = t; }
  }
  return best;
}
const det6 = (P, a, b, c, d) => {
  const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
  const bx = P[b * 3] - ax, by = P[b * 3 + 1] - ay, bz = P[b * 3 + 2] - az;
  const cx = P[c * 3] - ax, cy = P[c * 3 + 1] - ay, cz = P[c * 3 + 2] - az;
  const dx = P[d * 3] - ax, dy = P[d * 3 + 1] - ay, dz = P[d * 3 + 2] - az;
  return bx * (cy * dz - cz * dy) - cx * (by * dz - bz * dy) + dx * (by * cz - bz * cy);
};
const faceKey = (f) => f.slice().sort((x, y) => x - y).join(",");

// ---------------------------------------------------------------- cage validity + budgets
const flowerCage = makeFlowerCage();
const flowerFaces = flowerCage.boundary.length;
const flowerLightest = (() => {
  const P = flowerCage.pos, n = P.length / 3, vol = new Float64Array(n);
  for (const t of flowerCage.tets) { const v = det6(P, ...t) / 24; for (const w of t) vol[w] += v; }
  return Math.min(...vol) / (flowerCage.totalVolume / n);
})();
for (const id of NEW) {
  const t0 = performance.now();
  const cage = buildShapeCage(id);
  const buildMs = performance.now() - t0;
  const ref = makeShapeCage(id);
  check(`${id}: deterministic (a fresh build is bit-identical)`, cage.pos.length === ref.pos.length && cage.pos.every((v, i) => Object.is(v, ref.pos[i])) && JSON.stringify(cage.tets) === JSON.stringify(ref.tets), `${buildMs.toFixed(0)} ms`);
  const { pos, tets, boundary } = ref;
  const n = pos.length / 3;
  check(`${id}: structure`, pos instanceof Float64Array && Array.isArray(tets) && Array.isArray(boundary) && tets.every((t) => t.length === 4 && t.every((v) => Number.isInteger(v) && v >= 0 && v < n)) && pos.every(Number.isFinite));

  // positive tets, volume bookkeeping
  let vol = 0, minDet = Infinity;
  for (const t of tets) { const d = det6(pos, ...t); minDet = Math.min(minDet, d); vol += d / 6; }
  check(`${id}: every tet positively oriented`, minDet > 0, `min 6V ${minDet.toExponential(2)} m³`);
  check(`${id}: totalVolume is the sum of the tets`, Math.abs(vol - ref.totalVolume) < 1e-12 * Math.max(1, vol) + 1e-15);

  // boundary = unshared tet faces, outward, closed 2-manifold, genus 0
  const faces = new Map();
  for (const [a, b, c, d] of tets) for (const f of [[a, c, b], [a, b, d], [a, d, c], [b, c, d]]) { const k = faceKey(f); if (faces.has(k)) faces.delete(k); else faces.set(k, f); }
  const fromTets = new Set(faces.keys()), given = new Set(boundary.map(faceKey));
  check(`${id}: boundary is exactly the unshared tet faces`, fromTets.size === given.size && [...given].every((k) => fromTets.has(k)) && boundary.length === given.size);
  const sameOrientation = boundary.every((f) => { const g = faces.get(faceKey(f)); if (!g) return false; const i = g.indexOf(f[0]); return g[(i + 1) % 3] === f[1]; });
  check(`${id}: boundary faces keep the tets' outward orientation`, sameOrientation);
  let fluxVol = 0;
  for (const [a, b, c] of boundary) fluxVol += (pos[a * 3] * (pos[b * 3 + 1] * pos[c * 3 + 2] - pos[b * 3 + 2] * pos[c * 3 + 1]) - pos[a * 3 + 1] * (pos[b * 3] * pos[c * 3 + 2] - pos[b * 3 + 2] * pos[c * 3]) + pos[a * 3 + 2] * (pos[b * 3] * pos[c * 3 + 1] - pos[b * 3 + 1] * pos[c * 3])) / 6;
  check(`${id}: boundary encloses the tet volume (outward)`, Math.abs(fluxVol - ref.totalVolume) < 1e-9 * 1e-6 + 1e-6 * ref.totalVolume, `${(fluxVol * 1e6).toFixed(3)} vs ${(ref.totalVolume * 1e6).toFixed(3)} cm³`);
  const defects = checkManifold(boundary);
  const bVerts = new Set(boundary.flat()), edgeSet = new Set();
  for (const [a, b, c] of boundary) for (const [u, v] of [[a, b], [b, c], [c, a]]) edgeSet.add(Math.min(u, v) + "," + Math.max(u, v));
  const euler = bVerts.size - edgeSet.size + boundary.length;
  check(`${id}: watertight closed 2-manifold boundary of genus 0`, defects.length === 0 && euler === 2, `${defects.length} defects, χ = ${euler}`);

  // connectivity, all nodes used
  const used = new Uint8Array(n);
  for (const t of tets) for (const v of t) used[v] = 1;
  check(`${id}: every node belongs to a tet`, used.every((u) => u === 1));
  const parent = tets.map((_, i) => i), find = (x) => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
  const owner = new Map();
  tets.forEach((t, e) => { for (const f of [[t[0], t[1], t[2]], [t[0], t[1], t[3]], [t[0], t[2], t[3]], [t[1], t[2], t[3]]]) { const k = faceKey(f); if (owner.has(k)) { const r1 = find(owner.get(k)), r2 = find(e); if (r1 !== r2) parent[r1] = r2; } else owner.set(k, e); } });
  const roots = new Set(tets.map((_, e) => find(e)));
  check(`${id}: one face-connected piece`, roots.size === 1, `${roots.size} components`);

  // quality
  let minDih = 180, maxDih = 0, worstAspect = 0;
  const tmp = [0, 0];
  for (const t of tets) { tetDihedrals(pos, ...t, tmp); minDih = Math.min(minDih, tmp[0]); maxDih = Math.max(maxDih, tmp[1]); worstAspect = Math.max(worstAspect, tetAspect(pos, ...t)); }
  check(`${id}: tet quality (min dihedral ≥ 12°, max ≤ 165°, aspect ≤ 10)`, minDih >= 12 && maxDih <= 165 && worstAspect <= 10, `dihedral ${minDih.toFixed(1)}–${maxDih.toFixed(1)}°, worst aspect ${worstAspect.toFixed(2)}`);
  // node masses (lumped tet volume): a near-massless node cannot be grabbed and stalls the solver
  const nodeVol = new Float64Array(n);
  for (const t of tets) { const v = det6(pos, ...t) / 24; for (const w of t) nodeVol[w] += v; }
  const lightest = Math.min(...nodeVol) / (ref.totalVolume / n);
  check(`${id}: no near-massless nodes (lightest ≥ 2 % of the mean node mass)`, lightest >= 0.02, `${(lightest * 100).toFixed(1)} % (flower ${(flowerLightest * 100).toFixed(1)} %)`);

  // budgets
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity, rMax = 0;
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    rMax = Math.max(rMax, Math.hypot(x, z));
  }
  const stencils = makeSurfaceStencils(ref);
  check(`${id}: node / tet / face budget`, n >= 500 && n <= 950 && tets.length <= 3800 && boundary.length <= 1300 && stencils.vertexCount <= 11000,
    `${n} nodes, ${tets.length} tets, ${boundary.length} faces → ${stencils.vertexCount} render verts (flower ${flowerCage.pos.length / 3}/${flowerCage.tets.length}/${flowerFaces})`);
  check(`${id}: volume 95–135 cm³`, ref.totalVolume >= 95e-6 && ref.totalVolume <= 135e-6, `${(ref.totalVolume * 1e6).toFixed(1)} cm³ (flower ${(flowerCage.totalVolume * 1e6).toFixed(1)})`);
  check(`${id}: footprint ≤ 44 mm radius, height ≤ 62 mm, bottom at 10 mm`, rMax <= 0.044 && y1 - y0 <= 0.062 && y0 === 0.010,
    `r ${mm(rMax)} mm, ${mm(x1 - x0)} × ${mm(y1 - y0)} × ${mm(z1 - z0)} mm (x×y×z), min y ${y0}`);
  const st = shapeStats(id);
  check(`${id}: shapeStats agrees`, st && st.nodes === n && st.tets === tets.length && Math.abs(st.minDihedral - minDih) < 1e-9);

  // stencils + locator
  const locator = makeTetLocator(ref, 0.004);
  let located = 0;
  for (const [a, b, c, d] of tets) {
    const cx = (pos[a * 3] + pos[b * 3] + pos[c * 3] + pos[d * 3]) / 4, cy = (pos[a * 3 + 1] + pos[b * 3 + 1] + pos[c * 3 + 1] + pos[d * 3 + 1]) / 4, cz = (pos[a * 3 + 2] + pos[b * 3 + 2] + pos[c * 3 + 2] + pos[d * 3 + 2]) / 4;
    if (locator.locate(cx, cy, cz) >= 0) located++;
  }
  check(`${id}: makeSurfaceStencils + makeTetLocator work (every tet centre located)`, stencils.indices.length === boundary.length * 16 * 3 && located === tets.length, `${located}/${tets.length}`);

  // look
  const look = shapeLook(id);
  check(`${id}: shapeLook is cached`, shapeLook(id) === look);
  let dyeOk = true, fxOk = true, dyeMax = 0;
  for (let i = 0; i < n; i++) {
    if (look.dye) { const d = look.dye(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]); if (!(d.length === 3 && d.every((v) => Number.isFinite(v) && v >= 0 && v <= 200))) dyeOk = false; dyeMax = Math.max(dyeMax, ...d); }
    if (look.fx) { const f = look.fx(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]); if (!(f.length === 2 && f.every((v) => Number.isFinite(v) && v >= 0 && v <= 1))) fxOk = false; }
  }
  {
    // the precomputed signature colour = the mass-weighted mean of the dye (lumped tet volumes)
    const sig = signatureSigma(id), sum = [0, 0, 0];
    let ok = true;
    if (look.dye) {
      for (let i = 0; i < n; i++) { const d = look.dye(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]); for (let c = 0; c < 3; c++) sum[c] += d[c] * nodeVol[i] / ref.totalVolume; }
      ok = Array.isArray(sig) && sig.every((v, c) => Math.abs(v - sum[c]) <= 0.002 * Math.max(1, sum[c]));
    } else ok = sig === null;
    check(`${id}: signatureSigma matches the cage's mean signature colour`, ok, `${sig?.map((v) => v.toFixed(2)).join(",")} vs ${sum.map((v) => v.toFixed(2)).join(",")}`);
  }
  check(`${id}: look values finite (dye σ within 0..200, fx within 0..1)`, dyeOk && fxOk && Number.isInteger(look.glitter) && look.glitter >= 0 && Number.isInteger(look.pearls) && look.pearls >= 0, `σ max ${dyeMax.toFixed(1)}, glitter ${look.glitter}, pearls ${look.pearls}`);

  // decorations: on the rendered surface, unit outward normal, unit tangent up
  const surf = new Float32Array(stencils.vertexCount * 3), normals = new Float32Array(stencils.vertexCount * 3);
  evaluateSurface(stencils, pos, surf);
  computeVertexNormals(surf, stencils.indices, normals);
  const bTris = boundary.flat();
  const kinds = new Set(["eye", "nose", "mouth", "blush", "muzzle", "earInner", "cherry", "beak", "whisker", "strawberry"]);
  const decorProblems = [], innerProblems = [];
  let worstCage = 0, worstSurf = 0, shallowest = Infinity;
  for (const d of look.decor) {
    const tag = `${d.kind}@${d.u.map(mm).join(",")}`;
    if (!kinds.has(d.kind)) decorProblems.push(`${tag} unknown kind`);
    if (!(d.scale > 0.0005 && d.scale < 0.012)) decorProblems.push(`${tag} scale ${d.scale}`);
    if (d.color !== undefined && !/^#[0-9a-f]{6}$/i.test(d.color)) decorProblems.push(`${tag} colour ${d.color}`);
    const nl = Math.hypot(...d.n), ul = Math.hypot(...d.up), nu = d.n[0] * d.up[0] + d.n[1] * d.up[1] + d.n[2] * d.up[2];
    if (Math.abs(nl - 1) > 1e-6 || Math.abs(ul - 1) > 1e-6 || Math.abs(nu) > 1e-6) decorProblems.push(`${tag} n/up not orthonormal`);
    if ((d.kind === "strawberry") !== Boolean(d.inside)) decorProblems.push(`${tag} inside flag ${d.inside}`);
    if (d.inside) {
      // pieces set inside the body: located in a tet, a few mm under the
      // cage surface (deep enough for their relief, shallow enough to show)
      const depth = Math.sqrt(nearestOnMesh(d.u, pos, bTris).d2);
      shallowest = Math.min(shallowest, depth);
      if (locator.locate(...d.u) < 0) innerProblems.push(`${tag} not inside the cage`);
      if (!(depth >= 0.003 && depth <= 0.012)) innerProblems.push(`${tag} ${mm(depth)} mm under the cage surface`);
      continue;
    }
    const cageHit = nearestOnMesh(d.u, pos, bTris), surfHit = nearestOnMesh(d.u, surf, stencils.indices);
    worstCage = Math.max(worstCage, Math.sqrt(cageHit.d2)); worstSurf = Math.max(worstSurf, Math.sqrt(surfHit.d2));
    if (Math.sqrt(cageHit.d2) > 0.0015) decorProblems.push(`${tag} ${mm(Math.sqrt(cageHit.d2))} mm off the cage surface`);
    if (Math.sqrt(surfHit.d2) > 0.0002) decorProblems.push(`${tag} ${mm(Math.sqrt(surfHit.d2))} mm off the rendered surface`);
    // outward: agrees with the rendered normal there, outside just beyond, inside just below
    const [ia, ib, ic] = [stencils.indices[surfHit.t], stencils.indices[surfHit.t + 1], stencils.indices[surfHit.t + 2]];
    const sn = [0, 1, 2].map((k) => normals[ia * 3 + k] * surfHit.u + normals[ib * 3 + k] * surfHit.v + normals[ic * 3 + k] * surfHit.w);
    const cosN = (sn[0] * d.n[0] + sn[1] * d.n[1] + sn[2] * d.n[2]) / Math.hypot(...sn);
    if (!(cosN > 0.8)) decorProblems.push(`${tag} normal off the surface normal (cos ${cosN.toFixed(2)})`);
    const out = d.u.map((v, k) => v + d.n[k] * 0.0012), inn = d.u.map((v, k) => v - d.n[k] * 0.0012);
    if (locator.locate(...out) >= 0) decorProblems.push(`${tag} n points inward`);
    if (locator.locate(...inn) < 0) decorProblems.push(`${tag} not embedded under the surface`);
  }
  const need = { pudding: [], cake: ["cherry"], bear: ["eye", "eye", "nose", "mouth", "blush", "blush", "blush", "blush"], cat: ["eye", "eye", "mouth", "whisker", "whisker", "strawberry", "strawberry", "strawberry", "strawberry", "strawberry"], bird: ["eye", "eye", "beak"] }[id];
  const have = look.decor.map((d) => d.kind).sort().join(","), wanted = need.slice().sort().join(",");
  check(`${id}: decorations ${need.length ? need.join(" ") : "(none)"}`, have === wanted, have);
  check(`${id}: decorations sit on the rendered surface, unit outward normals`, decorProblems.length === 0,
    decorProblems.length ? decorProblems.slice(0, 4).join("; ") : `≤ ${mm(worstCage)} mm from the cage, ≤ ${(worstSurf * 1e6).toFixed(0)} µm from the rendered surface`);
  if (look.decor.some((d) => d.inside)) check(`${id}: inner pieces (strawberries) inside the body, 3–12 mm under the surface`, innerProblems.length === 0, innerProblems.length ? innerProblems.slice(0, 4).join("; ") : `shallowest ${mm(shallowest)} mm`);
}

// ---------------------------------------------------------------- idle motions (data)
{
  check("idle motions only for the cat and the bird", ["flower", "pudding", "cake", "bear"].every((id) => shapeMotions(id) === null) && shapeMotions("cat") && shapeMotions("bird"));
  for (const [id, interval, moves, need] of [["cat", 5, ["yawn", "punch"], ["head", "pawL", "pawR"]], ["bird", 7, ["flap", "chirp"], ["head", "wingL", "wingR", "tail"]]]) {
    const M = shapeMotions(id), cage = makeShapeCage(id), P = cage.pos, n = P.length / 3;
    const unit = (v) => Math.abs(Math.hypot(...v) - 1) < 1e-9;
    check(`${id}: motions every ${interval} s (${moves.join(" / ")}), frozen and cached`, M === shapeMotions(id) && Object.isFrozen(M) && M.interval === interval && M.moves.join() === moves.join() && Object.isFrozen(M.regions));
    check(`${id}: model axes are unit, up is +y, face ⟂ side`, unit(M.axes.side) && unit(M.axes.face) && M.axes.up.join() === "0,1,0" && Math.abs(M.axes.side[0] * M.axes.face[0] + M.axes.side[2] * M.axes.face[2]) < 1e-9);
    const report = [];
    let ok = need.every((r) => M.regions[r]);
    for (const [name, parts] of Object.entries(M.regions)) {
      let count = 0, full = 0, wsum = 0;
      const c = [0, 0, 0];
      for (let i = 0; i < n; i++) {
        const w = motionWeight(parts, P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
        if (!(w >= 0 && w <= 1)) ok = false;
        if (w > 0.01) { count++; wsum += w; for (let k = 0; k < 3; k++) c[k] += w * P[i * 3 + k]; }
        if (w > 0.9) full++;
      }
      if (count < 15 || full < 1) ok = false;
      report.push(`${name} ${count}/${full}`);
    }
    // the paws sit in front (toward the face), the wings on either side
    const centre = (r) => { const parts = M.regions[r], c = [0, 0, 0]; let s = 0; for (let i = 0; i < n; i++) { const w = motionWeight(parts, P[i * 3], P[i * 3 + 1], P[i * 3 + 2]); s += w; for (let k = 0; k < 3; k++) c[k] += w * P[i * 3 + k]; } return c.map((v) => v / s); };
    const dotA = (v, a) => v[0] * a[0] + v[1] * a[1] + v[2] * a[2];
    const all = centre("head").map((_, k) => P.filter((_, i) => i % 3 === k).reduce((a, b) => a + b, 0) / n);
    if (id === "cat") ok &&= dotA(centre("pawL"), M.axes.face) > dotA(all, M.axes.face) + 0.01 && centre("head")[1] > all[1] + 0.005;
    else ok &&= dotA(centre("wingL"), M.axes.side) < dotA(all, M.axes.side) - 0.01 && dotA(centre("wingR"), M.axes.side) > dotA(all, M.axes.side) + 0.01;
    check(`${id}: motion regions are soft weights in 0..1 on real parts of the cage (nodes / full-weight)`, ok, report.join(", "));
  }
}

// ---------------------------------------------------------------- physics
function topology(cage) { return { cage, stencils: makeSurfaceStencils(cage) }; }
function makeBody({ cage, stencils }, params = {}) {
  const body = new SoftBody({ cage, stencils, params });
  body.wallRadius = WALL;
  return body;
}
const run = (body, seconds, each) => { const n = Math.round(seconds / H); for (let s = 0; s < n; s++) { each?.(s); body.step(H); } };
function grabAt(body, pick) {
  body.updateSurface();
  const P = body.positions, I = body.indices;
  let best = -1, bestScore = -Infinity;
  for (let t = 0; t < I.length; t += 3) {
    const cx = (P[I[t] * 3] + P[I[t + 1] * 3] + P[I[t + 2] * 3]) / 3, cy = (P[I[t] * 3 + 1] + P[I[t + 1] * 3 + 1] + P[I[t + 2] * 3 + 1]) / 3, cz = (P[I[t] * 3 + 2] + P[I[t + 1] * 3 + 2] + P[I[t + 2] * 3 + 2]) / 3;
    const s = pick(cx, cy, cz);
    if (s > bestScore) { bestScore = s; best = t; }
  }
  const w = body.grabWeights(I[best], I[best + 1], I[best + 2], 1 / 3, 1 / 3, 1 / 3);
  const p = [0, 0, 0];
  for (let k = 0; k < w.ids.length; k++) for (let a = 0; a < 3; a++) p[a] += body.x[w.ids[k] * 3 + a] * w.weights[k];
  return { ids: w.ids, weights: w.weights, target: p.slice(), point: p.slice(), lambda: new Float64Array(3) };
}
// rigid-aligned RMS distance between two node sets (Kabsch via polar decomposition)
function rigidRms(x, ref, mass) {
  const n = mass.length;
  let M = 0; const cx = [0, 0, 0], cr = [0, 0, 0];
  for (let i = 0; i < n; i++) { M += mass[i]; for (let a = 0; a < 3; a++) { cx[a] += x[i * 3 + a] * mass[i]; cr[a] += ref[i * 3 + a] * mass[i]; } }
  for (let a = 0; a < 3; a++) { cx[a] /= M; cr[a] /= M; }
  const A = new Float64Array(9);
  for (let i = 0; i < n; i++) for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) A[r * 3 + c] += mass[i] * (x[i * 3 + r] - cx[r]) * (ref[i * 3 + c] - cr[c]);
  const R = A.slice(), inv = new Float64Array(9);
  for (let it = 0; it < 30; it++) {
    const [a, b, c, d, e, f, g, h, k] = R;
    const det = a * (e * k - f * h) - b * (d * k - f * g) + c * (d * h - e * g);
    inv[0] = (e * k - f * h) / det; inv[1] = (c * h - b * k) / det; inv[2] = (b * f - c * e) / det;
    inv[3] = (f * g - d * k) / det; inv[4] = (a * k - c * g) / det; inv[5] = (c * d - a * f) / det;
    inv[6] = (d * h - e * g) / det; inv[7] = (b * g - a * h) / det; inv[8] = (a * e - b * d) / det;
    for (let r = 0; r < 3; r++) for (let c2 = 0; c2 < 3; c2++) R[r * 3 + c2] = 0.5 * (R[r * 3 + c2] + inv[c2 * 3 + r]);
  }
  let s = 0;
  for (let i = 0; i < n; i++) {
    const q = [ref[i * 3] - cr[0], ref[i * 3 + 1] - cr[1], ref[i * 3 + 2] - cr[2]];
    for (let r = 0; r < 3; r++) { const p = R[r * 3] * q[0] + R[r * 3 + 1] * q[1] + R[r * 3 + 2] * q[2] + cx[r]; s += mass[i] * (p - x[i * 3 + r]) ** 2; }
  }
  rigidRms.tilt = Math.acos(Math.max(-1, Math.min(1, R[4]))) * 180 / Math.PI;   // how far the up axis turned
  return Math.sqrt(s / M);
}
const tiltOf = (body, ref) => { rigidRms(body.x, ref, body.mass); return rigidRms.tilt; };
// per tet: current volume / rest volume (the rest shape bites and plastic flow
// changed, if any) → { inverted: count < 0, min }
function tetRatios(body) {
  const x = body.x, I = body.ids, M = body.restDm;
  let inverted = 0, min = Infinity;
  for (let e = 0; e < body.elementCount; e++) {
    const r = det6(x, I[e * 4], I[e * 4 + 1], I[e * 4 + 2], I[e * 4 + 3]) / (M ? det3m(M, e * 9) : 6 * body.volumes[e]);
    if (r < 0) inverted++;
    if (r < min) min = r;
  }
  return { inverted, min };
}
const det3m = (m, o) => m[o] * (m[o + 4] * m[o + 8] - m[o + 5] * m[o + 7]) - m[o + 1] * (m[o + 3] * m[o + 8] - m[o + 5] * m[o + 6]) + m[o + 2] * (m[o + 3] * m[o + 7] - m[o + 4] * m[o + 6]);
const bite = (body) => {
  // bitten where the front faces the camera: the surface point nearest to
  // a point 10 mm above the centre of mass, in front of the jelly (the app's bite)
  body.updateSurface();
  const bb = body.bounds, c = body.center, P = body.positions, aim = [c[0], c[1] + 0.01, bb[5] + 0.01];
  let at = 0, d2 = Infinity;
  for (let v = 0; v < P.length; v += 3) { const d = (P[v] - aim[0]) ** 2 + (P[v + 1] - aim[1]) ** 2 + (P[v + 2] - aim[2]) ** 2; if (d < d2) { d2 = d; at = v; } }
  body.scaleRest(BITE.scale);
  return body.shrinkRegion([P[at], P[at + 1], P[at + 2] - 0.002], BITE.radius, BITE.factor, BITE.minScale);
};
const flowerBites = (() => {
  const body = makeBody(topology(makeFlowerCage()));
  run(body, 2);
  for (let i = 0; i < 4; i++) { bite(body); run(body, 0.5); }
  return tetRatios(body).inverted;
})();

const SLIME = { shear: 600 * 0.32, damping: 6.5, staticFriction: 0.65 * 1.7, dynamicFriction: 0.42 * 1.7 };
for (const id of NEW) {
  const topo = topology(makeShapeCage(id));
  const height0 = (topo.cage.pos.reduce((m, v, i) => (i % 3 === 1 ? Math.max(m, v) : m), 0)) - 0.010;

  // 1) drop and settle
  let body = makeBody(topo);
  let finite = true, minV = Infinity, maxV = 0, sleptAt = -1;
  for (let s = 0; s < 3 * 240; s++) {
    body.step(H);
    if (s % 6 === 0) { const v = body.volumeRatio(); minV = Math.min(minV, v); maxV = Math.max(maxV, v); finite &&= body.isFinite(); }
    if (body.sleeping && sleptAt < 0) sleptAt = (s + 1) * H;
  }
  body.updateSurface();
  const settled = body.x.slice(), restVol = body.volumeRatio(), b = body.bounds;
  const settledH = b[4] - b[1];
  check(`${id}: drop & settle — finite, volume 0.9–1.1, on the floor, asleep within 3 s`, finite && minV > 0.9 && maxV < 1.1 && b[1] < 0.001 && b[1] > -0.001 && sleptAt > 0,
    `volume ${minV.toFixed(3)}–${maxV.toFixed(3)} (rest ${restVol.toFixed(3)}), min y ${mm(b[1])} mm, height ${mm(settledH)}/${mm(height0)} mm, asleep at ${sleptAt < 0 ? "never" : sleptAt.toFixed(2) + " s"}`);
  const restTilt = tiltOf(body, topo.cage.pos);
  check(`${id}: sits upright (best-fit tilt after settling ≤ 8°)`, restTilt <= 8, `${restTilt.toFixed(1)}°`);
  // its own weight must not press any tet flat (the rim on the tray, an overhang)
  const settledTets = tetRatios(body);
  check(`${id}: no tet pressed flat after settling (volume ratio ≥ 0.15 each)`, settledTets.inverted === 0 && settledTets.min >= 0.15, `min ${settledTets.min.toFixed(3)}`);

  // 1b) the app's bounce (double tap / button, up to 1.45 m/s) and nudge: lands and stays upright
  {
    const b2 = makeBody(topo);
    run(b2, 1.5);
    let worst = 0, fin = true;
    for (const [vy, vx, vz] of [[1.0, 0.02, -0.02], [1.45, -0.025, 0.025], [1.45, 0.025, 0.02], [0, 0, 0], [1.45, -0.02, -0.025]]) {
      b2.updateSurface();
      if (vy) b2.bounce(vy, vx, vz); else b2.nudge();
      run(b2, 3, (s) => { if (s % 24 === 0) { worst = Math.max(worst, tiltOf(b2, topo.cage.pos)); fin &&= b2.isFinite(); } });
    }
    const endTilt = tiltOf(b2, topo.cage.pos);
    check(`${id}: bounces and nudges — finite, lands upright (does not topple)`, fin && endTilt <= 10 && worst < 45, `worst ${worst.toFixed(0)}°, after ${endTilt.toFixed(1)}°`);
  }

  // 2) grab a surface point on the top front and drag it 30 mm, release, recover
  body.grab = grabAt(body, (x, y, z) => y + 0.5 * z);
  const start = body.grab.point.slice();
  const raw = clampGrabTarget([start[0] + 0.03, start[1], start[2]], WALL);
  let maxStretch = 0;
  finite = true;
  run(body, 1.0, () => { easeGrabTarget(body.grab.target, raw, H); });
  maxStretch = Math.hypot(body.grab.point[0] - start[0], body.grab.point[1] - start[1], body.grab.point[2] - start[2]);
  finite &&= body.isFinite();
  body.grab = null;
  let slept2 = -1;
  for (let s = 0; s < 6 * 240; s++) { body.step(H); if (s % 24 === 0) finite &&= body.isFinite(); if (body.sleeping) { slept2 = (s + 1) * H; break; } }
  const rms = rigidRms(body.x, settled, body.mass), v2 = body.volumeRatio();
  check(`${id}: grab, drag 30 mm, release — finite, recovers its shape`, finite && maxStretch > 0.015 && rms < 0.002 && Math.abs(v2 - restVol) < 0.03,
    `dragged ${mm(maxStretch)} mm, shape error after ${slept2 < 0 ? "6+ s" : slept2.toFixed(1) + " s"}: ${mm(rms)} mm RMS, volume ${v2.toFixed(3)}`);

  // 3) bites (the app's bite: whole jelly × 0.87, bitten region caves in).
  //    One bite and the jelly stays (the bunny refuses / spits): nothing may
  //    stay inside out. Four bites (eaten): only a few, like the flower.
  finite = true;
  let oneBite = null;
  for (let i = 0; i < 4; i++) {
    if (!bite(body)) finite = false;
    run(body, i === 0 ? 2 : 0.5);
    if (i === 0) oneBite = tetRatios(body);
    finite &&= body.isFinite();
  }
  const fourBites = tetRatios(body);
  run(body, 2);
  body.updateSurface();
  check(`${id}: four bites — finite, still on the floor`, finite && body.isFinite() && body.bounds[1] > -0.001 && body.bounds[1] < 0.002, `height now ${mm(body.bounds[4] - body.bounds[1])} mm`);
  check(`${id}: bites leave (almost) no tet inside out (1 bite ≤ 4, 4 bites ≤ 40)`, oneBite.inverted <= 4 && fourBites.inverted <= 40,
    `after 1 bite ${oneBite.inverted}, after 4 bites ${fourBites.inverted} of ${body.elementCount} (flower ${flowerBites})`);

  // 4) slime: plastic flow for 20 s after a pull — finite, never collapses
  body = makeBody(topo, SLIME);
  run(body, 1.5);
  body.setPlastic(1.6, 0.13, 0.2);
  let clock = 0, lowest = Infinity, minVs = Infinity;
  finite = true;
  body.grab = grabAt(body, (x, y) => y);
  const pullTo = clampGrabTarget([body.grab.point[0] + 0.01, body.grab.point[1] + 0.025, body.grab.point[2]], WALL);
  for (let s = 0; s < 20 * 240; s++) {
    if (body.grab) easeGrabTarget(body.grab.target, pullTo, H);
    if (s === 240) body.grab = null;
    body.step(H);
    clock += H;
    if (clock >= 1 / 30) {
      body.plastic.recover = s < 240 * 3.5 ? 0.01 : 0.13;
      const strain = body.plasticStep(clock); clock = 0;
      if (strain > 0.03) body.quietTime = 0;
      if (!body.sleeping || s % 240 === 0) {
        body.updateSurface();
        if (s > 240 * 1.2) lowest = Math.min(lowest, body.bounds[4] - body.bounds[1]);
        minVs = Math.min(minVs, body.volumeRatio());
        finite &&= body.isFinite();
      }
    }
  }
  // the 3× softer slime sags more: a few rim tets under a heavy part (the
  // bear's head) may stay pressed through on the tray, but never more
  const slimeTets = tetRatios(body);
  check(`${id}: slime — at most 1 % of the tets inside out after 20 s of plastic flow`, slimeTets.inverted <= 0.01 * body.elementCount, `${slimeTets.inverted} of ${body.elementCount} inverted`);
  check(`${id}: slime (plastic flow 20 s) — finite, never below 40 % height`, finite && lowest > 0.4 * settledH && minVs > 0.8,
    `lowest ${mm(lowest)} mm of ${mm(settledH)} (${(lowest / settledH * 100).toFixed(0)} %), min volume ${minVs.toFixed(3)}, plastic strain ${body.plasticStrain.toFixed(3)}`);

  // 5) carry: lifted 50 mm in 0.4 s and put back (the app's carry), then a
  //    kinematic jolt (all nodes translated 50 mm up and back in 0.4 s each)
  body = makeBody(topo);
  run(body, 1.5);
  body.updateSurface();
  const c0 = body.center.slice();
  finite = true;
  let minVc = Infinity, maxVc = 0;
  const track = (s) => { if (s % 6 === 0) { const v = body.volumeRatio(); minVc = Math.min(minVc, v); maxVc = Math.max(maxVc, v); finite &&= body.isFinite(); } };
  run(body, 0.4, (s) => { body.carry = { target: [c0[0], c0[1] + 0.05 * Math.min(1, (s + 1) / 96), c0[2]] }; track(s); });
  run(body, 0.3, track);
  run(body, 0.4, (s) => { body.carry = { target: [c0[0], c0[1] + 0.05 * (1 - Math.min(1, (s + 1) / 96)), c0[2]] }; track(s); });
  body.carry = null;
  run(body, 1.0, track);
  const lift = 0.05 / 96;
  for (const dir of [1, -1]) run(body, 0.4, (s) => {
    for (let i = 0; i < body.nodeCount; i++) { body.x[i * 3 + 1] += dir * lift; body.velocity[i * 3 + 1] = dir * lift / H; }
    body.wake(); track(s);
  });
  run(body, 3, track);
  body.updateSurface();
  check(`${id}: carry 50 mm up and back + kinematic jolt — finite, lands on the floor`, finite && minVc > 0.75 && maxVc < 1.15 && body.bounds[1] > -0.001 && body.bounds[1] < 0.002,
    `volume ${minVc.toFixed(3)}–${maxVc.toFixed(3)}, min y ${mm(body.bounds[1])} mm`);
}

// ---------------------------------------------------------------- cost per 240 Hz step vs the flower
{
  const bodies = new Map([["flower", makeBody(topology(makeFlowerCage()))], ...NEW.map((id) => [id, makeBody(topology(makeShapeCage(id)))])]);
  for (const b of bodies.values()) run(b, 0.5);
  const best = new Map([...bodies.keys()].map((k) => [k, Infinity]));
  for (let round = 0; round < 7; round++) for (const [id, b] of bodies) {
    b.wake();
    const t0 = performance.now();
    for (let s = 0; s < 96; s++) { b.wake(); b.step(H); }
    best.set(id, Math.min(best.get(id), (performance.now() - t0) / 96));
  }
  const f = best.get("flower");
  console.log(`perf  flower ${f.toFixed(3)} ms/step (${flowerCage.pos.length / 3} nodes, ${flowerCage.tets.length} tets)`);
  for (const id of NEW) {
    const ms = best.get(id), c = makeShapeCage(id);
    // (a budget of ~1.2× the flower's nodes; the margin absorbs timer noise on a busy machine)
    check(`${id}: step cost ≤ 1.45× the flower's`, ms <= 1.45 * f, `${ms.toFixed(3)} ms/step = ${(ms / f).toFixed(2)}× (${c.pos.length / 3} nodes, ${c.tets.length} tets)`);
  }
}

console.log(failures ? `\n${failures} FAILED` : "\nALL SHAPE CHECKS PASSED");
process.exit(failures ? 1 : 0);
