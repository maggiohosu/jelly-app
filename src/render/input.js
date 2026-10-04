// Touch/mouse routing between "grab the jelly" and the orbit camera.
//  - A press that lands on the jelly grabs it; the orbit controls never see it.
//  - While a grab is active every other pointer is swallowed, so a second finger
//    cannot start a rotation mid-drag.
//  - A press that misses the jelly goes to OrbitControls (1 finger rotate,
//    2 fingers pinch zoom). While the camera is orbiting, grabs are ignored.
import * as THREE from "three/webgpu";

export function createInput({ canvas, camera, controls, view, onGrabStart, onGrabMove, onGrabEnd, onInteract, isEnabled }) {
  let activePointer = null;
  let orbiting = false;
  const dragPlane = new THREE.Plane();
  const viewDirection = new THREE.Vector3();
  const point = new THREE.Vector3();

  controls.addEventListener("start", () => { orbiting = true; onInteract?.(); });
  controls.addEventListener("end", () => { orbiting = false; });

  function swallow(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function down(event) {
    if (activePointer !== null) { swallow(event); return; }
    if (!isEnabled() || orbiting || event.button !== 0 || !event.isPrimary) return;
    const hit = view.pick(event.clientX, event.clientY, canvas.getBoundingClientRect());
    if (!hit) return;
    swallow(event);
    activePointer = event.pointerId;
    canvas.setPointerCapture?.(activePointer);
    controls.enabled = false;
    camera.getWorldDirection(viewDirection);
    dragPlane.setFromNormalAndCoplanarPoint(viewDirection, point.fromArray(hit.point));
    onGrabStart(hit);
    onInteract?.();
  }

  function move(event) {
    if (activePointer === null) return;
    if (event.pointerId !== activePointer) { swallow(event); return; }
    swallow(event);
    if (view.rayToPlane(event.clientX, event.clientY, canvas.getBoundingClientRect(), dragPlane, point)) {
      onGrabMove(point.toArray());
    }
  }

  function up(event) {
    if (activePointer === null) return;
    if (event.pointerId !== activePointer) { swallow(event); return; }
    swallow(event);
    end();
  }

  function end() {
    if (activePointer === null) return;
    if (canvas.hasPointerCapture?.(activePointer)) canvas.releasePointerCapture(activePointer);
    activePointer = null;
    controls.enabled = true;
    onGrabEnd();
  }

  canvas.addEventListener("pointerdown", down, { capture: true });
  canvas.addEventListener("pointermove", move, { capture: true, passive: false });
  canvas.addEventListener("pointerup", up, { capture: true });
  canvas.addEventListener("pointercancel", up, { capture: true });
  canvas.addEventListener("lostpointercapture", (event) => { if (event.pointerId === activePointer) end(); });

  // iOS Safari: block page pinch-zoom, double-tap zoom and the long-press callout.
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(type, (event) => event.preventDefault(), { passive: false });
  }
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  canvas.addEventListener("touchstart", (event) => { if (event.touches.length > 1 || activePointer !== null) event.preventDefault(); }, { passive: false });

  return { get grabbing() { return activePointer !== null; }, cancel: end };
}
