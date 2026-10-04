// Main-thread view of the jelly: the shell mesh (fed by the physics worker),
// the transmissive material, the receiver shadow texture (fed by the optics
// worker) and, on WebGPU, the GPU caustic field. Material and receiver shading
// follow the softbody-jelly example (MIT, Copyright (c) 2026 Scott Sun).
import * as THREE from "three/webgpu";
import { attribute, float, positionWorld, texture, uniform, vec3 } from "three/tsl";
import { GPUCausticField } from "./gpu-caustic-field.js";

export const LOOKS = Object.freeze({
  berry: { label: "베리", surface: "#ffe0eb", attenuation: "#ed5187", sigma: [5, 46, 23], pitch: 1.0 },
  mint: { label: "민트", surface: "#dbfff0", attenuation: "#4dc9a0", sigma: [40, 8, 20], pitch: 1.18 },
  honey: { label: "허니", surface: "#fff1d5", attenuation: "#edb643", sigma: [5, 17, 58], pitch: 0.84 },
});

const FIELD_SIZE = 192;

export function createJellyView(stage, init, { caustics = true } = {}) {
  const { scene, camera, sun, benchMaterial, benchTexture, isWebGPU } = stage;
  const vertexCount = init.positions.length / 3;

  const geometry = new THREE.BufferGeometry();
  const positionAttribute = new THREE.BufferAttribute(new Float32Array(init.positions), 3).setUsage(THREE.DynamicDrawUsage);
  const normalAttribute = new THREE.BufferAttribute(new Float32Array(init.normals), 3).setUsage(THREE.DynamicDrawUsage);
  const thicknessAttribute = new THREE.BufferAttribute(new Float32Array(vertexCount).fill(0.03), 1).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", positionAttribute);
  geometry.setAttribute("normal", normalAttribute);
  geometry.setAttribute("opticalThickness", thicknessAttribute);
  geometry.setIndex(new THREE.BufferAttribute(init.indices, 1));
  geometry.boundingBox = new THREE.Box3();
  geometry.boundingSphere = new THREE.Sphere();
  const center = new THREE.Vector3();
  const bodyAdapter = { center };

  function setBounds(bounds) {
    geometry.boundingBox.min.set(bounds[0], bounds[1], bounds[2]);
    geometry.boundingBox.max.set(bounds[3], bounds[4], bounds[5]);
    geometry.boundingBox.getBoundingSphere(geometry.boundingSphere);
  }
  setBounds(init.bounds);
  center.fromArray(init.center);

  const material = new THREE.MeshPhysicalNodeMaterial({
    color: "#ffe0eb",
    roughness: 0.075,
    metalness: 0,
    transmission: 1,
    thickness: 0.035,
    ior: 1.35,
    dispersion: 0.025,
    attenuationDistance: 0.035,
    attenuationColor: "#ed5187",
    clearcoat: 0.42,
    clearcoatRoughness: 0.05,
    transparent: false,
    side: THREE.FrontSide,
    flatShading: false,
  });
  material.thicknessNode = attribute("opticalThickness", "float");

  const jelly = new THREE.Mesh(geometry, material);
  jelly.name = "SoftbodyJelly";
  jelly.frustumCulled = false;

  const gripMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.0012, 16, 12),
    new THREE.MeshBasicNodeMaterial({ color: "#ffffff", transparent: true, opacity: 0.82, depthTest: false }),
  );
  gripMarker.visible = false;
  gripMarker.renderOrder = 4;
  const lineGeometry = new THREE.BufferGeometry();
  lineGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3).setUsage(THREE.DynamicDrawUsage));
  const gripLine = new THREE.Line(
    lineGeometry,
    new THREE.LineBasicNodeMaterial({ color: "#586b75", transparent: true, opacity: 0.38, depthTest: false, depthWrite: false }),
  );
  gripLine.frustumCulled = false;
  gripLine.visible = false;
  gripLine.renderOrder = 3;

  const group = new THREE.Group();
  group.add(jelly, gripMarker, gripLine);
  scene.add(group);

  // Receiver shadow/contact field written by the optics worker.
  const shadowBytes = new Uint8Array(FIELD_SIZE * FIELD_SIZE * 4);
  const shadowTexture = new THREE.DataTexture(shadowBytes, FIELD_SIZE, FIELD_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  shadowTexture.minFilter = shadowTexture.magFilter = THREE.LinearFilter;
  shadowTexture.generateMipmaps = false;
  shadowTexture.colorSpace = THREE.NoColorSpace;
  shadowTexture.needsUpdate = true;
  const origin = new THREE.Vector2(-0.11, -0.11);
  const originNode = uniform(origin);
  const spanNode = uniform(0.22);

  // GPU caustics need WebGPU compute; WebGL2 (lite mode) keeps everything else.
  let causticField = null;
  if (isWebGPU && caustics) {
    causticField = new GPUCausticField({
      positions: positionAttribute.array,
      indices: init.indices,
      geometry,
    });
    causticField.setCamera(camera);
  }

  const opticalUV = positionWorld.xz.sub(originNode).div(spanNode);
  const shadowField = texture(shadowTexture, opticalUV);
  const irradiance = causticField ? causticField.sampleIrradiance() : vec3(0);
  const bench = texture(benchTexture, positionWorld.xz.div(0.16).add(0.5)).rgb;
  const sunColor = uniform(sun.color);
  benchMaterial.colorNode = bench
    .mul(float(1).sub(shadowField.r.mul(0.63)))
    .mul(float(1).sub(shadowField.g.mul(0.40)));
  benchMaterial.emissiveNode = bench.mul(irradiance).mul(sunColor).mul(sun.intensity / Math.PI);
  benchMaterial.needsUpdate = true;

  let flavour = "berry";
  function setFlavour(name) {
    const look = LOOKS[name];
    if (!look) return;
    flavour = name;
    material.color.set(look.surface);
    material.attenuationColor.setRGB(
      ...look.sigma.map((sigma) => Math.exp(-sigma * material.attenuationDistance)),
      THREE.LinearSRGBColorSpace,
    );
  }
  setFlavour("berry");

  // ---- updates from workers ----
  function applyFrame(frame) {
    if (frame.positions) {
      positionAttribute.array.set(frame.positions);
      normalAttribute.array.set(frame.normals);
      positionAttribute.needsUpdate = true;
      normalAttribute.needsUpdate = true;
    }
    setBounds(frame.bounds);
    center.fromArray(frame.center);
    if (frame.grab) {
      gripMarker.position.fromArray(frame.grab.point);
      const p = lineGeometry.attributes.position;
      p.setXYZ(0, frame.grab.point[0], frame.grab.point[1], frame.grab.point[2]);
      p.setXYZ(1, frame.grab.target[0], frame.grab.target[1], frame.grab.target[2]);
      p.needsUpdate = true;
      gripMarker.visible = gripLine.visible = true;
    } else {
      gripMarker.visible = gripLine.visible = false;
    }
  }

  function applyField(field) {
    shadowBytes.set(field.shadowBytes);
    shadowTexture.needsUpdate = true;
    origin.set(field.origin[0], field.origin[1]);
    spanNode.value = field.span;
    thicknessAttribute.array.set(field.thickness);
    thicknessAttribute.needsUpdate = true;
  }

  function updateCaustics(renderer, allowTransport, force = false) {
    if (!causticField) return;
    causticField.update(renderer, bodyAdapter, LOOKS[flavour].sigma, force, allowTransport);
  }

  // ---- picking ----
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const triangle = new THREE.Triangle();
  const bary = new THREE.Vector3();
  function pick(clientX, clientY, rect) {
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    camera.updateMatrixWorld();
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObject(jelly, false)[0];
    if (!hit) return null;
    const { a, b, c } = hit.face;
    const p = positionAttribute.array;
    triangle.a.fromArray(p, a * 3); triangle.b.fromArray(p, b * 3); triangle.c.fromArray(p, c * 3);
    if (!triangle.getBarycoord(hit.point, bary)) return null;
    return { a, b, c, bary: [bary.x, bary.y, bary.z], point: hit.point.toArray() };
  }
  function rayToPlane(clientX, clientY, rect, plane, out) {
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    return raycaster.ray.intersectPlane(plane, out);
  }

  return {
    jelly, geometry, material, positionAttribute, normalAttribute,
    get flavour() { return flavour; },
    get hasCaustics() { return Boolean(causticField); },
    setFlavour, applyFrame, applyField, updateCaustics, pick, rayToPlane,
    disableCaustics() {
      if (!causticField) return;
      benchMaterial.emissiveNode = float(0);
      benchMaterial.needsUpdate = true;
      causticField = null;
    },
  };
}
