// Rare gems: pure geometry data of the 25 shapes (src/render/rare-shapes.js)
// and their SVG icons. No renderer needed: `node tests/rare-gems.test.mjs`.
import {
  RARE_GEM_INFO,
  RARE_PLANE_BUDGET,
  RARE_SIZE,
  RARE_TIER_INFO,
  RARE_TRIANGLE_BUDGET,
  rareIconSVG,
  rareShapeData,
} from "../src/render/rare-shapes.js";

let failures = 0;
const check = (label, ok, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`); };

const ids = RARE_GEM_INFO.map((g) => g.id);
check("25 rare gems with unique ids, labels and families", ids.length === 25 && new Set(ids).size === 25 && RARE_GEM_INFO.every((g) => g.label && g.family && /^#[0-9a-f]{6}$/i.test(g.color) && Object.isFrozen(g)));
check("rare size is 1.5 × the normal gem size", Math.abs(RARE_SIZE - 0.0075 * 1.5) < 1e-12, `${(RARE_SIZE * 1000).toFixed(2)} mm`);
check("three upgrade tiers 글리터 / 금빛 / 무지개빛", RARE_TIER_INFO.map((t) => t.id).join() === "glitter,gold,rainbow" && RARE_TIER_INFO.map((t) => t.label).join() === "글리터,금빛,무지개빛");

const t0 = performance.now();
const all = RARE_GEM_INFO.map((_, i) => rareShapeData(i));
const buildMs = performance.now() - t0;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);

let totalPlanes = 0;
for (const d of all) {
  const problems = [];
  const P = d.positions, N = d.normals, I = d.indices;
  const vtx = (i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
  const nrm = (i) => [N[i * 3], N[i * 3 + 1], N[i * 3 + 2]];
  const vc = d.vertexCount;

  // Finite, consistent arrays.
  for (const [name, arr, k] of [["positions", P, 3], ["normals", N, 3], ["colors", d.colors, 3], ["partA", d.partA, 4], ["partB", d.partB, 4]]) {
    if (arr.length !== vc * k) problems.push(`${name} length`);
    if (!arr.every(Number.isFinite)) problems.push(`${name} not finite`);
  }
  if (!d.colors.every((c) => c >= 0 && c <= 1)) problems.push("colour out of range");
  if (I.length % 3 !== 0 || !I.every((i) => i < vc)) problems.push("index out of range");

  // Size: longest extent = RARE_SIZE (±10 %), bounding radius sane.
  const ext = [0, 1, 2].map((k) => d.bounds.max[k] - d.bounds.min[k]);
  const longest = Math.max(...ext);
  if (Math.abs(longest / RARE_SIZE - 1) > 0.1) problems.push(`longest extent ${(longest * 1000).toFixed(2)} mm`);
  if (!(d.radius >= longest / 2 - 1e-9 && d.radius <= RARE_SIZE * 0.9)) problems.push(`radius ${(d.radius * 1000).toFixed(2)} mm`);

  // Budget and non-degenerate triangles.
  if (d.triangles > RARE_TRIANGLE_BUDGET) problems.push(`${d.triangles} triangles`);
  let minArea = Infinity;
  for (let t = 0; t < I.length; t += 3) {
    const a = vtx(I[t]), b = vtx(I[t + 1]), c = vtx(I[t + 2]);
    minArea = Math.min(minArea, len(cross(sub(b, a), sub(c, a))) / 2);
  }
  if (!(minArea > (RARE_SIZE * 1e-5) ** 2)) problems.push(`degenerate triangle (area ${minArea.toExponential(2)} m²)`);

  // Unit normals.
  let worstUnit = 0;
  for (let i = 0; i < vc; i += 1) worstUnit = Math.max(worstUnit, Math.abs(len(nrm(i)) - 1));
  if (worstUnit > 1e-3) problems.push(`normal length off by ${worstUnit.toExponential(2)}`);

  // Facet vertices (plane ranges in rareA) are exactly those after facetVertexStart.
  for (const part of d.parts) {
    for (let t = part.start; t < part.start + part.count; t += 1) {
      if ((I[t] >= d.facetVertexStart) !== (part.kind === "facet")) { problems.push("facet/smooth vertex ranges overlap"); break; }
    }
  }
  for (let v = 0; v < d.facetVertexStart; v += 1) if (d.partA[v * 4] < 0 || d.partA[v * 4] > 5) { problems.push(`smooth vertex with pattern ${d.partA[v * 4]}`); break; }

  // Groups cover every triangle once: 0 = smooth, 1 = facet.
  let covered = 0, lastEnd = 0;
  for (const g of d.groups) { if (g.start !== lastEnd || (g.materialIndex !== 0 && g.materialIndex !== 1)) problems.push("group layout"); covered += g.count; lastEnd = g.start + g.count; }
  if (covered !== I.length) problems.push("groups do not cover the index buffer");

  // Per part: closed and outward (positive volume), normals agree with faces;
  // facet parts lie inside their own convex planes.
  let disagree = 0;
  for (const part of d.parts) {
    let vol = 0;
    for (let t = part.start; t < part.start + part.count; t += 3) {
      const a = vtx(I[t]), b = vtx(I[t + 1]), c = vtx(I[t + 2]);
      vol += dot(a, cross(b, c)) / 6;
      const fn = cross(sub(b, a), sub(c, a));
      for (const i of [I[t], I[t + 1], I[t + 2]]) if (dot(nrm(i), fn) < 0) { disagree += 1; break; }
    }
    if (!(vol > 0)) problems.push(`part ${part.kind} ${part.color} inward or open (volume ${vol.toExponential(2)})`);
    if (part.kind === "facet") {
      if (!(part.planeCount > 3)) problems.push("facet part without planes");
      let worst = -Infinity;
      for (let k = 0; k < part.planeCount; k += 1) {
        const o = (part.planeOffset + k) * 4;
        const n = [d.planes[o], d.planes[o + 1], d.planes[o + 2]], dd = d.planes[o + 3];
        if (Math.abs(len(n) - 1) > 1e-4) problems.push("plane normal not unit");
        for (let t = part.start; t < part.start + part.count; t += 1) worst = Math.max(worst, dot(n, vtx(I[t])) - dd);
      }
      if (worst > RARE_SIZE * 1e-5) problems.push(`facet vertex outside its planes by ${(worst * 1e6).toFixed(2)} µm`);
    } else if (!(part.thickness > 0)) problems.push("smooth part without thickness");
  }
  const disagreeFrac = disagree / d.triangles;
  if (disagreeFrac > 0.01) problems.push(`${(disagreeFrac * 100).toFixed(1)} % of triangles have vertex normals facing inward`);
  totalPlanes += d.planeCount;

  for (const p of problems) check(`${d.id}: ${p}`, false);
  check(`${d.id}: geometry valid`, problems.length === 0,
    `${d.triangles} tris, ${d.vertexCount} verts, ${d.parts.length} parts, ${d.planeCount} planes, ${ext.map((e) => (e * 1000).toFixed(2)).join(" × ")} mm`);
}

check("hull planes of all gems fit the shared uniform block", totalPlanes <= RARE_PLANE_BUDGET, `${totalPlanes} / ${RARE_PLANE_BUDGET} vec4`);
check("faceted families carry convex planes, smooth families none",
  ["cube", "brilliant", "butterfly", "crown", "rose", "bear", "swan", "ringpop"].every((id) => all[ids.indexOf(id)].planeCount > 0)
  && ["capsule", "donut", "ring", "twist", "gummybear", "cherry"].every((id) => all[ids.indexOf(id)].planeCount === 0));
check("shape data is cached", rareShapeData(3) === all[3]);
console.log(`perf  all 25 shapes built in ${buildMs.toFixed(0)} ms`);

// Icons.
let iconProblems = 0, maxLen = 0;
const t1 = performance.now();
for (let i = 0; i < 25; i += 1) {
  const svgs = [0, 1, 2].map((t) => rareIconSVG(i, t));
  for (const svg of svgs) {
    maxLen = Math.max(maxLen, svg.length);
    if (!svg.startsWith("<svg") || !svg.endsWith("</svg>") || /NaN|undefined|Infinity/.test(svg) || !svg.includes("<path")) iconProblems += 1;
  }
  if (new Set(svgs).size !== 3) iconProblems += 1;
}
check("SVG icons: 25 gems × 3 tiers, well-formed and distinct per tier", iconProblems === 0, `largest ${(maxLen / 1024).toFixed(1)} KB, ${(performance.now() - t1).toFixed(0)} ms for 75`);
check("SVG icons stay small for UI buttons", maxLen < 16 * 1024);
check("icon ids are unique per gem and tier", rareIconSVG(0, 0).includes('id="rg0t0') && rareIconSVG(4, 2).includes('id="rg4t2'));

console.log(failures ? `\n${failures} FAILED` : "\nALL RARE GEM CHECKS PASSED");
process.exit(failures ? 1 : 0);
