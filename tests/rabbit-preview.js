// Standalone preview of the jelly-eating bunny (src/render/rabbit.js) on the
// app's tray, with the app's camera, light, background, fog and bloom.
// A stand-in jelly (transmissive, one of the app's shapes' bounding sizes) is
// CARRIED like the app does: while the bunny returns `hold`, the whole jelly is
// pulled toward it by a damped spring (rigid, lagging, a little squash wobble
// from acceleration; no stretching); otherwise it falls back onto the plate.
// It shrinks 13 % per bite and vanishes on "finish". On "kick" it gets the
// impulse the app's world gets ({dir, strength}): it slides and tumbles across
// the tray, bumps into the rim and stays there. "toilet" never touches it.
//
// Query: ?lite=1 (WebGL2)  ?quality=high|medium|low  ?outcome=eat|spit|kick|refuse|toilet
//        ?fullness=0..1 (belly; 1 = full: tummy hold + burp)  ?happy=1 (smiling buff face)
//        ?wand=wand (wand on the back, flourish on arrival / at the toilet smile)
//        ?mood=happy|ok|sad|special  ?bites=4  ?shape=flower|bear|cat|bird|cake|pudding
//        ?picky=1 (monocle)  ?head=ribbon|crown|flowerband|witchhat  ?face=glasses  ?neck=scarf
//        ?back=wings|cape  ?outfit=all (ribbon + glasses + scarf + wings)
//        ?color=%23rrggbb  ?autoplay=0  ?t=<s> freeze at that time (deterministic seek)
//        ?seat=<deg> seat angle (default: seated like the app, from the camera)  ?az=<rad> camera azimuth
//        ?polar=<rad>  ?dist=<m>  ?zoom=1 close-up  ?bloom=0|1  ?clean=1 hide HUD  ?jelly=0 no stand-in
import * as THREE from "three/webgpu";
import { pass } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { OUTFIT_SLOTS, Rabbit } from "../src/render/rabbit.js";

const q = new URLSearchParams(location.search);
const num = (k, d) => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);
const lite = q.get("lite") === "1";
let quality = q.get("quality") ?? "high";
let mood = q.get("mood") ?? "happy";
let outcome = q.get("outcome") ?? "eat";
let shape = q.get("shape") ?? "flower";
let jellyColor = q.get("color") ?? "#ff6f9a";
let bites = num("bites", 4);
let picky = q.get("picky") === "1";
let fullness = num("fullness", 0);
let happy = q.get("happy") === "1";
const outfit = q.get("outfit") === "all"
  ? { head: "ribbon", face: "glasses", neck: "scarf", back: "wings", wand: q.get("wand") }
  : { head: q.get("head"), face: q.get("face"), neck: q.get("neck"), back: q.get("back"), wand: q.get("wand") };
if (q.get("clean") === "1") document.body.classList.add("clean");

const R = (window.__rabbit = { errors: [], events: [], frames: 0, ready: false });
window.addEventListener("error", (e) => R.errors.push(String(e.message || e)));
window.addEventListener("unhandledrejection", (e) => R.errors.push(String(e.reason?.stack || e.reason)));

// ---------------------------------------------------------------- stage ----
const canvas = document.getElementById("stage");
const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: false, forceWebGL: lite });
await renderer.init();
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
renderer.setClearColor(0xdfe6e8, 1);
R.backend = renderer.backend?.isWebGPUBackend ? "webgpu" : "webgl2";

const scene = new THREE.Scene();
scene.background = new THREE.Color("#dfe6e8");
scene.fog = new THREE.FogExp2("#dfe6e8", 0.95);
const camera = new THREE.PerspectiveCamera(34, 1, 0.001, 3);
const tray = new THREE.Group();
scene.add(tray);

const LIGHT_DIRECTION = new THREE.Vector3(-0.6123724357, -0.5, 0.6123724357).normalize();
const sun = new THREE.DirectionalLight(0xfff1da, 3.0);
sun.target.position.set(0, 0.025, 0);
sun.position.copy(sun.target.position).addScaledVector(LIGHT_DIRECTION, -0.45);
tray.add(sun, sun.target);

function benchTexture() {
  const size = 1024, c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  g.fillStyle = "#dce4e6"; g.fillRect(0, 0, size, size);
  g.strokeStyle = "#bccbd04a"; g.lineWidth = 1;
  for (let i = 0; i <= 16; i += 1) {
    const p = (i * size) / 16;
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, size); g.stroke();
    g.beginPath(); g.moveTo(0, p); g.lineTo(size, p); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
  t.repeat.set(12 / 0.16, 12 / 0.16);
  return t;
}
const floorGeometry = new THREE.PlaneGeometry(12, 12);
floorGeometry.rotateX(-Math.PI / 2);
floorGeometry.translate(0, -0.00005, 0);
const floor = new THREE.Mesh(floorGeometry, new THREE.MeshStandardNodeMaterial({ map: benchTexture(), roughness: 0.63, metalness: 0 }));
tray.add(floor);
const TRAY_RADIUS = 0.075, rimTube = 0.0028;
const rim = new THREE.Mesh(
  new THREE.TorusGeometry(TRAY_RADIUS + rimTube, rimTube, 20, 180),
  new THREE.MeshPhysicalNodeMaterial({ color: "#f3f6f7", emissive: "#c4ced2", emissiveIntensity: 0.55, roughness: 0.22, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.1 }),
);
rim.rotation.x = -Math.PI / 2;
rim.position.y = rimTube * 0.7;
tray.add(rim);

// ---------------------------------------------------- stand-in jelly ----
// Bounding sizes (m) of the app's jelly shapes; p = superellipsoid exponent.
const SHAPES = {
  flower: { w: 0.072, h: 0.036, d: 0.072, p: 2, lobes: 5 },
  bear: { w: 0.066, h: 0.056, d: 0.05, p: 2.2 },
  cat: { w: 0.064, h: 0.06, d: 0.046, p: 2.4 },
  bird: { w: 0.074, h: 0.05, d: 0.048, p: 2 },
  cake: { w: 0.08, h: 0.046, d: 0.056, p: 4.5 },
  pudding: { w: 0.064, h: 0.052, d: 0.064, p: 3 },
};
const JELLY_YAW = 0.45; // the stand-in is turned a little so its bounds are not axis aligned
function jellyGeometry(spec) {
  const g = new THREE.SphereGeometry(1, 64, 40);
  const p = g.attributes.position, v = new THREE.Vector3();
  const e = 2 / spec.p;
  const sp = (a) => Math.sign(a) * Math.pow(Math.abs(a), e);
  for (let i = 0; i < p.count; i += 1) {
    v.fromBufferAttribute(p, i);
    const ring = Math.sqrt(Math.max(0, 1 - v.y * v.y));
    const lobe = spec.lobes ? 1 + 0.06 * Math.cos(spec.lobes * Math.atan2(v.z, v.x)) * ring : 1;
    const y = v.y < 0 ? -Math.pow(-v.y, 0.45) : sp(v.y); // flat-ish bottom
    p.setXYZ(i, sp(v.x) * lobe * spec.w / 2, y * spec.h / 2, sp(v.z) * lobe * spec.d / 2);
  }
  g.computeVertexNormals();
  g.computeBoundingBox();
  return g;
}
const jellyMaterial = new THREE.MeshPhysicalNodeMaterial({
  color: "#fff0f4", roughness: 0.075, metalness: 0, transmission: 1, thickness: 0.03, ior: 1.35,
  attenuationDistance: 0.035, attenuationColor: jellyColor, clearcoat: 0.42, clearcoatRoughness: 0.05, transparent: false,
});
const jelly = new THREE.Mesh(jellyGeometry(SHAPES[shape] || SHAPES.flower), jellyMaterial);
jelly.name = "StandInJelly";
jelly.rotation.y = JELLY_YAW;
jelly.visible = q.get("jelly") !== "0";
tray.add(jelly);
const J = { c: new THREE.Vector3(), v: new THREE.Vector3(), size: 1, sizeGoal: 1, wob: 0, wobV: 0, gone: false, carried: false, slide: null };
const spec = () => SHAPES[shape] || SHAPES.flower;
function setShape(name) {
  shape = SHAPES[name] ? name : "flower";
  jelly.geometry.dispose();
  jelly.geometry = jellyGeometry(spec());
}
function resetJelly() {
  J.c.set(0, spec().h / 2, 0); J.v.set(0, 0, 0);
  J.size = J.sizeGoal = 1; J.wob = J.wobV = 0; J.gone = false; J.carried = false; J.slide = null;
  jelly.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), JELLY_YAW);
  jellyMaterial.attenuationColor.set(jellyColor);
  jelly.visible = q.get("jelly") !== "0";
  placeJelly();
}
const _yawQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), JELLY_YAW), _tiltQ = new THREE.Quaternion();
function placeJelly() {
  const sy = 1 + J.wob, sxz = 1 / Math.sqrt(sy);
  jelly.position.copy(J.c);
  if (J.slide) {
    // tumble: tilt about the horizontal axis across the slide (pivoting near the floor)
    _tiltQ.setFromAxisAngle(J.slide.axis, J.slide.tilt);
    jelly.quaternion.copy(_tiltQ).multiply(_yawQ);
    jelly.position.y += Math.abs(Math.sin(J.slide.tilt)) * spec().w * 0.18;
  }
  jelly.scale.set(sxz * J.size, sy * J.size, sxz * J.size);
  if (J.gone && J.size <= 0.01) jelly.visible = false;
}
const _a = new THREE.Vector3();
// Kick (stand-in for the app's world): slide with friction, tumble (tilt spring
// kicked by the impulse), bump into the rim and stay there.
function kickJelly(dir, strength) {
  const d = new THREE.Vector3(dir[0], 0, dir[1]).normalize();
  J.slide = { d, speed: 0.64 * strength, axis: new THREE.Vector3(d.z, 0, -d.x), tilt: 0, tiltV: 7 * strength, hit: false };
  J.wobV -= 6 * strength;
}
function stepSlide(dt) {
  const S = J.slide;
  if (!S) return;
  const half = Math.max(spec().w, spec().d) / 2 * J.size;
  S.speed = Math.max(0, S.speed - 2.6 * dt);
  J.c.addScaledVector(S.d, S.speed * dt);
  const r = Math.hypot(J.c.x, J.c.z), lim = TRAY_RADIUS - half * 0.92;
  if (r > lim) {
    J.c.x *= lim / r; J.c.z *= lim / r;
    if (!S.hit) { S.hit = true; S.tiltV -= 9 * S.speed; J.wobV -= 25 * S.speed; }
    S.speed = 0;
  }
  // tilt spring: rocks over and settles upright
  const w = 2 * Math.PI * 2.2;
  S.tiltV += (-w * w * S.tilt - 2 * 0.3 * w * S.tiltV) * dt;
  S.tilt += S.tiltV * dt;
}
function stepJelly(dt, hold) {
  stepSlide(dt);
  if (J.gone) J.size = Math.max(0, J.size - dt * 8);
  else J.size += (J.sizeGoal - J.size) * (1 - Math.exp(-dt / 0.06));
  const rest = (spec().h / 2) * J.size;
  J.carried = Boolean(hold);
  const n = Math.max(1, Math.ceil(dt / (1 / 240))), h = dt / n;
  for (let i = 0; i < n; i += 1) {
    _a.set(0, 0, 0);
    if (hold) {
      // Rigid carry: every node translated toward the target, gravity off → spring on the centre.
      const w = 2 * Math.PI * 3.2, z = 0.45;
      _a.set(hold[0] - J.c.x, hold[1] - J.c.y, hold[2] - J.c.z).multiplyScalar(w * w).addScaledVector(J.v, -2 * z * w);
    } else {
      _a.y = -9.81;
      if (J.c.y <= rest + 1e-5) { J.v.x *= Math.exp(-h * 12); J.v.z *= Math.exp(-h * 12); }
    }
    J.v.addScaledVector(_a, h);
    J.c.addScaledVector(J.v, h);
    if (J.c.y < rest) { if (J.v.y < -0.05) J.wobV += J.v.y * 30; J.c.y = rest; J.v.y = Math.max(0, J.v.y) * 0; }
    // Squash wobble from vertical acceleration (soft body on a rigid carry).
    const ww = 2 * Math.PI * 5.5;
    J.wobV += (-ww * ww * J.wob - 2 * 0.2 * ww * J.wobV + (hold ? -_a.y * 0.02 : 0)) * h;
    J.wob += J.wobV * h;
  }
  J.wob = Math.max(-0.25, Math.min(0.25, J.wob));
  placeJelly();
}
const _box = new THREE.Box3();
function jellyInfo() {
  if (!jelly.visible || J.size <= 0.01) return null;
  // Exact AABB from the vertices (like the app's physics bounds); the tray is the scene root here.
  jelly.updateMatrixWorld(true);
  _box.setFromObject(jelly, true);
  return { center: [J.c.x, J.c.y, J.c.z], bounds: [_box.min.x, _box.min.y, _box.min.z, _box.max.x, _box.max.y, _box.max.z] };
}

// ---------------------------------------------------------------- rabbit ----
const rabbit = new Rabbit(tray, { quality });
rabbit.setOutfit(outfit);
rabbit.setFullness(fullness);
rabbit.setHappy(happy);
Object.assign(R, { rabbit, renderer, scene, camera, tray, jelly: J });
// Seat like the app (main.js feed()): behind the jelly as seen from the camera,
// 2.4 cm to the side, facing the camera. ?seat=<deg> instead seats it on the
// circle at that angle, facing the tray centre (the older preview behaviour).
const seat = [0, 0, -0.111], faceTo = [0, 0.02, 0];
function placeSeat() {
  if (q.has("seat")) {
    const a = (num("seat", 0) * Math.PI) / 180;
    seat.splice(0, 3, -0.111 * Math.sin(a), 0, -0.111 * Math.cos(a));
    faceTo.splice(0, 3, 0, 0.02, 0);
    return;
  }
  const toCam = new THREE.Vector3(Math.sin(cam.az), 0, Math.cos(cam.az)); // = the app's camera seen from the tray centre
  const side = new THREE.Vector3(-toCam.z, 0, toCam.x);
  const p = toCam.clone().multiplyScalar(-0.108).addScaledVector(side, 0.024);
  seat.splice(0, 3, p.x, 0, p.z);
  faceTo.splice(0, 3, toCam.x * 0.3, 0.04, toCam.z * 0.3);
}
let clock = 0, playStart = 0;
const logEl = document.getElementById("log");
const logLines = [];
function log(line) {
  logLines.push(line);
  while (logLines.length > 26) logLines.shift();
  logEl.textContent = logLines.join("\n");
}
const fmt = (a) => a.map((x) => x.toFixed(3)).join(",");

function play(m = mood) {
  mood = m;
  resetJelly();
  R.events.length = 0;
  log(`— play ${outcome} · ${mood} · ${shape} ×${bites} (${quality})${picky ? " · picky" : ""}${happy ? " · happy" : ""}${fullness ? ` · full ${fullness}` : ""}`);
  playStart = clock;
  const sp = spec();
  placeSeat();
  placeCamera();
  rabbit.play({
    position: seat, faceTo, outcome, mood, bites, jellyColor, picky,
    jelly: { center: [J.c.x, J.c.y, J.c.z], width: Math.max(sp.w, sp.d), height: sp.h },
    onEvent(type, data) {
      const t = clock - playStart;
      R.events.push({ t: Number(t.toFixed(3)), type, data });
      const extra = type === "bite" ? ` ${data.index + 1}/${data.count} @${fmt(data.mouth)}`
        : type === "grab" ? ` hold ${fmt(data.hold)}`
          : type === "lift" ? ` → ${fmt(data.hold)}`
            : type === "putDown" ? ` → ${fmt(data.to)}`
              : type === "spit" ? ` v ${fmt(data.velocity)}`
                : type === "kick" ? ` dir ${fmt(data.dir)} ×${data.strength} @${fmt(data.point)}`
                  : type === "react" || type === "refuse" ? ` ${data.mood}` : type === "hop" ? ` ${data.phase}#${data.index}`
                    : type === "hopOn" || type === "hopOff" ? ` → ${fmt(data.to)}` : type === "strain" || type === "wand" || type === "burp" ? ` ${data.duration}s` : "";
      log(`${t.toFixed(2).padStart(5)}s ${type}${extra}`);
      if (type === "bite") J.sizeGoal *= 0.87;
      if (type === "finish") J.gone = true;
      if (type === "kick") kickJelly(data.dir, data.strength);
    },
  });
  updateHud();
}

// ---------------------------------------------------------------- camera ----
const TARGET = new THREE.Vector3(0, 0.025, 0);
const cam = { az: num("az", 0), polar: num("polar", 1.1), dist: num("dist", 0) };
let drag = null;
canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener("pointermove", (e) => {
  if (!drag) return;
  cam.az -= (e.clientX - drag.x) * 0.006;
  cam.polar = Math.min(Math.PI * 0.46, Math.max(0.28, cam.polar - (e.clientY - drag.y) * 0.006));
  drag = { x: e.clientX, y: e.clientY };
  placeCamera();
});
canvas.addEventListener("pointerup", () => { drag = null; });
canvas.addEventListener("wheel", (e) => { cam.dist = Math.min(0.42, Math.max(0.08, (cam.dist || 0.31) * Math.exp(e.deltaY * 0.001))); placeCamera(); }, { passive: true });
// ?target=x,y,z overrides the look-at point (tray space)
const customTarget = q.has("target") ? new THREE.Vector3(...q.get("target").split(",").map(Number)) : null;
function placeCamera() {
  const d = cam.dist || (camera.aspect < 0.75 ? 0.31 : 0.26);
  const target = customTarget || (q.get("zoom") === "1" ? new THREE.Vector3(seat[0] * 0.75, 0.05, seat[2] * 0.75) : TARGET);
  const s = Math.sin(cam.polar);
  camera.position.set(target.x + d * s * Math.sin(cam.az), target.y + d * Math.cos(cam.polar), target.z + d * s * Math.cos(cam.az));
  camera.lookAt(target);
  camera.updateMatrixWorld();
}
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.fov = (2 * Math.atan(Math.tan((17 * Math.PI) / 180) * Math.max(1, 0.9 / camera.aspect)) * 180) / Math.PI;
  if (q.get("zoom") === "1") camera.fov *= 0.5;
  camera.setViewOffset(w, h, 0, h * (w < 700 ? 0.05 : 0.03), w, h);
  camera.updateProjectionMatrix();
  placeCamera();
}
window.addEventListener("resize", resize);
resize();

// ---------------------------------------------------------------- bloom ----
let pipeline = null;
const wantBloom = () => (q.has("bloom") ? q.get("bloom") === "1" : quality === "high" && !lite);
let lastDraws = 0;
function render() {
  renderOnce();
  lastDraws = renderer.info.render.drawCalls;
}
function renderOnce() {
  if (wantBloom()) {
    if (!pipeline) {
      const scenePass = pass(scene, camera);
      const color = scenePass.getTextureNode("output");
      pipeline = new THREE.RenderPipeline(renderer);
      pipeline.outputNode = color.add(bloom(color, 0.55, 0.45, 0.92));
    }
    pipeline.render();
  } else renderer.render(scene, camera);
}

// ---------------------------------------------------------------- HUD ----
const hud = document.getElementById("hud");
function button(label, on, fn) {
  const b = document.createElement("button");
  b.textContent = label; if (on) b.classList.add("on");
  b.addEventListener("click", fn);
  hud.appendChild(b);
}
const sep = () => hud.appendChild(Object.assign(document.createElement("span"), { className: "sep" }));
function updateHud() {
  hud.innerHTML = "";
  for (const [k, label] of [["eat", "🥄 eat"], ["spit", "💦 spit"], ["kick", "🦶 kick"], ["refuse", "🙅 refuse"], ["toilet", "🚽 toilet"]]) button(label, outcome === k, () => { outcome = k; play(mood); });
  button("🧐 picky", picky, () => { picky = !picky; play(mood); });
  button("😊 happy", happy, () => { happy = !happy; rabbit.setHappy(happy); play(mood); });
  for (const f of [0, 0.5, 1]) button(`배 ${f}`, fullness === f, () => { fullness = f; rabbit.setFullness(f); updateHud(); if (paused) render(); });
  sep();
  for (const [k, label] of [["happy", "😊"], ["ok", "🙂"], ["sad", "😢"], ["special", "🌟"]]) button(label, mood === k, () => play(k));
  button("⏭ skip", false, () => rabbit.skip());
  sep();
  for (const k of Object.keys(SHAPES)) button(k, shape === k, () => { setShape(k); play(mood); });
  sep();
  for (const c of ["#ff6f9a", "#7fd6a8", "#ffb347"]) button("●", jellyColor === c, () => { jellyColor = c; play(mood); });
  sep();
  for (const k of ["high", "medium", "low"]) button(k, quality === k, () => { quality = k; rabbit.setQuality(k); updateHud(); });
  for (const n of [2, 4, 6]) button(`${n}×`, bites === n, () => { bites = n; updateHud(); });
  sep();
  const worn = rabbit.outfit;
  for (const [slot, ids] of Object.entries(OUTFIT_SLOTS)) {
    for (const id of ids) button(`${slot}:${id}`, worn[slot] === id, () => { rabbit.setOutfit({ ...rabbit.outfit, [slot]: worn[slot] === id ? null : id }); updateHud(); if (paused) render(); });
  }
  for (const b of hud.querySelectorAll("button")) if (b.textContent === "●") b.style.color = ["#ff6f9a", "#7fd6a8", "#ffb347"][[...hud.querySelectorAll("button")].filter((x) => x.textContent === "●").indexOf(b)];
}
updateHud();
const statusEl = document.getElementById("status");

// ---------------------------------------------------------------- loop ----
let last = performance.now(), paused = false, lastFrame = null;
function step(dt) {
  clock += dt;
  const out = rabbit.update(dt, jellyInfo());
  stepJelly(dt, out.hold);
  lastFrame = out;
  return out;
}
// Deterministic seek: replays from 0 with a fixed 60 Hz step, then pauses.
R.seek = (t, opts = {}) => {
  if (opts.quality) { quality = opts.quality; rabbit.setQuality(quality); }
  if (opts.bites) bites = opts.bites;
  if (opts.outcome) outcome = opts.outcome;
  if (opts.color) jellyColor = opts.color;
  if (opts.shape) setShape(opts.shape);
  if (opts.picky !== undefined) picky = Boolean(opts.picky);
  if (opts.outfit) rabbit.setOutfit(opts.outfit);
  if (opts.fullness !== undefined) { fullness = opts.fullness; rabbit.setFullness(fullness); }
  if (opts.happy !== undefined) { happy = Boolean(opts.happy); rabbit.setHappy(happy); }
  clock = 0;
  play(opts.mood ?? mood);
  const n = Math.round(t * 60);
  for (let i = 0; i < n; i += 1) step(1 / 60);
  paused = true;
  render();
  R.seekDone = (R.seekDone || 0) + 1;
  return { phase: lastFrame?.phase, hold: lastFrame?.hold, paws: lastFrame?.paws, mouth: lastFrame?.mouth, jelly: jellyInfo() };
};
R.play = (m) => { paused = false; play(m); };
R.skip = () => rabbit.skip();
R.resume = () => { paused = false; last = performance.now(); };
R.step = step;
R.render = render;
R.setQuality = (k) => { quality = k; rabbit.setQuality(k); updateHud(); };
R.setOutfit = (o) => { rabbit.setOutfit(o); updateHud(); };
R.placeCamera = (o) => { Object.assign(cam, o); placeCamera(); };
// Draw calls of the bunny alone (plain render, no bloom).
R.countDraws = () => {
  const vis = tray.children.map((c) => c.visible);
  for (const c of tray.children) if (c !== rabbit.root && c !== rabbit.chunk && c !== rabbit.dust && c !== rabbit.potty?.group) c.visible = false;
  const bg = scene.background; scene.background = null;
  renderer.info.autoReset = false;
  renderer.info.reset();
  renderer.render(scene, camera);
  const calls = renderer.info.render.drawCalls;
  const triangles = renderer.info.render.triangles;
  renderer.info.autoReset = true;
  tray.children.forEach((c, i) => { c.visible = vis[i]; });
  scene.background = bg;
  R.bunnyDraws = calls - 1; // minus the backend's own output pass (an empty scene counts 1)
  return { calls, triangles };
};

renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!paused) step(dt);
  if (!paused || R.frames < 3) render();
  R.frames += 1;
  if (R.frames > 2) R.ready = true;
  if (R.frames % 10 === 0) {
    statusEl.textContent = `${R.backend} · ${quality} · ${lastFrame?.phase ?? ""} · t=${(clock - playStart).toFixed(2)}s · hold ${lastFrame?.hold ? fmt(lastFrame.hold) : "–"} · draws ${lastDraws} (bunny ${R.bunnyDraws ?? "?"})`;
  }
});

resetJelly();
if (q.has("t")) R.seek(num("t", 0));
else if (q.get("autoplay") !== "0") play(mood);
