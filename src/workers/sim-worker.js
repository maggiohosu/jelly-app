// Physics worker: owns the JellyWorld (the jelly, its paint field and gems)
// and streams the surface, colour, gem poses and events to the main thread.
//   main → worker
//     init {wallRadius, base}
//     tick {dt, events:[...], free:[ArrayBuffer...]}
//   worker → main
//     ready {indices, positions}
//     frame {positions?, normals?, dye?, bounds, center, energy, meanDye,
//            meanFx [pearl, glow], additiveCounts {glitter, stars},
//            gems, gemCount, grab, impact, wallImpact, events, steps, stepMs,
//            asleep, motionIn (s until the next idle motion, null: none)}
//   Idle motions (cat / bird) run on sim time, but the app stops ticking a
//   sleeping jelly: the worker then wakes itself when the next motion is due
//   (world.idle(wall time asleep) → the motion starts) and posts a frame on
//   its own, with asleep false, so the app resumes ticking.
import { JellyWorld } from "../core/world.js";

let world = null;
let paused = false;
let stepTimeAvg = 0;
let tickCount = 0;
let dyeSent = 0;
let sentOnce = false;
let beadsSent = false;
let decorSent = false;
let layersDirty = false;   // a reset / shape change: resend (or clear) beads and decorations
let additivesSent = -1;
let decorVersionSent = -1;
let wakeTimer = 0, lastFrameAt = 0;
const pool = new Map(); // byteLength → [ArrayBuffer]

function take(length) {
  const buffer = pool.get(length * 4)?.pop();
  return buffer ? new Float32Array(buffer) : new Float32Array(length);
}

function frame(steps, elapsed, stepped) {
  const body = world.body, transfer = [];
  const out = {
    type: "frame", steps, bounds: Array.from(body.bounds), center: body.center.slice(),
    energy: world.energy || 0, meanDye: world.meanDye.slice(), meanFx: world.meanFx.slice(),
    additiveCounts: { glitter: world.additives.glitter.length, stars: world.additives.stars.length },
    asleep: body.sleeping && !world.grabbing && !world.gems.some((g) => g.fall), motionIn: world.motionIn(),
  };
  if (stepped || !sentOnce) {
    const p = take(body.positions.length), n = take(body.normals.length);
    p.set(body.positions); n.set(body.normals);
    out.positions = p; out.normals = n; transfer.push(p.buffer, n.buffer);
    sentOnce = true;
  }
  // Colour changes slowly: send at most every 3rd tick (immediately after a drop).
  if (world.dyeVersion !== dyeSent && (tickCount % 3 === 0 || world.events.some((e) => e.type === "dropped" || e.type === "reset"))) {
    const d = take(world.shellDye.length);
    d.set(world.computeShellDye());
    out.dye = d; transfer.push(d.buffer);
    const f = take(world.shellFx.length);
    f.set(world.computeShellFx());
    out.fx = f; transfer.push(f.buffer);
    dyeSent = world.dyeVersion;
  }
  const gemCount = world.gems.length;
  out.gemCount = gemCount;
  if (gemCount) { const g = take(gemCount * 10); world.gemStates(g); out.gems = g; transfer.push(g.buffer); }
  out.texture = world.texture;
  // glitter / star candies: positions follow the jelly while it moves
  const additives = world.additiveCount();
  if (additives && (stepped || world.additiveVersion !== additivesSent)) {
    const a = take(additives * 5);
    world.additiveStates(a); out.additives = a; transfer.push(a.buffer);
    additivesSent = world.additiveVersion;
  } else if (!additives && additivesSent !== world.additiveVersion) { out.additives = new Float32Array(0); additivesSent = world.additiveVersion; }
  // foam beads (slime) + pearls (shape looks)
  const beadCount = world.beadCount();
  if (beadCount && (stepped || !beadsSent || layersDirty)) {
    const b = take(beadCount * 4);
    const states = world.beadStates(b); out.beads = states; transfer.push(b.buffer);
    beadsSent = true;
  } else if (!beadCount && (beadsSent || layersDirty)) { out.beads = new Float32Array(0); beadsSent = false; }
  // face / cherry / beak decorations follow the jelly (and change expression
  // during an idle motion: decorVersion — sent even if nothing stepped)
  const decorCount = world.decorCount();
  out.decorCount = decorCount;
  if (decorCount && (stepped || !decorSent || layersDirty || world.decorVersion !== decorVersionSent)) {
    const d = take(decorCount * 12);
    world.decorStates(d); out.decor = d; transfer.push(d.buffer);
    decorSent = true;
  } else if (!decorCount && (decorSent || layersDirty)) { out.decor = new Float32Array(0); decorSent = false; }
  decorVersionSent = world.decorVersion;
  layersDirty = false;
  out.grab = body.grab ? { point: body.grab.point.slice(), target: body.grab.target.slice() } : null;
  out.impact = body.impact; out.wallImpact = body.wallImpact;
  body.impact = 0; body.wallImpact = 0;
  if (steps > 0 && elapsed > 0 && stepped) stepTimeAvg = stepTimeAvg ? stepTimeAvg * 0.9 + (elapsed / steps) * 0.1 : elapsed / steps;
  out.stepMs = stepTimeAvg;
  out.events = world.events.splice(0);
  self.postMessage(out, transfer);
  scheduleWake(out.asleep, out.motionIn);
}

// Asleep with an idle motion pending: nobody ticks us, so wake up when it is due.
function scheduleWake(asleep, motionIn) {
  clearTimeout(wakeTimer); wakeTimer = 0;
  lastFrameAt = performance.now();
  if (!asleep || paused || motionIn === null || motionIn === undefined) return;
  wakeTimer = setTimeout(selfWake, Math.max(16, motionIn * 1000 + 5));
}
function selfWake() {
  wakeTimer = 0;
  if (!world || paused) return;
  world.idle((performance.now() - lastFrameAt) / 1000);
  if (world.motion) frame(0, 0, false);
  else scheduleWake(true, world.motionIn());
}

self.onmessage = ({ data }) => {
  try {
    if (data.type === "init") {
      world = new JellyWorld({ wallRadius: data.wallRadius, base: data.base, texture: data.texture, shape: data.shape });
      world.events.length = 0;
      self.postMessage({ type: "ready", indices: world.type.stencils.indices.slice(), positions: world.body.positions.slice() });
    } else if (data.type === "tick") {
      for (const buffer of data.free || []) {
        const list = pool.get(buffer.byteLength) || [];
        if (list.length < 8) list.push(buffer);
        pool.set(buffer.byteLength, list);
      }
      for (const event of data.events || []) {
        if (event.type === "pause") { paused = Boolean(event.paused); if (paused) { world.handle({ type: "grabEnd" }); clearTimeout(wakeTimer); wakeTimer = 0; } world.accumulator = 0; continue; }
        if (event.type === "reset") { sentOnce = false; layersDirty = true; }
        if (event.type === "shape") {
          world.handle(event);
          sentOnce = false; layersDirty = true; additivesSent = -1; dyeSent = -1;
          self.postMessage({ type: "topology", shape: world.shape, indices: world.type.stencils.indices.slice(), positions: world.body.positions.slice() });
          continue;
        }
        if (event.type === "bite") beadsSent = false;
        if (event.type === "texture") sentOnce = false;
        world.handle(event);
      }
      tickCount++;
      const r = paused ? { steps: 0, elapsed: 0, stepped: false } : world.advance(data.dt);
      frame(r.steps, r.elapsed, r.stepped);
    }
  } catch (error) {
    self.postMessage({ type: "error", message: String(error && error.stack || error) });
  }
};
