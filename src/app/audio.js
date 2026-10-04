// 말랑젤리 sound engine. Everything is synthesised with plain Web Audio nodes
// (no audio files, no AudioWorklet, no libraries):
//   • crunch         crunchy-slime ASMR: bead snaps (뽀득), sticky stretches (쩍)
//                    and air pops (뽁); setActivity() drives the bead crunching
//   • boing()/drip() the jelly squish and paint drops
//   • clink()        glassy gem "ting"s (C-major pentatonic, C6–C7)
//
// iOS rules: the AudioContext must be created/resumed synchronously inside a
// user gesture (unlock()); the 'ambient' audio session mixes with the user's
// music (Melon/Spotify keep playing) and respects the ringer switch.
//
// Signal graph (volumes are linear gains; each bus is unity at its default):
//   boing voices  → boingBus (master·boing/0.6) → legacy compressor ─────┐
//   crunch grains → crunchBus (crunch/0.8) → tone LP ─┬─→ musicIn (master) ┤
//   gem voices    → gemBus  (gems/0.6) ───────────────┤        ↑          │
//                   sends ─→ room (short generated convolver)            │
//                                 limiter (-4 dB, 20:1) ←────────────────┘ → make-up trim → out
//
// Offline rendering (tests): give the engine an OfflineAudioContext. Its clock
// is then virtual: call advanceTo(t) once per simulated frame (it runs the
// lookahead scheduler), then setActivity()/clink()/boing() as the app would,
// and finally startRendering(). onNote callbacks fire synchronously at
// scheduling time in that mode (event.time is the audio time of the crunch).
//   const off = new OfflineAudioContext(2, 12 * 48000, 48000);
//   const audio = new JellyAudio({ context: off, random: seededRng });
//   for (let f = 0; f <= 12 * 60; f++) { audio.advanceTo(f / 60); audio.setActivity(a, r); }
//   const buffer = await off.startRendering();
// or: const { buffer, audio } = await JellyAudio.renderOffline(12, (audio, t) => { ... }, { random });

const LOOKAHEAD = 0.12;            // s of audio scheduled ahead of the clock
const TICK_MS = 25;                // scheduler interval
const GRAIN_VOICES = 28;
const GEM_VOICES = 6;
const ACT_ON = 0.06, ACT_OFF = 0.04;          // start / stop thresholds (hysteresis)
const ATTACK_TAU = 0.05;           // activity rises to ~95 % in 0.15 s
const RELEASE_TAU = 0.4;           // and falls to ~5 % in 1.2 s
const REGISTER_TAU = 0.35;
const STALE_INPUT = 0.5;           // no setActivity() for this long → treat as 0
const CLINK_GAP = 0.045, CLINK_RATE = 10, CLINK_BURST = 3;
const LIMIT_DB = -4, LIMIT_RATIO = 20;
// DynamicsCompressorNode adds automatic make-up gain ((1/fullRangeGain)^0.6,
// same kernel in WebKit and Chromium); undo it so quiet signals pass at unity
// and the ceiling ends up near -3.8 dBFS.
const LIMITER_MAKEUP = Math.pow(10, (-LIMIT_DB * (1 - 1 / LIMIT_RATIO) * 0.6) / 20);
const LIMITER_DELAY = 0.006;       // compressor look-ahead (for onNote alignment)
const DEFAULT_VOLUMES = Object.freeze({ master: 0.9, crunch: 0.8, gems: 0.6, boing: 0.6 });
const CRUNCH_LEVEL = 0.32;          // peak of a velocity-1 grain before the bus

const PENTA = [0, 2, 4, 7, 9];     // C D E G A
// Gem pitches: C-major pentatonic from C6 (84) to C7 (96).
const CLINK_PITCHES = [];
for (let m = 84; m <= 96; m++) if (PENTA.includes(m % 12)) CLINK_PITCHES.push(m);

const GEM_LEVEL = 0.13;              // gems sit just under the piano
const GEM_RATIOS = [1, 2.76, 5.40, 8.93];
const GEM_LEVELS = [1, 0.5, 0.28, 0.14];
const GEM_TAUS = [0.2, 0.075, 0.035, 0.018];

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
function hash32(x) {
  x |= 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

export class JellyAudio {
  /**
   * @param {{ context?: BaseAudioContext, random?: () => number }} [options]
   *   context: render into this context (e.g. an OfflineAudioContext for tests)
   *            instead of creating one in unlock().
   *   random:  RNG for the improviser / room (seed it for reproducible renders).
   */
  constructor(options = {}) {
    this.ctx = null;
    this.master = null;            // boing input (the old master gain)
    this.enabled = true;
    this.lastPlay = 0;
    this.noise = null;
    this._random = typeof options.random === "function" ? options.random : Math.random;
    this._vol = { ...DEFAULT_VOLUMES };
    this._listeners = [];
    this._gen = 0;                 // bumped on suspend/dispose: drops pending onNote timers
    this._timer = 0;
    this._tickBound = () => this._tick();
    this._offline = false;
    this._ownsContext = true;
    this._vt = 0;                  // virtual clock (offline)
    // activity / register smoothing
    this._actTarget = 0; this._regTarget = 0.5;
    this._act = 0; this._reg = 0.5;
    this._actStamp = -1e9; this._smoothT = NaN;
    // crunch
    this.texture = "jelly";
    this._crunchOn = false; this._nextBurst = 0; this._lastPulse = -1e9;
    this._lastSquelch = -1e9; this._lastPop = -1e9;
    this._banks = null;
    this._grains = [];
    // voices
    this._gems = [];
    this._clinkTokens = CLINK_BURST; this._clinkTokT = 0;
    this._lastClink = -1e9; this._lastClinkMidi = -1;
    this.stats = { bursts: 0, grains: 0, grainDrops: 0, maxGrains: 0, clinks: 0, gemSteals: 0, maxGemVoices: 0, oscSeconds: 0 };
    if (options.context) {
      this.ctx = options.context;
      this._ownsContext = false;
      this._offline = typeof options.context.startRendering === "function";
      this._build(true);
    }
  }

  static get VOICE_LIMITS() { return { grains: GRAIN_VOICES, gems: GEM_VOICES }; }
  static get DEFAULT_VOLUMES() { return DEFAULT_VOLUMES; }

  /** Render `seconds` offline; `script(audio, t)` runs once per frame (fps). */
  static async renderOffline(seconds, script, { sampleRate = 48000, channels = 2, fps = 60, random, setup } = {}) {
    const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    const ctx = new Offline(channels, Math.ceil(seconds * sampleRate), sampleRate);
    const audio = new JellyAudio({ context: ctx, random });
    if (setup) setup(audio);
    const frames = Math.floor(seconds * fps);
    for (let f = 0; f <= frames; f++) {
      const t = f / fps;
      audio.advanceTo(t);
      if (script) script(audio, t);
    }
    const buffer = await ctx.startRendering();
    return { buffer, audio };
  }

  // ---------------------------------------------------------------- lifecycle

  // Call from inside every user gesture (pointerdown/touchend/click). Cheap when
  // already running. iOS home-screen apps come back from the background with the
  // context 'interrupted' or 'suspended', and only a gesture may resume it; if a
  // couple of gestures fail, the context is rebuilt from scratch.
  unlock() {
    try {
      if (navigator.audioSession && navigator.audioSession.type !== "ambient") navigator.audioSession.type = "ambient";
    } catch { /* older Safari */ }
    if (this._offline) return;
    if (this.ctx && (this.ctx.state === "closed" || (this.ctx.state !== "running" && (this._failedUnlocks || 0) >= 2))) this._rebuildContext();
    if (!this.ctx) {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) return;
      this.ctx = new Context({ latencyHint: "interactive" });
      this._ownsContext = true;
      this._build(false);
      this._failedUnlocks = 0;
    }
    if (this.ctx.state === "running") { this._failedUnlocks = 0; if (this.enabled) this._startTimer(); return; }
    // A silent blip inside the gesture fully unlocks output on iOS.
    try {
      const blip = this.ctx.createBufferSource();
      blip.buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
      blip.connect(this.ctx.destination);
      blip.start();
    } catch { /* closed */ }
    const ctx = this.ctx;
    ctx.resume().then(() => { if (ctx.state === "running") this._failedUnlocks = 0; }).catch(() => {});
    this._failedUnlocks = (this._failedUnlocks || 0) + 1;
    if (this.enabled) this._startTimer();
  }

  get running() { return Boolean(this.ctx && this.ctx.state === "running"); }

  _rebuildContext() {
    this._stopTimer();
    this._gen++;
    const ctx = this.ctx;
    for (const list of [this._gems]) {
      for (const v of list) for (const o of v.oscs) { try { o.stop(); } catch { /* not started */ } }
      list.length = 0;
    }
    try { this._out?.disconnect(); } catch { /* already */ }
    try { ctx?.close?.().catch(() => {}); } catch { /* closed */ }
    this.ctx = null;
    this.master = null;
  }

  suspend() {
    this._stopTimer();
    this._gen++;
    if (!this._offline) this.ctx?.suspend().catch(() => {});
  }

  resume() {
    if (this.ctx && this.enabled && !this._offline) {
      this.ctx.resume().catch(() => {});
      this._startTimer();
    }
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!this.ctx || this._offline) return;
    if (this.enabled) { this.ctx.resume().catch(() => {}); this._startTimer(); }
    else { this._stopTimer(); this._gen++; this.ctx.suspend().catch(() => {}); }
  }

  dispose() {
    this._stopTimer();
    this._gen++;
    this._listeners.length = 0;
    const ctx = this.ctx;
    if (ctx) {
      for (const list of [this._gems]) {
        for (const v of list) for (const o of v.oscs) { try { o.stop(); } catch { /* not started */ } }
        list.length = 0;
      }
      try { this._out.disconnect(); } catch { /* already */ }
      if (this._ownsContext && ctx.close) ctx.close().catch(() => {});
    }
    this.ctx = null;
    this.master = null;
  }

  // ------------------------------------------------------------------ controls

  /** Each 0..1 (linear gain; defaults master 0.9, crunch 0.8, gems 0.6, boing 0.6). */
  setVolumes(volumes = {}) {
    for (const key in DEFAULT_VOLUMES) {
      const v = volumes[key];
      if (typeof v === "number" && v === v) this._vol[key] = clamp(v, 0, 1);
    }
    this._applyVolumes(false);
  }

  get volumes() { return { ...this._vol }; }

  /** Called every frame: activity 0..1 (movement/stretch), register 0 low … 1 high. */
  setActivity(activity, register) {
    const a = +activity;
    this._actTarget = a > 0 ? (a < 1 ? a : 1) : 0;
    const r = +register;
    if (r === r) this._regTarget = r > 0 ? (r < 1 ? r : 1) : 0;
    const now = this._wall();
    this._actStamp = now;
    this._smooth(now);
  }

  /** 'jelly' (bright, crisp) or 'slime' (low, wet, more crunch). */
  setTexture(texture) {
    this.texture = texture === "slime" ? "slime" : "jelly";
    this._applyTexture();
  }

  _applyTexture() {
    if (!this._crunchTone) return;
    const f = this.texture === "slime" ? 5200 : 9000;
    if (this._offline) this._crunchTone.frequency.value = f;
    else this._crunchTone.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.05);
  }

  /** Smoothed activity (what the crunch scheduler is using). */
  get activity() { return this._act; }

  /** callback({ velocity, time }) when a crunch burst sounds (for visual pulses). Returns an unsubscribe fn. */
  onNote(callback) {
    if (typeof callback !== "function") return () => {};
    this._listeners.push(callback);
    return () => {
      const i = this._listeners.indexOf(callback);
      if (i >= 0) this._listeners.splice(i, 1);
    };
  }

  /** Offline contexts only: move the virtual clock to t and run the scheduler. */
  advanceTo(t) {
    if (!this._offline) return;
    if (t > this._vt) this._vt = t;
    this._tick();
  }

  // --------------------------------------------------------------- jelly boing

  // strength 0..1, pitch ~0.8..1.2 (flavour), kind: 'drop' | 'bump' | 'snap'
  boing(strength, pitch = 1, kind = "drop") {
    const ctx = this.ctx;
    if (!ctx || !this.enabled || (!this._offline && ctx.state !== "running")) return;
    const now = this._now();
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

  /**
   * Pipette drop landing on the jelly: a short water "plip" (fast upward
   * pitch sweep + a soft low bloop), on the effects bus with the boing volume.
   */
  drip(strength = 0.6, pitch = 1) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled || (!this._offline && ctx.state !== "running")) return;
    const now = this._now();
    if (now - (this._lastDrip || -1) < 0.05) return;
    this._lastDrip = now;
    const s = Math.max(0.05, Math.min(1, strength));
    const f0 = 520 * pitch * (0.92 + 0.16 * Math.random());
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(f0, now);
    osc.frequency.exponentialRampToValueAtTime(f0 * 2.6, now + 0.028);
    osc.frequency.exponentialRampToValueAtTime(f0 * 2.1, now + 0.09);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(0.22 * s, now + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);
    osc.connect(env).connect(this.master);
    const bloop = ctx.createOscillator();
    bloop.type = "sine";
    bloop.frequency.setValueAtTime(f0 * 0.42, now + 0.01);
    bloop.frequency.exponentialRampToValueAtTime(f0 * 0.3, now + 0.16);
    const bloopEnv = ctx.createGain();
    bloopEnv.gain.setValueAtTime(0.0001, now);
    bloopEnv.gain.exponentialRampToValueAtTime(0.1 * s, now + 0.02);
    bloopEnv.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    bloop.connect(bloopEnv).connect(this.master);
    osc.start(now); bloop.start(now);
    osc.stop(now + 0.13); bloop.stop(now + 0.2);
  }

  // ------------------------------------------------------------------ gem clink

  /**
   * Gem collision. Rate-limited (≥ 45 ms apart, ~10/s sustained). Pitched to
   * the C-major pentatonic, C6–C7. Returns the MIDI note played,
   * or -1 when dropped (rate limit, too soft, not running).
   */
  clink(strength, seed = 0) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled || (!this._offline && ctx.state !== "running")) return -1;
    const s = clamp(+strength || 0, 0, 1);
    if (s < 0.03) return -1;
    const now = this._now();
    this._clinkTokens = Math.min(CLINK_BURST, this._clinkTokens + (now - this._clinkTokT) * CLINK_RATE);
    this._clinkTokT = now;
    if (now - this._lastClink < CLINK_GAP || this._clinkTokens < 1) return -1;
    this._clinkTokens -= 1;
    this._lastClink = now;
    const pitches = CLINK_PITCHES;
    const h = hash32((seed | 0) ^ 0x5bd1e995);
    let i = h % pitches.length;
    if (pitches[i] === this._lastClinkMidi) i = (i + 1 + ((h >>> 8) & 1)) % pitches.length;
    const midi = pitches[i];
    this._lastClinkMidi = midi;
    this._gemNote(midi, s, now + 0.002, h);
    this.stats.clinks++;
    return midi;
  }

  // ======================================================================
  // internals

  _now() { return this._offline ? this._vt : this.ctx.currentTime; }
  _wall() { return this._offline ? this._vt : performance.now() / 1000; }

  _startTimer() {
    if (!this._timer && !this._offline && this.ctx) this._timer = setInterval(this._tickBound, TICK_MS);
  }

  _stopTimer() {
    if (this._timer) { clearInterval(this._timer); this._timer = 0; }
  }

  _build(sync) {
    const ctx = this.ctx;
    // Boing path: identical to the old graph (gain → compressor).
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18; compressor.ratio.value = 6;
    this.master = ctx.createGain();
    const length = Math.floor(ctx.sampleRate * 0.25);
    this.noise = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;

    // Output: brick-wall-ish limiter + make-up compensation.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = LIMIT_DB; limiter.knee.value = 0; limiter.ratio.value = LIMIT_RATIO;
    limiter.attack.value = 0.001; limiter.release.value = 0.1;
    this._out = ctx.createGain();
    this._out.gain.value = 1 / LIMITER_MAKEUP;
    limiter.connect(this._out).connect(ctx.destination);
    this.master.connect(compressor).connect(limiter);

    // Crunch + gems (+ room) → master gain → limiter.
    this._musicIn = ctx.createGain();
    this._musicIn.connect(limiter);
    this._crunchBus = ctx.createGain();
    this._crunchTone = ctx.createBiquadFilter();
    this._crunchTone.type = "lowpass"; this._crunchTone.Q.value = 0.5;
    this._crunchBus.connect(this._crunchTone).connect(this._musicIn);
    this._applyTexture();
    this._gemBus = ctx.createGain();
    this._gemBus.connect(this._musicIn);
    this._room = ctx.createConvolver();
    const roomOut = ctx.createGain(); roomOut.gain.value = 1;
    this._room.connect(roomOut).connect(this._musicIn);
    const crunchSend = ctx.createGain(); crunchSend.gain.value = 0.22;  // a touch of room
    this._crunchTone.connect(crunchSend).connect(this._room);
    const gemSend = ctx.createGain(); gemSend.gain.value = 0.55;      // wet ≈ -13 dB
    this._gemBus.connect(gemSend).connect(this._room);
    // ~1 ms of maths: keep it out of the tap handler on a live context.
    this._grains.length = 0; this._banks = null;
    if (sync) { this._room.buffer = this._impulse(1.1); this._makeBanks(); }
    else setTimeout(() => { if (this.ctx === ctx) { this._room.buffer = this._impulse(1.1); this._makeBanks(); } }, 0);
    this._applyVolumes(true);
  }

  // Short stereo "room": decaying, progressively darker noise + early reflections.
  _impulse(seconds) {
    const ctx = this.ctx, sr = ctx.sampleRate;
    const len = Math.max(1, Math.floor(sr * seconds));
    const buffer = ctx.createBuffer(2, len, sr);
    const rnd = this._random;
    const pre = Math.floor(sr * 0.011);
    for (let ch = 0; ch < 2; ch++) {
      const d = buffer.getChannelData(ch);
      let y = 0;
      for (let i = pre; i < len; i++) {
        const t = (i - pre) / sr;
        const c = 0.2 + 0.72 * (i / len);
        y += (1 - c) * (rnd() * 2 - 1 - y);
        d[i] = y * Math.exp(-t / 0.2) * (t < 0.004 ? t / 0.004 : 1);
      }
      const taps = ch ? [0.0137, 0.0211, 0.0297, 0.0389] : [0.0119, 0.0183, 0.0263, 0.0421];
      for (let k = 0; k < taps.length; k++) {
        const i = Math.floor(taps[k] * sr);
        if (i < len) d[i] += (0.5 - k * 0.09) * (k & 1 ? -1 : 1);
      }
    }
    return buffer;
  }

  _applyVolumes(immediate) {
    if (!this.ctx || !this.master) return;
    const { master, crunch, gems, boing } = this._vol;
    const now = this._now();
    const set = (param, value) => {
      if (immediate) param.value = value;
      else param.setTargetAtTime(value, now, 0.02);
    };
    set(this.master.gain, master * boing / DEFAULT_VOLUMES.boing);
    set(this._musicIn.gain, master);
    set(this._crunchBus.gain, crunch / DEFAULT_VOLUMES.crunch);
    set(this._gemBus.gain, gems / DEFAULT_VOLUMES.gems);
  }

  _smooth(now) {
    let dt = now - this._smoothT;
    this._smoothT = now;
    if (!(dt > 0)) return;
    if (dt > 0.25) dt = 0.25;
    const target = now - this._actStamp > STALE_INPUT ? 0 : this._actTarget;
    const tau = target > this._act ? ATTACK_TAU : RELEASE_TAU;
    this._act += (target - this._act) * (1 - Math.exp(-dt / tau));
    this._reg += (this._regTarget - this._reg) * (1 - Math.exp(-dt / REGISTER_TAU));
  }

  // ------------------------------------------------------------ scheduler

  // ------------------------------------------------------------ crunch scheduler
  //
  // Crunchy-slime ASMR, three sounds from small generated sample banks
  // (built once per context; playback is one BufferSource per grain):
  //   beads   뽀득·톡  foam beads snapping under pressure — bursts of 1–6
  //                    grains whose rate and loudness follow setActivity()
  //   squelch 쩍·찍    sticky stretch: a decelerating train of wet micro-clicks
  //   pop     뽁       an air pocket popping when a finger lets go
  // texture 'jelly' plays them brighter and crisper, 'slime' lower and wetter.

  _tick() {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!this._offline && ctx.state !== "running") return;
    const now = this._now();
    this._smooth(this._wall());
    this._crunchTick(now, now + LOOKAHEAD);
  }

  _crunchTick(now, horizon) {
    const a = this._act;
    if (this._crunchOn ? a < ACT_OFF : a >= ACT_ON) this._crunchOn = !this._crunchOn;
    if (!this._crunchOn || !this._banks) { this._nextBurst = 0; return; }
    const slime = this.texture === "slime";
    const rate = (slime ? 3 : 4) + (slime ? 30 : 40) * Math.pow(a, 1.3);   // bursts per second
    const rnd = this._random;
    if (this._nextBurst < now - 0.03) this._nextBurst = now + 0.004 - Math.log(1 - rnd() * 0.999) / rate;
    while (this._nextBurst < horizon) {
      this._burst(this._nextBurst, a);
      this._nextBurst += -Math.log(1 - rnd() * 0.999) / rate;
    }
  }

  // One crunch: a cluster of bead snaps a few ms apart, decaying.
  _burst(t, a, boost = 1) {
    const rnd = this._random, slime = this.texture === "slime";
    const n = 1 + Math.floor(rnd() * (1.5 + (slime ? 5 : 3.5) * a));
    let v = clamp((0.3 + 0.7 * a) * (0.55 + 0.45 * rnd()) * boost, 0, 1.4);
    for (let k = 0; k < n; k++) {
      this._grain(this._banks.beads, t, v, slime ? 0.78 : 1.12);
      t += 0.003 + rnd() * (slime ? 0.016 : 0.011);
      v *= 0.62 + 0.3 * rnd();
    }
    this.stats.bursts++;
    if (t - this._lastPulse > 0.11) { this._lastPulse = t; this._emitNote(0, clamp(v * 1.6, 0, 1), 0, t); }
  }

  _grain(bank, t, velocity, rate) {
    const ctx = this.ctx, rnd = this._random;
    const live = this._grains;
    while (live.length && live[0] <= t) live.shift();
    if (live.length >= GRAIN_VOICES) { this.stats.grainDrops++; return; }
    const buffer = bank[Math.floor(rnd() * bank.length)];
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const r = rate * (0.88 + 0.24 * rnd());
    src.playbackRate.value = r;
    const g = ctx.createGain();
    g.gain.value = CRUNCH_LEVEL * velocity;
    src.connect(g);
    const nodes = [src, g];
    if (ctx.createStereoPanner) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = (rnd() - 0.5) * 0.8;
      g.connect(pan); pan.connect(this._crunchBus); nodes.push(pan);
    } else g.connect(this._crunchBus);
    src.onended = () => { for (const node of nodes) { try { node.disconnect(); } catch { /* gone */ } } };
    src.start(t);
    const end = t + buffer.duration / r;
    let i = live.length;
    while (i > 0 && live[i - 1] > end) i--;
    live.splice(i, 0, end);
    this.stats.grains++;
    if (live.length > this.stats.maxGrains) this.stats.maxGrains = live.length;
  }

  /** A crunch burst right now (pressing in, a gem landing). strength 0..1. */
  crunch(strength = 0.7) {
    if (!this._ready()) return;
    const s = clamp(+strength || 0, 0, 1);
    if (s < 0.03) return;
    this._burst(this._now() + 0.002, s, 1.15);
  }

  /** Sticky stretch '쩍'. Rate-limited (≥ 0.14 s apart). strength 0..1. */
  squelch(strength = 0.6) {
    if (!this._ready()) return;
    const now = this._now();
    if (now - this._lastSquelch < 0.14) return;
    const s = clamp(+strength || 0, 0, 1);
    if (s < 0.05) return;
    this._lastSquelch = now;
    const slime = this.texture === "slime";
    this._grain(this._banks.squelch, now + 0.002, (0.45 + 0.6 * s) * (slime ? 1.15 : 0.8), slime ? 0.82 : 1.15);
  }

  /** Air pocket '뽁' (finger let go). strength 0..1. */
  pop(strength = 0.6) {
    if (!this._ready()) return;
    const now = this._now();
    if (now - this._lastPop < 0.08) return;
    this._lastPop = now;
    const s = clamp(+strength || 0, 0, 1);
    const slime = this.texture === "slime";
    this._grain(this._banks.pop, now + 0.002, 0.5 + 0.6 * s, (slime ? 0.8 : 1.1) * (0.9 + 0.3 * s));
  }

  _ready() {
    const ctx = this.ctx;
    return Boolean(ctx && this.enabled && this._banks && (this._offline || ctx.state === "running"));
  }

  // ------------------------------------------------------------ sample banks

  _makeBanks() {
    const ctx = this.ctx, sr = ctx.sampleRate, rnd = this._random;
    const make = (seconds, fill) => {
      const len = Math.max(1, Math.floor(seconds * sr));
      const buffer = ctx.createBuffer(1, len, sr), d = buffer.getChannelData(0);
      fill(d, len);
      let peak = 0;
      for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
      if (peak > 0) for (let i = 0; i < len; i++) d[i] /= peak;
      for (let i = Math.max(0, len - 64); i < len; i++) d[i] *= (len - i) / 64;   // no end click
      return buffer;
    };
    const TAU = Math.PI * 2;
    // Bead snap: a hard noise transient, two bright resonances of the bead
    // shell and a soft low "thud" of the wet matrix around it; some beads crack twice.
    const beads = [];
    for (let k = 0; k < 28; k++) {
      const f1 = 1500 + rnd() * 3800, f2 = f1 * (1.45 + rnd() * 0.9), f3 = 220 + rnd() * 420;
      const t1 = 0.0018 + rnd() * 0.0045, t2 = 0.001 + rnd() * 0.002, t3 = 0.004 + rnd() * 0.007, tn = 0.0005 + rnd() * 0.0012;
      const wet = 0.2 + rnd() * 0.7, p1 = rnd() * TAU, p2 = rnd() * TAU;
      const second = rnd() < 0.4 ? 0.002 + rnd() * 0.005 : -1, a2 = 0.35 + rnd() * 0.4;
      beads.push(make(0.034, (d, len) => {
        let lp = 0;
        const snap = (t) => (t < 0 ? 0 : Math.min(1, t / 0.00015));
        for (let i = 0; i < len; i++) {
          const t = i / sr, n = rnd() * 2 - 1;
          lp += 0.35 * (n - lp);
          const hp = n - lp;
          let y = hp * Math.exp(-t / tn) + 0.55 * Math.sin(TAU * f1 * t + p1) * Math.exp(-t / t1)
            + 0.3 * Math.sin(TAU * f2 * t + p2) * Math.exp(-t / t2) + wet * 0.6 * Math.sin(TAU * f3 * t) * Math.exp(-t / t3);
          y *= snap(t);
          if (second > 0 && t >= second) {
            const u = t - second;
            y += a2 * snap(u) * (hp * Math.exp(-u / tn) + 0.5 * Math.sin(TAU * f1 * 1.07 * u) * Math.exp(-u / t1));
          }
          d[i] = y;
        }
      }));
    }
    // Sticky stretch: wet micro-clicks that slow down as the strand thins,
    // a falling formant, and a little low-passed slurp underneath.
    const squelch = [];
    for (let k = 0; k < 6; k++) {
      const dur = 0.22 + rnd() * 0.12, fA = 900 + rnd() * 600, fB = fA * (0.55 + rnd() * 0.15);
      squelch.push(make(dur, (d, len) => {
        let t = 0.004;
        while (t < dur - 0.02) {
          const p = t / dur, f = fA + (fB - fA) * p, tau = 0.0009 + 0.0012 * rnd();
          const amp = Math.min(1, t / 0.03) * (1 - p * 0.55) * (0.45 + 0.55 * rnd());
          const i0 = Math.floor(t * sr), span = Math.floor(tau * 7 * sr), ph = rnd() * TAU;
          for (let j = 0; j < span && i0 + j < len; j++) {
            const u = j / sr;
            d[i0 + j] += amp * Math.sin(TAU * f * u + ph) * Math.exp(-u / tau);
          }
          t += 0.0015 + 0.014 * p * p + rnd() * 0.004;
        }
        let lp = 0;
        for (let i = 0; i < len; i++) {
          const p = i / len, n = rnd() * 2 - 1;
          lp += 0.06 * (n - lp);
          d[i] += lp * 2.2 * Math.sin(Math.PI * Math.min(1, p * 1.2)) * (0.6 + 0.4 * Math.sin(TAU * 31 * p));
        }
      }));
    }
    // Air pocket: a bubble whose resonance sweeps up as it closes, plus a click.
    const pop = [];
    for (let k = 0; k < 4; k++) {
      const f0 = 330 + rnd() * 260, rise = 1.8 + rnd() * 1.2, tau = 0.025 + rnd() * 0.02;
      pop.push(make(0.13, (d, len) => {
        let phase = 0;
        for (let i = 0; i < len; i++) {
          const t = i / sr, f = f0 * (1 + rise * (1 - Math.exp(-t / 0.012)));
          phase += TAU * f / sr;
          d[i] = Math.sin(phase) * Math.exp(-t / tau) * Math.min(1, t / 0.0006) + (t < 0.0012 ? (rnd() * 2 - 1) * 0.6 * (1 - t / 0.0012) : 0);
        }
      }));
    }
    this._banks = { beads, squelch, pop };
  }
  _emitNote(midi, velocity, chord, time) {
    if (!this._listeners.length) return;
    if (this._offline) {
      const evt = { midi, velocity, chord, time };
      for (const cb of this._listeners.slice()) { try { cb(evt); } catch (e) { console.error(e); } }
      return;
    }
    const gen = this._gen;
    const delay = this._audibleAt(time) - performance.now();
    setTimeout(() => {
      if (gen !== this._gen) return;
      const evt = { midi, velocity, chord, time };
      for (const cb of this._listeners.slice()) { try { cb(evt); } catch (e) { console.error(e); } }
    }, delay > 0 ? delay : 0);
  }

  // performance.now() at which audio time `time` reaches the speaker.
  _audibleAt(time) {
    const ctx = this.ctx;
    const nowPerf = performance.now();
    const direct = nowPerf + (time - ctx.currentTime + LIMITER_DELAY) * 1000;
    if (ctx.getOutputTimestamp) {
      const ts = ctx.getOutputTimestamp();
      if (ts && ts.performanceTime > 0 && ts.contextTime > 0) {
        const p = ts.performanceTime + (time - ts.contextTime + LIMITER_DELAY) * 1000;
        if (p > direct - 50 && p < direct + 500) return p;   // sane: includes output latency
      }
    }
    return direct + (ctx.outputLatency || ctx.baseLatency || 0) * 1000;
  }

  // ------------------------------------------------------------------ voices

  _prune(list, t) {
    for (let i = list.length - 1; i >= 0; i--) if (list[i].end <= t) list.splice(i, 1);
  }

  _release(v, t, tau) {
    if (v.released && t < v.relT) t = v.relT;      // keep automation events in time order
    v.gain.gain.setTargetAtTime(0, t, tau);
    v.released = true;
    v.relT = t;
    const stopAt = t + tau * 6;
    if (stopAt < v.end) {
      for (let i = 0; i < v.oscs.length; i++) {
        if (v.stops[i] > stopAt) {
          try { v.oscs[i].stop(stopAt); } catch { /* engine refused a re-stop: it is silent anyway */ }
          this.stats.oscSeconds -= v.stops[i] - stopAt;
          v.stops[i] = stopAt;
        }
      }
      v.end = stopAt;
    }
  }

  // Steal the oldest voice: already-damped ones first, the current bass note last.
  _steal(list, t, tau, bar) {
    let best = -1, bestKey = Infinity;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      const key = v.t0 + (v.released ? -1e6 : 0) + (v.bass && v.bar === bar ? 1e6 : 0);
      if (key < bestKey) { bestKey = key; best = i; }
    }
    if (best < 0) return;
    this._release(list[best], t, tau);
    list.splice(best, 1);
  }

  _finishVoice(nodes, oscs, stops, voice) {
    let last = 0;
    for (let i = 0; i < stops.length; i++) {
      this.stats.oscSeconds += stops[i] - voice.t0;
      if (stops[i] > stops[last]) last = i;
    }
    oscs[last].onended = () => {
      for (let i = 0; i < nodes.length; i++) { try { nodes[i].disconnect(); } catch { /* gone */ } }
    };
    voice.end = stops[last];
  }

  // Glass/crystal "ting": inharmonic bell partials with fast decays, a beating
  // second mode on the fundamental for shimmer, and a tiny contact tick.
  _gemNote(midi, s, t, h) {
    const ctx = this.ctx, list = this._gems;
    this._prune(list, t);
    if (list.length >= GEM_VOICES) { this._steal(list, t, 0.008, -1); this.stats.gemSteals++; }
    const f = mtof(midi);
    const fMax = Math.min(16000, ctx.sampleRate * 0.45);
    const amp = GEM_LEVEL * (0.15 + 0.85 * s);
    const bright = 0.45 + 0.55 * s;
    const vary = 0.85 + 0.3 * (((h >>> 10) & 255) / 255);
    const ring = 1.25 - 0.5 * clamp((midi - 84) / 12, 0, 1);      // higher gems ring shorter

    const gain = ctx.createGain();
    const nodes = [gain], oscs = [], stops = [];
    if (ctx.createStereoPanner) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = ((h & 1023) / 1023 - 0.5) * 0.7;
      gain.connect(pan); pan.connect(this._gemBus);
      nodes.push(pan);
    } else gain.connect(this._gemBus);

    let norm = 0;
    for (let k = 0; k < GEM_RATIOS.length; k++) norm += GEM_LEVELS[k] * (k ? bright : 1.45);
    for (let k = 0; k < GEM_RATIOS.length; k++) {
      const fk = f * GEM_RATIOS[k];
      if (fk > fMax) break;
      const a = amp * GEM_LEVELS[k] * (k ? bright : 1) / norm;
      const tau = GEM_TAUS[k] * vary * (k === 0 ? ring : 1);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(a, t + 0.0008);
      g.gain.setTargetAtTime(0, t + 0.0008, tau);
      g.connect(gain);
      const stopAt = t + 0.001 + tau * 5.75;              // -50 dB
      const o = ctx.createOscillator();
      o.frequency.value = fk;
      o.connect(g);
      o.start(t); o.stop(stopAt);
      nodes.push(g, o); oscs.push(o); stops.push(stopAt);
      if (k === 0) {               // shimmer: a mode 7 cents away beats slowly
        const o2 = ctx.createOscillator();
        o2.frequency.value = fk * 1.0042;
        const g2 = ctx.createGain();
        g2.gain.value = 0.45;
        o2.connect(g2); g2.connect(g);
        o2.start(t); o2.stop(stopAt);
        nodes.push(g2, o2); oscs.push(o2); stops.push(stopAt);
      }
    }

    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass"; hp.frequency.value = 6500;
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0, t);
    tg.gain.linearRampToValueAtTime(amp * 0.35 * s, t + 0.0005);
    tg.gain.setTargetAtTime(0, t + 0.0005, 0.0025);
    src.connect(hp); hp.connect(tg); tg.connect(gain);
    src.start(t, ((h >>> 3) & 1023) / 1023 * 0.2, 0.02);
    nodes.push(src, hp, tg);

    const voice = { t0: t, end: t, gain, oscs, stops, bass: false, bar: -1, released: false, relT: 0 };
    this._finishVoice(nodes, oscs, stops, voice);
    list.push(voice);
    if (list.length > this.stats.maxGemVoices) this.stats.maxGemVoices = list.length;
  }
}
