// Renderer, camera, orbit controls, bench receiver and tray.
// Look and camera rig follow the softbody-jelly gallery scene
// (threejs-awesome-graphics-agent-skills, MIT, Copyright (c) 2026 Scott Sun).
import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export const LIGHT_DIRECTION = new THREE.Vector3(-0.6123724357, -0.5, 0.6123724357).normalize();
export const TRAY_RADIUS = 0.072;
const BACKGROUND = "#dfe6e8";

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

export async function createStage(canvas, { forceWebGL = false } = {}) {
  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
    forceWebGL,
  });
  await renderer.init();
  const isWebGPU = renderer.backend?.isWebGPUBackend === true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.setClearColor(0xdfe6e8, 1);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND);
  scene.fog = new THREE.FogExp2(BACKGROUND, 0.95);

  const camera = new THREE.PerspectiveCamera(34, 1, 0.001, 2);
  camera.position.set(0, 0.096, 0.196);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.enablePan = false;
  controls.minDistance = 0.12;
  controls.maxDistance = 0.42;
  controls.minPolarAngle = 0.25;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.rotateSpeed = 0.8;
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  controls.target.set(0, 0.025, 0);
  controls.update();

  const sun = new THREE.DirectionalLight(0xfff1da, 3.0);
  sun.target.position.set(0, 0.025, 0);
  sun.position.copy(sun.target.position).addScaledVector(LIGHT_DIRECTION, -0.45);
  scene.add(sun, sun.target);

  const benchTexture = makeBenchTexture();
  const benchMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.63, metalness: 0 });
  // Large enough that its edge disappears into the fog even in tall portrait views.
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), benchMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.00005;
  scene.add(floor);

  // A low glazed rim marks the tray wall that keeps the jelly in view.
  const rimTube = 0.0026;
  // The scene has a single sun and no environment light, so give the glaze a
  // little self-illumination; otherwise its shaded half reads as a black band.
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(TRAY_RADIUS + rimTube, rimTube, 20, 160),
    new THREE.MeshPhysicalNodeMaterial({
      color: "#f3f6f7",
      emissive: "#c4ced2",
      emissiveIntensity: 0.55,
      roughness: 0.22,
      metalness: 0,
      clearcoat: 0.6,
      clearcoatRoughness: 0.1,
    }),
  );
  rim.rotation.x = -Math.PI / 2;
  rim.position.y = rimTube * 0.7;
  scene.add(rim);

  // Portrait framing: widen the vertical FOV for narrow screens (as the gallery
  // scene does) and pull back a little so the whole tray fits.
  let portraitDistance = 0;
  function resize(width, height, pixelRatio) {
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.fov = 2 * Math.atan(Math.tan((17 * Math.PI) / 180) * Math.max(1, 0.9 / camera.aspect)) * 180 / Math.PI;
    camera.setViewOffset(width, height, 0, height * (width < 700 ? 0.06 : 0.035), width, height);
    camera.updateProjectionMatrix();
    // Keep the whole tray (r = 7.5 cm) inside the frame on narrow screens.
    const wantDistance = camera.aspect < 0.75 ? 0.31 : 0.27;
    if (portraitDistance !== wantDistance) {
      portraitDistance = wantDistance;
      const offset = camera.position.clone().sub(controls.target).setLength(wantDistance);
      camera.position.copy(controls.target).add(offset);
      controls.update();
    }
  }

  return { THREE, renderer, isWebGPU, scene, camera, controls, sun, floor, benchMaterial, benchTexture, rim, resize };
}
