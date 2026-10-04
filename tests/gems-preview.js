// Standalone gem preview: all nine shapes in a 3×3 grid, slowly rotating, on
// the app's bench colour with the app's renderer settings plus a bloom pass.
//
// Query: ?color=<id|index>  ?quality=high|mid|low  ?lite=1 (WebGL2 backend)
//        ?t=<seconds> freeze time   ?spin=<rad/s>   ?mode=wobble|turn (±40° sway or full turns)
//        ?glow=0..1   ?glowScale=0..2
//        ?single=<shape index> one big gem   ?bloom=0   ?icons=0   ?hud=0   ?mixed=1 (all colours)
//        ?raw=1 no tone mapping / bloom (clipped = HDR ≥ 1)
//        ?jelly=1 wrap each gem in a transmissive blob (checks opaque-before-transmission)
import * as THREE from "three/webgpu";
import { pass } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { GEM_COLORS, GEM_SHAPES, GEM_SIZE, GemLayer, createGemLibrary, gemIconSVG } from "../src/render/gems.js";

const q = new URLSearchParams(location.search);
const num = (k, d) => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);
const colorParam = q.get("color") ?? "pink";
let colorIndex = GEM_COLORS.findIndex((c) => c.id === colorParam);
if (colorIndex < 0) colorIndex = Math.min(GEM_COLORS.length - 1, Math.max(0, num("color", 0) | 0));
const quality = q.get("quality") ?? "high";
const lite = q.get("lite") === "1";
const frozen = q.has("t") ? num("t", 0) : null;
const spin = num("spin", 0.45);
const glow = num("glow", 0);
const single = q.has("single") ? Math.min(8, Math.max(0, num("single", 0) | 0)) : -1;
const mixed = q.get("mixed") === "1";
const turn = q.get("mode") === "turn";

window.__gems = { errors: [], frames: 0, ready: false };
window.addEventListener("error", (e) => window.__gems.errors.push(String(e.message || e)));
window.addEventListener("unhandledrejection", (e) => window.__gems.errors.push(String(e.reason?.stack || e.reason)));

const hud = document.getElementById("hud");
if (q.get("hud") === "0") hud.hidden = true;
hud.innerHTML = GEM_COLORS.map((c) => `<a href="?${new URLSearchParams({ ...Object.fromEntries(q), color: c.id })}">${c.label}</a>`).join("")
  + ["high", "mid", "low"].map((t) => `<a href="?${new URLSearchParams({ ...Object.fromEntries(q), quality: t })}">${t}</a>`).join("");
if (q.get("icons") !== "0") {
  document.getElementById("icons").innerHTML = GEM_SHAPES.map((s, i) => `<span title="${s.label}">${gemIconSVG(i, GEM_COLORS[colorIndex].hex)}</span>`).join("");
}

const canvas = document.getElementById("stage");
const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: false, forceWebGL: lite });
await renderer.init();
renderer.outputColorSpace = THREE.SRGBColorSpace;
// ?raw=1: no tone mapping and no bloom, so clipped pixels mark linear HDR ≥ 1
// (what the app's bloom threshold catches).
const raw = q.get("raw") === "1";
renderer.toneMapping = raw ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
renderer.setClearColor(0xdfe6e8, 1);
window.__gems.backend = renderer.backend?.isWebGPUBackend ? "webgpu" : "webgl2";

const scene = new THREE.Scene();
scene.background = new THREE.Color("#dfe6e8");
const sun = new THREE.DirectionalLight(0xfff1da, 3.0);
const lightDirection = new THREE.Vector3(-0.6123724357, -0.5, 0.6123724357).normalize();
sun.position.copy(lightDirection).multiplyScalar(-0.45);
scene.add(sun, sun.target);

// Same viewing direction as the app camera (from the front, ~24° above).
const camera = new THREE.PerspectiveCamera(30, 1, 0.001, 2);
const viewDir = new THREE.Vector3(0, 0.096 - 0.025, 0.196).normalize();
const grid = new THREE.Group();
scene.add(grid);

const library = createGemLibrary({ quality });
const layer = new GemLayer(grid, library);
layer.setGlowScale(num("glowScale", 1));
window.__gems.library = library;
window.__gems.layer = layer;

const count = single >= 0 ? 1 : 9;
const spacing = GEM_SIZE * 1.45;
const states = new Float32Array(count * 10);
const euler = new THREE.Euler();
const quat = new THREE.Quaternion();

if (q.get("jelly") === "1") {
  const blob = new THREE.MeshPhysicalNodeMaterial({
    color: "#ffe0eb", roughness: 0.075, metalness: 0, transmission: 1, thickness: GEM_SIZE * 1.5, ior: 1.35,
    attenuationDistance: 0.035, attenuationColor: "#ed5187", clearcoat: 0.42, clearcoatRoughness: 0.05, transparent: false,
  });
  const geo = new THREE.SphereGeometry(GEM_SIZE * 0.68, 40, 24);
  for (let i = 0; i < count; i += 1) {
    const m = new THREE.Mesh(geo, blob);
    m.position.set(single >= 0 ? 0 : ((i % 3) - 1) * spacing, single >= 0 ? 0 : (1 - Math.floor(i / 3)) * spacing, 0);
    grid.add(m);
  }
}

function writeStates(time) {
  for (let i = 0; i < count; i += 1) {
    const shape = single >= 0 ? single : i;
    const o = i * 10;
    states[o] = shape;
    states[o + 1] = mixed ? (i % GEM_COLORS.length) : colorIndex;
    states[o + 2] = single >= 0 ? 0 : ((i % 3) - 1) * spacing;
    states[o + 3] = single >= 0 ? 0 : (1 - Math.floor(i / 3)) * spacing;
    states[o + 4] = 0;
    const yaw = turn ? time * spin + i * 0.7 : 0.7 * Math.sin(time * spin + i * 1.3);
    euler.set(0.25 * Math.sin(time * 0.37 + i), yaw, 0.06 * Math.sin(time * 0.23 + i * 2.1));
    quat.setFromEuler(euler);
    states[o + 5] = quat.x; states[o + 6] = quat.y; states[o + 7] = quat.z; states[o + 8] = quat.w;
    states[o + 9] = glow;
  }
  layer.update(states, count);
}

const pipeline = new THREE.RenderPipeline(renderer);
const scenePass = pass(scene, camera);
const sceneColor = scenePass.getTextureNode("output");
pipeline.outputNode = q.get("bloom") === "0" || raw ? sceneColor : sceneColor.add(bloom(sceneColor, 0.55, 0.3, 1.0));

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  const extent = single >= 0 ? GEM_SIZE * 1.25 : spacing * 3.05;
  const fit = extent / 2 / Math.tan((camera.fov * Math.PI) / 360) / Math.min(1, camera.aspect);
  camera.position.copy(viewDir).multiplyScalar(fit);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  // Face the grid toward the camera so the rows stay level on screen.
  grid.quaternion.copy(camera.quaternion);
}
window.addEventListener("resize", resize);
resize();

const start = performance.now();
renderer.setAnimationLoop(() => {
  const time = frozen ?? (performance.now() - start) / 1000;
  writeStates(time);
  pipeline.render();
  window.__gems.frames += 1;
  if (window.__gems.frames > 2) window.__gems.ready = true;
});
