// Physics worker: owns the JellyWorld (the jelly, its paint field and gems)
// and streams the surface, colour, gem poses and events to the main thread.
//   main → worker
//     init {wallRadius, base}
//     tick {dt, events:[...], free:[ArrayBuffer...]}
//   worker → main
//     ready {indices, positions}
//     frame {positions?, normals?, dye?, bounds, center, energy, meanDye,
//            gems, gemCount, grab, impact, wallImpact, events, steps, stepMs, asleep}
import { JellyWorld } from "../core/world.js";

let world = null;
let paused = false;
let stepTimeAvg = 0;
let tickCount = 0;
let dyeSent = 0;
let sentOnce = false;
const pool = new Map(); // byteLength → [ArrayBuffer]

function take(length) {
  const buffer = pool.get(length * 4)?.pop();
  return buffer ? new Float32Array(buffer) : new Float32Array(length);
}

function frame(steps, elapsed, stepped) {
  const body = world.body, transfer = [];
  const out = {
    type: "frame", steps, bounds: Array.from(body.bounds), center: body.center.slice(),
    energy: world.energy || 0, meanDye: world.meanDye.slice(), asleep: body.sleeping && !world.grabbing && !world.gems.some((g) => g.fall),
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
    dyeSent = world.dyeVersion;
  }
  const gemCount = world.gems.length;
  out.gemCount = gemCount;
  if (gemCount) { const g = take(gemCount * 10); world.gemStates(g); out.gems = g; transfer.push(g.buffer); }
  out.grab = body.grab ? { point: body.grab.point.slice(), target: body.grab.target.slice() } : null;
  out.impact = body.impact; out.wallImpact = body.wallImpact;
  body.impact = 0; body.wallImpact = 0;
  if (steps > 0 && elapsed > 0 && stepped) stepTimeAvg = stepTimeAvg ? stepTimeAvg * 0.9 + (elapsed / steps) * 0.1 : elapsed / steps;
  out.stepMs = stepTimeAvg;
  out.events = world.events.splice(0);
  self.postMessage(out, transfer);
}

self.onmessage = ({ data }) => {
  try {
    if (data.type === "init") {
      world = new JellyWorld({ wallRadius: data.wallRadius, base: data.base });
      world.events.length = 0;
      self.postMessage({ type: "ready", indices: world.type.stencils.indices.slice(), positions: world.body.positions.slice() });
    } else if (data.type === "tick") {
      for (const buffer of data.free || []) {
        const list = pool.get(buffer.byteLength) || [];
        if (list.length < 8) list.push(buffer);
        pool.set(buffer.byteLength, list);
      }
      for (const event of data.events || []) {
        if (event.type === "pause") { paused = Boolean(event.paused); if (paused) world.handle({ type: "grabEnd" }); world.accumulator = 0; continue; }
        if (event.type === "reset") sentOnce = false;
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
