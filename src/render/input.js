// Touch routing.
//  one finger on the jelly      → grab (stretch, wobble); a short tap pokes it
//  one finger on empty space   → tilt the tray toward the finger; springs back on release
//  two fingers                 → orbit (drag) + pinch zoom
//  mouse: wheel zoom, right-drag orbit (desktop testing)
import * as THREE from "three/webgpu";

const MAX_TILT = THREE.MathUtils.degToRad(22);
const TILT_FULL_PX = 170;

export function createInput({ canvas, stage, view, onGrabStart, onGrabMove, onGrabEnd, onTap, onTilt, onInteract, isEnabled }) {
  const { camera, rig, tray } = stage;
  const pointers = new Map(); // id → {x, y, x0, y0, t0}
  let mode = null;            // 'grab' | 'tilt' | 'camera' | 'mouse-orbit'
  let grabbed = null;         // pick result
  const dragPlane = new THREE.Plane(), viewDirection = new THREE.Vector3(), hitPoint = new THREE.Vector3();
  const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let pinch = null;
  function ray(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    return raycaster.ray;
  }

  function swallow(event) { event.preventDefault(); event.stopImmediatePropagation(); }

  function down(event) {
    if (!isEnabled()) return;
    swallow(event);
    canvas.setPointerCapture?.(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, x0: event.clientX, y0: event.clientY, t0: performance.now() });
    onInteract?.();
    if (event.pointerType === "mouse" && event.button === 2) { mode = "mouse-orbit"; return; }
    if (pointers.size === 2) {
      // A second finger turns a tilt (or nothing) into camera control; a grab keeps going.
      if (mode === "grab") return;
      if (mode === "tilt") onTilt(null, 0);
      mode = "camera";
      const [a, b] = [...pointers.values()];
      pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      return;
    }
    if (pointers.size > 2 || mode) return;
    const hit = view.pick(event.clientX, event.clientY, canvas.getBoundingClientRect());
    if (hit) {
      mode = "grab"; grabbed = hit;
      camera.getWorldDirection(viewDirection);
      dragPlane.setFromNormalAndCoplanarPoint(viewDirection, hit.worldPoint);
      onGrabStart(hit);
    } else {
      mode = "tilt";
    }
  }

  function move(event) {
    const p = pointers.get(event.pointerId);
    if (!p) return;
    swallow(event);
    const dx = event.clientX - p.x, dy = event.clientY - p.y;
    p.x = event.clientX; p.y = event.clientY;
    if (mode === "mouse-orbit") { rig.rotate(-dx * 0.006, -dy * 0.005); return; }
    if (mode === "grab" && pointers.size >= 1 && event.pointerId === [...pointers.keys()][0]) {
      if (ray(event.clientX, event.clientY).intersectPlane(dragPlane, hitPoint)) onGrabMove(tray.worldToLocal(hitPoint.clone()).toArray());
      return;
    }
    if (mode === "tilt") {
      const sx = p.x - p.x0, sy = p.y - p.y0, length = Math.hypot(sx, sy);
      if (length < 6) return;
      // Screen direction → horizontal world direction (camera azimuth).
      const az = rig.azimuth;
      const right = new THREE.Vector3(Math.cos(az), 0, -Math.sin(az));
      const far = new THREE.Vector3(-Math.sin(az), 0, -Math.cos(az));
      const dir = right.multiplyScalar(sx).addScaledVector(far, -sy).normalize();
      const angle = Math.min(1, length / TILT_FULL_PX) * MAX_TILT;
      onTilt(dir, angle);
      return;
    }
    if (mode === "camera" && pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      rig.rotate(-(mx - pinch.mx) * 0.007, -(my - pinch.my) * 0.005);
      if (distance > 10 && pinch.distance > 10) rig.zoom(pinch.distance / distance);
      pinch = { distance, mx, my };
    }
  }

  function up(event) {
    const p = pointers.get(event.pointerId);
    if (!p) return;
    swallow(event);
    pointers.delete(event.pointerId);
    if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (mode === "grab" && grabbed) {
      if (pointers.size) return; // a stray second finger lifted
      const tap = performance.now() - p.t0 < 260 && Math.hypot(p.x - p.x0, p.y - p.y0) < 10;
      onGrabEnd();
      if (tap) onTap(grabbed);
      grabbed = null;
    }
    if (mode === "tilt") onTilt(null, 0);
    if (!pointers.size) { mode = null; pinch = null; }
    else if (mode === "camera" && pointers.size === 1) pinch = null;
  }

  canvas.addEventListener("pointerdown", down, { capture: true });
  canvas.addEventListener("pointermove", move, { capture: true, passive: false });
  canvas.addEventListener("pointerup", up, { capture: true });
  canvas.addEventListener("pointercancel", up, { capture: true });
  canvas.addEventListener("wheel", (event) => { event.preventDefault(); rig.zoom(Math.exp(event.deltaY * 0.0012)); onInteract?.(); }, { passive: false });
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  // iOS Safari: block page pinch-zoom, double-tap zoom and the long-press callout.
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(type, (event) => event.preventDefault(), { passive: false });
  canvas.addEventListener("touchstart", (event) => event.preventDefault(), { passive: false });

  return {
    get grabbing() { return mode === "grab"; },
    cancel() { if (mode === "grab") onGrabEnd(); if (mode === "tilt") onTilt(null, 0); pointers.clear(); mode = null; grabbed = null; },
  };
}
