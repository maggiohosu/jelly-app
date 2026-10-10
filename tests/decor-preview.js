// Decoration preview: stand-in jelly blobs (70 mm transmissive spheres) on the
// app's stage (same renderer settings, bench, fog, sun, bloom, camera rig)
// wearing face decor from src/render/decor.js, plus the shape icons.
//
// Query: ?face=all|bear|cat|bird   ?zoom=1|3 (close-up)   ?lite=1 (WebGL2)
//        ?azimuth=<rad> ?polar=<rad> ?bloom=0 ?icons=0|big ?hud=0 ?wobble=0
//        ?t=<seconds> freeze time   ?bare=1 (decor without the blobs)
//        ?mode=embedded (decor under the surface, refracted)   ?inset=<m>
import * as THREE from "three/webgpu";
import { createStage } from "../src/render/stage.js";
import { DECOR_KINDS, DECOR_STRIDE, DecorLayer } from "../src/render/decor.js";
import { SHAPE_ICON_IDS, shapeIconSVG } from "../src/render/shape-icons.js";

const q = new URLSearchParams(location.search);
const num = (k, d) => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);
const lite = q.get("lite") === "1";
const face = q.get("face") ?? "all";
const zoom = num("zoom", 1);
const frozen = q.has("t") ? num("t", 0) : null;
const wobble = q.get("wobble") !== "0";
const bare = q.get("bare") === "1";
// Anchors sit ON the jelly surface (contract); ?inset=<m> moves them inward.
const INSET = num("inset", 0);
const embedded = q.get("mode") === "embedded";

window.__decor = { errors: [], frames: 0, ready: false };
window.addEventListener("error", (e) => window.__decor.errors.push(String(e.message || e)));
window.addEventListener("unhandledrejection", (e) => window.__decor.errors.push(String(e.reason?.stack || e.reason)));

const hud = document.getElementById("hud");
if (q.get("hud") === "0") hud.hidden = true;
const link = (k, v, label = v) => `<a class="${(q.get(k) ?? "") === String(v) ? "on" : ""}" href="?${new URLSearchParams({ ...Object.fromEntries(q), [k]: v })}">${label}</a>`;
hud.innerHTML = ["all", "bear", "cat", "bird"].map((f) => link("face", f)).join("") + link("zoom", 1, "1×") + link("zoom", 3, "3×") + link("mode", embedded ? "overlay" : "embedded") + link("lite", lite ? 0 : 1, lite ? "webgpu" : "lite");

const icons = document.getElementById("icons");
if (q.get("icons") !== "0") {
  if (q.get("icons") === "big") icons.classList.add("big");
  icons.innerHTML = [false, true].map((locked) => `<div>${SHAPE_ICON_IDS.map((id) => `<span title="${id}">${shapeIconSVG(id, { locked })}</span>`).join("")}</div>`).join("");
}

const canvas = document.getElementById("stage");
const stage = await createStage(canvas, { forceWebGL: lite });
window.__decor.backend = stage.isWebGPU ? "webgpu" : "webgl2";
stage.setBloom(q.get("bloom") !== "0");

// ---- stand-in jellies --------------------------------------------------------
const R = 0.035;
const FLAVOURS = {
  pink: { color: "#ffe0eb", attenuationColor: "#ed5187" },
  purple: { color: "#f1e6ff", attenuationColor: "#a77ce8" },
  clear: { color: "#f4f1ff", attenuationColor: "#e6d8ff" },
};
function jellyMaterial(flavour) {
  return new THREE.MeshPhysicalNodeMaterial({
    ...FLAVOURS[flavour], roughness: 0.028, metalness: 0, transmission: 1, thickness: 0.045, ior: 1.33,
    attenuationDistance: 0.035, clearcoat: 0.42, clearcoatRoughness: 0.05, transparent: false,
  });
}
const sphere = new THREE.SphereGeometry(R, 64, 40);
function mergeNonIndexed(list) {
  const out = new THREE.BufferGeometry();
  for (const name of ["position", "normal", "uv"]) {
    const size = list[0].attributes[name].itemSize;
    const arr = new Float32Array(list.reduce((n, g) => n + g.attributes[name].array.length, 0));
    let o = 0;
    for (const g of list) { arr.set(g.attributes[name].array, o); o += g.attributes[name].array.length; }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  return out;
}

const UP = new THREE.Vector3(0, 1, 0);
const dirOf = (yaw, pitch) => new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
const frameOf = (z, upHint = UP) => {
  const Z = z.clone().normalize();
  let Y = upHint.clone().addScaledVector(Z, -upHint.dot(Z));
  if (Y.lengthSq() < 1e-6) Y = new THREE.Vector3(0, 0, -1).addScaledVector(Z, -Z.z);
  Y.normalize();
  const X = new THREE.Vector3().crossVectors(Y, Z);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
};

// Decorations: { kind, p (tray), q, s, color: [r,g,b] sRGB or null }
const items = [];
function onSphere(center, kind, yaw, pitch, s, color = null, inset = INSET) {
  const n = dirOf(yaw, pitch);
  items.push({ kind, p: center.clone().addScaledVector(n, R - inset), q: frameOf(n), s, color });
}

function bear(center) {
  for (const sx of [-1, 1]) {
    onSphere(center, "eye", sx * 0.25, 0.17, 0.0028);
    onSphere(center, "blush", sx * 0.45, -0.01, 0.0045);
  }
  onSphere(center, "nose", 0, 0.05, 0.0016);
  onSphere(center, "mouth", 0, -0.015, 0.003);
  onSphere(center, "cherry", 0, Math.PI / 2, 0.0075, null, 0);
}
function cat(center, group) {
  // the strawberry jelly cat: dot eyes, a dark ω, whiskers, pointed ears and
  // strawberry halves set 4.5 mm inside (the inner kind)
  for (const sx of [-1, 1]) {
    onSphere(center, "eye", sx * 0.3, 0.12, 0.0027);
    const wn = dirOf(sx * 0.42, -0.04);
    items.push({ kind: "whisker", p: center.clone().addScaledVector(wn, R - INSET), q: frameOf(wn, sx > 0 ? UP : UP.clone().negate()), s: 0.0048, color: null });
    const n = dirOf(sx * 0.5, 0.88), h = 0.017, r0 = 0.0105;
    const base = center.clone().addScaledVector(n, R - 0.003);
    const ear = new THREE.ConeGeometry(r0, h, 40, 1).toNonIndexed();
    ear.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, n));
    ear.translate(...base.clone().addScaledVector(n, h / 2).sub(center).toArray());
    group.userData.extra.push(ear);
  }
  onSphere(center, "mouth", 0, -0.05, 0.0032, [0.11, 0.07, 0.09]);
  for (const [yaw, pitch, flip, s] of [[-0.75, -0.2, false, 0.0052], [0.8, -0.1, true, 0.005], [-0.45, 0.6, true, 0.0048], [0.35, 0.65, false, 0.0046]]) {
    const n = dirOf(yaw, pitch);
    items.push({ kind: "strawberry", p: center.clone().addScaledVector(n, R - 0.0045), q: frameOf(flip ? n.clone().negate() : n), s, color: null });
  }
}
function bird(center) {
  for (const sx of [-1, 1]) onSphere(center, "eye", sx * 0.6, 0.3, 0.0022);
  onSphere(center, "beak", 0, 0.2, 0.0055, null, 0);
}

const groups = [];
function addJelly(x, flavour, dress) {
  const g = new THREE.Group();
  g.userData.material = jellyMaterial(flavour);
  g.userData.extra = [];
  const center = new THREE.Vector3(x, R - 0.002, 0);
  const first = items.length;
  dress(center, g);
  if (!bare) {
    // One mesh per jelly (transmissive meshes do not see each other).
    const m = new THREE.Mesh(mergeNonIndexed([sphere.toNonIndexed(), ...g.userData.extra]), g.userData.material);
    m.position.copy(center);
    g.add(m);
  }
  groups.push({ g, center, first, last: items.length });
  stage.tray.add(g);
}
if (face === "all") {
  addJelly(-0.082, "purple", bear);
  addJelly(0, "pink", cat);
  addJelly(0.082, "pink", bird);
} else {
  addJelly(0, face === "bear" ? "purple" : "pink", { bear, cat, bird }[face] ?? bear);
}

const decor = new DecorLayer(stage.tray, { overlay: !embedded });
window.__decor.layer = decor;
const states = new Float32Array(items.length * DECOR_STRIDE);
const tmpQ = new THREE.Quaternion(), tmpP = new THREE.Vector3();

function writeStates(time) {
  // A gentle jiggle (rigid rotation of each blob about its base) so the
  // highlights can be judged in motion.
  let i = 0;
  for (const { g, center, first, last } of groups) {
    const a = wobble ? 0.12 * Math.sin(time * 1.3 + center.x * 40) : 0;
    tmpQ.setFromAxisAngle(UP, a);
    g.quaternion.copy(tmpQ);
    g.position.copy(center).sub(center.clone().applyQuaternion(tmpQ));
    for (let k = first; k < last; k += 1, i += 1) {
      const it = items[k], o = i * DECOR_STRIDE;
      tmpP.copy(it.p).applyQuaternion(tmpQ).add(g.position);
      const qq = tmpQ.clone().multiply(it.q);
      states[o] = DECOR_KINDS.indexOf(it.kind);
      states[o + 1] = tmpP.x; states[o + 2] = tmpP.y; states[o + 3] = tmpP.z;
      states[o + 4] = qq.x; states[o + 5] = qq.y; states[o + 6] = qq.z; states[o + 7] = qq.w;
      states[o + 8] = it.s;
      states[o + 9] = it.color ? it.color[0] : -1; states[o + 10] = it.color ? it.color[1] : 0; states[o + 11] = it.color ? it.color[2] : 0;
    }
  }
  decor.update(states, items.length);
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  stage.resize(w, h, Math.min(window.devicePixelRatio || 1, 3));
  const base = face === "all" ? (w / h < 0.75 ? 0.42 : 0.3) : (w / h < 0.75 ? 0.31 : 0.26);
  stage.rig.minDistance = 0.02;
  stage.rig.polar = stage.rig.goal.polar = num("polar", 1.1);
  stage.rig.azimuth = stage.rig.goal.azimuth = num("azimuth", 0);
  stage.rig.setDistance(base / zoom);
  if (zoom > 1) {
    // Close-up: aim at the face of the (centre) jelly.
    const target = new THREE.Vector3(0, R + 0.004, R * 0.6);
    const c = stage.camera, s = Math.sin(stage.rig.polar);
    c.position.set(target.x + stage.rig.distance * s * Math.sin(stage.rig.azimuth), target.y + stage.rig.distance * Math.cos(stage.rig.polar), target.z + stage.rig.distance * s * Math.cos(stage.rig.azimuth));
    c.lookAt(target);
    c.updateMatrixWorld();
  }
}
window.addEventListener("resize", resize);
resize();

writeStates(0);
window.__decor.info = { items: items.length, triangles: decor.triangleCounts, drawCalls: decor.meshes.filter((m) => m.visible).length };
// ?probe=1: compile every pipeline inside a validation error scope and report
// (headless WebGPU loses its device within seconds, before frames land).
if (q.get("probe") === "1") {
  const device = stage.renderer.backend?.device;
  const probe = { backend: window.__decor.backend };
  try {
    device?.pushErrorScope("validation");
    await stage.renderer.compileAsync(stage.scene, stage.camera);
    const err = device ? await device.popErrorScope() : null;
    probe.validation = err ? err.message : null;
    if (device) {
      probe.shaders = [];
      for (const mesh of decor.meshes) {
        const { vertexShader, fragmentShader } = await stage.renderer.debug.getShaderAsync(stage.scene, stage.camera, mesh);
        for (const code of [vertexShader, fragmentShader]) {
          const info = await device.createShaderModule({ code }).getCompilationInfo();
          probe.shaders.push(info.messages.filter((m) => m.type === "error").map((m) => m.message).join("; ") || "ok");
        }
      }
    }
  } catch (e) { probe.exception = String(e?.stack || e); }
  window.__decor.probe = probe;
}

const start = performance.now();
stage.renderer.setAnimationLoop(() => {
  const time = frozen ?? (performance.now() - start) / 1000;
  writeStates(time);
  stage.updateTilt();
  stage.syncTrayCamera();
  stage.render();
  window.__decor.frames += 1;
  if (window.__decor.frames > 3) window.__decor.ready = true;
  // Frozen time: stop after a few frames (cheap screenshots).
  if (frozen !== null && window.__decor.frames >= 6) stage.renderer.setAnimationLoop(null);
});
