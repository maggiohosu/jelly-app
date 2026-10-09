// Tray / background theme preview: the app's stage (renderer, bench, fog, sun,
// rim, camera rig) with stand-in jelly blobs and a chip per theme built from
// THEME_LOOKS (label + swatch). The floor is shaded like jelly-view's receiver
// (bench texture in tray space) minus the shadow / caustic terms.
//
// Query: ?theme=basic|flower|starry|strawberry|rainbow   ?lite=1 (WebGL2)
//        ?polar=<rad> ?distance=<m> ?azimuth=<rad>   ?bloom=0   ?chips=0
// window.__themes = { ready, errors, backend, stage, set(id) } for scripted shots.
import * as THREE from "three/webgpu";
import { positionLocal, texture } from "three/tsl";
import { createStage, THEME_LOOKS } from "../src/render/stage.js";

const q = new URLSearchParams(location.search);
const num = (k, d) => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);
window.__themes = { errors: [], ready: false };
window.addEventListener("error", (e) => window.__themes.errors.push(String(e.message || e)));
window.addEventListener("unhandledrejection", (e) => window.__themes.errors.push(String(e.reason?.stack || e.reason)));

const canvas = document.getElementById("stage");
const stage = await createStage(canvas, { forceWebGL: q.get("lite") === "1" });
stage.setBloom(q.get("bloom") !== "0");
stage.benchMaterial.colorNode = texture(stage.benchTexture, positionLocal.xz.div(0.16).add(0.5)).rgb;
stage.benchMaterial.needsUpdate = true;

// Stand-in jellies: squashed transmissive spheres in a few flavours.
const FLAVOURS = [
  { color: "#ffe0eb", attenuationColor: "#ed5187", at: [-0.022, 0.012] },
  { color: "#e3f6ff", attenuationColor: "#3f9be0", at: [0.026, 0.004] },
  { color: "#f4f1ff", attenuationColor: "#e6d8ff", at: [0.0, -0.03] },
];
const sphere = new THREE.SphereGeometry(0.019, 64, 40);
for (const flavour of FLAVOURS) {
  const material = new THREE.MeshPhysicalNodeMaterial({
    color: flavour.color, attenuationColor: flavour.attenuationColor, roughness: 0.028, metalness: 0, transmission: 1,
    thickness: 0.016, ior: 1.33, attenuationDistance: 0.05, clearcoat: 0.42, clearcoatRoughness: 0.05,
  });
  const mesh = new THREE.Mesh(sphere, material);
  mesh.scale.set(1, 0.72, 1);
  mesh.position.set(flavour.at[0], 0.019 * 0.72, flavour.at[1]);
  stage.tray.add(mesh);
}

const rig = stage.rig;
rig.azimuth = rig.goal.azimuth = num("azimuth", 0);
rig.polar = rig.goal.polar = num("polar", rig.polar);
function resize() {
  stage.resize(window.innerWidth, window.innerHeight, Math.min(2, window.devicePixelRatio || 1));
  if (q.has("distance")) rig.setDistance(num("distance", rig.distance));
  rig.apply();
}
window.addEventListener("resize", resize);
resize();

// Theme chips.
const chips = document.getElementById("themes");
if (q.get("chips") === "0") chips.hidden = true;
function set(id) {
  const applied = stage.setTheme(id);
  for (const button of chips.children) button.classList.toggle("on", button.dataset.theme === applied);
  return applied;
}
for (const [id, look] of Object.entries(THEME_LOOKS)) {
  const button = document.createElement("button");
  button.dataset.theme = id;
  const chip = document.createElement("i");
  chip.style.background = look.swatch;
  const label = document.createElement("span");
  label.textContent = look.label;
  button.append(chip, label);
  button.addEventListener("click", () => set(id));
  chips.append(button);
}
set(q.get("theme") || "basic");

// Drag to orbit (preview only).
let drag = null;
canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener("pointermove", (e) => {
  if (!drag) return;
  rig.rotate(-(e.clientX - drag.x) * 0.008, -(e.clientY - drag.y) * 0.006);
  drag = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener("pointerup", () => { drag = null; });
canvas.addEventListener("wheel", (e) => { rig.zoom(e.deltaY > 0 ? 1.08 : 1 / 1.08); e.preventDefault(); }, { passive: false });

await stage.renderer.compileAsync(stage.scene, stage.camera);
function frame() {
  rig.update();
  stage.render();
  requestAnimationFrame(frame);
}
frame();
Object.assign(window.__themes, { ready: true, backend: stage.isWebGPU ? "webgpu" : "webgl2", stage, set });
