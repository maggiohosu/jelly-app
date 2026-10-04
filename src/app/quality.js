// Quality tiers. iOS Safari does not expose the device model, so the tier is
// chosen from measured frame pacing (main thread) and physics load (worker).
// Physics stays at the original 240 Hz on every tier; it only drops to 160 Hz
// as an emergency when the worker cannot keep up (120 Hz sags the body).
export const TIERS = [
  { id: "high", label: "높음", maxDpr: 2.0, opticsHz: 24, causticHz: 60 },
  { id: "mid", label: "중간", maxDpr: 1.6, opticsHz: 15, causticHz: 30 },
  { id: "low", label: "낮음", maxDpr: 1.25, opticsHz: 10, causticHz: 15 },
];

export class QualityGovernor {
  constructor({ onTier, onPhysicsRate }) {
    this.onTier = onTier;
    this.onPhysicsRate = onPhysicsRate;
    this.index = 0;
    this.manual = null;
    this.intervals = [];
    this.baseline = 0;
    this.windowStart = 0;
    this.lastMedian = 0;
    this.physicsHz = 240;
    this.loadHigh = 0;
    this.cooldownUntil = 0;
  }

  get tier() { return TIERS[this.manual ?? this.index]; }
  get auto() { return this.manual === null; }

  setManual(id) {
    this.manual = id === "auto" ? null : TIERS.findIndex((t) => t.id === id);
    if (this.manual === -1) this.manual = null;
    this.intervals.length = 0;
    this.onTier(this.tier);
  }

  // Interval between two consecutive animated frames (ms). Evaluated in 1.5 s
  // windows. The fastest pacing is snapped to a display cap (120/60/30 Hz;
  // 30 Hz = iOS Low Power Mode) so a device that is slow from the very first
  // frame is still recognised as slow.
  sample(interval, now) {
    if (interval <= 0 || interval > 500) return;
    const list = this.intervals;
    if (!list.length) this.windowStart = now;
    list.push(interval);
    if (now - this.windowStart < 1500 || list.length < 12) return;
    const sorted = list.slice().sort((a, b) => a - b);
    const fast = sorted[Math.floor(sorted.length * 0.1)];
    const median = sorted[sorted.length >> 1];
    list.length = 0;
    const cap = [33.34, 16.67, 8.34].find((c) => fast >= c * 0.9) ?? 8.34;
    this.baseline = this.baseline ? Math.min(this.baseline, cap) : cap;
    this.lastMedian = median;
    if (!this.auto || now < this.cooldownUntil) return;
    if (median > this.baseline * 1.25 && this.index < TIERS.length - 1) {
      this.index += 1;
      this.cooldownUntil = now + 2500;
      this.onTier(this.tier);
    }
  }

  // stepMs: average physics step cost reported by the worker.
  physics(stepMs, now) {
    const load = stepMs * this.physicsHz / 1000;
    if (load > 0.85) this.loadHigh += 1; else this.loadHigh = 0;
    if (this.loadHigh > 90 && this.physicsHz > 160) {
      this.physicsHz = 160;
      this.loadHigh = 0;
      this.onPhysicsRate(160);
    }
  }
}
