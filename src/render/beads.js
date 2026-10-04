// Foam beads of the 슬랑이 (crunchy slime): small opaque pastel balls carried
// by the slime (positions come from the sim worker, tray space). One
// InstancedMesh, so ~180 beads cost a single draw call.
import * as THREE from "three/webgpu";

const MAX_BEADS = 220;
const BEAD_RADIUS = 0.0021;
export const BEAD_COLORS = ["#fffaf3", "#ffd6e4", "#d9ecff", "#e6dcff", "#fff1c9"];

export class BeadLayer {
  constructor(parent) {
    const geometry = new THREE.IcosahedronGeometry(BEAD_RADIUS, 2);
    // Seen through the tinted slime the beads would read as dark specks: a soft
    // self-glow keeps them looking like chalky pastel foam balls.
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0, emissive: new THREE.Color("#ffffff"), emissiveIntensity: 0.55 });
    this.mesh = new THREE.InstancedMesh(geometry, material, MAX_BEADS);
    this.mesh.name = "Beads";
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.colors = BEAD_COLORS.map((hex) => new THREE.Color(hex));
    for (let i = 0; i < MAX_BEADS; i++) this.mesh.setColorAt(i, this.colors[i % this.colors.length]);
    this.matrix = new THREE.Matrix4();
    this.scale = new THREE.Vector3(1, 1, 1);
    this.rotation = new THREE.Quaternion();
    this.position = new THREE.Vector3();
    parent.add(this.mesh);
  }

  // states: 4 floats per bead (x, y, z, colour index); empty → hidden.
  update(states) {
    const n = states ? Math.min(MAX_BEADS, Math.floor(states.length / 4)) : 0;
    this.mesh.visible = n > 0;
    if (!n) { this.mesh.count = 0; return; }
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      this.position.set(states[o], states[o + 1], states[o + 2]);
      // slight size variety, stable per bead
      const s = 0.8 + 0.4 * (((i * 2654435761) >>> 0) % 1000) / 1000;
      this.scale.setScalar(s);
      this.matrix.compose(this.position, this.rotation, this.scale);
      this.mesh.setMatrixAt(i, this.matrix);
      if (this.mesh.count <= i || this.lastColor?.[i] !== states[o + 3]) {
        this.mesh.setColorAt(i, this.colors[states[o + 3] % this.colors.length | 0]);
        if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
        (this.lastColor ||= new Float32Array(MAX_BEADS).fill(-1))[i] = states[o + 3];
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
