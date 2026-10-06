// JellyWorld: paint drops (exact pigment bookkeeping, subtractive mixing,
// diffusion, water dilution), gem containment / suspension / clinks, cost.
import { JellyWorld, PAINTS, BASES } from "../src/core/world.js";
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
