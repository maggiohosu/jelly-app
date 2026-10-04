// Shell-fur material for the plush bunny (src/render/rabbit.js).
//
// The whole bunny is ONE indexed geometry drawn as ONE instanced draw call:
// instance 0 is the skin, instances 1..N are fur shells pushed out along the
// normal (shell index = instanceIndex). Body parts are rigid or two-bone
// blended pieces of that geometry; their transforms come from a small uniform
// array (7 vec4 per bone: 4 columns of the skinning matrix + 3 columns of its
// normal matrix), so the rig animates without SkinnedMesh / bone textures and
// runs the same on WebGPU and on the WebGL2 fallback.
//
// Per-vertex attributes (bind pose, rig space):
//   skin  = (bone0, bone1, weight of bone1, blush weight)
//   fur   = (fur length m, strand density cells/m, gloss 0..1, baked AO)
//   comb  = (fibre lean vector in bind space, scaled; w = ear thinness)
//   color = linear albedo
//
// Fur strands: a jittered 3D cell grid evaluated at the BIND position of the
// skin point (not the offset shell point), so every shell samples the same
// strand and strands stay continuous. Each strand has its own length and a
// tapered radius, so tips get thin and sparse (soft fuzzy silhouette); the
// shells lean along `comb` quadratically (curved fibres). Shells are opaque
// (mask/discard, no blending) so the jelly's transmission sees the bunny.
//
// Lighting is evaluated here (unlit node material + fog + tone mapping) so the
// bunny never changes the app's light setup: wrapped sun diffuse, hemisphere
// ambient (the stage has no ambient light), a soft front fill, velvet rim,
// back-lit fur halo, ear translucency, and glossy bead-eye highlights.
import * as THREE from "three/webgpu";
import {
  abs,
  attribute,
  cameraPosition,
  cameraWorldMatrix,
  clamp,
  dot,
  float,
  floor,
  fract,
  instanceIndex,
  int,
  length,
  max,
  mix,
  modelWorldMatrix,
  mx_noise_float,
  normalGeometry,
  normalWorld,
  normalize,
  positionGeometry,
  positionWorld,
  pow,
  reflect,
  select,
  smoothstep,
  uniform,
  uniformArray,
  varying,
  vec3,
  vec4,
} from "three/tsl";

export const BONE_STRIDE = 7;

// Dave Hoskins' hash33 (sin-free, stable in fp32 for the cell ranges used here).
function hash3(p) {
  let q = fract(p.mul(vec3(0.1031, 0.103, 0.0973)));
  q = q.add(dot(q, q.yxz.add(33.33)));
  return fract(q.xxy.add(q.yxx).mul(q.zyx));
}

// One strand layer: true where a strand still exists at relative height h.
function strand(P, density, h, lengthScale, seed) {
  const g = P.mul(density).add(seed);
  const cell = floor(g);
  const r = hash3(cell);
  const d = length(fract(g).sub(r.mul(0.56).add(0.22)));
  const strandLength = fract(r.x.mul(7.13).add(r.y.mul(3.71))).mul(0.5).add(0.5).mul(lengthScale);
  const t = h.div(strandLength);
  const radius = float(0.5).mul(float(1).sub(t.mul(t).mul(0.82)));
  return { alive: t.lessThan(1).and(d.lessThan(radius)), tone: r.z };
}

/**
 * @param {number} boneCount
 * @returns {{ material: THREE.MeshBasicNodeMaterial, bones: THREE.Vector4[], u: object }}
 */
export function createFurMaterial(boneCount) {
  const bones = Array.from({ length: boneCount * BONE_STRIDE }, () => new THREE.Vector4());
  const boneData = uniformArray(bones, "vec4");

  const u = {
    shellCount: uniform(14),
    inflate: uniform(0),        // base-layer push-out when there are no shells (low quality)
    rootDark: uniform(0.7),    // albedo factor at the fur roots (1 = none)
    sunDir: uniform(new THREE.Vector3(0.6123724357, 0.5, -0.6123724357).normalize()),
    sunColor: uniform(new THREE.Color(1, 0.88, 0.7).multiplyScalar(3.0 / Math.PI)),
    // Ambient: the stage has no ambient light, so the bunny brings its own
    // soft studio: hemisphere (≈0.78 at the horizon) + a front fill toward
    // the viewer, giving irradiance ≈ 1 on the face (palette is calibrated to that).
    sky: uniform(new THREE.Color(1.04, 1.0, 0.97)),
    ground: uniform(new THREE.Color(0.52, 0.46, 0.43)),
    fill: uniform(0.26),
    blush: uniform(0.45),
    blushColor: uniform(new THREE.Color("#f39aa6")),
    gain: uniform(1),
  };

  const skin = attribute("skin", "vec4");
  const fur = attribute("fur", "vec4");
  const comb = attribute("comb", "vec4");
  const albedoIn = attribute("color", "vec3");

  // ---- vertex: shell offset in bind space, then two-bone rigid blend -------
  const shell = float(instanceIndex);
  const isBase = shell.lessThan(0.5);
  const h = select(isBase, u.inflate, shell.div(max(u.shellCount, 1)));
  const furLength = fur.x;
  const lift = furLength.mul(h);
  const bindPos = positionGeometry.add(normalGeometry.mul(lift)).add(comb.xyz.mul(lift.mul(h)));

  const fetch = (base, k) => boneData.element(base.add(int(k)));
  const xformP = (b, p) => {
    const i = int(b).mul(int(BONE_STRIDE));
    return fetch(i, 0).xyz.mul(p.x).add(fetch(i, 1).xyz.mul(p.y)).add(fetch(i, 2).xyz.mul(p.z)).add(fetch(i, 3).xyz);
  };
  const xformN = (b, n) => {
    const i = int(b).mul(int(BONE_STRIDE));
    return fetch(i, 4).xyz.mul(n.x).add(fetch(i, 5).xyz.mul(n.y)).add(fetch(i, 6).xyz.mul(n.z));
  };
  const skinned = mix(xformP(skin.x, bindPos), xformP(skin.y, bindPos), skin.z);
  // Furless pieces (eyes, nose, mouth) collapse to a point in the shell
  // instances: degenerate triangles cost nothing to rasterise.
  const collapse = isBase.not().and(furLength.lessThan(1e-6));
  const positionNode = select(collapse, vec3(0), skinned);
  const normalRig = normalize(mix(xformN(skin.x, normalGeometry), xformN(skin.y, normalGeometry), skin.z));
  const vNormal = varying(modelWorldMatrix.mul(vec4(normalRig, 0)).xyz, "v_rabbitNormal");
  const vH = varying(h, "v_rabbitH");
  const vShell = varying(select(isBase, float(0), float(1)), "v_rabbitShell");

  // ---- fragment: strands ------------------------------------------------------
  const P = positionGeometry; // bind-space root position of this fibre (varying)
  // Felt clumps: low-frequency noise, evaluated per vertex (it only depends on
  // the bind position) so the per-fragment shell cost stays two cheap hashes.
  const clump = varying(mx_noise_float(positionGeometry.mul(380)).mul(0.5).add(0.5), "v_rabbitClump");
  const lengthScale = mix(0.62, 1.04, clump);
  const density = fur.y;
  const s1 = strand(P, density, vH, lengthScale, vec3(0));
  const s2 = strand(P, density.mul(1.37), vH, lengthScale.mul(0.9), vec3(11.5, 3.25, 7.75));
  const alive = vShell.lessThan(0.5).or(s1.alive).or(s2.alive);

  // ---- fragment: shading ----------------------------------------------------
  const furry = smoothstep(0, 1e-5, fur.x);
  const N = normalize(vNormal);
  const V = normalize(cameraPosition.sub(positionWorld));
  const L = u.sunDir;
  const NdV = dot(N, V);
  const NdL = dot(N, L);
  const gloss = fur.z;
  const ao = fur.w;

  // Albedo: per-strand tone jitter, blush, darker roots / lighter tips.
  const tone = mix(s1.tone, 0.5, vShell.oneMinus()).sub(0.5).mul(0.12).mul(furry);
  let albedo = mix(albedoIn, u.blushColor, clamp(skin.w.mul(u.blush), 0, 1));
  albedo = albedo.mul(float(1).add(tone));
  const depth = mix(mix(u.rootDark, 1, smoothstep(0, 0.85, vH)), 1, furry.oneMinus());
  const tip = float(1).add(vH.mul(0.1).mul(furry));

  // Sun: wrapped diffuse for fur (soft terminator), plain Lambert otherwise;
  // deeper shells are partly shadowed by the outer ones.
  const wrapK = mix(0, 0.55, furry);
  const diffuse = clamp(NdL.add(wrapK).div(wrapK.add(1)), 0, 1);
  const selfShadow = mix(1, mix(0.5, 1, vH), furry.mul(u.rootDark.oneMinus().mul(2.6).min(1)));
  const translucent = clamp(NdL.negate(), 0, 1).mul(comb.w).mul(0.55);
  const hemi = mix(vec3(u.ground), vec3(u.sky), N.y.mul(0.5).add(0.5));
  const fill = clamp(NdV, 0, 1).mul(u.fill);
  const occlusion = mix(ao, 1, vH.mul(0.6));
  const irradiance = vec3(u.sunColor).mul(diffuse.mul(selfShadow).add(translucent)).add(hemi.add(fill).mul(occlusion));
  let color = albedo.mul(irradiance).mul(depth).mul(tip);

  // Velvet rim + back-lit fur halo (the sun sits behind the bunny in the app view).
  const rim = pow(clamp(NdV.oneMinus(), 0, 1), 3);
  color = color.add(vec3(u.sky).mul(albedo).mul(rim).mul(furry).mul(mix(0.22, 0.42, vH)));
  const back = pow(clamp(dot(V, L.negate()), 0, 1), 2).mul(pow(clamp(abs(NdV).oneMinus(), 0, 1), 2));
  color = color.add(vec3(u.sunColor).mul(albedo).mul(back).mul(furry).mul(vH.mul(0.9).add(0.2)));

  // Gloss: bead eyes and the satin nose. Sun specular + a fixed "studio
  // window" highlight to the upper left of the viewer + Fresnel sky rim.
  const R = reflect(V.negate(), N);
  const Hs = normalize(L.add(V));
  const sunSpec = pow(clamp(dot(N, Hs), 0, 1), mix(24, 260, gloss)).mul(gloss).mul(1.6);
  const studioDir = normalize(cameraWorldMatrix.mul(vec4(-0.42, 0.55, 0.72, 0)).xyz);
  const studio = smoothstep(mix(0.55, 0.8, gloss), mix(0.7, 0.86, gloss), dot(R, studioDir)).mul(gloss).mul(gloss).mul(2.4);
  const studio2 = smoothstep(0.9, 0.96, dot(R, normalize(cameraWorldMatrix.mul(vec4(0.35, -0.3, 0.88, 0)).xyz))).mul(gloss).mul(0.35);
  const fresnel = pow(clamp(NdV.oneMinus(), 0, 1), 4).mul(gloss).mul(0.18);
  color = color.add(vec3(u.sunColor).mul(sunSpec)).add(vec3(studio.add(studio2))).add(vec3(u.sky).mul(fresnel));

  const material = new THREE.MeshBasicNodeMaterial({ side: THREE.FrontSide });
  material.name = "RabbitFur";
  material.positionNode = positionNode;
  material.maskNode = alive;
  material.colorNode = color.mul(u.gain);
  return { material, bones, u };
}

// Unlit-with-own-lighting material for the little hearts (same light model).
export function createCandyMaterial(fur, hex) {
  const N = normalize(normalWorld);
  const V = normalize(cameraPosition.sub(positionWorld));
  const L = fur.u.sunDir;
  const base = vec3(uniform(new THREE.Color(hex)));
  const diffuse = clamp(dot(N, L).add(0.4).div(1.4), 0, 1);
  const hemi = mix(vec3(fur.u.ground), vec3(fur.u.sky), N.y.mul(0.5).add(0.5));
  const R = reflect(V.negate(), N);
  const studio = smoothstep(0.82, 0.9, dot(R, normalize(cameraWorldMatrix.mul(vec4(-0.42, 0.55, 0.72, 0)).xyz)));
  const rim = pow(clamp(dot(N, V).oneMinus(), 0, 1), 3).mul(0.35);
  const material = new THREE.MeshBasicNodeMaterial();
  material.name = "RabbitHeart";
  material.colorNode = base.mul(vec3(fur.u.sunColor).mul(diffuse).add(hemi.mul(0.9))).add(studio.mul(1.4)).add(rim);
  return material;
}
