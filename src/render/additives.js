// Additives carried by the jelly: glitter flakes (inside) and star candies
// (just under the surface). Positions come from the sim worker (tray space,
// 5 floats each: x, y, z, kind, variant + spin/10). Two InstancedMeshes, so
// hundreds of flakes cost two draw calls. Opaque, so the jelly's
// transmission refracts them like the gems.
import * as THREE from "three/webgpu";
import { float, fract, hash, instanceIndex, sin, time, vec3 } from "three/tsl";

const MAX_GLITTER = 400, MAX_STARS = 40;
const GLITTER_COLORS = ["#ffd76a", "#f3f6ff", "#ffb3d6", "#b9f0ff"];
const STAR_COLORS = ["#ffb3d1", "#fff1a8", "#bfe6ff", "#d9c7ff", "#c6f5d4"];

function starGeometry(radius = 0.0019, depth = 0.0011) {
  const shape = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? radius * 0.48 : radius, a = (i / 10) * Math.PI * 2 + Math.PI / 2;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
  }
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: depth * 0.45, bevelSize: radius * 0.2, bevelSegments: 3, curveSegments: 1 });
  g.translate(0, 0, -depth / 2);
  g.computeVertexNormals();
  return g;
}

export class AdditiveLayer {
  constructor(parent) {
    // Glitter: thin hexagonal flakes, metallic, each twinkling at its own rate.
    const flake = new THREE.CylinderGeometry(0.00075, 0.00075, 0.00009, 6, 1);
    const glitterMat = new THREE.MeshStandardNodeMaterial({ metalness: 0.85, roughness: 0.22 });
    const seed = hash(instanceIndex);
    const twinkle = fract(time.mul(float(0.6).add(seed.mul(1.6))).add(seed.mul(7.0)));
    const flash = sin(twinkle.mul(Math.PI)).pow(14);          // short bright flashes
    glitterMat.emissiveNode = vec3(1.0, 0.95, 0.8).mul(flash.mul(1.6).add(0.12));
    this.glitter = new THREE.InstancedMesh(flake, glitterMat, MAX_GLITTER);
    // Star candies: puffy pastel stars with a candy gloss.
    const starMat = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.08, sheen: 0.4 });
    starMat.emissiveNode = vec3(0.12, 0.1, 0.11);
    this.stars = new THREE.InstancedMesh(starGeometry(), starMat, MAX_STARS);
    for (const [mesh, colors, max] of [[this.glitter, GLITTER_COLORS, MAX_GLITTER], [this.stars, STAR_COLORS, MAX_STARS]]) {
      mesh.count = 0; mesh.visible = false; mesh.frustumCulled = false;
      const c = new THREE.Color();
      for (let i = 0; i < max; i++) mesh.setColorAt(i, c.set(colors[i % colors.length]));
      parent.add(mesh);
    }
    this.glitter.name = "Glitter"; this.stars.name = "StarCandies";
    this.m = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.e = new THREE.Euler(); this.p = new THREE.Vector3(); this.s = new THREE.Vector3(1, 1, 1);
    this.colorKey = { glitter: new Int8Array(MAX_GLITTER).fill(-1), stars: new Int8Array(MAX_STARS).fill(-1) };
  }

  update(states) {
    let g = 0, s = 0;
    const n = states ? Math.floor(states.length / 5) : 0;
    for (let i = 0; i < n; i++) {
      const o = i * 5, kind = states[o + 3], variant = Math.floor(states[o + 4]), spin = (states[o + 4] - variant) * 10;
      const glitter = kind < 0.5, mesh = glitter ? this.glitter : this.stars, k = glitter ? g : s;
      if (k >= (glitter ? MAX_GLITTER : MAX_STARS)) continue;
      this.p.set(states[o], states[o + 1], states[o + 2]);
      this.e.set(spin * 6.28, spin * 17.3, spin * 3.1);
      this.q.setFromEuler(this.e);
      this.s.setScalar(glitter ? 0.8 + 0.4 * ((i * 37) % 10) / 10 : 0.85 + 0.3 * spin);
      mesh.setMatrixAt(k, this.m.compose(this.p, this.q, this.s));
      const keys = glitter ? this.colorKey.glitter : this.colorKey.stars, colors = glitter ? GLITTER_COLORS : STAR_COLORS;
      if (keys[k] !== variant) {
        keys[k] = variant;
        mesh.setColorAt(k, new THREE.Color(colors[variant % colors.length]));
        mesh.instanceColor.needsUpdate = true;
      }
      if (glitter) g++; else s++;
    }
    for (const [mesh, count] of [[this.glitter, g], [this.stars, s]]) {
      mesh.count = count; mesh.visible = count > 0;
      if (count) mesh.instanceMatrix.needsUpdate = true;
    }
  }
}
