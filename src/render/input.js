// Touch routing.
//  each finger on the jelly     → its own grab (up to 3: pull it several ways);
//                                 tap pokes, double-tap bounces, an upward flick launches it
//  one finger on empty space   → tilt the tray toward the finger; springs back on release
//  two fingers on empty space  → orbit (drag) + pinch zoom
//  mouse: wheel zoom, right-drag orbit (desktop testing)
import * as THREE from "three/webgpu";

const MAX_TILT = THREE.MathUtils.degToRad(22);
const TILT_FULL_PX = 170;

export function createInput({ canvas, stage, view, onGrabStart, onGrabMove, onGrabEnd, onTap, onDoubleTap, onTilt, onInteract, isEnabled }) {
  const { camera, rig, tray } = stage;
  const pointers = new Map(); // id → {x, y, x0, y0, t0, kind: 'grab'|'space'|'mouse-orbit'}
  const grabs = new Map();    // id → {hit, plane, samples:[[t, y]]}
  let mode = null;            // null | 'tilt' | 'camera' (empty-space fingers only)
  let lastTap = null;         // {t, x, y} for double-tap
  const viewDirection = new THREE.Vector3(), hitPoint = new THREE.Vector3();
  const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let pinch = null;
  function ray(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    return raycaster.ray;
  }
  const spaceFingers = () => [...pointers.values()].filter((p) => p.kind === "space");

  function swallow(event) { event.preventDefault(); event.stopImmediatePropagation(); }

  function down(event) {
    if (!isEnabled()) return;
    swallow(event);
    canvas.setPointerCapture?.(event.pointerId);
    const p = { x: event.clientX, y: event.clientY, x0: event.clientX, y0: event.clientY, t0: performance.now(), kind: "space" };
    pointers.set(event.pointerId, p);
    onInteract?.();
    if (event.pointerType === "mouse" && event.button === 2) { p.kind = "mouse-orbit"; return; }
    // Each finger that lands on the jelly is its own grab (up to 3) — pull it several ways.
    if (mode !== "camera" && grabs.size < 3) {
      const hit = view.pick(event.clientX, event.clientY, canvas.getBoundingClientRect());
      if (hit) {
        if (mode === "tilt") { onTilt(null, 0); mode = null; for (const q of pointers.values()) if (q.kind === "space") q.kind = "idle"; }
        p.kind = "grab";
        camera.getWorldDirection(viewDirection);
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(viewDirection, hit.worldPoint);
        grabs.set(event.pointerId, { hit, plane, samples: [[p.t0, hit.point[1]]] });
        onGrabStart(event.pointerId, hit);
        return;
      }
    }
    if (grabs.size) { p.kind = "idle"; return; } // empty-space finger while holding the jelly
    const space = spaceFingers();
    if (space.length === 2) {
      if (mode === "tilt") onTilt(null, 0);
      mode = "camera";
      const [a, b] = space;
      pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    } else if (space.length === 1 && !mode) mode = "tilt";
    else p.kind = "idle";
  }

  function move(event) {
    const p = pointers.get(event.pointerId);
    if (!p) return;
    swallow(event);
    const dx = event.clientX - p.x, dy = event.clientY - p.y;
    p.x = event.clientX; p.y = event.clientY;
    if (p.kind === "mouse-orbit") { rig.rotate(-dx * 0.006, -dy * 0.005); return; }
    if (p.kind === "grab") {
      const g = grabs.get(event.pointerId);
      if (g && ray(event.clientX, event.clientY).intersectPlane(g.plane, hitPoint)) {
        const local = tray.worldToLocal(hitPoint.clone()).toArray();
        g.samples.push([performance.now(), local[1]]);
        if (g.samples.length > 8) g.samples.shift();
        onGrabMove(event.pointerId, local);
      }
      return;
    }
    if (p.kind !== "space") return;
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
    const space = spaceFingers();
    if (mode === "camera" && space.length === 2 && pinch) {
      const [a, b] = space;
      const distance = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      rig.rotate(-(mx - pinch.mx) * 0.007, -(my - pinch.my) * 0.005);
      if (distance > 10 && pinch.distance > 10) rig.zoom(pinch.distance / distance);
      pinch = { distance, mx, my };
    }
  }

  // Upward finger speed (m/s, tray space) over the last ~90 ms of the drag.
  function flickSpeed(samples) {
    const now = performance.now(), recent = samples.filter(([t]) => now - t < 90);
    if (recent.length < 2) return 0;
    const [t0, y0] = recent[0], [t1, y1] = recent[recent.length - 1];
    return t1 > t0 ? (y1 - y0) / ((t1 - t0) / 1000) : 0;
  }

  function up(event) {
    const p = pointers.get(event.pointerId);
    if (!p) return;
    swallow(event);
    pointers.delete(event.pointerId);
    if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (p.kind === "grab") {
      const g = grabs.get(event.pointerId);
      grabs.delete(event.pointerId);
      const now = performance.now();
      const tap = now - p.t0 < 260 && Math.hypot(p.x - p.x0, p.y - p.y0) < 10;
      onGrabEnd(event.pointerId, tap ? 0 : Math.max(0, flickSpeed(g.samples)));
      if (tap) {
        if (lastTap && now - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 40) { lastTap = null; onDoubleTap?.(g.hit); }
        else { lastTap = { t: now, x: p.x, y: p.y }; onTap(g.hit); }
      }
    } else if (p.kind === "space") {
      if (mode === "tilt") { onTilt(null, 0); mode = null; }
      else if (mode === "camera") { pinch = null; if (spaceFingers().length === 0) mode = null; }
    }
    if (!pointers.size) { mode = null; pinch = null; }
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
    get grabbing() { return grabs.size > 0; },
    cancel() { for (const id of grabs.keys()) onGrabEnd(id, 0); grabs.clear(); if (mode === "tilt") onTilt(null, 0); pointers.clear(); mode = null; pinch = null; },
  };
}
