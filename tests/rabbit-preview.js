// Standalone preview of the jelly-eating bunny (src/render/rabbit.js) on the
// app's tray, with the app's camera, light, background, fog and bloom.
// A stand-in jelly (pink transmissive dome, 72 × 36 mm) is moved by a damped
// spring toward the bunny's paw targets (lagging and wobbling like the app's
// physics would) and shrinks 13 % per bite.
//
// Query: ?lite=1 (WebGL2)  ?quality=high|medium|low  ?mood=happy|ok|sad  ?bites=4
//        ?autoplay=0  ?t=<s> freeze at that time (deterministic seek)  ?seat=<deg> seat angle
//        ?az=<rad> camera azimuth  ?polar=<rad>  ?dist=<m>  ?zoom=1 close-up  ?bloom=0|1
//        ?clean=1 hide HUD  ?jelly=0 no stand-in
import * as THREE from "three/webgpu";
import { pass } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { Rabbit } from "../src/render/rabbit.js";

const q = new URLSearchParams(location.search);
const num = (k, d) => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);
const lite = q.get("lite") === "1";
let quality = q.get("quality") ?? "high";
let mood = q.get("mood") ?? "happy";
let bites = num("bites", 4);
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
const JELLY_W = 0.072, JELLY_H = 0.036;
const jellyGeometry = new THREE.SphereGeometry(1, 64, 40);
{
  const p = jellyGeometry.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i += 1) {
    v.fromBufferAttribute(p, i);
    const a = Math.atan2(v.z, v.x);
    const lobe = 1 + 0.06 * Math.cos(5 * a) * Math.sqrt(Math.max(0, 1 - v.y * v.y));
    let y = v.y < 0 ? -Math.pow(-v.y, 0.45) : v.y; // flat-ish bottom
    p.setXYZ(i, v.x * lobe * JELLY_W / 2, y * JELLY_H / 2, v.z * lobe * JELLY_W / 2);
  }
  jellyGeometry.computeVertexNormals();
}
const jellyMaterial = new THREE.MeshPhysicalNodeMaterial({
  color: "#ffe0eb", roughness: 0.075, metalness: 0, transmission: 1, thickness: 0.03, ior: 1.35,
  attenuationDistance: 0.035, attenuationColor: "#ed5187", clearcoat: 0.42, clearcoatRoughness: 0.05, transparent: false,
});
const jelly = new THREE.Mesh(jellyGeometry, jellyMaterial);
jelly.name = "StandInJelly";
jelly.visible = q.get("jelly") !== "0";
tray.add(jelly);
const J = {
  c: new THREE.Vector3(0, JELLY_H / 2, 0), v: new THREE.Vector3(), size: 1, sizeGoal: 1,
  wob: 0, wobV: 0, gone: false, rest: new THREE.Vector3(0, JELLY_H / 2, 0), F: new THREE.Vector3(0, 0, 1),
};
function resetJelly() {
  J.c.copy(J.rest); J.v.set(0, 0, 0); J.size = J.sizeGoal = 1; J.wob = J.wobV = 0; J.gone = false;
  jelly.visible = q.get("jelly") !== "0";
}
function stepJelly(dt, paws) {
  if (J.gone) { J.size = Math.max(0, J.size - dt * 8); }
  else J.size += (J.sizeGoal - J.size) * (1 - Math.exp(-dt / 0.06));
  const target = new THREE.Vector3();
  let w = 2 * Math.PI * 1.6, z = 0.9;
  if (paws) {
    // Paws hold the jelly's left/right sides: its centre sits between them (sagging a little).
    target.set((paws[0][0] + paws[1][0]) / 2, (paws[0][1] + paws[1][1]) / 2, (paws[0][2] + paws[1][2]) / 2);
    target.y -= 0.002;
    w = 2 * Math.PI * 4.2; z = 0.32;
  } else {
    target.copy(J.c); target.y = (JELLY_H / 2) * J.size; // settle down onto the tray
    target.x *= 1; target.z *= 1;
    if (J.c.y > target.y + 1e-4) { J.v.y -= 9.81 * dt; }
  }
  const n = Math.max(1, Math.ceil(dt / (1 / 240))), h = dt / n;
  for (let i = 0; i < n; i += 1) {
    if (paws) {
      const a = target.clone().sub(J.c).multiplyScalar(w * w).addScaledVector(J.v, -2 * z * w);
      J.v.addScaledVector(a, h);
    } else {
      J.v.multiplyScalar(Math.exp(-h * 4));
    }
    J.c.addScaledVector(J.v, h);
    if (!paws && J.c.y < (JELLY_H / 2) * J.size) { J.c.y = (JELLY_H / 2) * J.size; if (J.v.y < 0) { J.wobV += -J.v.y * 40; J.v.y *= -0.15; } }
    // wobble (squash) driven by vertical acceleration
    const ww = 2 * Math.PI * 5.5;
    J.wobV += (-ww * ww * J.wob - 2 * 0.18 * ww * J.wobV) * h;
    J.wob += J.wobV * h;
  }
  if (paws) J.wobV += -J.v.y * dt * 30;
  J.wob = Math.max(-0.35, Math.min(0.35, J.wob));
  const sy = 1 + J.wob, sxz = 1 / Math.sqrt(sy);
  // Held jellies sag between the paws: flatter and a bit narrower.
  const sag = paws ? 0.9 : 1;
  jelly.position.copy(J.c);
  jelly.scale.set(sxz * J.size, sy * J.size * sag, sxz * J.size);
  if (J.gone && J.size <= 0) jelly.visible = false;
}
function jellyInfo() {
  if (!jelly.visible || J.size <= 0.01) return null;
  const hx = (JELLY_W / 2) * jelly.scale.x * 1.06, hy = (JELLY_H / 2) * jelly.scale.y, hz = (JELLY_W / 2) * jelly.scale.z * 1.06;
  const c = J.c;
  return { center: [c.x, c.y, c.z], bounds: [c.x - hx, c.y - hy, c.z - hz, c.x + hx, c.y + hy, c.z + hz] };
}

// ---------------------------------------------------------------- rabbit ----
const rabbit = new Rabbit(tray, { quality });
Object.assign(R, { rabbit, renderer, scene, camera, tray });
const seatAngle = (num("seat", 0) * Math.PI) / 180;
const seat = [-0.105 * Math.sin(seatAngle), 0, -0.105 * Math.cos(seatAngle)];
const faceTo = [0, 0.02, 0];
let clock = 0, playStart = 0;
const logEl = document.getElementById("log");
const logLines = [];
function log(line) {
  logLines.push(line);
  while (logLines.length > 26) logLines.shift();
  logEl.textContent = logLines.join("\n");
}

function play(m = mood) {
  mood = m;
  resetJelly();
  J.F.set(faceTo[0] - seat[0], 0, faceTo[2] - seat[2]).normalize();
  R.events.length = 0;
  log(`— play ${mood} ×${bites} (${quality})`);
  playStart = clock;
  rabbit.play({
    position: seat, faceTo, jelly: { center: [J.c.x, J.c.y, J.c.z], width: JELLY_W, height: JELLY_H }, bites, mood,
    onEvent(type, data) {
      const t = clock - playStart;
      R.events.push({ t: Number(t.toFixed(3)), type, data });
      const fmt = (a) => a.map((x) => x.toFixed(3)).join(",");
      const extra = type === "bite" ? ` ${data.index + 1}/${data.count} @${fmt(data.mouth)}`
        : type === "grab" ? ` L[${fmt(data.paws[0])}] R[${fmt(data.paws[1])}]`
          : type === "react" ? ` ${data.mood}` : type === "hop" ? ` ${data.phase}#${data.index}` : "";
      log(`${t.toFixed(2).padStart(5)}s ${type}${extra}`);
      if (type === "bite") J.sizeGoal *= 0.87;
      if (type === "finish") J.gone = true;
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
function placeCamera() {
  const d = cam.dist || (camera.aspect < 0.75 ? 0.31 : 0.26);
  const target = q.get("zoom") === "1" ? new THREE.Vector3(seat[0] * 0.75, 0.05, seat[2] * 0.75) : TARGET;
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
function updateHud() {
  hud.innerHTML = "";
  button("😊 happy", false, () => play("happy"));
  button("🙂 ok", false, () => play("ok"));
  button("😢 sad", false, () => play("sad"));
  button("⏭ skip", false, () => rabbit.skip());
  hud.appendChild(Object.assign(document.createElement("span"), { className: "sep" }));
  for (const k of ["high", "medium", "low"]) button(k, quality === k, () => { quality = k; rabbit.setQuality(k); updateHud(); });
  hud.appendChild(Object.assign(document.createElement("span"), { className: "sep" }));
  for (const n of [2, 4, 6]) button(`${n} bites`, bites === n, () => { bites = n; updateHud(); });
}
updateHud();
const statusEl = document.getElementById("status");

// ---------------------------------------------------------------- loop ----
let last = performance.now(), paused = false, lastFrame = null;
function step(dt) {
  clock += dt;
  const out = rabbit.update(dt, jellyInfo());
  stepJelly(dt, out.paws);
  lastFrame = out;
  return out;
}
// Deterministic seek: replays from 0 with a fixed 60 Hz step, then pauses.
R.seek = (t, opts = {}) => {
  if (opts.quality) { quality = opts.quality; rabbit.setQuality(quality); }
  if (opts.bites) bites = opts.bites;
  clock = 0;
  play(opts.mood ?? mood);
  const n = Math.round(t * 60);
  for (let i = 0; i < n; i += 1) step(1 / 60);
  paused = true;
  render();
  R.seekDone = (R.seekDone || 0) + 1;
  return { phase: lastFrame?.phase, paws: lastFrame?.paws, mouth: lastFrame?.mouth, jelly: jellyInfo() };
};
R.play = (m) => { paused = false; play(m); };
R.skip = () => rabbit.skip();
R.resume = () => { paused = false; last = performance.now(); };
R.step = step;
R.render = render;
R.setQuality = (k) => { quality = k; rabbit.setQuality(k); updateHud(); };
// Draw calls of the bunny alone (plain render, no bloom).
R.countDraws = () => {
  const vis = [tray.children.map((c) => c.visible)];
  for (const c of tray.children) if (c !== rabbit.root) c.visible = false;
  const bg = scene.background; scene.background = null;
  renderer.info.autoReset = false;
  renderer.info.reset();
  renderer.render(scene, camera);
  const calls = renderer.info.render.drawCalls;
  const triangles = renderer.info.render.triangles;
  renderer.info.autoReset = true;
  tray.children.forEach((c, i) => { c.visible = vis[0][i]; });
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
    statusEl.textContent = `${R.backend} · ${quality} · ${lastFrame?.phase ?? ""} · t=${(clock - playStart).toFixed(2)}s · draws ${lastDraws} (bunny ${R.bunnyDraws ?? "?"})`;
  }
});

if (q.has("t")) R.seek(num("t", 0));
else if (q.get("autoplay") !== "0") play(mood);
