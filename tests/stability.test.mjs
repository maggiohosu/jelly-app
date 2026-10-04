// Stability of the app-specific paths that are not covered by the golden test:
// the 160 Hz emergency rate, tilt gravity (clamped to 45°) with the tray wall,
// shake impulses. 120 Hz was rejected: the body sags to ~88 % volume at rest.
const { SoftBody, easeGrabTarget, clampGrabTarget, JELLY_DEFAULTS } = await import("../src/core/softbody.js");

let failures = 0;
const check = (label, ok, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`); };

function scenario(h, { tilt = 0, wall = 0, slippery = false } = {}) {
  const body = new SoftBody();
  if (wall) body.wallRadius = wall;
  if (slippery) body.frictionOverride = { staticFriction: 0.12, dynamicFriction: 0.08 };
  body.reset(0.03); // intro drop
  let minVol = Infinity, maxVol = -Infinity, finite = true, maxR = 0;
  const track = () => {
    const v = body.volumeRatio(); minVol = Math.min(minVol, v); maxVol = Math.max(maxVol, v);
    if (!body.isFinite()) finite = false;
    for (let i = 0; i < body.nodeCount; i++) maxR = Math.max(maxR, Math.hypot(body.x[i * 3], body.x[i * 3 + 2]));
  };
  const run = (seconds, each) => { const n = Math.round(seconds / h); for (let s = 0; s < n; s++) { each?.(); body.step(h); if (s % 8 === 0) track(); } };
  run(1.0);
  const restVolume = body.volumeRatio();
  if (tilt) {
    const a = tilt * Math.PI / 180;
    body.gravityVector = [JELLY_DEFAULTS.gravity * Math.sin(a), -JELLY_DEFAULTS.gravity * Math.cos(a), 0];
    body.wake();
  }
  body.nudge(); run(1.0);
  body.impulse(0.25, 0.3, -0.1); run(0.5);
  // hard grab-drag toward a far corner, then release
  body.updateSurface();
  const t = 4000, ia = body.indices[t * 3], ib = body.indices[t * 3 + 1], ic = body.indices[t * 3 + 2];
  const gw = body.grabWeights(ia, ib, ic, 0.3, 0.3, 0.4);
  const start = [0, 0, 0];
  for (let k = 0; k < gw.ids.length; k++) for (let a = 0; a < 3; a++) start[a] += body.x[gw.ids[k] * 3 + a] * gw.weights[k];
  body.grab = { ids: gw.ids, weights: gw.weights, target: start.slice(), point: [0, 0, 0], lambda: new Float64Array(3) };
  // The app clamps the finger target into the tray (see clampGrabTarget); mirror that here.
  const raw = wall ? clampGrabTarget([0.12, 0.13, -0.12], wall) : [0.12, 0.13, -0.12];
  run(1.0, () => easeGrabTarget(body.grab.target, raw, h));
  body.grab = null;
  let sleptAt = -1, elapsed = 0;
  const n = Math.round(8 / h);
  for (let s = 0; s < n; s++) { body.step(h); elapsed += h; if (s % 8 === 0) track(); if (body.sleeping && sleptAt < 0) { sleptAt = elapsed; break; } }
  return { minVol, maxVol, finite, sleptAt, maxR, restVolume, energy: body.energy() };
}

for (const [label, h, opts] of [
  ["240 Hz (original)", 1 / 240, {}],
  ["160 Hz (emergency)", 1 / 160, {}],
  ["240 Hz + wall + tilt 20°", 1 / 240, { tilt: 20, wall: 0.07, slippery: true }],
  ["240 Hz + wall + tilt 45° (max)", 1 / 240, { tilt: 45, wall: 0.07, slippery: true }],
  ["160 Hz + wall + tilt 45° (max)", 1 / 160, { tilt: 45, wall: 0.07, slippery: true }],
]) {
  const r = scenario(h, opts);
  const detail = `vol ${r.minVol.toFixed(3)}–${r.maxVol.toFixed(3)}, sleep ${r.sleptAt < 0 ? "never" : r.sleptAt.toFixed(2) + "s"}, maxR ${r.maxR.toFixed(4)}`;
  check(`${label}: finite`, r.finite, detail);
  // Transient squash on impacts is expected; the resting shape must not sag.
  const transientFloor = h > 1 / 200 ? 0.65 : 0.8;
  check(`${label}: rest volume ≥ 0.93`, r.restVolume >= 0.93, `rest ${r.restVolume.toFixed(3)}`);
  check(`${label}: transient volume within ${transientFloor}–1.1`, r.minVol > transientFloor && r.maxVol < 1.1, detail);
  check(`${label}: settles to sleep within 8 s`, r.sleptAt > 0, detail);
  if (opts.wall) check(`${label}: stays inside tray`, r.maxR <= opts.wall + 1e-9, detail);
}
console.log(failures ? `\n${failures} FAILED` : "\nALL STABILITY CHECKS PASSED");
process.exit(failures ? 1 : 0);
