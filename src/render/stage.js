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
const BACKGROUND = "#dfe6e8";
const TARGET = new THREE.Vector3(0, 0.025, 0);

function makeBenchTexture() {
  const size = 1024;
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const context = canvas.getContext("2d");
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
  const texture = new THREE.CanvasTexture(canvas);
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
  renderer.setClearColor(0xdfe6e8, 1);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND);
  scene.fog = new THREE.FogExp2(BACKGROUND, 0.95);

  const camera = new THREE.PerspectiveCamera(34, 1, 0.001, 3);
  const rig = new CameraRig(camera);

  const tray = new THREE.Group();
  tray.name = "Tray";
  scene.add(tray);
  const trayCamera = new THREE.PerspectiveCamera();
  const trayInverse = new THREE.Matrix4();

  const sun = new THREE.DirectionalLight(0xfff1da, 3.0);
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
    new THREE.MeshPhysicalNodeMaterial({ color: "#f3f6f7", emissive: "#c4ced2", emissiveIntensity: 0.55, roughness: 0.22, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.1 }),
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

  const stage = {
    THREE, renderer, isWebGPU, scene, camera, rig, tray, trayCamera, sun, glowLight, floor, benchMaterial, benchTexture, rim,
    tilt, updateTilt, trayGravity, syncTrayCamera, resize, render, setBloom, bloomOn: false,
    setBloomStrength(x) { if (bloomNode) bloomNode.strength.value = 0.55 * x; },
  };
  return stage;
}
