// Rare gem preview: all 25 rare gems in a 5×5 grid, slowly turning, in one
// upgrade tier, on the app's bench colour with the app's renderer settings and
// bloom; below, thumbnails made by the thumbnailer and the SVG icons.
//
// Query: ?tier=0|1|2 (글리터/금빛/무지개빛)   ?quality=high|mid|low   ?lite=1 (WebGL2)
//        ?single=<index> one big gem   ?layer=1 (8 gems through RareGemLayer)
//        ?compare=i,j,… rows of gems × the three tiers side by side
//        ?t=<seconds> freeze time   ?spin=<rad/s>   ?mode=sway|turn (±35° sway or full turns)
//        ?glow=0..1   ?bloom=0   ?labels=0
//        ?strips=0 (no thumbnails/icons)   ?thumb=<px> thumbnail size   ?hud=0
//        ?selftest=1 render one thumbnail right after init (window.__rare.selftest)
import * as THREE from "three/webgpu";
import { pass } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { RARE_GEMS, RARE_SIZE, RARE_TIERS, RareGemLayer, createRareGemLibrary, rareGemIconSVG } from "../src/render/rare-gems.js";
import { createThumbnailer } from "../src/render/thumbnail.js";

const q = new URLSearchParams(location.search);
const num = (k, d) => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);
const tier = Math.min(2, Math.max(0, num("tier", 0) | 0));
const quality = q.get("quality") ?? "high";
const lite = q.get("lite") === "1";
const frozen = q.has("t") ? num("t", 0) : null;
const spin = num("spin", 0.4);
const glow = num("glow", 0);
const single = q.has("single") ? Math.min(RARE_GEMS.length - 1, Math.max(0, num("single", 0) | 0)) : -1;
const useLayer = q.get("layer") === "1";
const turn = q.get("mode") === "turn";
const compare = q.has("compare") ? q.get("compare").split(",").map((x) => Math.min(RARE_GEMS.length - 1, Math.max(0, Number(x) | 0))) : null;

window.__rare = { errors: [], frames: 0, ready: false, thumbsDone: false };
window.addEventListener("error", (e) => window.__rare.errors.push(String(e.message || e)));
window.addEventListener("unhandledrejection", (e) => window.__rare.errors.push(String(e.reason?.stack || e.reason)));

const link = (patch, text, on) => `<a class="${on ? "on" : ""}" href="?${new URLSearchParams({ ...Object.fromEntries(q), ...patch })}">${text}</a>`;
const hud = document.getElementById("hud");
if (q.get("hud") === "0") hud.hidden = true;
hud.innerHTML = RARE_TIERS.map((t, i) => link({ tier: i }, t.label, i === tier)).join("")
  + " · " + ["high", "mid", "low"].map((t) => link({ quality: t }, t, t === quality)).join("")
  + " · " + link({ lite: lite ? "0" : "1" }, lite ? "WebGL2" : "WebGPU?", true)
  + " · " + link({ layer: useLayer ? "0" : "1" }, useLayer ? "layer" : "grid", true);

const canvas = document.getElementById("stage");
const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: false, forceWebGL: lite });
await renderer.init();
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
renderer.setClearColor(0xdfe6e8, 1);
window.__rare.backend = renderer.backend?.isWebGPUBackend ? "webgpu" : "webgl2";
renderer.onDeviceLost = (info) => window.__rare.errors.push(`device lost: ${info?.message ?? ""}`);

const scene = new THREE.Scene();
scene.background = new THREE.Color("#dfe6e8");
const sun = new THREE.DirectionalLight(0xfff1da, 3.0);
sun.position.copy(new THREE.Vector3(-0.6123724357, -0.5, 0.6123724357).normalize()).multiplyScalar(-0.45);
scene.add(sun, sun.target);

const camera = new THREE.PerspectiveCamera(30, 1, 0.001, 2);
const viewDir = new THREE.Vector3(0, 0.096 - 0.025, 0.196).normalize();
const grid = new THREE.Group();
scene.add(grid);

const library = createRareGemLibrary({ quality });
library.buildAll();
window.__rare.library = library;

const cols = compare ? 3 : useLayer ? 4 : 5;
const spacing = RARE_SIZE * 1.42, rowSpacing = RARE_SIZE * 1.62; // room for the labels
const indices = single >= 0 ? [single] : compare ? compare.flatMap((i) => [i, i, i]) : useLayer ? [0, 7, 11, 13, 16, 18, 21, 24] : RARE_GEMS.map((_, i) => i);
const tierOf = (k) => (compare || useLayer ? k % 3 : tier);
const rows = Math.ceil(indices.length / cols);
const cellPos = (k) => {
  if (single >= 0) return [0, 0];
  const c = k % cols, r = Math.floor(k / cols);
  return [(c - (cols - 1) / 2) * spacing, ((rows - 1) / 2 - r) * rowSpacing + RARE_SIZE * 0.1];
};

const objects = [];
let layer = null;
const states = new Float32Array(indices.length * 10);
if (useLayer) {
  layer = new RareGemLayer(grid, library);
  window.__rare.layer = layer;
} else {
  indices.forEach((index, k) => {
    const object = library.makeObject(index, tierOf(k));
    const [x, y] = cellPos(k);
    object.position.set(x, y, 0);
    object.userData.glow = glow;
    grid.add(object);
    objects.push(object);
  });
}

const euler = new THREE.Euler(), quat = new THREE.Quaternion();
function animate(time) {
  indices.forEach((index, k) => {
    const yaw = turn ? time * spin + k * 0.9 : 0.6 * Math.sin(time * spin + k * 1.3);
    euler.set(0.22 * Math.sin(time * 0.37 + k), yaw, 0.06 * Math.sin(time * 0.23 + k * 2.1));
    quat.setFromEuler(euler);
    if (layer) {
      const o = k * 10, [x, y] = cellPos(k);
      states.set([index, tierOf(k), x, y, 0, quat.x, quat.y, quat.z, quat.w, glow], o);
    } else {
      objects[k].quaternion.copy(quat);
    }
  });
  if (layer) layer.update(states, indices.length);
}

const pipeline = new THREE.RenderPipeline(renderer);
const scenePass = pass(scene, camera);
const sceneColor = scenePass.getTextureNode("output");
pipeline.outputNode = q.get("bloom") === "0" ? sceneColor : sceneColor.add(bloom(sceneColor, 0.55, 0.3, 1.0));

// Labels under each gem.
const labels = document.getElementById("labels");
if (q.get("labels") !== "0" && single < 0) {
  labels.innerHTML = indices.map((i, k) => `<span>${RARE_GEMS[i].label}${useLayer || compare ? ` · ${RARE_TIERS[tierOf(k)].label}` : ""}</span>`).join("");
}
const tmp = new THREE.Vector3();
function placeLabels() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  grid.updateMatrixWorld(true);
  [...labels.children].forEach((el, k) => {
    const [x, y] = cellPos(k);
    tmp.set(x, y - RARE_SIZE * 0.66, 0).applyMatrix4(grid.matrixWorld).project(camera);
    el.style.left = `${((tmp.x + 1) / 2) * w}px`;
    el.style.top = `${((1 - tmp.y) / 2) * h}px`;
  });
}

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  const extentX = single >= 0 ? RARE_SIZE * 1.3 : spacing * cols * 1.02;
  const extentY = single >= 0 ? RARE_SIZE * 1.3 : rowSpacing * rows * 1.04;
  const tanHalf = Math.tan((camera.fov * Math.PI) / 360);
  const fit = Math.max(extentY / 2 / tanHalf, extentX / 2 / tanHalf / camera.aspect);
  camera.position.copy(viewDir).multiplyScalar(fit);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  grid.quaternion.copy(camera.quaternion);
  placeLabels();
}
window.addEventListener("resize", resize);

// Strips: thumbnails (rendered offscreen by the thumbnailer) and SVG icons.
const strips = document.getElementById("strips");
if (q.get("strips") === "0") strips.hidden = true;
document.getElementById("icons").innerHTML = RARE_GEMS.map((g, i) => `<span title="${g.label}">${rareGemIconSVG(i, tier)}</span>`).join("");
resize();

const thumbnailer = createThumbnailer(renderer);
Object.assign(window.__rare, { thumbnailer, scene, camera, renderer });
async function makeThumbs() {
  const box = document.getElementById("thumbs");
  const size = num("thumb", 104);
  try {
    for (let i = 0; i < RARE_GEMS.length; i += 1) {
      const object = library.makeObject(i, tier);
      object.rotation.set(0.12, -0.35, 0);
      const url = await thumbnailer.renderObject(object, { size });
      const img = new Image();
      img.src = url; img.title = RARE_GEMS[i].label; img.alt = RARE_GEMS[i].id;
      box.appendChild(img);
    }
  } catch (error) {
    window.__rare.errors.push(`thumbnail: ${error?.stack || error}`);
  }
  window.__rare.thumbsDone = true;
}

if (q.get("selftest") === "1") {
  // Before the first frame (headless WebGPU drops its device within seconds):
  // thumbnails covering both materials and all tiers. Lollipop is asymmetric
  // (stick down) so a flipped readback would show.
  try {
    const urls = [];
    for (const [index, t] of [[16, 0], [18, 1], [13, 2], [7, 0]]) urls.push(await thumbnailer.renderObject(library.makeObject(index, t), { size: 128 }));
    window.__rare.selftestAll = urls;
    window.__rare.selftest = urls[0];
  } catch (error) {
    window.__rare.errors.push(`selftest: ${error?.message || error}`);
  }
}

const start = performance.now();
renderer.setAnimationLoop(() => {
  const time = frozen ?? (performance.now() - start) / 1000;
  animate(time);
  pipeline.render();
  window.__rare.frames += 1;
  if (window.__rare.frames === 3) {
    window.__rare.ready = true;
    if (q.get("strips") !== "0") makeThumbs(); else window.__rare.thumbsDone = true;
  }
});
