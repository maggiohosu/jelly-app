// Shape preview: one jelly shape on the tray, seen from the app camera.
// The surface is the cage boundary after two Loop subdivisions (exactly what
// the app renders), the transmissive material follows jelly-view.js, the dye
// comes per cage node from shapeLook(id).dye (absorbed over the view thickness
// exactly as render/jelly-view.js does), and the
// decor / glitter / pearls are simple stand-ins.
//
// Query: ?shape=<id>  ?lite=1 (WebGL2)  ?settle=0 (rest pose; default: the
//        settled pose after dropping it on the floor like the app)
//        ?azimuth=<rad> ?polar=<rad> ?dist=<m>  ?wire=1 (cage boundary edges)
//        ?clean=1 (no HUD)  ?decor=0  ?fill=0 (no glitter/pearls)
import * as THREE from "three/webgpu";
import { abs, attribute, clamp, dot, exp, float, mix, normalView, positionLocal, positionViewDirection, sin, time, vec3 } from "three/tsl";
import { SHAPES, makeShapeCage, shapeLook, shapeStats } from "../src/core/shapes.js";
import { makeSurfaceStencils, makeTetLocator, evaluateSurface } from "../src/core/cage.js";
import { SoftBody } from "../src/core/softbody.js";
import { SurfaceBVH } from "../src/core/optics.js";

const q = new URLSearchParams(location.search);
const num = (k, d) => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);
const shapeId = SHAPES.some((s) => s.id === q.get("shape")) ? q.get("shape") : "bear";
const lite = q.get("lite") === "1";
const settle = q.get("settle") !== "0";
if (q.get("clean") === "1") document.body.classList.add("clean");

window.__shapes = { errors: [], frames: 0, ready: false, shape: shapeId };
window.addEventListener("error", (e) => window.__shapes.errors.push(String(e.message || e)));
window.addEventListener("unhandledrejection", (e) => window.__shapes.errors.push(String(e.reason?.stack || e.reason)));

document.getElementById("hud").innerHTML = SHAPES.map((s) => `<a class="${s.id === shapeId ? "on" : ""}" href="?${new URLSearchParams({ ...Object.fromEntries(q), shape: s.id })}">${s.label}</a>`).join("")
  + `<a href="?${new URLSearchParams({ ...Object.fromEntries(q), settle: settle ? "0" : "1" })}">${settle ? "rest" : "settle"}</a>`;

// ---------------------------------------------------------------- physics side
const t0 = performance.now();
const cage = makeShapeCage(shapeId);
const tCage = performance.now() - t0;
const look = shapeLook(shapeId);
const stencils = makeSurfaceStencils(cage);
const locator = makeTetLocator(cage, 0.004);
const body = new SoftBody({ cage, stencils });
let simMs = 0;
if (settle) {
  const s0 = performance.now();
  for (let i = 0; i < 240 * 4 && !body.sleeping; i++) body.step(1 / 240);
  simMs = performance.now() - s0;
}
body.updateSurface();
const st = shapeId === "flower" ? null : shapeStats(shapeId);
document.getElementById("stats").textContent = [
  `${shapeId}: ${cage.pos.length / 3} nodes, ${cage.tets.length} tets, ${cage.boundary.length} faces → ${stencils.vertexCount} verts`,
  `volume ${(cage.totalVolume * 1e6).toFixed(1)} cm³` + (st ? `, dihedral ${st.minDihedral.toFixed(1)}–${st.maxDihedral.toFixed(1)}°` : ""),
  `cage ${tCage.toFixed(0)} ms` + (settle ? `, settle ${simMs.toFixed(0)} ms, vol ${body.volumeRatio().toFixed(3)}, sleeping ${body.sleeping}` : ""),
].join("\n");

// per-node dye / fx → per-surface-vertex via the stencils (as world.js does)
const nodeCount = cage.pos.length / 3;
const nodeDye = new Float64Array(nodeCount * 3), nodeFx = new Float64Array(nodeCount * 2);
for (let i = 0; i < nodeCount; i++) {
  const x = cage.pos[i * 3], y = cage.pos[i * 3 + 1], z = cage.pos[i * 3 + 2];
  nodeDye.set(look.dye ? look.dye(x, y, z) : [5, 46, 23], i * 3);
  if (look.fx) nodeFx.set(look.fx(x, y, z), i * 2);
}
const V = stencils.vertexCount;
const shellDye = new Float32Array(V * 3), shellFx = new Float32Array(V * 2);
for (let v = 0; v < V; v++) {
  let r = 0, g = 0, b = 0, p = 0, w2 = 0;
  for (let k = stencils.offsets[v]; k < stencils.offsets[v + 1]; k++) {
    const id = stencils.ids[k], w = stencils.weights[k];
    r += nodeDye[id * 3] * w; g += nodeDye[id * 3 + 1] * w; b += nodeDye[id * 3 + 2] * w;
    p += nodeFx[id * 2] * w; w2 += nodeFx[id * 2 + 1] * w;
  }
  shellDye.set([r, g, b], v * 3); shellFx.set([p, w2], v * 2);
}

// ---------------------------------------------------------------- stage
const canvas = document.getElementById("stage");
const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: false, forceWebGL: lite });
await renderer.init();
window.__shapes.backend = renderer.backend?.isWebGPUBackend ? "webgpu" : "webgl2";
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
renderer.setClearColor(0xdfe6e8, 1);
const scene = new THREE.Scene();
scene.background = new THREE.Color("#dfe6e8");
scene.fog = new THREE.FogExp2("#dfe6e8", 0.95);
const camera = new THREE.PerspectiveCamera(34, 1, 0.001, 3);
const TARGET = new THREE.Vector3(0, 0.025, 0);
const LIGHT_DIRECTION = new THREE.Vector3(-0.6123724357, -0.5, 0.6123724357).normalize();
const sun = new THREE.DirectionalLight(0xfff1da, 3.0);
sun.target.position.copy(TARGET);
sun.position.copy(TARGET).addScaledVector(LIGHT_DIRECTION, -0.45);
scene.add(sun, sun.target);

// bench + tray rim (as stage.js)
function benchTexture() {
  const size = 1024, c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  g.fillStyle = "#dce4e6"; g.fillRect(0, 0, size, size);
  g.strokeStyle = "#bccbd04a"; g.lineWidth = 1;
  for (let i = 0; i <= 16; i++) { const p = i * size / 16; g.beginPath(); g.moveTo(p, 0); g.lineTo(p, size); g.stroke(); g.beginPath(); g.moveTo(0, p); g.lineTo(size, p); g.stroke(); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(75, 75); t.anisotropy = 4;
  return t;
}
const floorGeometry = new THREE.PlaneGeometry(12, 12);
floorGeometry.rotateX(-Math.PI / 2);
scene.add(new THREE.Mesh(floorGeometry, new THREE.MeshStandardNodeMaterial({ map: benchTexture(), roughness: 0.63, metalness: 0 })));
const rim = new THREE.Mesh(new THREE.TorusGeometry(0.075 + 0.0028, 0.0028, 20, 180),
  new THREE.MeshPhysicalNodeMaterial({ color: "#f3f6f7", emissive: "#c4ced2", emissiveIntensity: 0.55, roughness: 0.22, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.1 }));
rim.rotation.x = -Math.PI / 2; rim.position.y = 0.0028 * 0.7;
scene.add(rim);
// a soft contact shadow under the jelly
{
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d"), grd = g.createRadialGradient(64, 64, 8, 64, 64, 64);
  grd.addColorStop(0, "rgba(60,80,90,0.35)"); grd.addColorStop(1, "rgba(60,80,90,0)");
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(0.11, 0.11), new THREE.MeshBasicNodeMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.set(0.012, 0.0003, -0.01);
  scene.add(shadow);
}

// ---------------------------------------------------------------- jelly
const geometry = new THREE.BufferGeometry();
geometry.setAttribute("position", new THREE.BufferAttribute(body.positions.slice(), 3));
geometry.setAttribute("normal", new THREE.BufferAttribute(body.normals.slice(), 3));
geometry.setAttribute("dye", new THREE.BufferAttribute(shellDye, 3));
geometry.setAttribute("fx", new THREE.BufferAttribute(shellFx, 2));
geometry.setIndex(new THREE.BufferAttribute(stencils.indices, 1));
// material as render/jelly-view.js: absorption over the per-vertex view
// thickness (refracted ray length through the body, as the optics worker
// computes it), so the colours here match the app's
const ATTENUATION_DISTANCE = 0.035;
geometry.setAttribute("opticalThickness", new THREE.BufferAttribute(new Float32Array(V).fill(0.03), 1));
const sigma = attribute("dye", "vec3");
const T = exp(sigma.mul(-ATTENUATION_DISTANCE));
const opticalThickness = attribute("opticalThickness", "float");
const material = new THREE.MeshPhysicalNodeMaterial({
  roughness: 0.028, metalness: 0, transmission: 1, thickness: 0.035, ior: 1.33, dispersion: 0.01,
  attenuationDistance: ATTENUATION_DISTANCE, clearcoat: 0.42, clearcoatRoughness: 0.05, transparent: false, side: THREE.FrontSide,
});
material.colorNode = vec3(1).sub(vec3(1).sub(T).mul(0.16));
material.attenuationColorNode = T;
material.thicknessNode = opticalThickness.mul(0.82);
{
  const fx = attribute("fx", "vec2");
  const facing = abs(dot(normalView, positionViewDirection));
  const rimF = float(1).sub(facing);
  const shimmer = sin(time.mul(1.7).add(positionLocal.x.mul(260)).add(positionLocal.y.mul(190))).mul(0.25).add(0.75);
  const pearl = mix(vec3(1.0, 0.82, 0.42), vec3(1.0, 0.62, 0.78), rimF).mul(rimF.mul(0.6).add(0.1)).mul(shimmer).mul(clamp(fx.x, 0, 1)).mul(0.32);
  const glowPaint = vec3(0.45, 1.0, 0.35).mul(clamp(fx.y, 0, 1)).mul(facing.mul(0.25).add(0.2));
  material.emissiveNode = pearl.add(glowPaint);
}
// view thickness (optics.js updateViewThickness) for the fixed camera
function updateViewThickness(cam) {
  const p = body.positions, n = body.normals, out = geometry.getAttribute("opticalThickness");
  const bvh = new SurfaceBVH(p, stencils.indices), eta = 1 / 1.35;
  for (let i = 0; i < p.length; i += 3) {
    let dx = p[i] - cam.x, dy = p[i + 1] - cam.y, dz = p[i + 2] - cam.z;
    const length = Math.hypot(dx, dy, dz) || 1; dx /= length; dy /= length; dz /= length;
    const nx = n[i], ny = n[i + 1], nz = n[i + 2];
    if (dx * nx + dy * ny + dz * nz > -0.01) continue;
    const cosine = Math.min(1, Math.max(0, -(dx * nx + dy * ny + dz * nz)));
    const k = 1 - eta * eta * (1 - cosine * cosine);
    if (k < 0) continue;
    const a = eta * cosine - Math.sqrt(k);
    const rx = eta * dx + a * nx, ry = eta * dy + a * ny, rz = eta * dz + a * nz;
    const hit = bvh.hit(p[i] + rx * 2e-6, p[i + 1] + ry * 2e-6, p[i + 2] + rz * 2e-6, rx, ry, rz);
    out.array[i / 3] = hit ? Math.min(0.16, Math.max(0.0002, hit.distance)) : 0.002;
  }
  out.needsUpdate = true;
}
const jelly = new THREE.Mesh(geometry, material);
jelly.frustumCulled = false;
scene.add(jelly);
if (q.get("wire") === "1") {
  const pts = [];
  for (const [a, b, c] of cage.boundary) for (const [u, v] of [[a, b], [b, c], [c, a]]) if (u < v) pts.push(...body.x.slice(u * 3, u * 3 + 3), ...body.x.slice(v * 3, v * 3 + 3));
  const lg = new THREE.BufferGeometry(); lg.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  scene.add(new THREE.LineSegments(lg, new THREE.LineBasicNodeMaterial({ color: "#3b5560", transparent: true, opacity: 0.35 })));
}

// material point (rest) → deformed position
const tmp = [0, 0, 0];
function deformed(p) {
  const e = locator.locate(p[0], p[1], p[2]);
  if (e < 0) return null;
  body.pointInTet(e, locator.bary, tmp);
  return new THREE.Vector3(tmp[0], tmp[1], tmp[2]);
}

// ---------------------------------------------------------------- glitter / pearls (seeded)
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
function interiorPoints(count, margin) {
  const out = [], b = locator.bounds;
  let guard = 0;
  while (out.length < count && guard++ < count * 400) {
    const p = [b[0] + (b[3] - b[0]) * rnd(), b[1] + (b[4] - b[1]) * rnd(), b[2] + (b[5] - b[2]) * rnd()];
    // keep a margin inside: all six axis probes must be inside too
    let ok = locator.locate(...p) >= 0;
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) if (ok) ok = locator.locate(p[0] + dx * margin, p[1] + dy * margin, p[2] + dz * margin) >= 0;
    if (ok) { const d = deformed(p); if (d) out.push(d); }
  }
  return out;
}
if (q.get("fill") !== "0") {
  if (look.glitter) {
    const pts = interiorPoints(look.glitter, 0.0015);
    const g = new THREE.OctahedronGeometry(0.00075, 0);
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, opacity: 0.95 });
    const mesh = new THREE.InstancedMesh(g, m, pts.length);
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(1, 0.25, 1), C = new THREE.Color();
    pts.forEach((p, i) => {
      Q.setFromEuler(new THREE.Euler(rnd() * 6.28, rnd() * 6.28, rnd() * 6.28));
      M.compose(p, Q, S); mesh.setMatrixAt(i, M);
      C.setHSL(rnd(), 0.7, 0.72); mesh.setColorAt(i, C);
    });
    scene.add(mesh);
  }
  if (look.pearls) {
    const pts = interiorPoints(look.pearls, 0.003);
    const g = new THREE.SphereGeometry(0.0021, 16, 12);
    const m = new THREE.MeshStandardNodeMaterial({ color: "#fbf7f4", emissive: "#d9d2d6", roughness: 0.3, metalness: 0, transparent: true });
    const mesh = new THREE.InstancedMesh(g, m, pts.length);
    const M = new THREE.Matrix4();
    pts.forEach((p, i) => { M.makeTranslation(p.x, p.y, p.z); mesh.setMatrixAt(i, M); });
    scene.add(mesh);
  }
}

// ---------------------------------------------------------------- decor stand-ins
const DECOR_COLORS = { eye: "#1b1420", nose: "#2a1c24", mouth: "#2a1c24", blush: "#ff9db8", muzzle: "#ffffff", earInner: "#ff9ec0", cherry: "#e2203a", beak: "#e9b65a" };
function decorMesh(d) {
  const color = new THREE.Color(d.color || DECOR_COLORS[d.kind] || "#ffffff");
  const s = d.scale;
  const group = new THREE.Group();
  // transparent pass: drawn after the transmissive jelly, so the stand-ins are
  // not refracted (smeared) through the jelly they sit on
  // (the app's sun shines from behind, so a share of the colour is emissive)
  const mat = (opts = {}) => new THREE.MeshPhysicalNodeMaterial({ color, emissive: color.clone().multiplyScalar(0.55), roughness: 0.25, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.08, transparent: true, ...opts });
  // local frame: +z = normal, +y = up
  if (d.kind === "eye") {
    const m = new THREE.Mesh(new THREE.SphereGeometry(s, 24, 16), mat({ roughness: 0.12 }));
    m.scale.set(1, 1.08, 0.45); group.add(m);
    const hl = new THREE.Mesh(new THREE.SphereGeometry(s * 0.3, 12, 8), new THREE.MeshBasicNodeMaterial({ color: "#ffffff", transparent: true }));
    hl.position.set(-s * 0.3, s * 0.35, s * 0.42); group.add(hl);
  } else if (d.kind === "nose") {
    const m = new THREE.Mesh(new THREE.SphereGeometry(s, 16, 12), mat()); m.scale.set(1.3, 0.9, 0.6); group.add(m);
  } else if (d.kind === "mouth") {
    for (const sx of [-1, 1]) {
      const m = new THREE.Mesh(new THREE.TorusGeometry(s * 0.55, s * 0.13, 8, 24, Math.PI), mat());
      m.rotation.z = Math.PI; m.position.set(sx * s * 0.55, 0, 0); group.add(m);
    }
  } else if (d.kind === "blush" || d.kind === "muzzle") {
    const m = new THREE.Mesh(new THREE.SphereGeometry(s, 24, 12), mat({ roughness: 0.4, clearcoat: 0, opacity: d.kind === "blush" ? 0.6 : 0.92 }));
    m.scale.set(1.25, d.kind === "blush" ? 0.75 : 0.8, 0.22); group.add(m);
  } else if (d.kind === "earInner") {
    const shape = new THREE.Shape(); shape.moveTo(-s, -s * 0.8); shape.lineTo(s, -s * 0.8); shape.lineTo(0, s * 1.1); shape.closePath();
    const m = new THREE.Mesh(new THREE.ShapeGeometry(shape), mat({ roughness: 0.4, clearcoat: 0, side: THREE.DoubleSide, opacity: 0.9 }));
    m.position.z = s * 0.15; group.add(m);
  } else if (d.kind === "cherry") {
    const m = new THREE.Mesh(new THREE.SphereGeometry(s, 32, 24), mat({ roughness: 0.08 })); m.position.z = s * 0.85; m.scale.set(1.05, 1, 0.95); group.add(m);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.07, s * 0.09, s * 2.2, 8), new THREE.MeshStandardNodeMaterial({ color: "#b98a3a", transparent: true }));
    stem.rotation.x = Math.PI / 2; stem.position.set(0, s * 0.25, s * 2.6); stem.rotation.y = 0.35; group.add(stem);
  } else if (d.kind === "beak") {
    const m = new THREE.Mesh(new THREE.ConeGeometry(s * 0.55, s * 1.4, 20), mat({ roughness: 0.15 }));
    m.rotation.x = Math.PI / 2; m.position.z = s * 0.55; group.add(m);
  }
  return group;
}
if (q.get("decor") !== "0") {
  for (const d of look.decor) {
    const u = d.u, n = d.n, up = d.up;
    // anchored on the rendered surface like world.js (DECOR_INSET = 0); the
    // app draws decorations in an overlay pass, so they are never buried
    let inside = null, p = null;
    for (let k = 0; k < 8 && !p; k++) { const depth = k * 0.0006; inside = [u[0] - n[0] * depth, u[1] - n[1] * depth, u[2] - n[2] * depth]; p = deformed(inside); }
    // local frame from material points a little under the anchor
    const a0 = [u[0] - n[0] * 0.0012, u[1] - n[1] * 0.0012, u[2] - n[2] * 0.0012];
    const base = deformed(a0), deep = deformed([u[0] - n[0] * 0.003, u[1] - n[1] * 0.003, u[2] - n[2] * 0.003]);
    const side = deformed([a0[0] + up[0] * 0.001, a0[1] + up[1] * 0.001, a0[2] + up[2] * 0.001]);
    if (!p || !base || !deep || !side) { window.__shapes.errors.push(`decor ${d.kind} not inside the cage`); continue; }
    const N = base.clone().sub(deep).normalize(), U = side.clone().sub(base); U.addScaledVector(N, -U.dot(N)).normalize();
    const R = new THREE.Vector3().crossVectors(U, N);
    const g = decorMesh(d);
    g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(R, U, N));
    // (the app biases decor depth 0.7 mm toward the camera; lifting the
    // stand-in 0.5 mm along the normal is the cheap equivalent here)
    g.position.copy(p).addScaledVector(N, 0.0005);
    (window.__shapes.decor ||= []).push({ kind: d.kind, at: g.position.toArray().map((v) => +(v * 1000).toFixed(2)), n: N.toArray().map((v) => +v.toFixed(2)) });
    scene.add(g);
  }
}

// ---------------------------------------------------------------- camera (as stage.js)
const azimuth = num("azimuth", 0), polar = num("polar", 1.1);
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.fov = 2 * Math.atan(Math.tan((17 * Math.PI) / 180) * Math.max(1, 0.9 / camera.aspect)) * 180 / Math.PI;
  camera.setViewOffset(w, h, 0, h * (w < 700 ? 0.05 : 0.03), w, h);
  camera.updateProjectionMatrix();
  const distance = num("dist", camera.aspect < 0.75 ? 0.31 : 0.26), s = Math.sin(polar);
  camera.position.set(TARGET.x + distance * s * Math.sin(azimuth), TARGET.y + distance * Math.cos(polar), TARGET.z + distance * s * Math.cos(azimuth));
  camera.lookAt(TARGET);
  updateViewThickness(camera.position);
}
window.addEventListener("resize", resize);
resize();
renderer.setAnimationLoop(() => {
  renderer.render(scene, camera);
  window.__shapes.frames++;
  if (window.__shapes.frames > 3) window.__shapes.ready = true;
});
