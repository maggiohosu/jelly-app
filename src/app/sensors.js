// Device tilt → gravity vector, and shake → impulse.
// Reference pose: phone lying flat, screen up = straight-down gravity.
// Scene axes when the phone lies flat: screen right = +x, screen top = -z
// (far side of the tray), out of the screen = +y.
const G = 9.81;
const DEADZONE_DEG = 3;     // below this the original fixed gravity is used (lets the body sleep)
const MAX_TILT_DEG = 45;    // beyond this the body is squashed against the rim (see stability test)
const SLIPPERY_AT_DEG = 12; // friction blends to "wet tray" by this angle
const SHAKE_THRESHOLD = 13; // m/s² of user acceleration
const lerp = (a, b, t) => a + (b - a) * t;

export class MotionSensors {
  constructor({ onGravity, onShake }) {
    this.onGravity = onGravity;
    this.onShake = onShake;
    this.enabled = false;
    this.available = typeof window.DeviceOrientationEvent !== "undefined";
    this.smoothed = null;
    this.lastSent = null;
    this.lastShake = 0;
    this.receivedOrientation = false;
    this.handleOrientation = this.handleOrientation.bind(this);
    this.handleMotion = this.handleMotion.bind(this);
  }

  // Must be called synchronously from a tap handler on iOS.
  requestPermission() {
    const requests = [];
    if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function") {
      requests.push(DeviceMotionEvent.requestPermission());
    }
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
      requests.push(DeviceOrientationEvent.requestPermission());
    }
    if (!requests.length) return Promise.resolve(this.available ? "granted" : "unsupported");
    return Promise.all(requests)
      .then((results) => (results.every((r) => r === "granted") ? "granted" : "denied"))
      .catch(() => "denied");
  }

  start() {
    if (this.enabled) return;
    this.enabled = true;
    window.addEventListener("deviceorientation", this.handleOrientation);
    window.addEventListener("devicemotion", this.handleMotion);
  }

  stop() {
    if (!this.enabled) return;
    this.enabled = false;
    window.removeEventListener("deviceorientation", this.handleOrientation);
    window.removeEventListener("devicemotion", this.handleMotion);
    this.smoothed = null;
    this.emit(null, 0);
  }

  screenAngle() {
    const angle = screen.orientation?.angle ?? window.orientation ?? 0;
    return (Number(angle) || 0) * Math.PI / 180;
  }

  // Device-frame vector → scene vector, compensating for UI rotation.
  toScene(dx, dy, dz) {
    const a = this.screenAngle(), c = Math.cos(a), s = Math.sin(a);
    const sx = c * dx - s * dy, sy = s * dx + c * dy;
    return [sx, dz, -sy];
  }

  handleOrientation(event) {
    if (event.beta == null || event.gamma == null) return;
    this.receivedOrientation = true;
    const beta = event.beta * Math.PI / 180, gamma = event.gamma * Math.PI / 180;
    // Gravity direction in device coordinates for the W3C Z-X'-Y'' rotation.
    const g = this.toScene(Math.sin(gamma) * Math.cos(beta), -Math.sin(beta), -Math.cos(beta) * Math.cos(gamma));
    if (!this.smoothed) this.smoothed = g;
    else for (let i = 0; i < 3; i++) this.smoothed[i] = lerp(this.smoothed[i], g[i], 0.2);
    const [x, y, z] = this.smoothed;
    const horizontal = Math.hypot(x, z);
    let tilt = Math.atan2(horizontal, -y) * 180 / Math.PI;
    if (tilt < DEADZONE_DEG || horizontal < 1e-6) { this.emit(null, tilt); return; }
    tilt = Math.min(tilt, MAX_TILT_DEG);
    const t = tilt * Math.PI / 180, k = Math.sin(t) / horizontal;
    this.emit([x * k * G, -Math.cos(t) * G, z * k * G], tilt);
  }

  emit(vector, tilt) {
    const last = this.lastSent;
    if (!vector && last === null) return;
    if (vector && last && Math.hypot(vector[0] - last[0], vector[1] - last[1], vector[2] - last[2]) < 0.08) return;
    this.lastSent = vector ? vector.slice() : null;
    const blend = vector ? Math.min(1, Math.max(0, (tilt - DEADZONE_DEG) / (SLIPPERY_AT_DEG - DEADZONE_DEG))) : 0;
    const friction = vector ? { staticFriction: lerp(0.65, 0.12, blend), dynamicFriction: lerp(0.42, 0.08, blend) } : null;
    this.onGravity(vector, friction, tilt);
  }

  handleMotion(event) {
    const a = event.acceleration;
    if (!a || a.x == null) return;
    const magnitude = Math.hypot(a.x, a.y, a.z);
    const now = performance.now();
    if (magnitude < SHAKE_THRESHOLD || now - this.lastShake < 280) return;
    this.lastShake = now;
    const [x, , z] = this.toScene(a.x, a.y, a.z);
    const horizontal = Math.hypot(x, z) || 1;
    const speed = Math.min(0.38, 0.14 + (magnitude - SHAKE_THRESHOLD) * 0.018);
    // The tray accelerates one way; the jelly lags the other way and hops.
    this.onShake([-x / horizontal * speed, 0.16 + speed * 0.5, -z / horizontal * speed], magnitude);
  }
}
