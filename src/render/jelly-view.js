// Main-thread view of the jelly: the shell (fed by the physics worker), the
// transmissive material whose absorption comes per vertex from the paint
// field, the inner glow + coloured light, the receiver shadow (optics worker),
// GPU caustics (WebGPU) and the falling paint droplets of the pipette.
// Material and receiver shading follow the softbody-jelly example
// (threejs-awesome-graphics-agent-skills, MIT, Copyright (c) 2026 Scott Sun).
import * as THREE from "three/webgpu";
import { abs, attribute, clamp, dot, exp, float, max, mix, normalView, positionLocal, positionViewDirection, sin, texture, time, uniform, vec3 } from "three/tsl";
import { GPUCausticField } from "./gpu-caustic-field.js";

const ATTENUATION_DISTANCE = 0.035;
const FIELD_SIZE = 192;
const DROP_HEIGHT = 0.038;     // m above the landing point where a drop leaves the pipette

const transmittance = (sigma) => sigma.map((s) => Math.exp(-s * ATTENUATION_DISTANCE));

function makeMaterial(glow) {
  const sigma = attribute("dye", "vec3");                 // absorption (1/m) per vertex
  const T = exp(sigma.mul(-ATTENUATION_DISTANCE));        // transmittance over the reference depth
  const thickness = attribute("opticalThickness", "float");
  const material = new THREE.MeshPhysicalNodeMaterial({
    roughness: 0.028, metalness: 0, transmission: 1, thickness: 0.035, ior: 1.33, dispersion: 0.01,
    attenuationDistance: ATTENUATION_DISTANCE, clearcoat: 0.42, clearcoatRoughness: 0.05,
    transparent: false, side: THREE.FrontSide,
  });
  // Surface tint: a pale version of the body colour (the original flavours
  // pair e.g. #ffe0eb with an attenuation of #ed5187).
  material.colorNode = vec3(1).sub(vec3(1).sub(T).mul(0.16));
  material.attenuationColorNode = T;
  // Clear gelatin: low roughness keeps embedded gems crisp, and the optical
  // path is trimmed a little so they read through the colour (still tinted).
  material.thicknessNode = thickness.mul(0.82);
  // Inner glow in the body's own hue (normalised so dark mixes still glow).
  const hueColor = T.div(max(max(T.x, T.y), max(T.z, 0.05)));
  const inner = hueColor.mul(glow).mul(float(0.35).add(clamp(thickness.div(0.03), 0, 1).mul(0.65))).mul(0.6);
  // 금펄 paint: a pearly gold sheen that shifts toward pink at grazing angles
  // and shimmers slowly; 야광 paint: a soft lime glow in its own light.
  const fx = attribute("fx", "vec2");
  const facing = abs(dot(normalView, positionViewDirection));
  const rim = float(1).sub(facing);
  const shimmer = sin(time.mul(1.7).add(positionLocal.x.mul(260)).add(positionLocal.y.mul(190))).mul(0.25).add(0.75);
  const pearl = mix(vec3(1.0, 0.82, 0.42), vec3(1.0, 0.62, 0.78), rim).mul(rim.mul(0.6).add(0.1)).mul(shimmer).mul(clamp(fx.x, 0, 1)).mul(0.32);
  const glowPaint = vec3(0.45, 1.0, 0.35).mul(clamp(fx.y, 0, 1)).mul(facing.mul(0.25).add(0.2));
  material.emissiveNode = inner.add(pearl).add(glowPaint);
  return material;
}

export function createJellyView(stage, init, { caustics = true } = {}) {
  const { camera, sun, benchMaterial, benchTexture, isWebGPU, tray } = stage;
  // The surface topology changes with the jelly's shape: everything sized by
  // it is (re)built here.
  let geometry, position, normal, thickness, dye, fxAttr;
  function buildGeometry(init) {
    const vertexCount = init.positions.length / 3;
    geometry = new THREE.BufferGeometry();
    position = new THREE.BufferAttribute(new Float32Array(init.positions), 3).setUsage(THREE.DynamicDrawUsage);
    normal = new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3).setUsage(THREE.DynamicDrawUsage);
    thickness = new THREE.BufferAttribute(new Float32Array(vertexCount).fill(0.03), 1).setUsage(THREE.DynamicDrawUsage);
    dye = new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3).setUsage(THREE.DynamicDrawUsage);
    fxAttr = new THREE.BufferAttribute(new Float32Array(vertexCount * 2), 2).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", position);
    geometry.setAttribute("normal", normal);
    geometry.setAttribute("opticalThickness", thickness);
    geometry.setAttribute("dye", dye);
    geometry.setAttribute("fx", fxAttr);
    geometry.setIndex(new THREE.BufferAttribute(init.indices, 1));
    geometry.boundingBox = new THREE.Box3();
    geometry.boundingSphere = new THREE.Sphere();
    return geometry;
  }
  buildGeometry(init);

  const glow = uniform(0);
  const jelly = new THREE.Mesh(geometry, makeMaterial(glow));
  jelly.name = "SoftbodyJelly";
  jelly.frustumCulled = false;
  tray.add(jelly);
  const center = new THREE.Vector3();
  const state = { center, meanDye: [5, 46, 23], energy: 0, glowLevel: 0, pulse: 0 };

  // Receiver shadow/contact field (optics worker).
  const shadowBytes = new Uint8Array(FIELD_SIZE * FIELD_SIZE * 4);
  const shadowTexture = new THREE.DataTexture(shadowBytes, FIELD_SIZE, FIELD_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  shadowTexture.minFilter = shadowTexture.magFilter = THREE.LinearFilter;
  shadowTexture.generateMipmaps = false;
  shadowTexture.colorSpace = THREE.NoColorSpace;
  shadowTexture.needsUpdate = true;
  const origin = new THREE.Vector2(-0.11, -0.11);
  const originNode = uniform(origin), spanNode = uniform(0.22);

  // GPU caustics (WebGPU only), traced in tray space; the BVH topology comes
  // from the rest shape passed in `init.positions`.
  let field = null;
  if (isWebGPU && caustics) {
    field = new GPUCausticField({ positions: position.array, indices: init.indices, geometry });
    field.setCamera(stage.trayCamera);
  }
  const trayPosition = positionLocal; // floor geometry is authored in tray space
  const shadowField = texture(shadowTexture, trayPosition.xz.sub(originNode).div(spanNode));
  const bench = texture(benchTexture, trayPosition.xz.div(0.16).add(0.5)).rgb;
  const sunColor = uniform(sun.color);
  const causticEmission = () => bench.mul(field.sampleIrradiance(trayPosition)).mul(sunColor).mul(sun.intensity / Math.PI).mul(shadowStrength);
  const shadowStrength = uniform(1);       // 0 while the jelly is hidden (eaten)
  benchMaterial.colorNode = bench.mul(float(1).sub(shadowField.r.mul(shadowStrength.mul(0.63)))).mul(float(1).sub(shadowField.g.mul(shadowStrength.mul(0.40))));
  benchMaterial.emissiveNode = field ? causticEmission() : float(0);
  benchMaterial.needsUpdate = true;
  let causticsOn = Boolean(field);

  // Finger anchor like the original.
  const gripMarker = new THREE.Mesh(new THREE.SphereGeometry(0.0012, 16, 12), new THREE.MeshBasicNodeMaterial({ color: "#ffffff", transparent: true, opacity: 0.82, depthTest: false }));
  gripMarker.visible = false; gripMarker.renderOrder = 4;
  const lineGeometry = new THREE.BufferGeometry();
  lineGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3).setUsage(THREE.DynamicDrawUsage));
  const gripLine = new THREE.Line(lineGeometry, new THREE.LineBasicNodeMaterial({ color: "#586b75", transparent: true, opacity: 0.38, depthTest: false, depthWrite: false }));
  gripLine.frustumCulled = false; gripLine.visible = false; gripLine.renderOrder = 3;
  tray.add(gripMarker, gripLine);

  // Paint droplets (pool) and splash rings.
  const dropGeometry = new THREE.SphereGeometry(0.0021, 20, 14);
  dropGeometry.scale(1, 1.25, 1);
  const ringGeometry = new THREE.RingGeometry(0.7, 1, 48);
  const drops = Array.from({ length: 10 }, () => {
    const material = new THREE.MeshPhysicalNodeMaterial({ color: "#ffffff", roughness: 0.08, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05 });
    const mesh = new THREE.Mesh(dropGeometry, material);
    mesh.visible = false; tray.add(mesh);
    const ring = new THREE.Mesh(ringGeometry, new THREE.MeshBasicNodeMaterial({ color: "#ffffff", transparent: true, opacity: 0, depthWrite: false }));
    ring.visible = false; tray.add(ring);
    return { mesh, ring, active: false, t: 0, from: new THREE.Vector3(), to: new THREE.Vector3(), normal: new THREE.Vector3(), splash: -1, onLand: null };
  });

  const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2();

  return {
    jelly, state,
    get geometry() { return geometry; },
    // New jelly shape: new surface topology (worker "topology" message).
    setTopology(next) {
      const old = geometry;
      jelly.geometry = buildGeometry(next);
      old.dispose();
      if (field) {
        field = new GPUCausticField({ positions: position.array, indices: next.indices, geometry });
        field.setCamera(stage.trayCamera);
        if (causticsOn) { benchMaterial.emissiveNode = causticEmission(); benchMaterial.needsUpdate = true; }
      }
    },
    get causticsOn() { return causticsOn; },
    get hasCaustics() { return field !== null; },

    sync(frame, recycle) {
      // (frames from before a shape change can still arrive: skip mismatched sizes)
      if (frame.positions) {
        if (frame.positions.length === position.array.length) {
          position.array.set(frame.positions); normal.array.set(frame.normals);
          position.needsUpdate = true; normal.needsUpdate = true;
        }
        recycle(frame.positions.buffer); recycle(frame.normals.buffer);
      }
      if (frame.dye) { if (frame.dye.length === dye.array.length) { dye.array.set(frame.dye); dye.needsUpdate = true; } recycle(frame.dye.buffer); }
      if (frame.fx) { if (frame.fx.length === fxAttr.array.length) { fxAttr.array.set(frame.fx); fxAttr.needsUpdate = true; } recycle(frame.fx.buffer); }
      const b = frame.bounds;
      geometry.boundingBox.min.set(b[0], b[1], b[2]); geometry.boundingBox.max.set(b[3], b[4], b[5]);
      geometry.boundingBox.getBoundingSphere(geometry.boundingSphere);
      center.fromArray(frame.center);
      state.meanDye = frame.meanDye; state.energy = frame.energy;
      if (frame.grab) {
        gripMarker.position.fromArray(frame.grab.point);
        const p = lineGeometry.attributes.position;
        p.setXYZ(0, ...frame.grab.point); p.setXYZ(1, ...frame.grab.target); p.needsUpdate = true;
        gripMarker.visible = gripLine.visible = true;
      } else gripMarker.visible = gripLine.visible = false;
    },

    applyField(data) {
      shadowBytes.set(data.shadowBytes); shadowTexture.needsUpdate = true;
      origin.set(data.origin[0], data.origin[1]); spanNode.value = data.span;
      const t = data.thickness[0]?.thickness;
      if (t && t.length === thickness.array.length) { thickness.array.set(t); thickness.needsUpdate = true; }
    },

    // Glow: smoothed motion energy + melody pulses, scaled by the slider.
    updateGlow(dt, scale) {
      const target = Math.min(1, state.energy / 0.06);
      state.glowLevel += (target - state.glowLevel) * Math.min(1, dt * (target > state.glowLevel ? 8 : 1.2));
      state.pulse = Math.max(0, state.pulse - dt * 2.5);
      const g = (state.glowLevel * 0.85 + state.pulse) * scale;
      glow.value = g;
      const T = transmittance(state.meanDye), m = Math.max(T[0], T[1], T[2], 0.05);
      const light = stage.glowLight;
      light.color.setRGB(T[0] / m, T[1] / m, T[2] / m);
      light.position.set(center.x, Math.max(0.01, center.y * 0.6), center.z);
      light.intensity = 0.0042 * g;
      return g > 0.003;
    },
    pulse(strength) { state.pulse = Math.min(1.2, state.pulse + strength); },
    // Hide the jelly (and its shadow / caustics) while it is gone.
    setHidden(hidden) {
      jelly.visible = !hidden;
      shadowStrength.value = hidden ? 0 : 1;
    },
    get hidden() { return !jelly.visible; },

    updateCaustics(renderer, allowTransport) {
      if (!causticsOn) return;
      field.update(renderer, state, state.meanDye, false, allowTransport);
    },
    setCaustics(on) {
      on = on && field !== null;
      if (on === causticsOn) return;
      causticsOn = on;
      benchMaterial.emissiveNode = on ? causticEmission() : float(0);
      benchMaterial.needsUpdate = true;
    },
    disableCaustics() { this.setCaustics(false); field = null; },

    // Raycast the jelly; tray-space hit data (surface triangle + barycentrics).
    pick(clientX, clientY, rect) {
      ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      camera.updateMatrixWorld();
      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster.intersectObject(jelly, false)[0];
      if (!hit) return null;
      const { a, b, c } = hit.face, p = position.array;
      const local = tray.worldToLocal(hit.point.clone());
      const tri = new THREE.Triangle(new THREE.Vector3().fromArray(p, a * 3), new THREE.Vector3().fromArray(p, b * 3), new THREE.Vector3().fromArray(p, c * 3));
      const bary = tri.getBarycoord(local, new THREE.Vector3());
      if (!bary) return null;
      const n = new THREE.Vector3();
      tri.getNormal(n);
      return { a, b, c, bary: [bary.x, bary.y, bary.z], point: local.toArray(), normal: n, worldPoint: hit.point.clone() };
    },

    // Release a paint droplet above a tray-space point; onLand fires on impact.
    dropPaint(point, normal, colorHex, onLand) {
      const d = drops.find((x) => !x.active && x.splash < 0);
      if (!d) { onLand(); return; }
      d.active = true; d.t = 0; d.onLand = onLand;
      d.to.fromArray(point); d.normal.copy(normal || new THREE.Vector3(0, 1, 0));
      d.from.copy(d.to).add(new THREE.Vector3(0, DROP_HEIGHT, 0));
      d.mesh.material.color.set(colorHex);
      d.mesh.position.copy(d.from); d.mesh.visible = true;
      d.ring.material.color.set(colorHex);
    },
    // Advances droplets and splash rings; returns true while anything animates.
    updateDrops(dt) {
      let busy = false;
      for (const d of drops) {
        if (d.active) {
          busy = true;
          d.t += dt;
          const fall = 0.5 * 9.81 * d.t * d.t; // free fall
          if (fall >= DROP_HEIGHT) {
            d.active = false; d.mesh.visible = false;
            d.splash = 0;
            d.ring.position.copy(d.to).addScaledVector(d.normal, 0.0006);
            d.ring.lookAt(d.ring.position.clone().add(d.normal));
            d.ring.visible = true;
            d.onLand?.();
          } else {
            d.mesh.position.copy(d.from).y -= fall;
            d.mesh.scale.set(1, 1 + Math.min(0.6, d.t * 3), 1);
          }
        } else if (d.splash >= 0) {
          busy = true;
          d.splash += dt;
          const k = d.splash / 0.42;
          if (k >= 1) { d.splash = -1; d.ring.visible = false; continue; }
          const r = 0.002 + 0.011 * Math.sqrt(k);
          d.ring.scale.setScalar(r);
          d.ring.material.opacity = 0.55 * (1 - k);
        }
      }
      return busy;
    },
  };
}
