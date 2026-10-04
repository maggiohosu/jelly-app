// 말랑젤리 sound engine. Everything is synthesised with plain Web Audio nodes
// (no audio files, no AudioWorklet, no libraries):
//   • boing()        the jelly squish (same sound as before)
//   • piano          a soft additive "grand" improvising a C-major-pentatonic
//                    melody over I–V–vi–IV; setActivity() drives density/dynamics
//   • clink()        glassy gem "ting"s tuned to the chord that is sounding now
//
// iOS rules: the AudioContext must be created/resumed synchronously inside a
// user gesture (unlock()); the 'ambient' audio session mixes with the user's
// music (Melon/Spotify keep playing) and respects the ringer switch.
//
// Signal graph (volumes are linear gains; each bus is unity at its default):
//   boing voices → boingBus (master·boing/0.6) → legacy compressor ──────┐
//   piano voices → pianoBus (piano/0.7) ─┬─→ musicIn (master) ──────────┤
//   gem voices   → gemBus  (gems/0.6) ───┤        ↑                     │
//                  sends ─→ room (short generated convolver)            │
//                                 limiter (-4 dB, 20:1) ←───────────────┘ → make-up trim → out
//
// Offline rendering (tests): give the engine an OfflineAudioContext. Its clock
// is then virtual: call advanceTo(t) once per simulated frame (it runs the
// lookahead scheduler), then setActivity()/clink()/boing() as the app would,
// and finally startRendering(). onNote callbacks fire synchronously at
// scheduling time in that mode (event.time is the audio time of the note).
//   const off = new OfflineAudioContext(2, 12 * 48000, 48000);
//   const audio = new JellyAudio({ context: off, random: seededRng });
//   for (let f = 0; f <= 12 * 60; f++) { audio.advanceTo(f / 60); audio.setActivity(a, r); }
//   const buffer = await off.startRendering();
// or: const { buffer, audio } = await JellyAudio.renderOffline(12, (audio, t) => { ... }, { random });

const LOOKAHEAD = 0.12;            // s of audio scheduled ahead of the clock
const TICK_MS = 25;                // scheduler interval
const PIANO_VOICES = 10;
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
const DEFAULT_VOLUMES = Object.freeze({ master: 0.9, piano: 0.7, gems: 0.6, boing: 0.6 });

const PENTA = [0, 2, 4, 7, 9];     // C D E G A
const CHORDS = Object.freeze([
  Object.freeze({ name: "C", root: 0, tones: [0, 4, 7] }),
  Object.freeze({ name: "G", root: 7, tones: [7, 11, 2] }),
  Object.freeze({ name: "Am", root: 9, tones: [9, 0, 4] }),
  Object.freeze({ name: "F", root: 5, tones: [5, 9, 0] }),
]);
// Which pentatonic degrees are chord tones of each chord (melody snapping).
const CHORD_DEG = CHORDS.map((c) => PENTA.map((pc) => c.tones.includes(pc)));
// Gem pitches: chord tones from C6 (84) to C7 (96).
const CLINK_PITCHES = CHORDS.map((c) => {
  const out = [];
  for (let m = 84; m <= 96; m++) if (c.tones.includes(m % 12)) out.push(m);
  return out;
});
// Melody rhythm: probability weight of each 8th in the bar.
const STEP_WEIGHT = [1, 0.55, 0.85, 0.6, 0.95, 0.55, 0.8, 0.65];

const PIANO_LEVEL = 0.3;           // peak of a velocity-1 note before the bus
const PIANO_PARTIALS = [1, 0.62, 0.42, 0.28, 0.19, 0.13, 0.09];
const STRING2 = 0.35;              // level of the second (detuned) string
const GEM_LEVEL = 0.13;              // gems sit just under the piano
const GEM_RATIOS = [1, 2.76, 5.40, 8.93];
const GEM_LEVELS = [1, 0.5, 0.28, 0.14];
const GEM_TAUS = [0.2, 0.075, 0.035, 0.018];

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const degToMidi = (d) => { const o = Math.floor(d / 5); return 60 + 12 * o + PENTA[d - 5 * o]; };
const mod5 = (d) => ((d % 5) + 5) % 5;
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
    this._bpm = 92;
    this._eighth = 30 / 92;
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
    // 8th-note grid on the audio clock
    this._gridReady = false;
    this._anchorTime = 0; this._anchorStep = 0;
    this._step = 0; this._nextStepTime = 0;
    // improviser
    this._resting = true;
    this._deg = 5; this._dir = 1; this._lastMove = 1;
    this._pedalBar = -1; this._lastReplayBar = -9;
    this._motifSlot = new Float64Array(4); this._motifDeg = new Int16Array(4);
    this._motifLen = 0; this._motifHead = 0;
    this._planSlot = new Float64Array(4); this._planDeg = new Int16Array(4);
    this._planLen = 0; this._planIdx = 0;
    // voices
    this._piano = [];
    this._gems = [];
    this._clinkTokens = CLINK_BURST; this._clinkTokT = 0;
    this._lastClink = -1e9; this._lastClinkMidi = -1;
    this.stats = { notes: 0, bassNotes: 0, clinks: 0, pianoSteals: 0, gemSteals: 0, maxPianoVoices: 0, maxGemVoices: 0, oscSeconds: 0 };
    if (options.context) {
      this.ctx = options.context;
      this._ownsContext = false;
      this._offline = typeof options.context.startRendering === "function";
      this._build(true);
    }
  }

  static get CHORDS() { return CHORDS; }
  static get VOICE_LIMITS() { return { piano: PIANO_VOICES, gems: GEM_VOICES }; }
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
    for (const list of [this._piano, this._gems]) {
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
      for (const list of [this._piano, this._gems]) {
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

  /** Each 0..1 (linear gain; defaults master 0.9, piano 0.7, gems 0.6, boing 0.6). */
  setVolumes(volumes = {}) {
    for (const key in DEFAULT_VOLUMES) {
      const v = volumes[key];
      if (typeof v === "number" && v === v) this._vol[key] = clamp(v, 0, 1);
    }
    this._applyVolumes(false);
  }

  get volumes() { return { ...this._vol }; }

  get tempo() { return this._bpm; }
  set tempo(bpm) {
    const b = clamp(Number(bpm) || 92, 40, 220);
    if (b === this._bpm) return;
    if (this._gridReady) {         // re-anchor the grid at the next unscheduled 8th
      this._anchorTime = this._nextStepTime;
      this._anchorStep = this._step;
    }
    this._bpm = b;
    this._eighth = 30 / b;
  }

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

  /** Smoothed activity (what the improviser is using). */
  get activity() { return this._act; }

  /** callback({ midi, velocity, chord, time }) when a melody note sounds. Returns an unsubscribe fn. */
  onNote(callback) {
    if (typeof callback !== "function") return () => {};
    this._listeners.push(callback);
    return () => {
      const i = this._listeners.indexOf(callback);
      if (i >= 0) this._listeners.splice(i, 1);
    };
  }

  /** Chord index (0 C, 1 G, 2 Am, 3 F) sounding at audio time t. */
  chordAt(t) {
    if (!this._gridReady) return 0;
    const step = this._anchorStep + Math.floor((t - this._anchorTime) / this._eighth + 1e-7);
    const bar = Math.floor(step / 8);
    return ((bar % 4) + 4) % 4;
  }

  get currentChord() { return this.ctx ? this.chordAt(this._now()) : 0; }

  /** Audio time of 8th-note step 0 (valid while the tempo is unchanged). */
  get gridOrigin() { return this._anchorTime - this._anchorStep * this._eighth; }

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
   * Gem collision. Rate-limited (≥ 45 ms apart, ~10/s sustained). Pitched to a
   * chord tone of the chord sounding now, C6–C7. Returns the MIDI note played,
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
    const chord = this.chordAt(now);
    const pitches = CLINK_PITCHES[chord];
    const h = hash32((seed | 0) ^ 0x5bd1e995);
    let i = h % pitches.length;
    if (pitches[i] === this._lastClinkMidi) i = (i + 1 + ((h >>> 8) & 1)) % pitches.length;
    const midi = pitches[i];
    this._lastClinkMidi = midi;
    this._gemNote(midi, s, now + 0.002, h);
    this.stats.clinks++;
    return midi;
  }

  /** Play one piano note now (or at audio time `when`). Mainly for tests/UI. */
  playNote(midi, velocity = 0.7, when = 0) {
    const ctx = this.ctx;
    if (!ctx || (!this._offline && ctx.state !== "running")) return;
    this._pianoNote(midi, velocity, Math.max(this._now(), when), false, -1);
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

    // Music: piano + gems (+ room) → master gain → limiter.
    this._musicIn = ctx.createGain();
    this._musicIn.connect(limiter);
    this._pianoBus = ctx.createGain();
    this._pianoBus.connect(this._musicIn);
    this._gemBus = ctx.createGain();
    this._gemBus.connect(this._musicIn);
    this._room = ctx.createConvolver();
    const roomOut = ctx.createGain(); roomOut.gain.value = 1;
    this._room.connect(roomOut).connect(this._musicIn);
    const pianoSend = ctx.createGain(); pianoSend.gain.value = 0.5;   // wet ≈ -17 dB
    this._pianoBus.connect(pianoSend).connect(this._room);
    const gemSend = ctx.createGain(); gemSend.gain.value = 0.55;      // wet ≈ -13 dB
    this._gemBus.connect(gemSend).connect(this._room);
    // ~1 ms of maths: keep it out of the tap handler on a live context.
    if (sync) this._room.buffer = this._impulse(1.1);
    else setTimeout(() => { if (this.ctx === ctx) this._room.buffer = this._impulse(1.1); }, 0);
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
    const { master, piano, gems, boing } = this._vol;
    const now = this._now();
    const set = (param, value) => {
      if (immediate) param.value = value;
      else param.setTargetAtTime(value, now, 0.02);
    };
    set(this.master.gain, master * boing / DEFAULT_VOLUMES.boing);
    set(this._musicIn.gain, master);
    set(this._pianoBus.gain, piano / DEFAULT_VOLUMES.piano);
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

  _tick() {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!this._offline && ctx.state !== "running") return;
    const now = this._now();
    this._smooth(this._wall());
    if (!this._gridReady) {
      this._anchorTime = now + 0.05;
      this._anchorStep = 0;
      this._step = 0;
      this._gridReady = true;
    }
    const e = this._eighth;
    let t = this._anchorTime + (this._step - this._anchorStep) * e;
    if (t < now - 0.03) {          // timer was throttled: skip the missed 8ths silently
      this._step = this._anchorStep + Math.ceil((now - this._anchorTime) / e);
      t = this._anchorTime + (this._step - this._anchorStep) * e;
      this._planLen = 0;
    }
    const horizon = now + LOOKAHEAD;
    while (t < horizon) {
      this._doStep(this._step, t);
      this._step++;
      t = this._anchorTime + (this._step - this._anchorStep) * this._eighth;
    }
    this._nextStepTime = t;
  }

  _doStep(step, t) {
    const a = this._act;
    const s = step & 7;
    const bar = Math.floor(step / 8);
    const chord = bar & 3;
    const e = this._eighth;
    if (a < ACT_OFF || !this.enabled) { this._resting = true; this._planLen = 0; return; }
    if (this._resting && a < ACT_ON) return;
    if (s === 0 && !this._resting) this._maybeReplay(step, chord, bar);

    // Left hand: soft root (+ fifth) on beat 1, a light octave on beat 3 when busy.
    if (s === 0 && a > 0.25) {
      const root = this._bassRoot(chord);
      this._bass(root, 0.22 + 0.3 * a, t, bar);
      if (a > 0.45) this._bass(root + 7, (0.22 + 0.3 * a) * 0.72, t, bar);
    } else if (s === 4 && a > 0.7) {
      this._bass(this._bassRoot(chord) + 12, 0.16 + 0.2 * a, t, bar);
    }

    const slot = step * 2;         // 16th-note slot index
    if (this._planLen) {           // replaying a motif: it owns this part of the bar
      while (this._planIdx < this._planLen && this._planSlot[this._planIdx] <= slot + 1) {
        const ps = this._planSlot[this._planIdx];
        const d = this._planDeg[this._planIdx];
        this._planIdx++;
        if (ps < slot) continue;
        const sub = ps === slot + 1;
        this._setDeg(d);
        this._melody(d, sub ? t + e / 2 : t, this._velocity(a, s, sub), chord, ps, bar);
      }
      if (this._planIdx >= this._planLen) this._planLen = 0;
      return;
    }

    let play;
    if (this._resting) {           // rising from silence: start right on this 8th
      this._resting = false;
      play = true;
      this._setDeg(this._snap(Math.round(this._reg * 10), chord, 1));
    } else {
      let p = s === 0 ? (a > 0.15 ? 1 : a * 1.5) : Math.min(0.95, a * 1.3 * STEP_WEIGHT[s]);
      if ((bar & 1) && s >= 6) p *= a > 0.85 ? 0.3 : 0.04;      // breathe every 2 bars
      play = this._random() < p;
      if (play) {
        const strong = s === 0 || s === 4 || ((bar & 1) === 1 && s === 5);
        this._setDeg(this._nextDeg(strong, chord));
      }
    }
    if (play) this._melody(this._deg, t, this._velocity(a, s, false), chord, slot, bar);

    // 16th pickups / runs when the jelly is really moving.
    if (a > 0.65 && !((bar & 1) && s === 6)) {
      const q = (a - 0.65) * (s === 7 ? 2.4 : 1.4);
      if (this._random() < q) {
        const d = this._clampDeg(this._deg + this._dir);
        this._setDeg(d);
        this._melody(d, t + e / 2, this._velocity(a, s, true), chord, slot + 1, bar);
      }
    }
  }

  // Occasionally repeat the last 3–4-note motif, transposed onto the new chord.
  _maybeReplay(step, chord, bar) {
    if (this._motifLen < 3 || this._act < 0.25 || bar - this._lastReplayBar < 2 || this._random() > 0.35) return;
    const base = step * 2;
    const last = (this._motifHead + 3) & 3;
    let n = this._motifLen, first = 0;
    for (; n >= 3; n--) {          // the longest recent motif that fits in one bar
      first = (this._motifHead - n + 4) & 3;
      const span = this._motifSlot[last] - this._motifSlot[first];
      if (span >= 2 && span <= 14) break;
    }
    if (n < 3 || base - this._motifSlot[first] > 32) return;
    const d0 = this._motifDeg[first];
    const dirn = this._random() < 0.5 ? 1 : -1;
    let target = this._snap(d0 + dirn, chord, dirn);
    if (target === d0) target = this._snap(d0 + 2 * dirn, chord, dirn);
    let shift = target - d0;
    const c = Math.round(this._reg * 10);
    for (let k = 0; k < n; k++) {  // keep it in range: sequence the other way instead
      const d = this._motifDeg[(first + k) & 3] + shift;
      if (d < c - 6 || d > c + 7) { shift = this._snap(d0 - dirn * 2, chord, -dirn) - d0; break; }
    }
    for (let k = 0; k < n; k++) {
      const i = (first + k) & 3;
      this._planSlot[k] = base + (this._motifSlot[i] - this._motifSlot[first]);
      this._planDeg[k] = this._clampDeg(this._motifDeg[i] + shift);
    }
    this._planLen = n;
    this._planIdx = 0;
    this._lastReplayBar = bar;
  }

  _nextDeg(strong, chord) {
    const rnd = this._random;
    const c = this._reg * 10;
    const r = rnd();
    let mv = r < 0.3 ? 1 : r < 0.6 ? -1 : r < 0.72 ? 2 : r < 0.84 ? -2 : r < 0.92 ? 0 : r < 0.96 ? 3 : -3;
    if (mv !== 0 && rnd() < 0.35) mv = Math.abs(mv) * this._dir;        // keep going the same way
    if (mv === 0 && this._lastMove === 0) mv = this._dir;               // no triple repeats
    const d0 = this._deg;
    if ((d0 > c + 3 && mv > 0) || (d0 < c - 3 && mv < 0)) mv = -mv;    // drift back to the centre
    let d = this._clampDeg(d0 + mv);
    if (strong) d = this._snap(d, chord, mv >= 0 ? 1 : -1);
    return d;
  }

  _clampDeg(d) {
    const c = Math.round(this._reg * 10);
    const lo = Math.max(-3, c - 5), hi = Math.min(15, c + 6);
    return d < lo ? lo + (d < lo - 1 ? 0 : 1) : d > hi ? hi - (d > hi + 1 ? 0 : 1) : d;
  }

  // Nearest pentatonic chord tone, preferring the direction of motion.
  _snap(d, chord, dir) {
    const mask = CHORD_DEG[chord];
    if (mask[mod5(d)]) return d;
    const sgn = dir < 0 ? -1 : 1;
    for (let k = 1; k <= 3; k++) {
      if (mask[mod5(d + sgn * k)]) return d + sgn * k;
      if (mask[mod5(d - sgn * k)]) return d - sgn * k;
    }
    return d;
  }

  _setDeg(d) {
    const mv = d - this._deg;
    if (mv) this._dir = mv > 0 ? 1 : -1;
    this._lastMove = mv;
    this._deg = d;
  }

  _velocity(a, s, sub) {
    let v = 0.16 + 0.74 * a;
    if (s === 0) v += 0.08; else if (s === 4) v += 0.04; else if (s & 1) v -= 0.05;
    if (sub) v -= 0.1;
    v += (this._random() - 0.5) * 0.08;
    return clamp(v, 0.06, 1);
  }

  _bassRoot(chord) {
    const pc = CHORDS[chord].root;
    const root = pc + 36 < 41 ? pc + 48 : pc + 36;      // F2 … E3
    return this._reg > 0.7 ? root + 12 : root;
  }

  _melody(deg, t, velocity, chord, slot, bar) {
    const midi = degToMidi(deg);
    this._pedal(bar, t);
    this._pianoNote(midi, velocity, t, false, bar);
    const h = this._motifHead;
    this._motifSlot[h] = slot; this._motifDeg[h] = deg;
    this._motifHead = (h + 1) & 3;
    if (this._motifLen < 4) this._motifLen++;
    this.stats.notes++;
    this._emitNote(midi, velocity, chord, t);
  }

  _bass(midi, velocity, t, bar) {
    this._pedal(bar, t);
    this._pianoNote(midi, velocity, t, true, bar);
    this.stats.bassNotes++;
  }

  // "Pedal change" on the first note of a new bar: damp what rang in the old chord.
  _pedal(bar, t) {
    if (bar === this._pedalBar) return;
    this._pedalBar = bar;
    const list = this._piano;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (v.t0 < t - 0.001 && !v.released) this._release(v, t + 0.004, 0.11);
    }
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

  // Additive soft grand: inharmonic partials f_n = n·f0·√(1+B·n²), two detuned
  // strings on the lowest partials, per-partial two-stage decays, a velocity
  // low-pass that closes over time, and a filtered-noise hammer.
  _pianoNote(midi, velocity, t, bass, bar) {
    const ctx = this.ctx, list = this._piano;
    this._prune(list, t);
    if (list.length >= PIANO_VOICES) { this._steal(list, t, 0.02, bar); this.stats.pianoSteals++; }
    const rnd = this._random;
    const v = clamp(velocity, 0.02, 1);
    const f0 = mtof(midi);
    const fMax = Math.min(14000, ctx.sampleRate * 0.45);
    const B = 0.0004 * (1 + Math.max(0, midi - 60) / 36);
    const nPart = midi < 55 ? 7 : midi < 67 ? 6 : midi < 79 ? 5 : 4;
    const T60 = clamp(3.6 * Math.pow(0.72, (midi - 60) / 12), 1.0, 4.5);
    const tau1 = T60 / 6.9;
    const bright = 0.55 + 0.45 * v;
    const amp = PIANO_LEVEL * Math.pow(v, 1.4);
    const atk = 0.0025;

    // Velocity low-pass: opens with velocity, closes over ~0.5–1.6 s. k-rate and
    // a finite ramp: a-rate biquad automation recomputes coefficients per sample.
    const fOpen = Math.min(fMax, f0 * (2 + 14 * v * v) + 500);
    const fClose = Math.min(fOpen, f0 * 2.5 + 300);
    // Partials: skip what the filter or the velocity would make inaudible.
    let count = 0, norm = 0;
    for (let n = 1; n <= nPart; n++) {
      const fn = n * f0 * Math.sqrt(1 + B * n * n);
      const rel = PIANO_PARTIALS[n - 1] * Math.pow(bright, n - 1);
      if (fn > fMax || (n > 2 && (rel < 0.02 || fn > 2.5 * fOpen))) break;
      norm += rel * (n <= 2 ? 1 + STRING2 : 1);
      count = n;
    }

    const gain = ctx.createGain();
    gain.connect(this._pianoBus);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.Q.value = 0;
    try { lp.frequency.automationRate = "k-rate"; } catch { /* older engines: a-rate */ }
    lp.frequency.setValueAtTime(fOpen, t);
    if (fClose < fOpen) lp.frequency.exponentialRampToValueAtTime(fClose, t + 0.5 + 1.1 * (1 - v));
    lp.connect(gain);
    const nodes = [gain, lp], oscs = [], stops = [];

    for (let n = 1; n <= count; n++) {
      const fn = n * f0 * Math.sqrt(1 + B * n * n);
      const a = amp * PIANO_PARTIALS[n - 1] * Math.pow(bright, n - 1) / norm;
      const tau = tau1 / (1 + 0.8 * (n - 1));          // upper partials die sooner
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(a, t + atk);
      let stopAt;
      if (n <= 2) {                // prompt sound then a slower aftersound
        g.gain.setTargetAtTime(0, t + atk, 0.25);
        g.gain.setTargetAtTime(0, t + atk + 0.15, tau);
        stopAt = t + atk + 0.15 + tau * 5.2;            // ≈ -50 dB
      } else {
        g.gain.setTargetAtTime(0, t + atk, tau);
        stopAt = t + atk + tau * 5.75;                  // -50 dB
      }
      g.connect(lp);
      const o = ctx.createOscillator();
      o.frequency.value = fn;
      o.detune.value = n <= 2 ? -1.5 : (rnd() - 0.5) * 2;
      o.connect(g);
      o.start(t); o.stop(stopAt);
      nodes.push(g, o); oscs.push(o); stops.push(stopAt);
      if (n <= 2) {                // second string, +1.5 cents
        const o2 = ctx.createOscillator();
        o2.frequency.value = fn;
        o2.detune.value = 1.5;
        const g2 = ctx.createGain();
        g2.gain.value = STRING2;
        o2.connect(g2); g2.connect(g);
        o2.start(t); o2.stop(stopAt);
        nodes.push(g2, o2); oscs.push(o2); stops.push(stopAt);
      }
    }

    // Hammer: a few ms of band-passed noise.
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = clamp(f0 * 6, 1200, 5000); bp.Q.value = 0.7;
    const hg = ctx.createGain();
    hg.gain.setValueAtTime(0, t);
    hg.gain.linearRampToValueAtTime(amp * (0.35 + 0.9 * v), t + 0.0012);
    hg.gain.setTargetAtTime(0, t + 0.0012, 0.007);
    src.connect(bp); bp.connect(hg); hg.connect(gain);
    src.start(t, rnd() * 0.18, 0.06);
    nodes.push(src, bp, hg);

    const voice = { t0: t, end: t, gain, oscs, stops, bass, bar, released: false, relT: 0 };
    this._finishVoice(nodes, oscs, stops, voice);
    list.push(voice);
    if (list.length > this.stats.maxPianoVoices) this.stats.maxPianoVoices = list.length;
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
