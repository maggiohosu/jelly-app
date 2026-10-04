// Physics worker: owns the SoftBody, runs the fixed-step XPBD loop and the
// Loop-subdivided surface, and streams positions/normals back to the main thread.
// Message protocol (main → worker):
//   init  {wallRadius, lift}
//   tick  {dt, rawTarget:[x,y,z]|null, buffers:{positions,normals}|null, events:[...]}
// Events: {type:'grabStart', a,b,c, bary:[3], point:[3]} | {type:'grabEnd'} |
//         {type:'nudge'} | {type:'impulse', v:[3]} | {type:'reset', lift} |
//         {type:'gravity', vector:[3]|null, friction:{staticFriction,dynamicFriction}|null} |
//         {type:'rate', hz} | {type:'pause', paused}
import { SoftBody, easeGrabTarget, clampGrabTarget } from "../core/softbody.js";

let body = null;
let step = 1 / 240;
let accumulator = 0;
let paused = false;
let wallRadius = 0;
const rawTarget = [0, 0, 0];
let stepTimeAvg = 0;

function handleEvent(event) {
  switch (event.type) {
    case "grabStart": {
      const weights = body.grabWeights(event.a, event.b, event.c, event.bary[0], event.bary[1], event.bary[2]);
      if (!weights) return;
      body.wake();
      body.grab = { ...weights, target: event.point.slice(), point: event.point.slice(), lambda: new Float64Array(3) };
      rawTarget[0] = event.point[0]; rawTarget[1] = event.point[1]; rawTarget[2] = event.point[2];
      break;
    }
    case "grabEnd": body.grab = null; break;
    case "nudge": body.nudge(); break;
    case "impulse": body.impulse(event.v[0], event.v[1], event.v[2]); break;
    case "reset": body.reset(event.lift || 0); accumulator = 0; break;
    case "gravity": {
      const previous = body.gravityVector;
      body.gravityVector = event.vector;
      body.frictionOverride = event.friction;
      const a = previous || [0, -9.81, 0], b = event.vector || [0, -9.81, 0];
      // Wake only on a meaningful change so sensor noise cannot keep the body awake.
      if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > 0.25) body.wake();
      break;
    }
    case "rate": step = 1 / event.hz; accumulator = 0; break;
    case "pause": paused = Boolean(event.paused); accumulator = 0; if (paused) body.grab = null; break;
  }
}

function tick(message) {
  for (const event of message.events || []) handleEvent(event);
  if (message.rawTarget && body.grab) {
    rawTarget[0] = message.rawTarget[0]; rawTarget[1] = message.rawTarget[1]; rawTarget[2] = message.rawTarget[2];
    clampGrabTarget(rawTarget, wallRadius);
  }

  const wallDelta = Math.min(Math.max(Number(message.dt) || 0, 0), 0.05);
  let steps = 0, stepped = false;
  const started = performance.now();
  if (!paused) {
    accumulator += wallDelta;
    while (accumulator >= step && steps < 12) {
      if (body.grab) easeGrabTarget(body.grab.target, rawTarget, step);
      const awake = !body.sleeping || body.grab;
      body.step(step);
      accumulator -= step;
      steps += 1;
      if (awake) stepped = true;
    }
    if (steps === 12) accumulator = Math.min(accumulator, step);
  }
  const elapsed = performance.now() - started;
  let resetHappened = false;
  if (stepped && !body.isFinite()) {
    // The original pauses here; an app should just recover.
    body.reset(); accumulator = 0; resetHappened = true;
  }

  const reply = {
    type: "frame",
    stepped,
    steps,
    sleeping: body.sleeping,
    center: body.center.slice(),
    bounds: Array.from(body.bounds),
    grab: body.grab ? { point: body.grab.point.slice(), target: body.grab.target.slice() } : null,
    impact: body.impact,
    wallImpact: body.wallImpact,
    resetHappened,
    paused,
    stepMs: 0,
  };
  body.impact = 0; body.wallImpact = 0;
  if (steps > 0 && stepped) {
    const perStep = elapsed / steps;
    stepTimeAvg = stepTimeAvg ? stepTimeAvg * 0.9 + perStep * 0.1 : perStep;
  }
  reply.stepMs = stepTimeAvg;

  const transfer = [];
  if (stepped) {
    body.updateSurface();
    reply.center = body.center.slice();
    reply.bounds = Array.from(body.bounds);
    let positions = message.buffers?.positions, normals = message.buffers?.normals;
    if (!positions || positions.length !== body.positions.length) positions = new Float32Array(body.positions.length);
    if (!normals || normals.length !== body.normals.length) normals = new Float32Array(body.normals.length);
    positions.set(body.positions); normals.set(body.normals);
    reply.positions = positions; reply.normals = normals;
    transfer.push(positions.buffer, normals.buffer);
  } else if (message.buffers) {
    // Hand unused buffers back so the main thread keeps its pool.
    reply.returned = message.buffers;
    transfer.push(message.buffers.positions.buffer, message.buffers.normals.buffer);
  }
  self.postMessage(reply, transfer);
}

self.onmessage = ({ data }) => {
  try {
    if (data.type === "init") {
      wallRadius = data.wallRadius || 0;
      body = new SoftBody();
      body.wallRadius = wallRadius;
      body.reset(data.lift || 0);
      self.postMessage({
        type: "ready",
        indices: body.indices.slice(),
        positions: body.positions.slice(),
        normals: body.normals.slice(),
        bounds: Array.from(body.bounds),
        center: body.center.slice(),
        mass: body.totalMass,
      });
    } else if (data.type === "tick") {
      tick(data);
    }
  } catch (error) {
    self.postMessage({ type: "error", message: String(error && error.stack || error) });
  }
};
