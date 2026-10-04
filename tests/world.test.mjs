// JellyWorld: paint drops (exact pigment bookkeeping, subtractive mixing,
// diffusion, water dilution), gem containment / suspension / clinks, cost.
import { JellyWorld, PAINTS, BASES } from "../src/core/world.js";

let failures = 0;
const check = (label, ok, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`); };
const dt = 1 / 60;
const run = (w, seconds, each) => { for (let t = 0; t < seconds; t += dt) { each?.(); w.advance(dt); } };
const drain = (w) => w.events.splice(0);
const paint = (id) => PAINTS.findIndex((p) => p.id === id);
const top = (w) => { const b = w.body.bounds; return [w.body.center[0], b[4], w.body.center[2]]; };
const transmit = (sigma) => sigma.map((s) => Math.exp(-s * 0.035));

// 1) one drop adds exactly its pigment, then spreads to a uniform colour
let w = new JellyWorld({ base: "clear" });
run(w, 0.5);
const before = w.totalPigment();
w.handle({ type: "drop", point: top(w), paint: paint("blue") });
const after = w.totalPigment();
const expectedDose = 0.015 * w.body.totalMass * 3;
const blue = PAINTS[paint("blue")].sigma;
const doseErr = Math.max(...[0, 1, 2].map((c) => Math.abs((after[c] - before[c]) - blue[c] * expectedDose) / (blue[c] * expectedDose)));
check("a drop adds exactly one drop of pigment", doseErr < 1e-9, `rel err ${doseErr.toExponential(2)}`);
const ev = drain(w);
check("drop emits an event", ev.some((e) => e.type === "dropped"));
const spread = () => { let lo = Infinity, hi = -Infinity; for (let i = 0; i < w.body.nodeCount; i++) { lo = Math.min(lo, w.dye[i * 3]); hi = Math.max(hi, w.dye[i * 3]); } return hi - lo; };
const s0 = spread();
run(w, 6, () => { if (Math.random() < 0.04) w.handle({ type: "nudge" }); });
const s1 = spread(), p1 = w.totalPigment();
check("the drop spreads through the jelly (marbling fades)", s1 < s0 * 0.5, `red-channel spread ${s0.toFixed(1)} → ${s1.toFixed(1)} /m`);
check("pigment is conserved while spreading", Math.max(...[0, 1, 2].map((c) => Math.abs(p1[c] - after[c]) / after[c])) < 1e-9);

// 2) subtractive mixing: yellow + blue on a clear jelly → green
w = new JellyWorld({ base: "clear" });
run(w, 0.3);
for (let i = 0; i < 4; i++) { w.handle({ type: "drop", point: top(w), paint: paint("yellow") }); w.handle({ type: "drop", point: top(w), paint: paint("blue") }); }
w.updateMeanDye();
const T = transmit(w.meanDye);
check("yellow + blue reads green (Beer-Lambert)", T[1] > T[0] && T[1] > T[2], `T = ${T.map((v) => v.toFixed(3)).join(", ")}`);
w = new JellyWorld({ base: "clear" });
for (let i = 0; i < 4; i++) { w.handle({ type: "drop", point: top(w), paint: paint("red") }); w.handle({ type: "drop", point: top(w), paint: paint("yellow") }); }
const T2 = transmit(w.meanDye);
check("red + yellow reads orange", T2[0] > T2[1] && T2[1] > T2[2], `T = ${T2.map((v) => v.toFixed(3)).join(", ")}`);

// 3) proportionality: twice the drops → twice the added absorption
w = new JellyWorld({ base: "clear" });
const base = w.meanDye.slice();
w.handle({ type: "drop", point: top(w), paint: paint("purple") }); w.updateMeanDye();
const one = w.meanDye.map((v, c) => v - base[c]);
w.handle({ type: "drop", point: top(w), paint: paint("purple") }); w.updateMeanDye();
const two = w.meanDye.map((v, c) => v - base[c]);
check("colour change is proportional to the amount dropped", Math.max(...[0, 1, 2].map((c) => Math.abs(two[c] / one[c] - 2))) < 1e-9);

// 4) water lightens
w = new JellyWorld({ base: "berry" });
const pb = w.totalPigment();
for (let i = 0; i < 5; i++) w.handle({ type: "drop", point: top(w), paint: paint("water") });
const pw = w.totalPigment();
check("water drops dilute the pigment", pw.every((v, c) => v < pb[c]), `berry G pigment ${(pb[1]).toFixed(3)} → ${(pw[1]).toFixed(3)}`);
w.handle({ type: "base", base: "mint" });
check("base change resets the colour", Math.abs(w.meanDye[0] - BASES.mint[0]) < 1e-9);

// 5) gems
w = new JellyWorld(); run(w, 0.5);
w.handle({ type: "gemScatter", count: 12 });
const gemCount = w.gems.length;
check("scatter places gems", gemCount >= 10, `${gemCount} gems`);
const u0 = w.gems.map((g) => g.u.slice());
let clinks = 0;
run(w, 5, () => { if (Math.random() < 0.06) w.handle({ type: "nudge" }); clinks += w.events.filter((e) => e.type === "clink").length; drain(w); });
const moved = w.gems.reduce((t, g, i) => t + Math.hypot(g.u[0] - u0[i][0], g.u[1] - u0[i][1], g.u[2] - u0[i][2]), 0) / gemCount;
check("all gems remain inside the jelly", w.gems.every((g) => w.type.locator.locate(g.u[0], g.u[1], g.u[2]) >= 0));
check("shaking makes gems wander through the jelly", moved > 0.001, `mean drift ${(moved * 1000).toFixed(1)} mm`);
run(w, 3);
const rest0 = w.gems.map((g) => g.u.slice());
run(w, 2);
const restDrift = Math.max(...w.gems.map((g, i) => Math.hypot(g.u[0] - rest0[i][0], g.u[1] - rest0[i][1], g.u[2] - rest0[i][2])));
check("gems stay suspended when the jelly rests", restDrift < 1e-4, `max drift ${(restDrift * 1000).toFixed(3)} mm`);
let worst = 0;
for (let i = 0; i < w.gems.length; i++) for (let j = i + 1; j < w.gems.length; j++) {
  const a = w.gems[i], b = w.gems[j];
  worst = Math.max(worst, 1 - Math.hypot(a.wpos[0] - b.wpos[0], a.wpos[1] - b.wpos[1], a.wpos[2] - b.wpos[2]) / (a.radius + b.radius));
}
check("gems keep their spacing (overlap < 25 %)", worst < 0.25, `worst ${(worst * 100).toFixed(1)} %`);
check("moving gems clink", clinks > 0, `${clinks} clinks`);
const states = w.gemStates(new Float32Array(gemCount * 10));
check("gem states finite", Array.from(states).every(Number.isFinite));
w.handle({ type: "gemScatter", count: 20 });
check("gem capacity is enforced", w.gems.length <= w.gemCapacity, `${w.gems.length}/${w.gemCapacity}`);

// 5b) scattered gems fall from the air and land inside
w = new JellyWorld(); run(w, 0.5); drain(w);
w.handle({ type: "gemScatter", count: 5 });
const startY = Math.min(...w.gems.map((g) => g.wpos[1]));
check("scattered gems start above the jelly", startY > w.body.bounds[4], `lowest ${(startY * 1000).toFixed(0)} mm vs top ${(w.body.bounds[4] * 1000).toFixed(0)} mm`);
let landed = 0; run(w, 0.15); const midFall = w.gems.some((g) => g.fall);
run(w, 2, () => { landed += w.events.filter((e) => e.type === "gemLand").length; drain(w); });
check("gems are in flight shortly after scattering", midFall);
check("every gem lands and sticks in", landed === 5 && w.gems.every((g) => !g.fall), `${landed} landings`);
const inside = w.gems.every((g) => g.wpos[1] < w.body.bounds[4] && g.wpos[1] > w.body.bounds[1]);
check("landed gems sit within the jelly", inside);

// 5c) bounce and multi-finger grabs
w = new JellyWorld(); run(w, 1.5);
const y0 = w.body.center[1];
w.handle({ type: "bounce", strength: 1 }); let peak = y0;
run(w, 0.6, () => { peak = Math.max(peak, w.body.center[1]); });
check("통통 lifts the jelly", peak - y0 > 0.01, `+${((peak - y0) * 1000).toFixed(1)} mm`);
run(w, 2.5);
check("it settles back after bouncing", Math.abs(w.body.center[1] - y0) < 0.002 && w.body.isFinite());
const tri = (i) => { const ix = w.type.stencils.indices; return [ix[i * 3], ix[i * 3 + 1], ix[i * 3 + 2]]; };
const surf = (a) => [w.body.positions[a * 3], w.body.positions[a * 3 + 1], w.body.positions[a * 3 + 2]];
let left = 0, right = 0;
for (let i = 0; i < w.type.stencils.indices.length / 3; i++) { const p = surf(tri(i)[0]); if (p[0] < surf(tri(left)[0])[0]) left = i; if (p[0] > surf(tri(right)[0])[0]) right = i; }
const width0 = w.body.bounds[3] - w.body.bounds[0];
for (const [id, t, dx] of [[1, left, -0.03], [2, right, 0.03]]) {
  const [a, b, c] = tri(t), p = surf(a);
  w.handle({ type: "grabStart", id, a, b, c, bary: [1, 0, 0], point: p });
  w.handle({ type: "target", id, point: [p[0] + dx, p[1] + 0.01, p[2]] });
}
run(w, 1.2);
const width1 = w.body.bounds[3] - w.body.bounds[0];
check("two fingers stretch the jelly both ways", width1 > width0 + 0.02, `width ${(width0 * 1000).toFixed(0)} → ${(width1 * 1000).toFixed(0)} mm`);
w.handle({ type: "grabEnd", id: 1 }); run(w, 0.2);
check("lifting one finger keeps the other grab", w.grabbing && w.body.grab && !w.body.extraGrabs.length);
w.handle({ type: "grabEnd", id: 2 }); run(w, 3);
check("released jelly stays finite and calm", w.body.isFinite() && !w.grabbing);

// 6) cost (awake, 240 Hz, with gems and an active dye field)
w = new JellyWorld(); run(w, 0.3);
w.handle({ type: "gemScatter", count: 12 });
let steps = 0, ms = 0;
for (let t = 0; t < 3; t += dt) {
  if (w.body.sleeping) w.handle({ type: "nudge" });
  if (Math.random() < 0.05) w.handle({ type: "drop", point: top(w), paint: Math.floor(Math.random() * 6) });
  const started = performance.now(); const r = w.advance(dt); ms += performance.now() - started; steps += r.steps;
}
const perSecond = ms / (steps / 240);
console.log(`perf  jelly + 12 gems + dye: ${(ms / steps).toFixed(3)} ms/step incl. per-tick work → ${(perSecond / 10).toFixed(0)} % of one core`);
check("fits a worker comfortably (< 60 % of a core here)", perSecond < 600, `${perSecond.toFixed(0)} ms per simulated second`);

console.log(failures ? `\n${failures} FAILED` : "\nALL WORLD CHECKS PASSED");
process.exit(failures ? 1 : 0);
