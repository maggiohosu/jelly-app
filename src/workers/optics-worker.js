// Optics worker: refractive receiver shadow/contact for every body on the tray
// plus per-body view thickness.
//   init   {size}
//   update {camera:[x,y,z], bodies:[{id, indices?, positions, normals}], keep:[ids], shadowBytes?}
import { SceneOptics } from "../core/optics.js";

let optics = null;
const topology = new Map(); // id → indices (sent once per body)

self.onmessage = ({ data }) => {
  try {
    if (data.type === "init") {
      optics = new SceneOptics(data.size || 192);
      self.postMessage({ type: "ready", size: optics.field.size });
    } else if (data.type === "update") {
      const started = performance.now();
      const keep = new Set(data.keep);
      optics.keepOnly(keep);
      for (const id of [...topology.keys()]) if (!keep.has(id)) topology.delete(id);
      for (const b of data.bodies) {
        if (b.indices) topology.set(b.id, b.indices);
        const indices = topology.get(b.id);
        if (indices) optics.setBody(b.id, indices, b.positions, b.normals);
      }
      optics.update(data.camera[0], data.camera[1], data.camera[2]);
      const F = optics.field;
      let shadowBytes = data.shadowBytes;
      if (!shadowBytes || shadowBytes.length !== F.shadowBytes.length) shadowBytes = new Uint8Array(F.shadowBytes.length);
      shadowBytes.set(F.shadowBytes);
      const thickness = [], transfer = [shadowBytes.buffer];
      for (const [id, b] of optics.bodies) { const t = b.thickness.slice(); thickness.push({ id, thickness: t }); transfer.push(t.buffer); }
      const returned = data.bodies.map((b) => b.positions.buffer).concat(data.bodies.map((b) => b.normals.buffer));
      self.postMessage({ type: "field", shadowBytes, thickness, origin: F.origin.slice(), span: F.span, ms: performance.now() - started, returned }, transfer.concat(returned));
    }
  } catch (error) {
    self.postMessage({ type: "error", message: String(error && error.stack || error) });
  }
};
