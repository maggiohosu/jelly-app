// JellyWorld: paint drops (exact pigment bookkeeping, subtractive mixing,
// diffusion, water dilution), gem containment / suspension / clinks, the
// animal shapes' idle motions and expressions, the bunny's kick, rare-gem
// events, plain bases, cost.
import { JellyWorld, PAINTS, BASES, DECOR_KINDS } from "../src/core/world.js";
import { SHAPES, signatureSigma } from "../src/core/shapes.js";

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

// 5d) 슬랑이 texture: softer and saggier, keeps a pulled shape, rounds back, beads
w = new JellyWorld(); run(w, 2);
const jellyH = w.body.bounds[4] - w.body.bounds[1];
w.handle({ type: "texture", texture: "slime" }); run(w, 6);
const slimeH = w.body.bounds[4] - w.body.bounds[1];
check("slime sags (lower than jelly)", slimeH < jellyH * 0.85 && slimeH > jellyH * 0.5, `${(jellyH * 1000).toFixed(1)} → ${(slimeH * 1000).toFixed(1)} mm`);
check("slime has foam beads", w.beads && w.beads.count >= 150, `${w.beads?.count}`);
const bs = w.beadStates(new Float32Array(w.beads.count * 4));
check("bead positions finite and inside the slime bounds", Array.from(bs).every(Number.isFinite) && (() => { const b = w.body.bounds; for (let i = 0; i < w.beads.count; i++) { const y = bs[i * 4 + 1]; if (y < b[1] - 1e-3 || y > b[4] + 1e-3) return false; } return true; })());
const widthOf = () => w.body.bounds[3] - w.body.bounds[0];
const w0 = widthOf();
{
  const ix = w.type.stencils.indices; let k = 0;
  for (let i = 0; i < ix.length / 3; i++) if (w.body.positions[ix[i * 3] * 3] > w.body.positions[ix[k * 3] * 3]) k = i;
  const [a, b, c] = [ix[k * 3], ix[k * 3 + 1], ix[k * 3 + 2]], p = [w.body.positions[a * 3], w.body.positions[a * 3 + 1], w.body.positions[a * 3 + 2]];
  w.handle({ type: "grabStart", id: 1, a, b, c, bary: [1, 0, 0], point: p });
  w.handle({ type: "target", id: 1, point: [p[0] + 0.04, p[1] + 0.01, p[2]] });
}
run(w, 1.5); w.handle({ type: "grabEnd", id: 1 }); run(w, 1.5);
const wHeld = widthOf();
check("slime keeps the pulled shape after release", wHeld > w0 + 0.012, `${(w0 * 1000).toFixed(0)} → ${(wHeld * 1000).toFixed(0)} mm`);
run(w, 25);
const wRound = widthOf();
check("then slowly rounds back", wRound < wHeld - 0.006, `${(wHeld * 1000).toFixed(0)} → ${(wRound * 1000).toFixed(0)} mm after 25 s`);
run(w, 10);
check("and eventually sleeps (no endless CPU)", w.body.sleeping);
w.handle({ type: "texture", texture: "jelly" }); run(w, 4);
const backH = w.body.bounds[4] - w.body.bounds[1];
check("switching back to jelly restores its shape", Math.abs(backH - jellyH) < 0.0015 && w.body.isFinite(), `${(backH * 1000).toFixed(1)} mm`);

// 5e) bunny: grab with two paws, lift, bite (caves in + eats gems), new paints, additives, rare gems
w = new JellyWorld(); run(w, 1);
w.handle({ type: "gemScatter", count: 6 }); run(w, 2.5); drain(w);
w.handle({ type: "gemScatter", count: 1, rare: { index: 3, tier: 2 }, radius: 0.0048 }); run(w, 2.5);
const rareGem = w.gems.find((g) => g.rare);
const gs = w.gemStates(new Float32Array(w.gems.length * 10));
check("rare gem is encoded in the gem states (tier ≥ 100)", rareGem && Array.from({ length: w.gems.length }, (_, i) => gs[i * 10 + 1]).includes(102));
for (let i = 0; i < 8; i++) w.handle({ type: "gemScatter", count: 1, rare: { index: i, tier: 0 }, radius: 0.0048 });
check("at most 8 rare gems per jelly", w.rareCount <= 8 && w.events.some((e) => e.type === "rareFull"), `${w.rareCount}`);
drain(w);
const meshVolume = () => { const P = w.body.positions, I = w.type.stencils.indices; let v = 0; for (let t = 0; t < I.length; t += 3) { const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3; v += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6; } return Math.abs(v); };
const vol0 = meshVolume();
const c0 = w.body.center.slice(), b0 = Array.from(w.body.bounds);
w.handle({ type: "grabNear", id: "L", point: [b0[0], c0[1], c0[2]] });
w.handle({ type: "grabNear", id: "R", point: [b0[3], c0[1], c0[2]] });
check("two paw grabs attach", w.grabs.size === 2);
for (let t = 0; t < 1.2; t += dt) {
  const k = Math.min(1, t / 0.8);
  w.handle({ type: "target", id: "L", point: [b0[0] + 0.004, c0[1] + 0.05 * k, c0[2]] });
  w.handle({ type: "target", id: "R", point: [b0[3] - 0.004, c0[1] + 0.05 * k, c0[2]] });
  w.advance(dt);
}
check("the paws lift the jelly", w.body.center[1] > c0[1] + 0.025, `+${((w.body.center[1] - c0[1]) * 1000).toFixed(0)} mm`);
const widthBefore = w.body.bounds[3] - w.body.bounds[0], gemsBefore = w.gems.length;
const mouth = [w.body.center[0], w.body.center[1] + 0.004, w.body.bounds[5] + 0.004];
let eatenCount = 0;
for (let i = 0; i < 4; i++) {
  const m = [mouth[0] + (i - 1.5) * 0.012, mouth[1], w.body.bounds[5] + 0.003];
  w.handle({ type: "bite", center: m });
  eatenCount += w.events.filter((e) => e.type === "bitten").reduce((n, e) => n + e.eaten.length, 0); drain(w);
  run(w, 0.5);
}
const vol1 = meshVolume();
check("bites cave the jelly in (it gets visibly smaller)", vol1 < vol0 * 0.45, `volume ${(vol0 * 1e6).toFixed(0)} → ${(vol1 * 1e6).toFixed(0)} cm³`);
check("bitten jelly stays stable", w.body.isFinite());
check("gems inside the bites are eaten", w.gems.length <= gemsBefore, `${gemsBefore} → ${w.gems.length} (${eatenCount} eaten)`);
w.handle({ type: "grabEnd" }); run(w, 1);
w.handle({ type: "reset", base: "berry", lift: 0.05 });
check("a new jelly appears (lifted, then drops)", w.body.center[1] > 0.05 && w.gems.length === 0);
run(w, 2);
check("…and lands on the tray", w.body.center[1] < 0.03 && w.body.isFinite());
w.handle({ type: "drop", point: top(w), paint: paint("pearl") });
w.handle({ type: "drop", point: top(w), paint: paint("glow") });
const fx = w.computeShellFx();
check("pearl and glow paints carry their effect", Math.max(...Array.from(fx).filter((_, i) => i % 2 === 0)) > 0.3 && Math.max(...Array.from(fx).filter((_, i) => i % 2 === 1)) > 0.3);
w.handle({ type: "additive", kind: "glitter", point: top(w) });
w.handle({ type: "additive", kind: "stars", point: top(w) });
const nAdd = w.additiveCount(), as = w.additiveStates(new Float32Array(nAdd * 5));
check("glitter and star candies are added", w.additives.glitter.length >= 60 && w.additives.stars.length >= 4, `${w.additives.glitter.length} glitter, ${w.additives.stars.length} stars`);
check("additive positions are finite and on/in the jelly", Array.from(as).every(Number.isFinite) && (() => { const b = w.body.bounds; for (let i = 0; i < nAdd; i++) { const y = as[i * 5 + 1]; if (y < b[1] - 0.002 || y > b[4] + 0.002) return false; } return true; })());

// 5f) carry: the bunny holds the whole jelly — it rises as one piece, no stretching
{
  const c = new JellyWorld(); run(c, 2);
  const size = () => { const b = c.body.bounds; return [b[3] - b[0], b[4] - b[1], b[5] - b[2]]; };
  // compare with the rest shape: off the floor the jelly un-sags back to it (that is not stretching)
  const r = c.body.rest, s0 = [0, 1, 2].map((k) => { let lo = Infinity, hi = -Infinity; for (let i = k; i < r.length; i += 3) { lo = Math.min(lo, r[i]); hi = Math.max(hi, r[i]); } return hi - lo; });
  const y0 = c.body.center[1], x0 = c.body.center[0];
  let worst = 0;
  const target = [x0 + 0.02, y0 + 0.06, c.body.center[2]];
  c.handle({ type: "carry", target });
  for (let t = 0; t < 1.5; t += dt) {
    c.advance(dt);
    const s1 = size();
    worst = Math.max(worst, ...s1.map((v, k) => Math.abs(v / s0[k] - 1)));
  }
  check("carry lifts the jelly to the paws", Math.abs(c.body.center[1] - target[1]) < 0.004 && Math.abs(c.body.center[0] - target[0]) < 0.004, `Δ ${(Math.hypot(c.body.center[0] - target[0], c.body.center[1] - target[1]) * 1000).toFixed(1)} mm`);
  let settledWorst = 0; for (let t = 0; t < 0.3; t += dt) { c.advance(dt); settledWorst = Math.max(settledWorst, ...size().map((v, k) => Math.abs(v / s0[k] - 1))); }
  check("carried jelly keeps its rest shape (no stretching, < 8 % once lifted)", settledWorst < 0.08, `${(settledWorst * 100).toFixed(1)} % (incl. the lift-off jolt: ${(worst * 100).toFixed(1)} %)`);
  // move it around like the bunny does, then put it down
  for (let t = 0; t < 1; t += dt) { c.handle({ type: "carry", target: [x0 + 0.02 * Math.cos(t * 6), y0 + 0.06, 0.01 * Math.sin(t * 6)] }); c.advance(dt); }
  check("still no stretching while swaying (< 10 %)", Math.max(...size().map((v, k) => Math.abs(v / s0[k] - 1))) < 0.10, size().map((v, k) => (v / s0[k]).toFixed(2)).join(" "));
  c.handle({ type: "carry", target: [x0, y0 + 0.002, 0] }); run(c, 1);
  c.handle({ type: "carry", target: null }); run(c, 2);
  check("put down: back on the tray, finite", c.body.isFinite() && c.body.center[1] < y0 + 0.004 && !c.body.carry);
}

// 5g) shapes: each one is a new jelly with its signature look, decorations follow it
for (const sh of SHAPES.filter((x) => x.id !== "flower")) {
  const sw = new JellyWorld(); run(sw, 0.3); drain(sw);
  sw.handle({ type: "gemScatter", count: 4 }); run(sw, 1.5);
  sw.handle({ type: "shape", shape: sh.id });
  const ev = drain(sw);
  check(`${sh.id}: switching shape starts a new jelly`, sw.shape === sh.id && sw.gems.length === 0 && ev.some((e) => e.type === "shape"));
  run(sw, 2.5);
  const nd = sw.decorCount(), ds = sw.decorStates(new Float32Array(nd * 12));
  const b = sw.body.bounds;
  check(`${sh.id}: settles finite on the tray`, sw.body.isFinite() && b[1] < 0.003 && b[1] > -0.001, `min y ${(b[1] * 1000).toFixed(1)} mm`);
  const decorOk = Array.from(ds).every(Number.isFinite) && Array.from({ length: nd }, (_, i) => ds[i * 12 + 2] > b[1] - 0.002 && ds[i * 12 + 2] < b[4] + 0.012 && Math.abs(Math.hypot(ds[i * 12 + 4], ds[i * 12 + 5], ds[i * 12 + 6], ds[i * 12 + 7]) - 1) < 1e-3).every(Boolean);
  check(`${sh.id}: decorations follow the jelly (${nd})`, decorOk);
  const look = sw.type.look;
  const sig = signatureSigma(sh.id);
  check(`${sh.id}: a fresh jelly's mean colour is the order's starting colour (signatureSigma)`, !look.dye || sig.every((v, c) => Math.abs(v - sw.meanDye[c]) < 0.005 * Math.max(1, v)), `${sw.meanDye.map((v) => v.toFixed(2))} vs ${sig}`);
  check(`${sh.id}: signature look applied`, (!look.dye || Math.max(...sw.meanDye) > 3) && sw.additives.glitter.length >= Math.min(look.glitter, 30) && (!look.pearls || sw.beadCount() > look.pearls * 0.6));
  sw.handle({ type: "gemScatter", count: 30 }); run(sw, 3);
  check(`${sh.id}: 24 gems fit`, sw.gems.length >= 18 && sw.gems.length <= 24, `${sw.gems.length}`);
  sw.handle({ type: "carry", target: [sw.body.center[0], 0.07, sw.body.center[2]] }); run(sw, 0.8);
  for (let i = 0; i < 4; i++) { sw.handle({ type: "bite", center: [sw.body.center[0], sw.body.center[1] + 0.01, sw.body.bounds[5] - 0.002] }); run(sw, 0.4); }
  sw.handle({ type: "carry", target: null }); run(sw, 2);
  check(`${sh.id}: carried + 4 bites stays stable`, sw.body.isFinite());
  sw.handle({ type: "texture", texture: "slime" }); run(sw, 4);
  check(`${sh.id}: slime works`, sw.body.isFinite() && sw.beadCount() > 100);
}

// 5h) a shape's signature pattern stays put: paint dropped on the rainbow cake
//     spreads through it, the layers underneath keep their colours
{
  const cw = new JellyWorld(); run(cw, 0.3);
  cw.handle({ type: "shape", shape: "cake" }); run(cw, 1.5); drain(cw);
  const rest = cw.type.cage.pos, n = cw.body.nodeCount;
  const band = (y0, y1) => { const ids = []; for (let i = 0; i < n; i++) if (rest[i * 3 + 1] > y0 && rest[i * 3 + 1] < y1) ids.push(i); return ids; };
  const blue = band(0.0160, 0.0210), yellow = band(0.0295, 0.0345);
  const meanRed = (ids) => ids.reduce((a, i) => a + cw.dye[i * 3], 0) / ids.length;
  const contrast0 = meanRed(blue) - meanRed(yellow);
  for (let k = 0; k < 3; k++) { cw.handle({ type: "drop", point: top(cw), paint: k }); run(cw, 0.4); }
  const pig0 = cw.totalPigment();
  for (let t = 0; t < 20; t += 1) { cw.handle({ type: "nudge" }); run(cw, 1); }
  const pig1 = cw.totalPigment(), contrast1 = meanRed(blue) - meanRed(yellow);
  check("cake layers stay layered after paint is dropped and stirred (≥ 80 % of the contrast)", blue.length > 5 && yellow.length > 5 && contrast1 > 0.8 * contrast0,
    `blue − yellow red absorption ${contrast0.toFixed(1)} → ${contrast1.toFixed(1)} 1/m`);
  check("the dropped paint still spreads and pigment is conserved", pig1.every((v, c) => Math.abs(v - pig0[c]) < 1e-9 * Math.max(1, pig0[c])) && !cw.dyeActive,
    pig0.map((v, c) => `${(v * 1e6).toFixed(3)}→${(pig1[c] * 1e6).toFixed(3)}`).join(" "));
}

// 7) v8: idle motions of the animal shapes (cat: yawn / 냥냥펀치 every 5 s,
//    bird: flap / 짹짹짹 every 7 s), expressions, kick, rare-gem events, plain
{
  const det6 = (x, a, b, c, d) => { const ax = x[a * 3], ay = x[a * 3 + 1], az = x[a * 3 + 2]; const bx = x[b * 3] - ax, by = x[b * 3 + 1] - ay, bz = x[b * 3 + 2] - az, cx = x[c * 3] - ax, cy = x[c * 3 + 1] - ay, cz = x[c * 3 + 2] - az, dx = x[d * 3] - ax, dy = x[d * 3 + 1] - ay, dz = x[d * 3 + 2] - az; return bx * (cy * dz - cz * dy) - cx * (by * dz - bz * dy) + dx * (by * cz - bz * cy); };
  const inverted = (b) => { let n = 0; for (let e = 0; e < b.elementCount; e++) if (det6(b.x, b.ids[e * 4], b.ids[e * 4 + 1], b.ids[e * 4 + 2], b.ids[e * 4 + 3]) <= 0) n++; return n; };
  const starts = (w, seconds) => { const out = []; run(w, seconds, () => { for (const e of drain(w)) if (e.type === "motion") out.push({ t: w.time, ...e }); }); return out; };
  const kinds = (w) => { const n = w.decorCount(), d = w.decorStates(new Float32Array(n * 12)); return Array.from({ length: n }, (_, i) => ({ kind: DECOR_KINDS[d[i * 12]], scale: d[i * 12 + 8], name: w.decor[i].name, p: [d[i * 12 + 1], d[i * 12 + 2], d[i * 12 + 3]] })); };
  check("DECOR_KINDS: the 8 kinds, the 4 expressions, then whisker / strawberry (append only)", DECOR_KINDS.join() === "eye,nose,mouth,blush,muzzle,earInner,cherry,beak,eyeClosed,eyeHappy,mouthOpen,beakOpen,whisker,strawberry");

  // the timer: start to start, in sim time, never for the flower or while disabled
  for (const [shape, interval, moves] of [["cat", 5, ["yawn", "punch"]], ["bird", 7, ["flap", "chirp"]]]) {
    const w = new JellyWorld({ shape }); const t0 = w.time || 0; drain(w);
    const s = starts(w, interval * 4 + 1.5);
    const gaps = s.slice(1).map((e, i) => e.t - s[i].t);
    check(`${shape}: an idle motion every ${interval} s (${moves.join(" / ")})`, s.length === 4 && Math.abs(s[0].t - t0 - interval) < 0.02 && gaps.every((g) => Math.abs(g - interval) < 0.02) && s.every((e) => moves.includes(e.name) && e.shape === shape && e.duration > 0.5 && e.duration < 2.5),
      `${s.map((e) => `${e.name}@${(e.t - t0).toFixed(2)}`).join(" ")}`);
    w.handle({ type: "motions", enabled: false });
    check(`${shape}: no motion while disabled`, starts(w, interval * 2 + 1).length === 0 && !w.motion);
    w.handle({ type: "motions", enabled: true });
    const again = starts(w, interval + 0.1);
    check(`${shape}: re-enabled — the timer starts over`, again.length === 1 && Math.abs(again[0].t - (w.time - 0.1)) < 0.05);
  }
  {
    const w = new JellyWorld(); drain(w);
    w.handle({ type: "motionNow", name: "yawn" });
    check("flower: never moves on its own (no idle motions, motionNow ignored)", starts(w, 16).length === 0 && !w.type.motions && w.motionIn() === null);
  }
  // also while a finger holds it
  {
    const w = new JellyWorld({ shape: "cat" }); run(w, 1); drain(w);
    const ix = w.type.stencils.indices, [a, b, c] = [ix[0], ix[1], ix[2]], p = [w.body.positions[a * 3], w.body.positions[a * 3 + 1], w.body.positions[a * 3 + 2]];
    w.handle({ type: "grabStart", id: 1, a, b, c, bary: [1, 0, 0], point: p });
    w.handle({ type: "target", id: 1, point: [p[0], p[1] + 0.01, p[2]] });
    const s = starts(w, 4.5);
    check("cat: the timer runs while it is held, a motion plays under the finger", s.length === 1 && w.grabbing && w.body.isFinite());
    w.handle({ type: "grabEnd", id: 1 }); run(w, 2);
  }

  // cues for sound sync, and expressions swapped on the face, then back
  for (const [shape, name, want, swaps] of [
    ["cat", "yawn", { open: 1, stretch: 1 }, { at: 0.7, eye: "eyeClosed", mouth: "mouthOpen" }],
    ["cat", "punch", { punch: 4 }, { at: 0.5, eye: "eyeHappy", mouth: "mouthOpen" }],
    ["bird", "flap", { flap: 1, hop: 2, plop: 1 }, { at: 1.8, eye: "eyeHappy" }],
    ["bird", "chirp", { chirp: 3 }, { at: 0.2, eye: "eyeHappy", beak: "beakOpen" }],
  ]) {
    const w = new JellyWorld({ shape }); w.handle({ type: "motions", enabled: false }); run(w, 2); drain(w);
    const before = kinds(w), v0 = w.decorVersion;
    w.handle({ type: "motionNow", name });
    const ev = drain(w);
    run(w, swaps.at);
    const mid = kinds(w), cues = {};
    for (const e of [...ev, ...drain(w)]) if (e.type === "motionCue" && e.name === name) cues[e.cue] = (cues[e.cue] || 0) + 1;
    run(w, 2.6);
    for (const e of drain(w)) if (e.type === "motionCue" && e.name === name) cues[e.cue] = (cues[e.cue] || 0) + 1;
    const after = kinds(w);
    const swapOk = Object.entries(swaps).filter(([k]) => k !== "at").every(([role, kind]) => mid.filter((d) => d.name === role).length > 0 && mid.filter((d) => d.name === role).every((d) => d.kind === kind));
    const eyeSize = mid.filter((d) => d.name === "eye").every((d) => Math.abs(d.scale - before.find((b) => b.name === "eye").scale) < 1e-9);
    check(`${shape} ${name}: "motion" + cues ${JSON.stringify(want)}`, ev.some((e) => e.type === "motion" && e.name === name && e.shape === shape) && Object.entries(want).every(([k, n]) => cues[k] === n), JSON.stringify(cues));
    check(`${shape} ${name}: expressions swapped in mid-motion (${Object.entries(swaps).filter(([k]) => k !== "at").map(([k, v]) => `${k}→${v}`).join(", ")}), eyes keep their size`, swapOk && eyeSize && w.decorVersion !== v0, mid.map((d) => d.kind).join(" "));
    check(`${shape} ${name}: and back to the normal face afterwards`, after.every((d, i) => d.kind === before[i].kind && Math.abs(d.scale - before[i].scale) < 1e-12) && !w.motion && w.body.extraGrabs.length === 0);
  }
  {
    // the yawn's mouth opens wide and closes again
    const w = new JellyWorld({ shape: "cat" }); w.handle({ type: "motions", enabled: false }); run(w, 1);
    const base = kinds(w).find((d) => d.name === "mouth").scale;
    w.handle({ type: "motionNow", name: "yawn" });
    let widest = 0; run(w, 1.8, () => { const m = kinds(w).find((d) => d.name === "mouth"); if (m.kind === "mouthOpen") widest = Math.max(widest, m.scale / base); });
    check("cat yawn: the mouth opens wide (scaled up) then closes", widest > 1.4, `× ${widest.toFixed(2)}`);
  }

  // the jelly visibly acts: the head rises in a yawn, the paws jab forward, the bird hops
  {
    const regionAt = (w, name) => { const r = w.type.regions[name], x = w.body.x, m = w.body.mass; let s = 0; const p = [0, 0, 0]; for (let k = 0; k < r.ids.length; k++) { const q = r.w[k] * m[r.ids[k]]; s += q; for (let a = 0; a < 3; a++) p[a] += x[r.ids[k] * 3 + a] * q; } return p.map((v) => v / s); };
    const peak = (shape, name, region, axis, seconds) => {
      const w = new JellyWorld({ shape }); w.handle({ type: "motions", enabled: false }); run(w, 2);
      const p0 = regionAt(w, region), c0 = w.body.center.slice();
      w.handle({ type: "motionNow", name });
      // relative to the jelly's centre (a hop lifts everything)
      let best = 0; run(w, seconds, () => { const p = regionAt(w, region); best = Math.max(best, (p[axis] - p0[axis]) - (w.body.center[axis] - c0[axis])); });
      return best;
    };
    const head = peak("cat", "yawn", "head", 1, 1.2), paw = peak("cat", "punch", "pawL", 2, 0.5), hop = peak("bird", "flap", "wingR", 1, 1.4);
    check("motions read: a yawn lifts the head ≥ 4 mm, a punch jabs a paw ≥ 4 mm forward, the bird's wing flaps ≥ 4 mm up", head > 0.004 && paw > 0.004 && hop > 0.004, `${(head * 1000).toFixed(1)} / ${(paw * 1000).toFixed(1)} / ${(hop * 1000).toFixed(1)} mm`);
  }

  // 60 s with the motions on (a move every 5 / 7 s): stable, sane volume, no
  // inside-out mess (a plain bounce turns ~165 tets inside out for a moment),
  // and the jelly stays where it was
  for (const [shape, texture] of [["cat", "jelly"], ["bird", "jelly"], ["cat", "slime"], ["bird", "slime"]]) {
    const w = new JellyWorld({ shape, texture }); w.handle({ type: "motions", enabled: false }); run(w, texture === "slime" ? 5 : 2);
    const b = w.body, inv0 = inverted(b), c0 = b.center.slice(), slime = texture === "slime";
    let n = 0, worst = 0, lo = Infinity, hi = 0, finite = true, k = 0;
    w.handle({ type: "motions", enabled: true });
    run(w, 60, () => {
      for (const e of drain(w)) if (e.type === "motion") n++;
      if (++k % 30 === 0) { worst = Math.max(worst, inverted(b)); const v = b.volumeRatio(); lo = Math.min(lo, v); hi = Math.max(hi, v); finite &&= b.isFinite(); }
    });
    w.handle({ type: "motions", enabled: false }); run(w, 3);
    const drift = Math.hypot(b.center[0] - c0[0], b.center[2] - c0[2]), invEnd = inverted(b);
    const endLimit = slime ? Math.round(0.01 * b.elementCount) : inv0 + 2;
    check(`${shape} (${texture}): 60 s of idle motions (${n}) — finite, volume 0.88–1.06, ≤ ${slime ? 120 : 60} tets inside out at worst, ≤ ${endLimit} once settled`, n === (shape === "cat" ? 12 : 8) && finite && b.isFinite() && lo > 0.88 && hi < 1.06 && worst <= (slime ? 120 : 60) && invEnd <= endLimit,
      `volume ${lo.toFixed(3)}–${hi.toFixed(3)}, inverted ${inv0} → worst ${worst} → ${invEnd}`);
    check(`${shape} (${texture}): …and it stays where it was (< 4 mm), on the tray`, drift < 0.004 && b.bounds[1] > -0.001 && b.bounds[1] < 0.002, `drift ${(drift * 1000).toFixed(2)} mm`);
  }

  // cancelled cleanly by a new jelly, a new shape, or switching motions off
  for (const how of ["reset", "shape", "off"]) {
    const w = new JellyWorld({ shape: "cat" }); run(w, 1);
    w.handle({ type: "motionNow", name: "yawn" }); run(w, 0.6);
    const mid = w.motion && kinds(w).some((d) => d.kind === "eyeClosed");
    if (how === "reset") w.handle({ type: "reset", base: "berry" });
    else if (how === "shape") w.handle({ type: "shape", shape: "bird" });
    else w.handle({ type: "motions", enabled: false });
    const face = kinds(w).every((d) => !["eyeClosed", "eyeHappy", "mouthOpen", "beakOpen"].includes(d.kind));
    run(w, 2);
    check(`a motion is cancelled cleanly by ${how}`, mid && !w.motion && face && w.body.extraGrabs.length === 0 && w.body.isFinite() && (how !== "off" || w.motionIn() === null));
  }

  // asleep and not ticked: idle() keeps the timer going (the worker's self-wake)
  {
    const w = new JellyWorld({ shape: "bird" }); run(w, 3); drain(w);
    const left = w.motionIn();
    w.idle(left - 0.5);
    const early = drain(w).some((e) => e.type === "motion");
    w.idle(0.6);
    check("idle(): wall time while nobody ticks starts the motion when due", w.body.sleeping === false && !early && drain(w).some((e) => e.type === "motion") && w.motion, `motionIn was ${left.toFixed(2)} s`);
  }

  // the bunny's kick: tumbles across the tray, hits the rim and stays there
  for (const shape of ["flower", "cat", "bird"]) {
    const w = new JellyWorld({ shape }); w.handle({ type: "motions", enabled: false }); run(w, 2); drain(w);
    const c0 = w.body.center.slice();
    w.handle({ type: "kick", dir: [0.8, -0.6], strength: 0.8 });
    const kicked = drain(w).some((e) => e.type === "kicked");
    let inside = true, finite = true, maxR = 0;
    run(w, 6, () => { const x = w.body.x; for (let i = 0; i < w.body.nodeCount; i++) { const r = Math.hypot(x[i * 3], x[i * 3 + 2]); maxR = Math.max(maxR, r); if (r > w.wallRadius + 1e-9) inside = false; } finite &&= w.body.isFinite(); });
    const moved = Math.hypot(w.body.center[0] - c0[0], w.body.center[2] - c0[2]), along = ((w.body.center[0] - c0[0]) * 0.8 - (w.body.center[2] - c0[2]) * 0.6);
    check(`${shape}: a kick sends it ≥ 20 mm across the tray (along the kick), into the rim, and it settles`, kicked && moved > 0.02 && along > 0.015 && inside && finite && w.body.sleeping && maxR > w.wallRadius - 0.003,
      `moved ${(moved * 1000).toFixed(0)} mm, reaches r ${(maxR * 1000).toFixed(1)} of ${(w.wallRadius * 1000).toFixed(0)} mm, asleep ${w.body.sleeping}`);
  }

  // rare gems: rareIn when really placed, rejections name the gem, reset lists the ones left
  {
    const w = new JellyWorld();
    const first = drain(w).find((e) => e.type === "reset");
    check("the very first jelly's reset event lists no rare gems", first && Array.isArray(first.rare) && first.rare.length === 0);
    run(w, 1);
    w.handle({ type: "gemScatter", count: 1, rare: { index: 3, tier: 1 }, radius: 0.0048 });
    const ix = w.type.stencils.indices;
    let t = 0; for (let k = 0; k < ix.length / 3; k++) if (w.body.positions[ix[k * 3] * 3 + 1] > w.body.positions[ix[t * 3] * 3 + 1]) t = k;
    w.handle({ type: "gemAdd", a: ix[t * 3], b: ix[t * 3 + 1], c: ix[t * 3 + 2], bary: [1 / 3, 1 / 3, 1 / 3], shape: 0, color: 0, radius: 0.0048, rare: { index: 5, tier: 0 } });
    w.handle({ type: "gemScatter", count: 2 });
    const ev = drain(w), ins = ev.filter((e) => e.type === "rareIn");
    check("rareIn for every rare gem placed (scatter and drop), none for normal gems", ins.length === 2 && ins[0].index === 3 && ins[0].tier === 1 && ins[1].index === 5 && ins[1].tier === 0, JSON.stringify(ins));
    run(w, 2);
    for (let i = 0; w.rareCount < 8 && i < 30; i++) w.handle({ type: "gemScatter", count: 1, rare: { index: 10 + (i % 8), tier: 2 }, radius: 0.0048 });
    drain(w);
    w.handle({ type: "gemScatter", count: 1, rare: { index: 20, tier: 1 }, radius: 0.0048 });
    w.handle({ type: "gemAdd", a: ix[t * 3], b: ix[t * 3 + 1], c: ix[t * 3 + 2], bary: [1 / 3, 1 / 3, 1 / 3], shape: 0, color: 0, radius: 0.0048, rare: { index: 21, tier: 0 } });
    const rej = drain(w);
    check("a rejected rare gem is named in the rejection (rareFull {rare: {index, tier}}), no rareIn", w.rareCount === 8 && !rej.some((e) => e.type === "rareIn") && rej.some((e) => e.type === "rareFull" && e.rare?.index === 20 && e.rare.tier === 1) && rej.some((e) => e.type === "rareFull" && e.rare?.index === 21 && e.rare.tier === 0), JSON.stringify(rej.filter((e) => e.type !== "clink")));
    run(w, 2);
    const left = w.gems.filter((g) => g.rare).map((g) => `${g.shape}:${g.tier}`).sort().join();
    w.handle({ type: "reset", base: "mint" });
    const r1 = drain(w).find((e) => e.type === "reset");
    check("reset lists the rare gems still in the old jelly (for the refund)", r1 && r1.rare.length === 8 && r1.rare.map((g) => `${g.index}:${g.tier}`).sort().join() === left, JSON.stringify(r1?.rare));
    w.handle({ type: "gemScatter", count: 1, rare: { index: 7, tier: 2 }, radius: 0.0048 }); run(w, 1.5); drain(w);
    w.handle({ type: "shape", shape: "cake" });
    const r2 = drain(w);
    check("a shape change is a new jelly too: reset {rare} then shape", r2.findIndex((e) => e.type === "reset" && e.rare.length === 1 && e.rare[0].index === 7 && e.rare[0].tier === 2) < r2.findIndex((e) => e.type === "shape"));
    w.handle({ type: "reset", base: "berry" });
    check("…and the next reset lists none", drain(w).find((e) => e.type === "reset").rare.length === 0);
  }

  // plain: a plain base colour on a shaped jelly — the layers go, the cherry and glitter stay
  {
    const w = new JellyWorld({ shape: "cake" });
    const layered = w.lookDye !== null && Math.abs(w.meanDye[0] - signatureSigma("cake")[0]) < 0.1;
    w.handle({ type: "reset", base: "mint", plain: true });
    const spread = (() => { let lo = Infinity, hi = -Infinity; for (let i = 0; i < w.body.nodeCount; i++) { lo = Math.min(lo, w.dye[i * 3]); hi = Math.max(hi, w.dye[i * 3]); } return hi - lo; })();
    check("plain reset on a cake: uniform base colour, no signature pattern", layered && w.lookDye === null && spread < 1e-9 && Math.abs(w.meanDye[0] - BASES.mint[0]) < 1e-9);
    check("…the cherry and the glitter stay", w.decor.some((d) => d.name === "cherry") && w.additives.glitter.length > 30);
    w.handle({ type: "shape", shape: "bird", base: "honey", plain: true });
    check("plain shape change: the bird's pattern is replaced by the base, its face and sheen stay", w.lookDye === null && Math.abs(w.meanDye[2] - BASES.honey[2]) < 1e-9 && w.decor.length === 3 && w.meanFx[0] > 0.7);
    w.handle({ type: "reset", base: "berry" });
    check("a normal reset brings the signature look back", w.lookDye !== null && Math.abs(w.meanDye[1] - signatureSigma("bird")[1]) < 0.1);
  }

  // meanFx: mass-weighted [pearl, glow]
  {
    const w = new JellyWorld({ base: "clear" }); run(w, 0.3);
    const z = w.meanFx.slice();
    w.handle({ type: "drop", point: top(w), paint: paint("pearl") });
    w.handle({ type: "drop", point: top(w), paint: paint("glow") });
    const m = w.body.mass, M = w.body.totalMass; let p = 0, g = 0;
    for (let i = 0; i < w.body.nodeCount; i++) { p += w.fx[i * 2] * m[i] / M; g += w.fx[i * 2 + 1] * m[i] / M; }
    check("meanFx = mass-weighted mean [pearl, glow]", z[0] === 0 && z[1] === 0 && w.meanFx[0] > 0.005 && w.meanFx[1] > 0.005 && Math.abs(w.meanFx[0] - p) < 1e-12 && Math.abs(w.meanFx[1] - g) < 1e-12, w.meanFx.map((v) => v.toFixed(4)).join(", "));
  }
}

// 8) v9: the strawberry jelly cat — its look, paint on it, gems around its
//    strawberries (decor, never gems), all of it through motions and bites
{
  const inside = (w, g) => w.type.locator.locate(g.u[0], g.u[1], g.u[2]) >= 0;
  const berries = (w) => w.decor.filter((d) => d.name === "strawberry");
  {
    const w = new JellyWorld({ shape: "cat" }); run(w, 1.5);
    const names = w.decor.map((d) => d.name).sort().join();
    check("cat: dot eyes, ω mouth, whiskers and 5 strawberry halves inside; no glitter / pearls", names === "eye,eye,mouth,strawberry,strawberry,strawberry,strawberry,strawberry,whisker,whisker" && w.additives.glitter.length === 0 && w.beadCount() === 0 && berries(w).every((d) => d.inner), names);
    const sig = signatureSigma("cat");
    check("cat: a fresh jelly is strawberry pink (meanDye = signatureSigma)", sig.every((v, c) => Math.abs(v - w.meanDye[c]) < 0.005 * Math.max(1, v)) && sig[1] > sig[2] && sig[2] > sig[0], `${w.meanDye.map((v) => v.toFixed(2))} vs ${sig}`);
    // the deeper pink of the ear tips stays put while paint dropped on top spreads
    const rest = w.type.cage.pos, n = w.body.nodeCount, hi = [], lo = [];
    for (let i = 0; i < n; i++) (w.lookDye[i * 3 + 1] > 35 ? hi : rest[i * 3 + 1] < 0.03 ? lo : null)?.push(i);
    const green = (ids) => ids.reduce((a, i) => a + w.dye[i * 3 + 1], 0) / ids.length;
    const c0 = green(hi) - green(lo), pig0 = w.totalPigment();
    for (let k = 0; k < 3; k++) { w.handle({ type: "drop", point: top(w), paint: paint("blue") }); run(w, 0.3); }
    const redSpread = () => { let a = Infinity, b = -Infinity; for (let i = 0; i < n; i++) { a = Math.min(a, w.dye[i * 3]); b = Math.max(b, w.dye[i * 3]); } return b - a; };
    const pig1 = w.totalPigment(), m1 = w.meanDye.slice(), s1 = redSpread();
    for (let t = 0; t < 15; t += 1) { w.handle({ type: "nudge" }); run(w, 1); }
    const c1 = green(hi) - green(lo), pig2 = w.totalPigment(), s2 = redSpread();
    check("cat: paint drops add pigment, spread through it (conserved) and tint the mean colour", pig1[0] > pig0[0] * 1.5 && pig2.every((v, c) => Math.abs(v - pig1[c]) < 1e-9 * Math.max(1, pig1[c])) && s2 < 0.5 * s1 && m1[0] > sig[0] + 3,
      `σr ${sig[0].toFixed(1)} → ${w.meanDye[0].toFixed(1)}, red spread ${s1.toFixed(0)} → ${s2.toFixed(0)} 1/m`);
    check("cat: the ear tips keep their deeper pink under the paint (≥ 80 % of the contrast)", hi.length >= 6 && lo.length > 50 && c1 > 0.8 * c0, `${hi.length} ear-tip nodes, contrast ${c0.toFixed(1)} → ${c1.toFixed(1)} 1/m`);
    w.handle({ type: "reset", base: "mint", plain: true });
    check("cat: a plain reset is the plain base colour, the face and strawberries stay", w.lookDye === null && BASES.mint.every((v, c) => Math.abs(w.meanDye[c] - v) < 1e-9) && berries(w).length === 5 && w.decor.length === 10);
    w.handle({ type: "reset", base: "berry" });
    check("…and a normal reset brings the strawberry pink back", w.lookDye !== null && sig.every((v, c) => Math.abs(v - w.meanDye[c]) < 0.005 * Math.max(1, v)));
  }
  {
    // gems: normal ones by the handful, the 8 rare ones; none inside a strawberry
    const w = new JellyWorld({ shape: "cat" }); w.handle({ type: "motions", enabled: false }); run(w, 1); drain(w);
    w.handle({ type: "gemScatter", count: 10 }); run(w, 2.5);
    const ix = w.type.stencils.indices;
    for (let i = 0; i < 8; i++) {
      if (i % 2) w.handle({ type: "gemScatter", count: 1, rare: { index: i, tier: i % 3 }, radius: 0.0048 });
      else { const t = 40 + i * 37; w.handle({ type: "gemAdd", a: ix[t * 3], b: ix[t * 3 + 1], c: ix[t * 3 + 2], bary: [1 / 3, 1 / 3, 1 / 3], shape: 0, color: 0, radius: 0.0048, rare: { index: i, tier: i % 3 } }); }
    }
    run(w, 3);
    const ev = drain(w), ins = ev.filter((e) => e.type === "rareIn");
    const clear = (w) => w.gems.every((g) => !w.inInner(g.u, g.radius) && inside(w, g));
    check("cat: 10 gems + the 8 rare ones fit (8 × rareIn, no rejection), none in a strawberry, strawberries are not gems",
      w.rareCount === 8 && ins.length === 8 && !ev.some((e) => e.type === "rareFull" || e.type === "gemFull") && w.gems.length === 18 && clear(w) && berries(w).length === 5,
      `${w.gems.length} gems (${w.rareCount} rare), ${ins.length} rareIn`);
    // motions on for 30 s (6 moves): every gem stays inside, none drifts into a strawberry
    w.handle({ type: "motions", enabled: true });
    let moves = 0, ok = true;
    run(w, 30, () => { for (const e of drain(w)) if (e.type === "motion") moves++; if (Math.random() < 0.05) ok &&= clear(w); });
    w.handle({ type: "motions", enabled: false }); run(w, 2);
    const b = w.body.bounds, worldIn = w.gems.every((g) => g.wpos.every(Number.isFinite) && g.wpos[1] > b[1] - 0.001 && g.wpos[1] < b[4] + 0.001);
    check("cat: through 30 s of yawns and 냥냥펀치 the gems stay inside (material and world), clear of the strawberries", moves === 6 && ok && clear(w) && worldIn && w.gems.length === 18, `${moves} moves`);
    // bites: the strawberries in the bite go with it (eaten like decor), gems in it are eaten (not refunded)
    const n0 = berries(w).length;
    const cheek = berries(w).find((d) => d.inner.u[0] < 0 && d.inner.u[2] > 0.008), p = [0, 0, 0];
    w.body.pointInTet(cheek.tet, cheek.bary, p);
    w.handle({ type: "bite", center: p }); run(w, 0.6);
    const bitten = drain(w).find((e) => e.type === "bitten");
    check("cat: a bite on the cheek eats that strawberry (decor), the eaten list has gems only", berries(w).length === n0 - 1 && !berries(w).includes(cheek) && bitten && bitten.eaten.every((g) => Number.isInteger(g.shape)) && w.gems.every((g) => inside(w, g)) && w.body.isFinite());
    for (let i = 0; i < 3; i++) { w.handle({ type: "bite", center: [w.body.center[0], w.body.center[1] + 0.01, w.body.bounds[5] - 0.002] }); run(w, 0.4); }
    run(w, 1.5);
    const rare = w.gems.filter((g) => g.rare).map((g) => `${g.shape}:${g.tier}`).sort().join();
    w.handle({ type: "reset", base: "berry" });
    const r = drain(w).find((e) => e.type === "reset");
    check("cat: after 4 bites the jelly is stable, the gems left are inside, reset {rare} lists exactly the rare ones left", w.body.isFinite() && r && r.rare.map((g) => `${g.index}:${g.tier}`).sort().join() === rare, `${rare.split(",").filter(Boolean).length} rare left`);
  }
}

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
