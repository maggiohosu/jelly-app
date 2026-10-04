// Offscreen thumbnails / snapshots with the app's WebGPURenderer (either
// backend). Rendering goes to a half-float HDR target first (MSAA), then a
// full-screen pass applies the renderer's tone mapping + sRGB into an RGBA8
// target that is read back with readRenderTargetPixelsAsync. The renderer's
// render target, clear colour/alpha and the caller's camera are restored, so
// the main loop is not disturbed; it can run between frames.
//
//   const thumbs = createThumbnailer(renderer);
//   const png  = await thumbs.renderObject(mesh, { size: 256 });            // transparent
//   const webp = await thumbs.renderScene(scene, camera, { width, height }); // snapshot

import * as THREE from "three/webgpu";
import { max, sRGBTransferOETF, texture, toneMapping, uniform, vec4 } from "three/tsl";

export function createThumbnailer(renderer) {
  // Small studio for single objects: lights only matter for lit materials
  // (the gem materials carry their own analytic environment).
  const studio = new THREE.Scene();
  studio.add(new THREE.HemisphereLight(0xf4f6ff, 0xd8cec6, 1.5));
  const key = new THREE.DirectionalLight(0xfff1da, 2.4);
  key.position.set(-0.5, 0.8, 0.9);
  const fill = new THREE.DirectionalLight(0xe6eeff, 0.9);
  fill.position.set(0.9, 0.2, 0.5);
  const back = new THREE.DirectionalLight(0xffffff, 1.2);
  back.position.set(0.61, 0.5, -0.61);
  studio.add(key, fill, back);
  const pivot = new THREE.Group();
  studio.add(pivot);
  const camera = new THREE.PerspectiveCamera(26, 1, 1e-4, 10);
  const viewDir = new THREE.Vector3(0, 0.36, 1).normalize();

  let hdr = null, ldr = null;
  const exposure = uniform(1);
  const source = texture(new THREE.Texture());
  const quads = new Map(); // per tone-mapping mode

  function quadFor(mapping) {
    let quad = quads.get(mapping);
    if (quad) return quad;
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, blending: THREE.NoBlending, depthTest: false, depthWrite: false });
    const c = source;
    // Un-premultiply MSAA edges before the non-linear tone curve; keep alpha.
    const rgb = c.rgb.div(max(c.a, 1e-4));
    material.colorNode = vec4(sRGBTransferOETF(toneMapping(mapping, exposure, rgb)), c.a);
    quad = new THREE.QuadMesh(material);
    quads.set(mapping, quad);
    return quad;
  }

  function targets(width, height) {
    if (!hdr) {
      hdr = new THREE.RenderTarget(width, height, { type: THREE.HalfFloatType, samples: 4, depthBuffer: true, generateMipmaps: false });
      ldr = new THREE.RenderTarget(width, height, { type: THREE.UnsignedByteType, samples: 0, depthBuffer: false, generateMipmaps: false });
    } else if (hdr.width !== width || hdr.height !== height) {
      hdr.setSize(width, height);
      ldr.setSize(width, height);
    }
  }

  const prevClear = new THREE.Color();
  let queue = Promise.resolve();

  // Render `scene` with `cam` into the HDR target, tone-map into the LDR one and
  // start the readback, all synchronously; returns the pending pixel promise.
  function draw(scene, cam, width, height) {
    targets(width, height);
    const prevTarget = renderer.getRenderTarget();
    const prevMRT = renderer.getMRT ? renderer.getMRT() : null;
    renderer.getClearColor(prevClear);
    const prevAlpha = renderer.getClearAlpha();
    const prevAutoClear = renderer.autoClear;
    try {
      if (renderer.setMRT) renderer.setMRT(null);
      renderer.autoClear = true;
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(hdr);
      renderer.render(scene, cam);
      exposure.value = renderer.toneMappingExposure;
      source.value = hdr.texture;
      renderer.setRenderTarget(ldr);
      quadFor(renderer.toneMapping).render(renderer);
    } finally {
      renderer.setRenderTarget(prevTarget);
      if (renderer.setMRT) renderer.setMRT(prevMRT);
      renderer.setClearColor(prevClear, prevAlpha);
      renderer.autoClear = prevAutoClear;
    }
    const target = ldr;
    return renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height).catch((error) => {
      // e.g. the GPU device was lost, so nothing was drawn into the target.
      throw new Error(`thumbnail readback failed: ${error?.message || error}`);
    });
  }

  function encode(pixels, width, height, { background = null, mime = "image/png", quality } = {}) {
    // WebGPU pads rows to 256 bytes; WebGL rows are tight and bottom-up.
    const tight = width * 4;
    const stride = pixels.length === tight * height ? tight : height > 1 ? (pixels.length - tight) / (height - 1) : tight;
    const flip = renderer.backend?.isWebGLBackend === true;
    const image = new ImageData(width, height);
    for (let y = 0; y < height; y += 1) {
      const src = (flip ? height - 1 - y : y) * stride;
      image.data.set(pixels.subarray(src, src + tight), y * tight);
    }
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (background !== null && background !== undefined) {
      const layer = document.createElement("canvas");
      layer.width = width; layer.height = height;
      layer.getContext("2d").putImageData(image, 0, 0);
      ctx.fillStyle = typeof background === "string" ? background : `#${new THREE.Color(background).getHexString()}`;
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(layer, 0, 0);
    } else {
      ctx.putImageData(image, 0, 0);
    }
    return canvas.toDataURL(mime, quality);
  }

  const box = new THREE.Box3(), sphere = new THREE.Sphere();
  const corner = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3();

  /**
   * Thumbnail of one object, framed to its bounding sphere from the front and
   * slightly above. The object is borrowed for the draw call (it goes back to
   * its parent, at the same child index, before this returns its promise).
   */
  function renderObject(object, { size = 256, background = null, padding = 1.1, direction = viewDir, mime = "image/png", quality } = {}) {
    const run = async () => {
      const w = Math.max(1, Math.round(size)), h = w;
      const parent = object.parent;
      const index = parent ? parent.children.indexOf(object) : -1;
      let pending;
      try {
        pivot.add(object);
        studio.updateMatrixWorld(true);
        box.setFromObject(object, true);
        if (box.isEmpty()) box.set(new THREE.Vector3(-0.01, -0.01, -0.01), new THREE.Vector3(0.01, 0.01, 0.01));
        box.getBoundingSphere(sphere);
        // Fit the eight box corners (not the sphere) into the view cone.
        const dir = direction.clone().normalize();
        camera.position.copy(sphere.center).add(dir);
        camera.lookAt(sphere.center);
        camera.updateMatrixWorld();
        const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / padding;
        let dist = sphere.radius * 0.5;
        for (let c = 0; c < 8; c += 1) {
          corner.set(c & 1 ? box.max.x : box.min.x, c & 2 ? box.max.y : box.min.y, c & 4 ? box.max.z : box.min.z).sub(sphere.center);
          const x = corner.dot(right.setFromMatrixColumn(camera.matrixWorld, 0));
          const y = corner.dot(up.setFromMatrixColumn(camera.matrixWorld, 1));
          const z = corner.dot(dir);
          dist = Math.max(dist, z + Math.abs(x) / tanHalf, z + Math.abs(y) / tanHalf);
        }
        camera.aspect = 1;
        camera.near = Math.max(dist - sphere.radius * 2, dist * 0.01);
        camera.far = dist + sphere.radius * 2;
        camera.position.copy(sphere.center).addScaledVector(dir, dist);
        camera.lookAt(sphere.center);
        camera.updateProjectionMatrix();
        pending = draw(studio, camera, w, h);
      } finally {
        pivot.remove(object);
        if (parent) {
          parent.add(object);
          const children = parent.children;
          children.splice(children.indexOf(object), 1);
          children.splice(Math.min(index, children.length), 0, object);
        }
      }
      return encode(await pending, w, h, { background, mime, quality });
    };
    const result = queue.then(run, run);
    queue = result.catch(() => {});
    return result;
  }

  /** Snapshot of a whole scene through `camera` (aspect temporarily matched). */
  function renderScene(scene, cam, { width, height, mime = "image/webp", quality = 0.85, background = null } = {}) {
    const run = async () => {
      const size = renderer.getDrawingBufferSize(new THREE.Vector2());
      const w = Math.max(1, Math.round(width ?? size.x)), h = Math.max(1, Math.round(height ?? size.y));
      const saved = { aspect: cam.aspect, view: cam.view ? { ...cam.view } : null };
      const fits = !cam.isPerspectiveCamera || Math.abs(cam.aspect - w / h) < 1e-4;
      let pending;
      try {
        if (!fits) {
          cam.aspect = w / h;
          if (cam.view && cam.view.enabled) {
            const sx = w / cam.view.fullWidth, sy = h / cam.view.fullHeight;
            Object.assign(cam.view, { fullWidth: w, fullHeight: h, offsetX: cam.view.offsetX * sx, offsetY: cam.view.offsetY * sy, width: cam.view.width * sx, height: cam.view.height * sy });
          }
          cam.updateProjectionMatrix();
        }
        pending = draw(scene, cam, w, h);
      } finally {
        if (!fits) {
          cam.aspect = saved.aspect;
          if (saved.view) cam.view = saved.view;
          cam.updateProjectionMatrix();
        }
      }
      return encode(await pending, w, h, { background, mime, quality });
    };
    const result = queue.then(run, run);
    queue = result.catch(() => {});
    return result;
  }

  function dispose() {
    hdr?.dispose(); ldr?.dispose();
    hdr = ldr = null;
    for (const quad of quads.values()) quad.material.dispose();
    quads.clear();
  }

  return { renderObject, renderScene, dispose };
}
