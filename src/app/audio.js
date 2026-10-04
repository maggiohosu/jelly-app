// Synthesised jelly sounds (no audio files). iOS rules:
//  - the AudioContext must be created/resumed inside a user gesture (unlock()),
//  - 'ambient' audio session mixes with the user's music and respects the
//    ringer switch, so the app never pauses Melon/Spotify.
export class JellyAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.lastPlay = 0;
    this.noise = null;
  }

  unlock() {
    try {
      if (navigator.audioSession) navigator.audioSession.type = "ambient";
    } catch { /* older Safari */ }
    if (!this.ctx) {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) return;
      this.ctx = new Context({ latencyHint: "interactive" });
      const compressor = this.ctx.createDynamicsCompressor();
      compressor.threshold.value = -18; compressor.ratio.value = 6;
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(compressor).connect(this.ctx.destination);
      const length = Math.floor(this.ctx.sampleRate * 0.25);
      this.noise = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
      // A silent blip inside the gesture fully unlocks output on iOS.
      const blip = this.ctx.createBufferSource();
      blip.buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
      blip.connect(this.ctx.destination);
      blip.start();
    }
    if (this.ctx.state !== "running") this.ctx.resume().catch(() => {});
  }

  suspend() { this.ctx?.suspend().catch(() => {}); }
  resume() { if (this.ctx && this.enabled) this.ctx.resume().catch(() => {}); }

  setEnabled(on) {
    this.enabled = on;
    if (!this.ctx) return;
    if (on) this.ctx.resume().catch(() => {}); else this.ctx.suspend().catch(() => {});
  }

  // strength 0..1, pitch ~0.8..1.2 (flavour), kind: 'drop' | 'bump' | 'snap'
  boing(strength, pitch = 1, kind = "drop") {
    const ctx = this.ctx;
    if (!ctx || !this.enabled || ctx.state !== "running") return;
    const now = ctx.currentTime;
    if (now - this.lastPlay < 0.09) return;
    this.lastPlay = now;
    const s = Math.max(0.05, Math.min(1, strength));
    const base = (kind === "bump" ? 150 : kind === "snap" ? 260 : 190) * pitch;
    const duration = kind === "snap" ? 0.32 : 0.42;

    // Pitch-gliding sine with a fast vibrato: the "boing".
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(base * (1.35 + 0.4 * s), now);
    osc.frequency.exponentialRampToValueAtTime(base * 0.62, now + duration);
    const lfo = ctx.createOscillator();
    lfo.frequency.setValueAtTime(13, now);
    lfo.frequency.linearRampToValueAtTime(7, now + duration);
    const lfoGain = ctx.createGain();
    lfoGain.gain.setValueAtTime(base * 0.09, now);
    lfoGain.gain.exponentialRampToValueAtTime(1, now + duration);
    lfo.connect(lfoGain).connect(osc.frequency);
    const env = ctx.createGain();
    const peak = (kind === "bump" ? 0.16 : 0.28) * s;
    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(peak, now + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass"; tone.frequency.value = 1400; tone.Q.value = 2;
    osc.connect(tone).connect(env).connect(this.master);

    // A short wet "squelch" on top.
    const noise = ctx.createBufferSource();
    noise.buffer = this.noise;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass"; band.frequency.value = 700 * pitch; band.Q.value = 1.4;
    const noiseEnv = ctx.createGain();
    noiseEnv.gain.setValueAtTime(0.0001, now);
    noiseEnv.gain.exponentialRampToValueAtTime(0.09 * s, now + 0.006);
    noiseEnv.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);
    noise.connect(band).connect(noiseEnv).connect(this.master);

    osc.start(now); lfo.start(now); noise.start(now);
    osc.stop(now + duration + 0.02); lfo.stop(now + duration + 0.02); noise.stop(now + 0.1);
  }
}
