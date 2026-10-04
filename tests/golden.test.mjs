// Golden test: the optimised SoftBody must reproduce the original skill example
// bit-for-bit (positions, velocities, surface, normals) through a nudge, a grab
// drag, a release and sleep. Run with `node tests/golden.test.mjs`.
globalThis.self = globalThis; globalThis.window = globalThis;
const THREE = await import("three/webgpu");
const original = await import("./original/softbody-jelly.js");
const { SoftBody, easeGrabTarget } = await import("../src/core/softbody.js");

const camera = new THREE.PerspectiveCamera(34, 0.46, 0.001, 2);
camera.position.set(0, 0.096, 0.196); camera.lookAt(0, 0.025, 0); camera.updateMatrixWorld();
const system = original.createSoftbodyJellySystem({ camera });
const A = system.body;
const B = new SoftBody();

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
};
const maxDiff = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
const identical = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i]) && a[i] !== b[i]) return false; return true; };

check("node count 762", B.nodeCount === 762, String(B.nodeCount));
check("tetrahedra 3240", B.elementCount === 3240, String(B.elementCount));
check("shell stencils 6338", B.stencils.vertexCount === 6338, String(B.stencils.vertexCount));
check("shell triangles 12672", B.indices.length / 3 === 12672, String(B.indices.length / 3));
check("rest volume", B.cage.totalVolume === 0.00011933031247661388, String(B.cage.totalVolume));
check("mass", B.totalMass === A.totalMass && B.totalMass === 0.12529682810044418, String(B.totalMass));
check("rest positions identical", identical(A.x, B.x));
check("initial surface identical", identical(A.surface.positions, B.positions));
check("initial normals identical", identical(A.surface.geometry.attributes.normal.array, B.normals));

const h = 1 / 240;
let worstX = 0, worstV = 0, firstDivergence = -1;
function stepBoth(n, onStep) {
  for (let s = 0; s < n; s++) {
    if (onStep) onStep(s);
    A.step(h); B.step(h);
    const dx = maxDiff(A.x, B.x), dv = maxDiff(A.velocity, B.velocity);
    worstX = Math.max(worstX, dx); worstV = Math.max(worstV, dv);
    if ((dx > 0 || dv > 0) && firstDivergence < 0) firstDivergence = s;
  }
  A.updateSurface(); B.updateSurface();
}

// 1) nudge and wobble
A.nudge(); B.nudge();
stepBoth(240);
check("after nudge: x/v identical", worstX === 0 && worstV === 0, `maxΔx=${worstX} maxΔv=${worstV} first=${firstDivergence}`);
check("after nudge: surface identical", identical(A.surface.positions, B.positions));
check("after nudge: normals identical", identical(A.surface.geometry.attributes.normal.array, B.normals));

// 2) grab a surface point and drag it (original beginGrab weight construction)
const tri = 4000, bary = [0.2, 0.3, 0.5];
const ia = A.surface.indices[tri * 3], ib = A.surface.indices[tri * 3 + 1], ic = A.surface.indices[tri * 3 + 2];
const weights = new Map();
for (const [surfaceId, w0] of [[ia, bary[0]], [ib, bary[1]], [ic, bary[2]]]) {
  for (const [id, weight] of A.surface.stencils[surfaceId]) weights.set(id, (weights.get(id) || 0) + weight * w0);
}
const weightList = [...weights].filter(([, w]) => w > 1e-8);
const sum = weightList.reduce((t, [, w]) => t + w, 0);
for (const pair of weightList) pair[1] /= sum;
const gw = B.grabWeights(ia, ib, ic, bary[0], bary[1], bary[2]);
check("grab weights identical", gw.ids.length === weightList.length && weightList.every(([id, w], k) => gw.ids[k] === id && gw.weights[k] === w));

const start = new THREE.Vector3();
for (const [id, w] of weightList) { start.x += A.x[id * 3] * w; start.y += A.x[id * 3 + 1] * w; start.z += A.x[id * 3 + 2] * w; }
const raw = new THREE.Vector3(start.x + 0.03, start.y + 0.035, start.z - 0.01);
A.wake(); B.wake();
A.grab = { weights: weightList, target: start.clone(), point: start.clone(), lambda: new Float64Array(3) };
B.grab = { ids: gw.ids, weights: gw.weights, target: [start.x, start.y, start.z], point: [0, 0, 0], lambda: new Float64Array(3) };
const tmp = new THREE.Vector3();
stepBoth(360, () => {
  // original updateGrabTarget()
  const target = A.grab.target, delta = tmp.copy(raw).sub(target), distance = delta.length();
  if (distance > 0) target.addScaledVector(delta, Math.min(1 - Math.exp(-32 * h), 0.65 * h / distance));
  easeGrabTarget(B.grab.target, [raw.x, raw.y, raw.z], h);
});
check("during grab: x/v identical", worstX === 0 && worstV === 0, `maxΔx=${worstX} maxΔv=${worstV} first=${firstDivergence}`);

// 3) release, settle, sleep
A.grab = null; B.grab = null;
stepBoth(1200);
check("after release: x/v identical", worstX === 0 && worstV === 0, `maxΔx=${worstX} maxΔv=${worstV} first=${firstDivergence}`);
check("sleep state identical", A.sleeping === B.sleeping, `orig=${A.sleeping} port=${B.sleeping}`);
check("surface identical at end", identical(A.surface.positions, B.positions));
check("normals identical at end", identical(A.surface.geometry.attributes.normal.array, B.normals));
check("volume ratio identical", A.volumeRatio() === B.volumeRatio(), `${A.volumeRatio()} vs ${B.volumeRatio()}`);
check("centre identical", A.center.x === B.center[0] && A.center.y === B.center[1] && A.center.z === B.center[2]);

// 4) performance (awake body)
const time = (body, n) => { body.reset(); body.nudge(); for (let i = 0; i < 120; i++) body.step(h); const t = performance.now(); for (let i = 0; i < n; i++) { if (body.sleeping) body.nudge(); body.step(h); } return (performance.now() - t) / n; };
const tA = time(A, 960), tB = time(B, 960);
const sA = performance.now(); for (let i = 0; i < 120; i++) A.updateSurface(); const uA = (performance.now() - sA) / 120;
const sB = performance.now(); for (let i = 0; i < 120; i++) B.updateSurface(); const uB = (performance.now() - sB) / 120;
console.log(`perf  step: original ${tA.toFixed(3)} ms → port ${tB.toFixed(3)} ms (${(tA / tB).toFixed(2)}×)`);
console.log(`perf  surface: original ${uA.toFixed(3)} ms → port ${uB.toFixed(3)} ms (${(uA / uB).toFixed(2)}×)`);

system.dispose();
console.log(failures ? `\n${failures} FAILED` : "\nALL GOLDEN CHECKS PASSED");
process.exit(failures ? 1 : 0);
