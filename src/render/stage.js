// Renderer, camera rig, tray (tiltable), lights and the bloom pipeline.
// Look follows the softbody-jelly gallery scene (threejs-awesome-graphics-agent-skills,
// MIT, Copyright (c) 2026 Scott Sun).
//
// Frames: everything that belongs to the tray (floor, rim, jellies, gems, sun)
// lives in `tray`, a group the user tilts with one finger. Physics, optics and
// caustics work in tray coordinates; `trayCamera` is the view camera expressed
// in that frame so the caustic atlas and view thickness stay registered.
import * as THREE from "three/webgpu";
import { pass } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";

export const LIGHT_DIRECTION = new THREE.Vector3(-0.6123724357, -0.5, 0.6123724357).normalize();
export const TRAY_RADIUS = 0.075;
const TARGET = new THREE.Vector3(0, 0.025, 0);
const BENCH_SIZE = 1024;       // px per floor tile; jelly-view maps one tile to 0.16 m, tray centred
const TAU = Math.PI * 2;

// ---- floor patterns ----
// A theme paints a bench canvas and the one CanvasTexture is flagged for
// upload: the floor material and the shadow / caustic nodes jelly-view built on
// it stay untouched. The texture repeats every 0.16 m and the tray covers ~94 %
// of one tile, so every pattern tiles seamlessly: motifs are stamped together
// with their wrapped copies, gradients cycle, stripes divide the tile. Random
// motif parameters are drawn before stamping so the wrapped copies match.

function drawBasic(context, size) {
  context.fillStyle = "#dce4e6";
  context.fillRect(0, 0, size, size);
  context.strokeStyle = "#bccbd04a";
  context.lineWidth = 1;
  for (let index = 0; index <= 16; index += 1) {
    const point = (index * size) / 16;
    context.beginPath(); context.moveTo(point, 0); context.lineTo(point, size); context.stroke();
    context.beginPath(); context.moveTo(0, point); context.lineTo(size, point); context.stroke();
  }
  context.strokeStyle = "#869ba23a";
  context.lineWidth = 1.5;
  for (let y = 0; y <= 4; y += 1) for (let x = 0; x <= 4; x += 1) {
    const originX = (x * size) / 4, originY = (y * size) / 4;
    context.beginPath();
    context.moveTo(originX - 4, originY); context.lineTo(originX + 4, originY);
    context.moveTo(originX, originY - 4); context.lineTo(originX, originY + 4);
    context.stroke();
  }
}

// Deterministic per-theme randomness (the pattern is the same on every load).
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Draw a motif at (x, y) and at every wrapped copy that reaches into the tile.
function stamp(context, size, x, y, reach, draw) {
  for (let dy = -size; dy <= size; dy += size) for (let dx = -size; dx <= size; dx += size) {
    const px = x + dx, py = y + dy;
    if (px + reach < 0 || px - reach > size || py + reach < 0 || py - reach > size) continue;
    context.save(); context.translate(px, py); draw(context); context.restore();
  }
}
// Jittered n×n grid, odd rows offset half a cell (n even keeps it periodic):
// an even, not grid-like spread that tiles.
function scatter(n, size, rnd, jitter = 0.7) {
  const cell = size / n, points = [];
  for (let j = 0; j < n; j += 1) for (let i = 0; i < n; i += 1) {
    const x = (i + 0.5 + (j % 2) * 0.5 + (rnd() - 0.5) * jitter) * cell;
    points.push({ x: x % size, y: (j + 0.5 + (rnd() - 0.5) * jitter) * cell });
  }
  return points;
}
// Canvas row 0 lands on the camera side of the tray (flipY, +z towards the
// default view): flip so motif "up" (−y) reads upright from the start camera.
function upright(context, size) { context.setTransform(1, 0, 0, -1, 0, size); }
function softDot(context, radius, rgb, alpha) {
  const gradient = context.createRadialGradient(0, 0, 0, 0, 0, radius);
  gradient.addColorStop(0, `rgba(${rgb}, ${alpha})`);
  gradient.addColorStop(1, `rgba(${rgb}, 0)`);
  context.fillStyle = gradient;
  context.fillRect(-radius, -radius, radius * 2, radius * 2);
}

// 꽃무늬 접시: blush tablecloth with swiss dots and small pastel flowers.
const FLOWER_PETALS = [["#f7a6c0", "#ffe08c"], ["#c9b5f2", "#fff3c4"], ["#ffd47e", "#f6a35f"], ["#a8d2f6", "#fff3c4"], ["#ffbca3", "#ffe08c"], ["#f4a0b4", "#fff6d8"]];
function flowerMotif(context, r, [petal, centre], petals, turn, leaves) {
  context.rotate(turn);
  if (leaves) {
    context.fillStyle = "#9fd6ad";
    for (const side of [-1, 1]) {
      context.save(); context.rotate(Math.PI * 0.5 + side * 0.62);
      context.beginPath(); context.ellipse(r * 0.98, 0, r * 0.52, r * 0.22, 0, 0, TAU); context.fill();
      context.restore();
    }
  }
  context.fillStyle = petal;
  for (let k = 0; k < petals; k += 1) {
    const a = (k / petals) * TAU;
    context.beginPath(); context.ellipse(Math.cos(a) * r * 0.52, Math.sin(a) * r * 0.52, r * 0.5, r * 0.37, a, 0, TAU); context.fill();
  }
  context.fillStyle = "rgba(255, 255, 255, 0.4)";
  for (let k = 0; k < petals; k += 1) {
    const a = (k / petals) * TAU;
    context.beginPath(); context.ellipse(Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5, r * 0.2, r * 0.12, a, 0, TAU); context.fill();
  }
  context.fillStyle = centre;
  context.beginPath(); context.arc(0, 0, r * 0.27, 0, TAU); context.fill();
  context.fillStyle = "rgba(255, 255, 255, 0.75)";
  context.beginPath(); context.arc(-r * 0.08, -r * 0.08, r * 0.09, 0, TAU); context.fill();
}
function drawFlower(context, size) {
  const rnd = rng(11);
  upright(context, size);
  context.fillStyle = "#ffdce8";
  context.fillRect(0, 0, size, size);
  context.fillStyle = "rgba(255, 255, 255, 0.9)";
  for (let j = 0; j < size; j += 64) for (let i = 0; i < size; i += 64) {
    context.beginPath(); context.arc(i + 16, j + 16, 3.2, 0, TAU); context.arc(i + 48, j + 48, 3.2, 0, TAU); context.fill();
  }
  for (const p of scatter(4, size, rnd, 0.5)) {
    const r = 15 + rnd() * 4, colours = FLOWER_PETALS[(rnd() * FLOWER_PETALS.length) | 0], turn = rnd() * TAU;
    stamp(context, size, p.x + size / 8, p.y + size / 8, r * 1.6, (c) => flowerMotif(c, r, colours, 5, turn, false));
  }
  for (const p of scatter(4, size, rnd, 0.45)) {
    const r = 31 + rnd() * 8, colours = FLOWER_PETALS[(rnd() * FLOWER_PETALS.length) | 0];
    const petals = rnd() < 0.25 ? 6 : 5, turn = rnd() * TAU;
    stamp(context, size, p.x, p.y, r * 1.6, (c) => flowerMotif(c, r, colours, petals, turn, true));
  }
}

// 별밤: indigo night with a soft milky haze, tiny stars and twinkles.
function twinkle(context, r) {
  const w = r * 0.16;
  context.beginPath();
  context.moveTo(0, -r);
  context.quadraticCurveTo(w, -w, r, 0); context.quadraticCurveTo(w, w, 0, r);
  context.quadraticCurveTo(-w, w, -r, 0); context.quadraticCurveTo(-w, -w, 0, -r);
  context.fill();
}
function star5(context, r, inner = 0.48) {
  context.beginPath();
  for (let k = 0; k < 10; k += 1) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5, rr = k % 2 ? r * inner : r;
    context.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  context.closePath();
  context.fill();
  context.lineJoin = "round"; context.lineWidth = r * 0.28; context.strokeStyle = context.fillStyle;
  context.stroke();
}
function drawStarry(context, size) {
  const rnd = rng(23);
  upright(context, size);
  context.fillStyle = "#4b5796";
  context.fillRect(0, 0, size, size);
  // moonlit pool under the tray keeps the jelly's colours readable
  stamp(context, size, size / 2, size / 2, size * 0.62, (c) => softDot(c, size * 0.62, "170, 182, 240", 0.5));
  const hazes = ["150, 160, 236", "196, 160, 232", "128, 182, 238", "236, 170, 214"];
  for (const p of scatter(4, size, rnd, 0.9)) {
    const r = 150 + rnd() * 170, rgb = hazes[(rnd() * hazes.length) | 0], alpha = 0.22 + rnd() * 0.2;
    stamp(context, size, p.x, p.y, r, (c) => softDot(c, r, rgb, alpha));
  }
  for (let k = 0; k < 340; k += 1) {
    const x = rnd() * size, y = rnd() * size, r = 1.6 + rnd() * rnd() * 3.4, warm = rnd() < 0.3, alpha = 0.45 + rnd() * 0.55;
    stamp(context, size, x, y, r, (c) => { c.fillStyle = warm ? `rgba(255, 238, 190, ${alpha})` : `rgba(255, 255, 255, ${alpha})`; c.beginPath(); c.arc(0, 0, r, 0, TAU); c.fill(); });
  }
  for (const p of scatter(4, size, rnd, 0.8)) {
    const r = 13 + rnd() * 10, turn = (rnd() - 0.5) * 0.4;
    stamp(context, size, p.x, p.y, r * 2.4, (c) => { softDot(c, r * 2.4, "255, 244, 206", 0.35); c.rotate(turn); c.fillStyle = "#fffaf0"; twinkle(c, r); });
  }
  for (const p of scatter(2, size, rnd, 0.8)) {
    const r = 15 + rnd() * 5, turn = (rnd() - 0.5) * 0.6, colour = rnd() < 0.5 ? "#ffe9a3" : "#ffd6e6";
    stamp(context, size, p.x + size / 4, p.y + size / 4, r * 2.2, (c) => { softDot(c, r * 2.2, "255, 236, 180", 0.3); c.rotate(turn); c.fillStyle = colour; star5(c, r); });
  }
}

// 딸기 테이블: red/white gingham picnic cloth with little strawberries.
const SEEDS = [[-0.34, -0.3], [0, -0.34], [0.34, -0.3], [-0.46, 0.02], [-0.16, -0.02], [0.16, -0.02], [0.46, 0.02], [-0.3, 0.3], [0, 0.3], [0.3, 0.3], [-0.13, 0.6], [0.13, 0.6]];
function strawberryMotif(context, s, turn) {
  context.rotate(turn);
  const body = () => {
    context.beginPath();
    context.moveTo(0, -s * 0.6);
    context.bezierCurveTo(s * 0.98, -s * 0.8, s * 0.86, s * 0.36, 0, s * 0.96);
    context.bezierCurveTo(-s * 0.86, s * 0.36, -s * 0.98, -s * 0.8, 0, -s * 0.6);
    context.closePath();
  };
  context.save(); context.translate(s * 0.08, s * 0.1); body(); context.fillStyle = "rgba(160, 40, 60, 0.14)"; context.fill(); context.restore();
  const gradient = context.createRadialGradient(-s * 0.3, -s * 0.3, s * 0.05, 0, 0, s * 1.1);
  gradient.addColorStop(0, "#ff8b9b"); gradient.addColorStop(0.55, "#f2506a"); gradient.addColorStop(1, "#d93652");
  body(); context.fillStyle = gradient; context.fill();
  context.fillStyle = "#ffe7a6";
  for (const [x, y] of SEEDS) { context.beginPath(); context.ellipse(x * s, y * s, s * 0.045, s * 0.075, 0, 0, TAU); context.fill(); }
  context.fillStyle = "rgba(255, 255, 255, 0.55)";
  context.beginPath(); context.ellipse(-s * 0.38, -s * 0.18, s * 0.09, s * 0.17, 0.5, 0, TAU); context.fill();
  context.fillStyle = "#5dbb72";
  for (let k = 0; k < 5; k += 1) {
    context.save(); context.translate(0, -s * 0.6); context.rotate(Math.PI * (0.12 + 0.19 * k));
    context.beginPath(); context.ellipse(s * 0.3, 0, s * 0.32, s * 0.12, 0, 0, TAU); context.fill();
    context.restore();
  }
  context.strokeStyle = "#4a9e5d"; context.lineWidth = s * 0.12; context.lineCap = "round";
  context.beginPath(); context.moveTo(0, -s * 0.66); context.quadraticCurveTo(s * 0.02, -s * 0.92, s * 0.16, -s * 1.02); context.stroke();
}
function drawStrawberry(context, size) {
  const rnd = rng(37);
  upright(context, size);
  context.fillStyle = "#fffaf7";
  context.fillRect(0, 0, size, size);
  const period = size / 8, band = period / 2;
  context.fillStyle = "rgba(238, 88, 112, 0.30)";
  for (let k = 0; k < 8; k += 1) {
    context.fillRect(k * period + band / 2, 0, band, size);
    context.fillRect(0, k * period + band / 2, size, band);
  }
  // fine diagonal weave (period 8 px divides the tile)
  context.strokeStyle = "rgba(170, 60, 80, 0.07)"; context.lineWidth = 1.5;
  context.beginPath();
  for (let c = -size; c < size; c += 8) { context.moveTo(c, 0); context.lineTo(c + size, size); }
  context.stroke();
  for (const p of scatter(4, size, rnd, 0.55)) {
    const s = 33 + rnd() * 8, turn = (rnd() - 0.5) * 1.1;
    stamp(context, size, p.x, p.y, s * 1.2, (c) => strawberryMotif(c, s, turn));
  }
  for (const p of scatter(4, size, rnd, 0.5)) {
    const r = 11 + rnd() * 3, turn = rnd() * TAU;
    stamp(context, size, p.x + size / 8, p.y + size / 8, r * 1.2, (c) => flowerMotif(c, r, ["#ffffff", "#ffd968"], 5, turn, false));
  }
}

// 무지개 구름: pastel sky cycling along the diagonal, little rainbows with
// cloud feet, loose clouds and sparkles.
const ARC_COLOURS = ["#f8a5bc", "#ffc59e", "#ffe48f", "#bce7ad", "#a6d3f6", "#c6b3f0"];
const PUFFS = [[-0.56, 0.12, 0.36], [-0.2, -0.16, 0.48], [0.24, -0.06, 0.42], [0.6, 0.14, 0.3], [0.02, 0.18, 0.42]];
function cloudMotif(context, s) {
  context.fillStyle = "rgba(170, 160, 228, 0.35)";
  for (const [x, y, r] of PUFFS) { context.beginPath(); context.arc(x * s, (y + 0.12) * s, r * s, 0, TAU); context.fill(); }
  context.fillStyle = "#ffffff";
  for (const [x, y, r] of PUFFS) { context.beginPath(); context.arc(x * s, y * s, r * s, 0, TAU); context.fill(); }
}
function rainbowMotif(context, R) {
  const w = R * 0.14;
  context.lineCap = "butt";
  context.lineWidth = w + 0.8;
  ARC_COLOURS.forEach((colour, k) => {
    context.strokeStyle = colour;
    context.beginPath(); context.arc(0, 0, R - w * (k + 0.5), Math.PI, TAU); context.stroke();
  });
  for (const side of [-1, 1]) { context.save(); context.translate(side * (R - w * 3), w * 0.3); cloudMotif(context, R * 0.42); context.restore(); }
}
function drawRainbow(context, size) {
  const rnd = rng(53);
  upright(context, size);
  const stops = ["#c8e2ff", "#dcd2ff", "#ffd3e7", "#ffe9cc", "#d0f3df", "#c8e2ff"];
  for (const offset of [0, size / 2]) {
    const gradient = context.createLinearGradient(offset, offset, offset + size / 2, offset + size / 2);
    stops.forEach((colour, k) => gradient.addColorStop(k / (stops.length - 1), colour));
    context.fillStyle = gradient;
    context.beginPath();
    if (offset === 0) context.rect(0, 0, size, size);
    else { context.moveTo(size, 0); context.lineTo(size, size); context.lineTo(0, size); context.closePath(); }
    context.fill();
  }
  for (const p of scatter(4, size, rnd, 0.8)) {
    const r = 3 + rnd() * 3;
    stamp(context, size, p.x + size / 8, p.y, r * 3, (c) => { softDot(c, r * 3, "255, 255, 255", 0.7); c.fillStyle = "#ffffff"; twinkle(c, r * 2.2); });
  }
  for (const p of scatter(4, size, rnd, 0.6)) {
    const s = 30 + rnd() * 14;
    stamp(context, size, p.x + size / 8, p.y + size / 8, s * 1.1, (c) => cloudMotif(c, s));
  }
  for (const p of scatter(2, size, rnd, 0.5)) {
    const R = 92 + rnd() * 16;
    stamp(context, size, p.x, p.y, R * 1.3, (c) => rainbowMotif(c, R));
  }
}

// Theme table: floor painter, background (= fog = clear colour), fog density,
// rim [colour, emissive, emissiveIntensity] and sun [colour, gain]. The gain
// scales the sun colour in place (the caustic emission reads the same Color
// object as a uniform, so floor light and caustics stay in step).
const THEMES = {
  basic: { draw: drawBasic, background: "#dfe6e8", fog: 0.95, rim: ["#f3f6f7", "#c4ced2", 0.55], sun: [0xfff1da, 1] },
  flower: { draw: drawFlower, background: "#f6e5ec", fog: 0.95, rim: ["#fff8fa", "#f3bfd0", 0.55], sun: [0xfff6f4, 1.14] },
  starry: { draw: drawStarry, background: "#222a57", fog: 1.05, rim: ["#fff4d6", "#f2c86e", 0.8], sun: [0xf2f2ff, 1.18] },
  strawberry: { draw: drawStrawberry, background: "#f8e7e3", fog: 0.95, rim: ["#fff7f5", "#f29aa8", 0.5], sun: [0xfff0dc, 1.05] },
  rainbow: { draw: drawRainbow, background: "#e6e5fb", fog: 0.95, rim: ["#ffffff", "#cfd3ff", 0.55], sun: [0xfffaf4, 1.12] },
};
export const THEME_LOOKS = {
  basic: { label: "기본", background: THEMES.basic.background,
    swatch: "repeating-linear-gradient(0deg, transparent 0 6px, rgba(134, 155, 162, 0.35) 6px 7px), repeating-linear-gradient(90deg, transparent 0 6px, rgba(134, 155, 162, 0.35) 6px 7px), #dce4e6" },
  flower: { label: "꽃무늬 접시", background: THEMES.flower.background,
    swatch: "radial-gradient(circle at 34% 36%, #ffe08c 0 7%, #f7a6c0 8% 22%, transparent 23%), radial-gradient(circle at 70% 66%, #fff3c4 0 6%, #c9b5f2 7% 19%, transparent 20%), radial-gradient(circle at 74% 26%, #a8d2f6 0 9%, transparent 10%), radial-gradient(circle at 28% 76%, #9fd6ad 0 8%, transparent 9%), #ffdfe9" },
  starry: { label: "별밤", background: THEMES.starry.background,
    swatch: "radial-gradient(circle at 30% 32%, #fffaf0 0 6%, transparent 7%), radial-gradient(circle at 68% 44%, #ffe9a3 0 8%, transparent 9%), radial-gradient(circle at 44% 72%, #ffffff 0 4%, transparent 5%), radial-gradient(circle at 76% 76%, #ffffff 0 3%, transparent 4%), radial-gradient(circle at 50% 45%, #7380c8, #2a3366 75%)" },
  strawberry: { label: "딸기 테이블", background: THEMES.strawberry.background,
    swatch: "radial-gradient(circle at 50% 56%, #f2506a 0 22%, transparent 23%), radial-gradient(ellipse 30% 14% at 50% 34%, #5dbb72 0 70%, transparent 72%), repeating-linear-gradient(0deg, rgba(238, 88, 112, 0.35) 0 25%, transparent 25% 50%), repeating-linear-gradient(90deg, rgba(238, 88, 112, 0.35) 0 25%, transparent 25% 50%), #fffaf7" },
  rainbow: { label: "무지개 구름", background: THEMES.rainbow.background,
    swatch: "radial-gradient(circle at 50% 78%, transparent 0 22%, #c6b3f0 23% 29%, #a6d3f6 30% 36%, #bce7ad 37% 43%, #ffe48f 44% 50%, #ffc59e 51% 57%, #f8a5bc 58% 64%, transparent 65%), linear-gradient(135deg, #c8e2ff, #ffd3e7)" },
};

function benchCanvas(draw) {
  const canvas = document.createElement("canvas");
  canvas.width = BENCH_SIZE; canvas.height = BENCH_SIZE;
  if (draw) paintBench(canvas, draw);
  return canvas;
}
function paintBench(canvas, draw) {
  const context = canvas.getContext("2d");
  context.save();
  draw(context, canvas.width);
  context.restore();
}

function makeBenchTexture() {
  const texture = new THREE.CanvasTexture(benchCanvas(drawBasic));
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}

// Spherical orbit around the tray centre with damping (two-finger rotate, pinch).
class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.azimuth = 0; this.polar = 1.1; this.distance = 0.31;
    this.goal = { azimuth: 0, polar: 1.1, distance: 0.31 };
    this.minPolar = 0.28; this.maxPolar = Math.PI * 0.46;
    this.minDistance = 0.12; this.maxDistance = 0.42;
    this.apply();
  }
  rotate(dAzimuth, dPolar) {
    this.goal.azimuth += dAzimuth;
    this.goal.polar = Math.min(this.maxPolar, Math.max(this.minPolar, this.goal.polar + dPolar));
  }
  zoom(factor) { this.goal.distance = Math.min(this.maxDistance, Math.max(this.minDistance, this.goal.distance * factor)); }
  setDistance(d) { this.goal.distance = this.distance = Math.min(this.maxDistance, Math.max(this.minDistance, d)); this.apply(); }
  // Returns true while the camera is still moving.
  update() {
    const k = 0.2;
    const da = this.goal.azimuth - this.azimuth, dp = this.goal.polar - this.polar, dd = this.goal.distance - this.distance;
    const moving = Math.abs(da) > 1e-5 || Math.abs(dp) > 1e-5 || Math.abs(dd) > 1e-6;
    if (!moving) return false;
    this.azimuth += da * k; this.polar += dp * k; this.distance += dd * k;
    this.apply();
    return true;
  }
  apply() {
    const s = Math.sin(this.polar);
    this.camera.position.set(TARGET.x + this.distance * s * Math.sin(this.azimuth), TARGET.y + this.distance * Math.cos(this.polar), TARGET.z + this.distance * s * Math.cos(this.azimuth));
    this.camera.lookAt(TARGET);
    this.camera.updateMatrixWorld();
  }
}

export async function createStage(canvas, { forceWebGL = false } = {}) {
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance", forceWebGL });
  await renderer.init();
  const isWebGPU = renderer.backend?.isWebGPUBackend === true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  const basic = THEMES.basic;
  renderer.setClearColor(basic.background, 1);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(basic.background);
  scene.fog = new THREE.FogExp2(basic.background, basic.fog);

  const camera = new THREE.PerspectiveCamera(34, 1, 0.001, 3);
  const rig = new CameraRig(camera);

  const tray = new THREE.Group();
  tray.name = "Tray";
  scene.add(tray);
  const trayCamera = new THREE.PerspectiveCamera();
  const trayInverse = new THREE.Matrix4();

  const sun = new THREE.DirectionalLight(basic.sun[0], 3.0);
  sun.target.position.set(0, 0.025, 0);
  sun.position.copy(sun.target.position).addScaledVector(LIGHT_DIRECTION, -0.45);
  tray.add(sun, sun.target);

  // A soft point light inside the jelly, coloured by its paint; follows the glow.
  const glowLight = new THREE.PointLight(0xffffff, 0, 0.16, 2);
  tray.add(glowLight);

  // Floor geometry is pre-rotated so the mesh-local frame equals tray coordinates
  // (the receiver shader uses positionLocal). Large enough to vanish in the fog.
  const benchTexture = makeBenchTexture();
  const benchMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.63, metalness: 0 });
  const floorGeometry = new THREE.PlaneGeometry(12, 12);
  floorGeometry.rotateX(-Math.PI / 2);
  floorGeometry.translate(0, -0.00005, 0);
  const floor = new THREE.Mesh(floorGeometry, benchMaterial);
  tray.add(floor);

  const rimTube = 0.0028;
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(TRAY_RADIUS + rimTube, rimTube, 20, 180),
    new THREE.MeshPhysicalNodeMaterial({ color: basic.rim[0], emissive: basic.rim[1], emissiveIntensity: basic.rim[2], roughness: 0.22, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.1 }),
  );
  rim.rotation.x = -Math.PI / 2;
  rim.position.y = rimTube * 0.7;
  tray.add(rim);

  // Bloom: HDR scene pass + threshold bloom, composited before tone mapping.
  let pipeline = null, bloomNode = null;
  function setBloom(on) {
    if (on && !pipeline) {
      const scenePass = pass(scene, camera);
      const color = scenePass.getTextureNode("output");
      bloomNode = bloom(color, 0.55, 0.45, 0.92);
      pipeline = new THREE.RenderPipeline(renderer);
      pipeline.outputNode = color.add(bloomNode);
    }
    stage.bloomOn = Boolean(on && pipeline);
  }

  // Tilt (radians) about a horizontal axis; physics gravity is the world
  // gravity expressed in tray coordinates.
  const tilt = { axis: new THREE.Vector3(1, 0, 0), angle: 0, goalAxis: new THREE.Vector3(1, 0, 0), goalAngle: 0 };
  const gravity = new THREE.Vector3();
  function updateTilt() {
    const k = tilt.goalAngle > tilt.angle ? 0.35 : 0.14;
    const before = tilt.angle;
    tilt.angle += (tilt.goalAngle - tilt.angle) * k;
    if (Math.abs(tilt.goalAngle - tilt.angle) < 1e-4) tilt.angle = tilt.goalAngle;
    if (tilt.goalAngle > 0) tilt.axis.lerp(tilt.goalAxis, 0.35).normalize();
    tray.quaternion.setFromAxisAngle(tilt.axis, tilt.angle);
    tray.updateMatrixWorld(true);
    return Math.abs(before - tilt.angle) > 1e-5;
  }
  function trayGravity() {
    if (tilt.angle < 0.002) return null;
    gravity.set(0, -9.81, 0).applyQuaternion(tray.quaternion.clone().invert());
    return gravity.toArray();
  }

  function syncTrayCamera() {
    trayInverse.copy(tray.matrixWorld).invert();
    trayCamera.copy(camera, false);
    trayCamera.matrixWorld.multiplyMatrices(trayInverse, camera.matrixWorld);
    trayCamera.matrixWorld.decompose(trayCamera.position, trayCamera.quaternion, trayCamera.scale);
    trayCamera.updateMatrixWorld(true);
    trayCamera.projectionMatrix.copy(camera.projectionMatrix);
    trayCamera.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
    return trayCamera;
  }

  let narrow = null;
  function resize(width, height, pixelRatio) {
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.fov = 2 * Math.atan(Math.tan((17 * Math.PI) / 180) * Math.max(1, 0.9 / camera.aspect)) * 180 / Math.PI;
    camera.setViewOffset(width, height, 0, height * (width < 700 ? 0.05 : 0.03), width, height);
    camera.updateProjectionMatrix();
    const isNarrow = camera.aspect < 0.75;
    if (narrow !== isNarrow) { narrow = isNarrow; rig.setDistance(isNarrow ? 0.31 : 0.26); }
  }

  function render() {
    if (stage.bloomOn) pipeline.render(); else renderer.render(scene, camera);
  }

  // Tray / background theme. Everything is changed in place (canvas redraw +
  // texture upload, Color.set on objects the materials and fog nodes already
  // reference), so no material or node graph is rebuilt; the caller requests a
  // render. Unknown ids fall back to "basic"; re-applying the current one is free.
  let themeId = "basic", themeCanvas = null;
  const basicCanvas = benchTexture.image;
  function setTheme(id) {
    const key = Object.hasOwn(THEMES, id) ? id : "basic";
    if (key === themeId) return key;
    themeId = key;
    const theme = THEMES[key];
    // The basic canvas is never drawn over again (a canvas that has been redrawn
    // can rasterise its hairlines a level differently): other themes paint a
    // second canvas of the same size and the texture swaps its image.
    if (key === "basic") benchTexture.image = basicCanvas;
    else {
      if (!themeCanvas) themeCanvas = benchCanvas(null);
      paintBench(themeCanvas, theme.draw);
      benchTexture.image = themeCanvas;
    }
    benchTexture.needsUpdate = true;
    scene.background.set(theme.background);
    scene.fog.color.set(theme.background);
    scene.fog.density = theme.fog;
    renderer.setClearColor(theme.background, 1);
    rim.material.color.set(theme.rim[0]);
    rim.material.emissive.set(theme.rim[1]);
    rim.material.emissiveIntensity = theme.rim[2];
    sun.color.set(theme.sun[0]).multiplyScalar(theme.sun[1]);
    return key;
  }

  const stage = {
    THREE, renderer, isWebGPU, scene, camera, rig, tray, trayCamera, sun, glowLight, floor, benchMaterial, benchTexture, rim,
    tilt, updateTilt, trayGravity, syncTrayCamera, resize, render, setBloom, bloomOn: false,
    setBloomStrength(x) { if (bloomNode) bloomNode.strength.value = 0.55 * x; },
    setTheme, get theme() { return themeId; },
  };
  return stage;
}
