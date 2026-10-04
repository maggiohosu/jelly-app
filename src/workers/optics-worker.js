// Optics worker: refractive receiver shadow/contact field and view thickness.
//   init   {positions, normals, indices}  (rest shape; fixes the BVH topology)
//   update {positions, normals, camera:[x,y,z], shadowBytes?, thickness?}
import { ReceiverOptics } from "../core/optics.js";

let optics = null;

self.onmessage = ({ data }) => {
  try {
    if (data.type === "init") {
      optics = new ReceiverOptics(data.positions.slice(), data.normals.slice(), data.indices);
      self.postMessage({ type: "ready", size: optics.size });
    } else if (data.type === "update") {
      const started = performance.now();
      optics.p.set(data.positions);
      optics.n.set(data.normals);
      optics.updateReceiver();
      optics.updateViewThickness(data.camera[0], data.camera[1], data.camera[2]);
      let shadowBytes = data.shadowBytes, thickness = data.thickness;
      if (!shadowBytes || shadowBytes.length !== optics.shadowBytes.length) shadowBytes = new Uint8Array(optics.shadowBytes.length);
      if (!thickness || thickness.length !== optics.thickness.length) thickness = new Float32Array(optics.thickness.length);
      shadowBytes.set(optics.shadowBytes);
      thickness.set(optics.thickness);
      self.postMessage({
        type: "field",
        shadowBytes,
        thickness,
        origin: optics.origin.slice(),
        span: optics.span,
        ms: performance.now() - started,
        positions: data.positions,
        normals: data.normals,
      }, [shadowBytes.buffer, thickness.buffer, data.positions.buffer, data.normals.buffer]);
    }
  } catch (error) {
    self.postMessage({ type: "error", message: String(error && error.stack || error) });
  }
};
