// Optics equivalence: ReceiverOptics must match the original RefractiveLightField
// (shadow/contact bytes, field origin/span, view thickness) on deformed shapes.
globalThis.self = globalThis; globalThis.window = globalThis;
const THREE = await import("three/webgpu");
const original = await import("./original/softbody-jelly.js");
const { SoftBody } = await import("../src/core/softbody.js");
const { ReceiverOptics } = await import("../src/core/optics.js");

const camera = new THREE.PerspectiveCamera(34, 0.46, 0.001, 2);
camera.position.set(0.05, 0.11, 0.18); camera.lookAt(0, 0.025, 0); camera.updateMatrixWorld();
const system = original.createSoftbodyJellySystem({ camera });
const A = system.body, LA = system.optics;
const B = new SoftBody();
const LB = new ReceiverOptics(B.positions, B.normals, B.indices);
// The original refreshes once at construction; back-facing vertices keep those values.
LB.updateReceiver(); LB.updateViewThickness(camera.position.x, camera.position.y, camera.position.z);

let failures = 0;
const check = (label, ok, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`); };
const diffCount = (a, b) => { let c = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) c++; return c; };

const h = 1 / 240;
A.nudge(); B.nudge();
let tA = 0, tB = 0, runs = 0;
for (let round = 0; round < 6; round++) {
  for (let s = 0; s < 40; s++) { A.step(h); B.step(h); }
  A.updateSurface(); B.updateSurface();
  let t = performance.now(); LA.update(A); LA.updateViewThickness(camera); tA += performance.now() - t;
  t = performance.now(); LB.updateReceiver(); LB.updateViewThickness(camera.position.x, camera.position.y, camera.position.z); tB += performance.now() - t;
  runs++;
  const thicknessA = A.surface.geometry.attributes.opticalThickness.array;
  check(`round ${round}: span/origin`, LA.span === LB.span && LA.origin.x === LB.origin[0] && LA.origin.y === LB.origin[1], `${LA.span} vs ${LB.span}`);
  check(`round ${round}: shadow/contact bytes`, diffCount(LA.shadowBytes, LB.shadowBytes) === 0, `${diffCount(LA.shadowBytes, LB.shadowBytes)} differ`);
  check(`round ${round}: view thickness`, diffCount(thicknessA, LB.thickness) === 0, `${diffCount(thicknessA, LB.thickness)} differ`);
}
console.log(`perf  optics refresh: original ${(tA / runs).toFixed(2)} ms → port ${(tB / runs).toFixed(2)} ms (${(tA / tB).toFixed(2)}×)`);
system.dispose();
console.log(failures ? `\n${failures} FAILED` : "\nALL OPTICS CHECKS PASSED");
process.exit(failures ? 1 : 0);
