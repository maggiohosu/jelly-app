// 말랑젤리 sound engine. Everything is synthesised with plain Web Audio nodes
// (no audio files, no AudioWorklet, no libraries):
//   • crunch         crunchy-slime ASMR: bead snaps (뽀득), sticky stretches (쩍)
//                    and air pops (뽁); setActivity() drives the bead crunching
//   • boing()/drip() the jelly squish and paint drops
//   • clink()        glassy gem "ting"s (C-major pentatonic, C6–C7)
//   • munch()/chew() a bunny biting (와삭!) and chewing (냠냠) the jelly
//   • squeak()       the bunny itself: 뀨! / 뀽 / 흐응…
//   • coin()/coinShower(), cardShake()/cardFlip(), reveal(), levelUp()
//                    gold coins, gacha cards and their fanfares (C-major pentatonic)
//
// iOS rules: the AudioContext must be created/resumed synchronously inside a
// user gesture (unlock()); the 'ambient' audio session mixes with the user's
// music (Melon/Spotify keep playing) and respects the ringer switch.
//
// Signal graph (volumes are linear gains; each bus is unity at its default):
//   boing voices  → boingBus (master·boing/0.6) → legacy compressor ─────┐
//   crunch grains → crunchBus (crunch/0.8) → tone LP ─┬─→ musicIn (master) ┤
//   munch / chew  ↗ (chew via a muffling LP)          │        ↑          │
//   gem voices    → gemBus  (gems/0.6) ───────────────┤        │          │
//   fx voices     → fxBus   (effects/0.8) ────────────┘        │          │
//                   sends ─→ room (short generated convolver) ─┘          │
//                                 limiter (-4 dB, 20:1) ←────────────────┘ → make-up trim → out
// "effects" (squeak, coins, cards, fanfares) is an extra level next to the
// DEFAULT_VOLUMES keys: setVolumes({ effects }) 0..1, default 0.8.
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

// Effects (bunny, coins, cards, fanfares).
const FX_VOICES = 20;               // tonal notes (2–5 oscillators each)
const BED_VOICES = 6;               // noise layers (shimmer, whoosh, rattle)
const FX_QUEUE_MAX = 256;           // pending scheduled parts
const DEFAULT_EFFECTS = 0.8;        // the effects level; the fx bus is unity here
const MUNCH_GAP = 0.1, THUMP_LEVEL = 0.14;
const SQUEAK_LEVEL = 0.12;
const COIN_GAP = 0.025, COIN_RATE = 16, COIN_BURST = 4;
const COIN_LEVEL = 0.2, COIN_BASE = 2300;
// Struck thin disc: (2,0) (beating twin) (3,0) (1,1) (4,0) modes.
const COIN_RATIOS = [1, 1.006, 2.31, 3.89, 4.12];
const COIN_LEVELS = [1, 0.55, 0.8, 0.5, 0.45];
const COIN_TAUS = [0.12, 0.12, 0.07, 0.048, 0.048];
const COIN_GROUPS = [[0, 1], [2], [3, 4]];                // modes sharing an envelope
const FLIP_LEVEL = 0.2, SHAKE_LEVEL = 0.16;
const SPARKLE_PITCHES = [96, 98, 100, 103, 105, 108];   // C7–C8 pentatonic
// Tonal fx timbres: partial ratios / levels / decay taus (s); `beat` adds a
// slightly detuned twin of the fundamental for shimmer.
const TONES = {
  pluck: { ratios: [1, 2, 3, 4.16], levels: [1, 0.3, 0.12, 0.05], taus: [0.22, 0.1, 0.06, 0.03], attack: 0.002, beat: 1.0035 },
  warm: { ratios: [1, 2, 3, 4], levels: [1, 0.5, 0.25, 0.08], taus: [0.28, 0.15, 0.09, 0.05], attack: 0.003, beat: 1.0028 },
  tink: { ratios: [1, 2, 5.1], levels: [1, 0.22, 0.1], taus: [0.07, 0.035, 0.015], attack: 0.001 },
  bell: { ratios: [0.5, 1, 1.5, 2, 2.52, 3], levels: [0.4, 1, 0.28, 0.45, 0.26, 0.13], taus: [0.45, 0.4, 0.28, 0.24, 0.17, 0.11], attack: 0.002, beat: 1.0022 },
  chip: { ratios: [1], levels: [1], taus: [0.14], attack: 0.003, wave: "chip" },
};
const RAINBOW_GLISS = [72, 74, 76, 79, 81, 84, 86, 88, 91, 93, 96, 98, 100, 103, 105, 108];   // C5→C8

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
function hash32(x) {
  x |= 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}
// Fixed-seed RNG for the effect sample banks (keeps the engine's own RNG
// sequence, and so the crunch, exactly as it was).
function seededRandom(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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
    this.stats = { bursts: 0, grains: 0, grainDrops: 0, maxGrains: 0, clinks: 0, gemSteals: 0, maxGemVoices: 0, oscSeconds: 0,
      munches: 0, chewBites: 0, squeaks: 0, coins: 0, coinDrops: 0, reveals: 0, fxNotes: 0, fxSteals: 0, maxFxVoices: 0, beds: 0, bedSteals: 0, maxBeds: 0 };
    // effects
    this._fxVol = DEFAULT_EFFECTS;
    this._fx = []; this._beds = []; this._fxQueue = [];
    this._fxNoise = null; this._waves = null;
    this._lastMunch = -1e9; this._lastBite = -1e9; this._chewCount = 0;
    this._lastSqueak = -1e9; this._squeakVoice = null;
    this._coinTokens = COIN_BURST; this._coinTokT = 0; this._lastCoin = -1e9;
    this._lastShower = -1e9; this._showerSeed = 0;
    this._lastFlip = -1e9; this._lastShake = -1e9; this._shakeVoice = null;
    this._lastReveal = -1e9; this._lastLevelUp = -1e9;
    if (options.context) {
      this.ctx = options.context;
      this._ownsContext = false;
      this._offline = typeof options.context.startRendering === "function";
      this._build(true);
    }
  }

  static get VOICE_LIMITS() { return { grains: GRAIN_VOICES, gems: GEM_VOICES, fx: FX_VOICES, beds: BED_VOICES }; }
  static get DEFAULT_VOLUMES() { return DEFAULT_VOLUMES; }
  static get DEFAULT_EFFECTS() { return DEFAULT_EFFECTS; }

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
    for (const list of [this._gems, this._fx, this._beds]) {
      for (const v of list) for (const o of v.oscs) { try { o.stop(); } catch { /* not started */ } }
      list.length = 0;
    }
    this._fxQueue.length = 0;
    try { this._out?.disconnect(); } catch { /* already */ }
    try { ctx?.close?.().catch(() => {}); } catch { /* closed */ }
    this.ctx = null;
    this.master = null;
  }

  suspend() {
    this._stopTimer();
    this._gen++;
    this._fxQueue.length = 0;      // queued fanfare/chew parts would only come back late
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
    else { this._stopTimer(); this._gen++; this._fxQueue.length = 0; this.ctx.suspend().catch(() => {}); }
  }

  dispose() {
    this._stopTimer();
    this._gen++;
    this._listeners.length = 0;
    this._fxQueue.length = 0;
    const ctx = this.ctx;
    if (ctx) {
      for (const list of [this._gems, this._fx, this._beds]) {
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

  /**
   * Each 0..1 (linear gain; defaults master 0.9, crunch 0.8, gems 0.6, boing 0.6).
   * `effects` (default 0.8, under master) sets the squeak/coin/card/fanfare level;
   * munch()/chew() follow `crunch`.
   */
  setVolumes(volumes = {}) {
    for (const key in DEFAULT_VOLUMES) {
      const v = volumes[key];
      if (typeof v === "number" && v === v) this._vol[key] = clamp(v, 0, 1);
    }
    const e = volumes.effects;
    if (typeof e === "number" && e === e) this._fxVol = clamp(e, 0, 1);
    this._applyVolumes(false);
  }

  get volumes() { return { ...this._vol, effects: this._fxVol }; }

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
    const fc = this.texture === "slime" ? 1500 : 2200;    // chewing, mouth closed
    if (this._offline) { this._crunchTone.frequency.value = f; this._chewTone.frequency.value = fc; }
    else { this._crunchTone.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.05); this._chewTone.frequency.setTargetAtTime(fc, this.ctx.currentTime, 0.05); }
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

  // -------------------------------------------- bunny, coins, cards, fanfares
  //
  // All on the effects bus (`effects` level, under master). Multi-part sounds
  // are queued and handed to Web Audio by the lookahead scheduler, so every
  // note takes its voice at its own start time (FX_VOICES tonal notes,
  // BED_VOICES noise layers; the oldest is stolen, chord/bell notes last).
  // Each returns true when it sounded / was scheduled, false when dropped.

  /**
   * Tiny bunny voice: 'happy' 뀨뀨! (two bright rising chirps), 'ok' 뀽 (short,
   * neutral), 'sad' 흐응… (breathy, falling, with a little vibrato). < 0.6 s,
   * fundamental 600–1600 Hz. ≥ 0.2 s apart; a new squeak cuts the previous one.
   */
  squeak(mood = "happy") {
    if (!this._ready()) return false;
    const now = this._now();
    if (now - this._lastSqueak < 0.2) return false;
    this._lastSqueak = now;
    const rnd = this._random, t = now + 0.003;
    const p = 0.96 + 0.08 * rnd();                 // a slightly different bunny every time
    const prev = this._squeakVoice;
    if (prev && prev.end > t) this._release(prev, t, 0.015);
    const v = this._openVoice(this._fx, FX_VOICES, t, (rnd() - 0.5) * 0.3, "squeak");
    const L = SQUEAK_LEVEL;
    if (mood === "sad") {
      this._breath(v, t, 0.08, L * 0.12);
      this._syllable(v, t + 0.04, 0.11, [860 * p, 880 * p, 830 * p], L * 0.5, 2300, 1700, 0, 0);
      this._syllable(v, t + 0.16, 0.28, [900 * p, 830 * p, 640 * p], L * 0.65, 2200, 1000, 0, 0.03);
    } else if (mood === "ok") {
      this._syllable(v, t, 0.17, [880 * p, 1020 * p, 930 * p], L * 0.85, 3000, 1500, 0.7, 0);
    } else {
      this._syllable(v, t, 0.1, [820 * p, 1300 * p, 1240 * p], L, 3600, 2300, 1, 0);
      this._syllable(v, t + 0.135, 0.13, [930 * p, 1490 * p, 1430 * p], L * 1.05, 3800, 2400, 1, 0);
    }
    this._closeVoice(this._fx, v);
    this._squeakVoice = v;
    this.stats.squeaks++;
    return true;
  }

  /**
   * One gold coin landing: a bright, metallic, inharmonic ring (~2.1–2.5 kHz
   * disc modes with a beating twin) with a sharp chink and two small bounces.
   * `seed` picks the pitch (±7 %) and bounce timing. Rate-limited (≥ 25 ms
   * apart, ~16/s sustained).
   */
  coin(strength = 0.7, seed = 0) {
    if (!this._ready()) return false;
    const s = clamp(+strength || 0, 0, 1);
    if (s < 0.03) return false;
    const now = this._now();
    this._coinTokens = Math.min(COIN_BURST, this._coinTokens + (now - this._coinTokT) * COIN_RATE);
    this._coinTokT = now;
    if (now - this._lastCoin < COIN_GAP || this._coinTokens < 1) { this.stats.coinDrops++; return false; }
    this._coinTokens -= 1;
    this._lastCoin = now;
    const h = hash32((seed | 0) ^ 0x27d4eb2f);
    this._coinNote(now + 0.002, s, h, (((h >>> 5) & 255) / 255 - 0.5) * 0.8, "coin");
    return true;
  }

  /**
   * A cascade of `count` coins (1..40) over `duration` s (0.2..4): dense at
   * first, thinning out, softer towards the end, over a light shimmer.
   * Coins ≥ 15 ms apart; showers ≥ 0.3 s apart, at most 32 coins pending.
   */
  coinShower(count = 12, duration = 1.2) {
    if (!this._ready()) return false;
    const now = this._now();
    if (now - this._lastShower < 0.3) return false;
    const n = Math.round(clamp(+count || 0, 0, 40));
    if (n < 1) return false;
    const d = clamp(+duration || 0, 0.2, 4);
    this._lastShower = now;
    const rnd = this._random, t0 = now + 0.004;
    const base = (this._showerSeed = (this._showerSeed + 0x9e3779b1) | 0);
    const pendingT = [];
    for (const e of this._fxQueue) if (e.tag === "coin") pendingT.push(e.t);
    // gaps grow geometrically: a dense first clatter that thins out (≥ 15 ms
    // apart; a coin landing within 10 ms of one still pending is skipped)
    const r = 1 + 2.2 / n, gaps = [0];
    let sum = 0;
    for (let k = 1; k < n; k++) { gaps.push(Math.pow(r, k - 1) * (0.8 + 0.4 * rnd())); sum += gaps[k]; }
    let t = t0;
    for (let k = 0; k < n && pendingT.length < 32; k++) {
      if (k) t = Math.max(t + (gaps[k] * d * 0.92) / sum, t + 0.015);
      const u = (t - t0) / (d * 0.92);
      const s = clamp(0.95 - 0.55 * u + 0.16 * (rnd() - 0.5), 0.25, 1);
      const h = hash32(base + k * 7919);
      const pan = (rnd() - 0.5) * 1.2;
      if (pendingT.some((p) => Math.abs(p - t) < 0.01)) continue;
      pendingT.push(t);
      this._schedule(t, "coin", (tt) => this._coinNote(tt, s, h, pan, "coin"));
    }
    this._shimmer(t0, d + 0.15, 0.03, "coin", 8500);
    this._flushFx(now);
    return true;
  }

  /** A card picked up / flipped: papery whoosh (sweeping L→R) and a soft landing tick. ~0.25 s. */
  cardFlip() {
    if (!this._ready()) return false;
    const now = this._now();
    if (now - this._lastFlip < 0.08) return false;
    this._lastFlip = now;
    const rnd = this._random, t = now + 0.003, end = t + 0.3;
    const v = this._openVoice(this._beds, BED_VOICES, t, 0, "card");
    if (v.panner) { v.panner.pan.setValueAtTime(-0.35, t); v.panner.pan.linearRampToValueAtTime(0.35, t + 0.18); }
    // whoosh: band of air sweeping up and back
    const air = this._noiseSource(v, t, end);
    const bp = this._filter(v, "bandpass", 700, 0.9);
    bp.frequency.setValueAtTime(700, t);
    bp.frequency.exponentialRampToValueAtTime(3400, t + 0.11);
    bp.frequency.exponentialRampToValueAtTime(1900, t + 0.22);
    const wg = this._gain(v, 0);
    wg.gain.setValueAtTime(0, t);
    wg.gain.linearRampToValueAtTime(FLIP_LEVEL, t + 0.07);
    wg.gain.setTargetAtTime(0, t + 0.085, 0.032);
    air.connect(bp); bp.connect(wg); wg.connect(v.gain);
    // paper: a few crinkly high spikes along the way
    const crinkle = this._noiseSource(v, t, end);
    const hp = this._filter(v, "highpass", 4200, 0.7);
    const cg = this._gain(v, 0);
    cg.gain.setValueAtTime(0, t);
    for (let i = 0; i < 6; i++) {
      const ti = t + 0.02 + 0.13 * (i / 6) + rnd() * 0.015;
      cg.gain.setValueAtTime(FLIP_LEVEL * (0.5 + 0.6 * rnd()) * Math.sin(Math.PI * (i + 0.5) / 6), ti);
      cg.gain.setTargetAtTime(0, ti, 0.004);
    }
    crinkle.connect(hp); hp.connect(cg); cg.connect(v.gain);
    // the card lands: a soft tick and a little wooden tock
    const tl = t + 0.17;
    this._partial(v, tl, 1500, FLIP_LEVEL * 0.3, 0.006, 0.0005, 5.75);
    this._partial(v, tl, 420, FLIP_LEVEL * 0.3, 0.012, 0.001, 5.75);
    const tick = this._noiseSource(v, tl, tl + 0.03);
    const tbp = this._filter(v, "bandpass", 2800, 1.2);
    const tg = this._gain(v, 0);
    tg.gain.setValueAtTime(0, tl);
    tg.gain.linearRampToValueAtTime(FLIP_LEVEL * 0.9, tl + 0.0005);
    tg.gain.setTargetAtTime(0, tl + 0.0005, 0.002);
    tick.connect(tbp); tbp.connect(tg); tg.connect(v.gain);
    this._closeVoice(this._beds, v);
    return true;
  }

  /**
   * Anticipation before a card flips (~0.7 s, rising): a low rumble opening
   * up, a rising tone and an accelerating rattle that gets brighter and
   * louder. ≥ 0.3 s apart; a new shake replaces the previous one.
   */
  cardShake() {
    if (!this._ready()) return false;
    const now = this._now();
    if (now - this._lastShake < 0.3) return false;
    this._lastShake = now;
    const rnd = this._random, t = now + 0.003, T = 0.7, end = t + T + 0.02;
    const prev = this._shakeVoice;
    if (prev && prev.end > t) this._release(prev, t, 0.02);
    const v = this._openVoice(this._beds, BED_VOICES, t, 0, "shake");
    // rumble
    const rum = this._noiseSource(v, t, end);
    const lp = this._filter(v, "lowpass", 160, 0.9);
    lp.frequency.setValueAtTime(160, t);
    lp.frequency.exponentialRampToValueAtTime(420, t + T);
    const rg = this._gain(v, 0);
    rg.gain.setValueAtTime(0, t);
    rg.gain.linearRampToValueAtTime(SHAKE_LEVEL * 0.3, t + 0.06);
    rg.gain.exponentialRampToValueAtTime(SHAKE_LEVEL, t + T - 0.04);
    rg.gain.linearRampToValueAtTime(0, t + T);
    rum.connect(lp); lp.connect(rg); rg.connect(v.gain);
    // rising tone
    const o = this._source(v, this.ctx.createOscillator(), t, end);
    o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(660, t + T);
    const og = this._gain(v, 0);
    og.gain.setValueAtTime(0, t);
    og.gain.linearRampToValueAtTime(SHAKE_LEVEL * 0.06, t + 0.1);
    og.gain.linearRampToValueAtTime(SHAKE_LEVEL * 0.22, t + T - 0.05);
    og.gain.linearRampToValueAtTime(0, t + T);
    o.connect(og); og.connect(v.gain);
    // rattle: ticks accelerating from ~13/s to ~33/s, brighter and louder
    const rat = this._noiseSource(v, t, end);
    const bp = this._filter(v, "bandpass", 1800, 2);
    bp.frequency.setValueAtTime(1800, t);
    bp.frequency.exponentialRampToValueAtTime(3600, t + T);
    const kg = this._gain(v, 0);
    kg.gain.setValueAtTime(0, t);
    let ti = t + 0.02, k = 0;
    while (ti < t + T - 0.03) {
      const p = (ti - t) / T;
      kg.gain.setValueAtTime(SHAKE_LEVEL * 2.2 * (0.25 + 0.75 * p) * (k & 1 ? 0.7 : 1) * (0.85 + 0.3 * rnd()), ti);
      kg.gain.setTargetAtTime(0, ti, 0.005);
      if (v.panner) v.panner.pan.setValueAtTime(k & 1 ? 0.22 : -0.22, ti);
      ti += 0.075 - 0.045 * p;
      k++;
    }
    rat.connect(bp); bp.connect(kg); kg.connect(v.gain);
    this._closeVoice(this._beds, v);
    this._shakeVoice = v;
    return true;
  }

  /**
   * Gacha card reveal fanfare, C-major pentatonic. kind:
   *   'new'     bright sparkly ascending arpeggio (~1 s)
   *   'gold'    warmer, richer arpeggio + bell + shimmer (~1.5 s)
   *   'rainbow' rising pentatonic glissando → major chord bloom + bell + sparkles (~2.2 s)
   *   'dupe'    a coin and a small 'coin back' ding-ding (~0.6 s)
   * ≥ 0.1 s apart; a new reveal cuts the previous one short (skipping cards).
   */
  reveal(kind = "new") {
    if (!this._ready()) return false;
    const now = this._now();
    if (now - this._lastReveal < 0.1) return false;
    this._lastReveal = now;
    this._stopTag("reveal", now);
    const rnd = this._random, t0 = now + 0.004, tag = "reveal";
    const note = (dt, midi, amp, type, o = {}) => this._schedule(t0 + dt, tag, (t) => this._toneNote(t, midi, amp, type, { tag, ...o }));
    const sparkles = (n, from, span, amp) => {
      for (let i = 0; i < n; i++) {
        note(from + span * rnd(), SPARKLE_PITCHES[Math.floor(rnd() * SPARKLE_PITCHES.length)], amp * (0.6 + 0.4 * rnd()), "tink", { pan: (rnd() - 0.5) * 1.4 });
      }
    };
    if (kind === "rainbow") {
      // the glissando sweeps C5→C8 and left→right, getting louder
      const last = RAINBOW_GLISS.length - 1;
      for (let i = 0; i <= last; i++) {
        const u = i / last;
        note(0.62 * Math.pow(u, 0.85), RAINBOW_GLISS[i], 0.03 + 0.04 * u, "pluck", { ring: 0.35, decays: 4.6, pan: -0.6 + 1.2 * u });
      }
      this._schedule(t0, tag, (t) => this._riser(t, 0.66, 0.05, tag));
      const B = 0.68;                                     // the bloom
      note(B, 84, 0.1, "bell", { keep: true, ring: 1.1 });
      [[60, 0.05], [72, 0.04], [76, 0.035], [79, 0.035], [84, 0.03], [88, 0.025]].forEach(([m, a], i) => {
        note(B + 0.004 * i, m, a, "pad", { keep: true, attack: 0.08, hold: 0.85, rel: 0.25, pan: (i / 5 - 0.5) * 0.8 });
      });
      [96, 100, 103, 108].forEach((m, i) => note(B + 0.06 * i, m, 0.06 - 0.008 * i, "pluck", { ring: 0.9 }));
      sparkles(14, B + 0.07, 1.2, 0.032);
      this._schedule(t0 + 0.6, tag, (t) => this._shimmer(t, 1.5, 0.035, tag, 8000));
    } else if (kind === "gold") {
      [79, 84, 88, 91].forEach((m, i) => note(0.08 * i, m, 0.065, "warm", { pan: -0.3 + 0.2 * i }));
      note(0.32, 84, 0.12, "bell", { keep: true });
      [[76, 0.025], [79, 0.025], [84, 0.022]].forEach(([m, a], i) => note(0.32 + 0.005 * i, m, a, "pad", { keep: true, attack: 0.06, hold: 0.5, rel: 0.2 }));
      note(0.32, 96, 0.04, "pluck");
      sparkles(7, 0.4, 0.8, 0.028);
      this._schedule(t0 + 0.3, tag, (t) => this._shimmer(t, 1.1, 0.03, tag, 7500));
    } else if (kind === "dupe") {
      const h = hash32((this._showerSeed = (this._showerSeed + 0x9e3779b1) | 0));
      this._schedule(t0, tag, (t) => this._coinNote(t, 0.55, h, 0, tag));
      note(0.06, 91, 0.05, "pluck", { ring: 0.8 });
      note(0.16, 96, 0.055, "pluck", { ring: 0.8 });
    } else {
      [84, 88, 91, 96].forEach((m, i) => note(0.065 * i, m, 0.06 + 0.008 * i, "pluck", { pan: -0.3 + 0.2 * i }));
      note(0.195, 100, 0.03, "tink");
      sparkles(4, 0.24, 0.4, 0.025);
      this._schedule(t0 + 0.15, tag, (t) => this._shimmer(t, 0.6, 0.02, tag, 9000));
    }
    this._flushFx(now);
    this.stats.reveals++;
    return true;
  }

  /** Short cheerful level-up jingle (~1 s): da-da-da-da-DING with a chord and sparkles. ≥ 0.3 s apart. */
  levelUp() {
    if (!this._ready()) return false;
    const now = this._now();
    if (now - this._lastLevelUp < 0.3) return false;
    this._lastLevelUp = now;
    this._stopTag("level", now);
    const rnd = this._random, t0 = now + 0.004, tag = "level";
    const note = (dt, midi, amp, type, o = {}) => this._schedule(t0 + dt, tag, (t) => this._toneNote(t, midi, amp, type, { tag, ...o }));
    [79, 84, 88, 91].forEach((m, i) => note(0.075 * i, m, 0.05, "chip", { pan: -0.25 + 0.17 * i }));
    note(0.33, 96, 0.06, "chip", { ring: 1.8, keep: true });
    [88, 91, 96].forEach((m, i) => note(0.33 + 0.004 * i, m, 0.04, "pluck", { ring: 1, keep: true, pan: (i - 1) * 0.3 }));
    for (let i = 0; i < 3; i++) note(0.4 + 0.12 * i + 0.05 * rnd(), [100, 103, 105][i], 0.025, "tink", { pan: (rnd() - 0.5) * 1.2 });
    this._schedule(t0 + 0.33, tag, (t) => this._shimmer(t, 0.6, 0.018, tag, 9000));
    this._flushFx(now);
    return true;
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
    this._chewTone = ctx.createBiquadFilter();
    this._chewTone.type = "lowpass"; this._chewTone.Q.value = 0.7;
    this._chewTone.connect(this._crunchBus);
    this._applyTexture();
    this._gemBus = ctx.createGain();
    this._gemBus.connect(this._musicIn);
    this._fxBus = ctx.createGain();
    this._fxBus.connect(this._musicIn);
    this._room = ctx.createConvolver();
    const roomOut = ctx.createGain(); roomOut.gain.value = 1;
    this._room.connect(roomOut).connect(this._musicIn);
    const crunchSend = ctx.createGain(); crunchSend.gain.value = 0.22;  // a touch of room
    this._crunchTone.connect(crunchSend).connect(this._room);
    const gemSend = ctx.createGain(); gemSend.gain.value = 0.55;      // wet ≈ -13 dB
    this._gemBus.connect(gemSend).connect(this._room);
    const fxSend = ctx.createGain(); fxSend.gain.value = 0.3;
    this._fxBus.connect(fxSend).connect(this._room);
    // ~1 ms of maths: keep it out of the tap handler on a live context.
    this._grains.length = 0; this._banks = null;
    this._fx.length = 0; this._beds.length = 0; this._fxQueue.length = 0;
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
    set(this._fxBus.gain, this._fxVol / DEFAULT_EFFECTS);
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
    this._flushFx(now);
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

  _grain(bank, t, velocity, rate, dest = this._crunchBus) {
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
      g.connect(pan); pan.connect(dest); nodes.push(pan);
    } else g.connect(dest);
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

  // ------------------------------------------------------------ bunny eating
  //
  // On the crunch bus (crunch volume, texture tone). Grains share the crunch
  // grain pool (GRAIN_VOICES).

  /**
   * One big bite '와삭!': a dense 60–120 ms cluster of bead snaps, a wet tear,
   * a juicy bubble or two and a soft low thump. Louder and denser than crunch().
   * ≥ 0.1 s apart. strength 0..1. Returns true when it sounded.
   */
  munch(strength = 0.8) {
    if (!this._ready()) return false;
    const now = this._now();
    if (now - this._lastMunch < MUNCH_GAP) return false;
    const s = clamp(+strength || 0, 0, 1);
    if (s < 0.03) return false;
    this._lastMunch = now;
    const rnd = this._random, slime = this.texture === "slime", banks = this._banks;
    const t0 = now + 0.002;
    const n = Math.round((slime ? 15 : 13) + 8 * s);
    const span = 0.06 + 0.05 * s + (slime ? 0.01 : 0);        // the cluster: 60–120 ms
    const rate = slime ? 0.8 : 1.15;
    for (let k = 0; k < n; k++) {
      const u = k / (n - 1);
      const t = t0 + span * Math.pow(u, 1.35) + (k ? rnd() * 0.003 : 0);
      const v = (0.5 + 0.4 * s) * (1 - 0.55 * u) * (0.6 + 0.4 * rnd()) * (k === 0 ? 1.3 : 1);
      this._grain(banks.beads, t, v, rate);
    }
    this._grain(banks.tear, t0 + 0.008, (0.45 + 0.45 * s) * (slime ? 1.15 : 0.85), slime ? 0.85 : 1.1);
    for (let k = slime ? 2 : 1; k > 0; k--) {
      this._grain(banks.pop, t0 + 0.03 + rnd() * 0.07, 0.16 + 0.14 * s, (slime ? 1.5 : 2.1) * (0.9 + 0.2 * rnd()));
    }
    this._thump(t0, s, slime);
    this.stats.munches++;
    this._lastPulse = t0;
    this._emitNote(0, s, 0, t0);
    return true;
  }

  /**
   * Chewing '냠냠': soft, muffled wet crunches ~7 per second (strong–weak
   * pairs) fading out over `duration` s (0.05..4). Calling it again while
   * chewing keeps the rhythm and restarts the fade. Returns true when scheduled.
   */
  chew(duration = 0.4) {
    if (!this._ready()) return false;
    const d = clamp(+duration || 0, 0, 4);
    if (d < 0.05) return false;
    const now = this._now(), rnd = this._random;
    let start = now + 0.002;
    const pending = this._fxQueue.find((e) => e.tag === "chew");
    if (pending) start = pending.t;
    else if (start - this._lastBite < 0.12) start = this._lastBite + 0.13;
    this._cancel("chew");
    let k = this._chewCount, t = start;
    while (t < now + d - 0.03) {
      const v = Math.pow(1 - (t - now) / d, 1.2) * (k & 1 ? 0.8 : 1);
      this._schedule(t, "chew", (tt) => this._chewBite(tt, v));
      t += (k & 1 ? 0.16 : 0.13) * (0.92 + 0.16 * rnd());
      k++;
    }
    this._chewCount = k;
    this._flushFx(now);
    return true;
  }

  _chewBite(t, v) {
    const rnd = this._random, slime = this.texture === "slime", banks = this._banks;
    this._lastBite = t;
    this._grain(banks.chew, t, 0.5 * v, slime ? 0.85 : 1, this._chewTone);
    const n = 2 + Math.floor(rnd() * 2);
    let tt = t + 0.004, vv = 0.6 * v;
    for (let i = 0; i < n; i++) {
      this._grain(banks.beads, tt, vv, slime ? 0.6 : 0.72, this._chewTone);
      tt += 0.006 + rnd() * 0.012;
      vv *= 0.7;
    }
    this.stats.chewBites++;
  }

  // The soft low "thump" of the bite (jaw + jelly body).
  _thump(t, s, slime) {
    const ctx = this.ctx;
    const f = (slime ? 80 : 105) * (0.94 + 0.12 * this._random());
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(f * 1.5, t);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.025);
    o.frequency.exponentialRampToValueAtTime(f * 0.7, t + 0.15);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(THUMP_LEVEL * (0.4 + 0.6 * s), t + 0.006);
    g.gain.setTargetAtTime(0, t + 0.006, slime ? 0.045 : 0.035);
    o.connect(g); g.connect(this._crunchBus);
    o.start(t); o.stop(t + 0.3);
    o.onended = () => { try { o.disconnect(); g.disconnect(); } catch { /* gone */ } };
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
    this._banks = { beads, squelch, pop, ...this._makeFxBanks(make) };
  }
  // Effect banks and waves, from a fixed seed (the engine RNG stays untouched).
  _makeFxBanks(make) {
    const ctx = this.ctx, sr = ctx.sampleRate, rnd = seededRandom(0x6a656c6c);
    const TAU = Math.PI * 2;
    // 2 s of white noise for whooshes, shimmer, rattles and clicks (looped).
    const nlen = Math.floor(2 * sr);
    this._fxNoise = ctx.createBuffer(1, nlen, sr);
    const nd = this._fxNoise.getChannelData(0);
    for (let i = 0; i < nlen; i++) nd[i] = rnd() * 2 - 1;
    // Wet tear (munch): a dense run of wet micro-clicks that slows as the
    // jelly tears through, under a falling formant, with crackly juice fizz
    // and a low slurp.
    const tear = [];
    for (let k = 0; k < 5; k++) {
      const dur = 0.12 + rnd() * 0.05, fA = 1600 + rnd() * 1000, fB = fA * (0.5 + rnd() * 0.15);
      tear.push(make(dur, (d, len) => {
        let t = 0.0015;
        while (t < dur - 0.01) {
          const p = t / dur, f = fA + (fB - fA) * p, tau = 0.0005 + 0.0009 * rnd();
          const amp = Math.min(1, t / 0.004) * Math.pow(1 - p, 1.3) * (0.35 + 0.65 * rnd());
          const i0 = Math.floor(t * sr), span = Math.floor(tau * 7 * sr), ph = rnd() * TAU;
          for (let j = 0; j < span && i0 + j < len; j++) {
            const u = j / sr;
            d[i0 + j] += amp * Math.sin(TAU * f * u + ph) * Math.exp(-u / tau);
          }
          t += 0.0006 + 0.012 * p * p + rnd() * 0.002;
        }
        let lp = 0, lp2 = 0;
        for (let i = 0; i < len; i++) {
          const t = i / sr, p = i / len, n = rnd() * 2 - 1;
          lp += 0.45 * (n - lp); lp2 += 0.04 * (n - lp2);
          d[i] += (n - lp) * 0.5 * Math.exp(-t / 0.035) * (rnd() < 0.12 ? 1 : 0.12)
            + lp2 * 1.8 * Math.sin(Math.PI * Math.min(1, p * 1.6)) * (1 - p);
        }
      }));
    }
    // Chew (냠): a soft low-passed wet squish, a few tiny wet clicks and a muffled 'm'.
    const chew = [];
    for (let k = 0; k < 4; k++) {
      const dur = 0.07 + rnd() * 0.02, fm = 190 + rnd() * 80, cf = 800 + rnd() * 600;
      const clicks = [];
      for (let c = 3 + Math.floor(rnd() * 4); c > 0; c--) clicks.push([0.003 + rnd() * 0.04, 0.3 + 0.3 * rnd(), rnd() * TAU]);
      chew.push(make(dur, (d, len) => {
        let lp = 0;
        for (let i = 0; i < len; i++) {
          const t = i / sr, n = rnd() * 2 - 1;
          lp += 0.12 * (n - lp);
          d[i] = lp * 2.4 * Math.min(1, t / 0.006) * Math.exp(-t / 0.022)
            + 0.35 * Math.sin(TAU * fm * t) * Math.min(1, t / 0.004) * Math.exp(-t / 0.018);
        }
        for (const [t0, a, ph] of clicks) {
          const i0 = Math.floor(t0 * sr);
          for (let j = 0; j < 0.006 * sr && i0 + j < len; j++) {
            const u = j / sr;
            d[i0 + j] += a * Math.sin(TAU * cf * u + ph) * Math.exp(-u / 0.0008);
          }
        }
      }));
    }
    const wave = (h) => ctx.createPeriodicWave(new Float32Array(h.length), new Float32Array(h));
    this._waves = {
      voice: wave([0, 1, 0.36, 0.14, 0.06, 0.025]),       // soft, round bunny voice
      chip: wave([0, 1, 0, 0.28, 0, 0.12, 0, 0.05]),       // gentle square (level-up)
      pad: wave([0, 1, 0.2, 0.07, 0.025]),                 // chord bloom
    };
    return { tear, chew };
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
      const key = v.t0 + (v.released ? -1e6 : 0) + (v.bass && v.bar === bar ? 1e6 : 0) + (v.keep ? 1e3 : 0);
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

  // ------------------------------------------------------------ fx scheduling
  //
  // A small time-ordered queue of sound parts. _flushFx() (called by every fx
  // method and by the lookahead scheduler) hands everything due before
  // now + LOOKAHEAD to Web Audio; parts made stale by a stalled timer are
  // dropped on a live context. Tags let a new reveal/chew replace the old one.

  _schedule(t, tag, fn) {
    const q = this._fxQueue;
    if (q.length >= FX_QUEUE_MAX) return false;
    let i = q.length;
    while (i > 0 && q[i - 1].t > t) i--;
    q.splice(i, 0, { t, tag, fn });
    return true;
  }

  _cancel(tag) {
    const q = this._fxQueue;
    let j = 0;
    for (let i = 0; i < q.length; i++) if (q[i].tag !== tag) q[j++] = q[i];
    q.length = j;
  }

  // Cancel a tag's pending parts and fade out its sounding voices.
  _stopTag(tag, t) {
    this._cancel(tag);
    for (const list of [this._fx, this._beds]) {
      for (const v of list) if (v.tag === tag && v.end > t) this._release(v, t, 0.03);
    }
  }

  _flushFx(now) {
    const q = this._fxQueue;
    if (!q.length) return;
    if (!this.enabled) { q.length = 0; return; }
    if (!this._banks) return;
    const horizon = now + LOOKAHEAD;
    while (q.length && q[0].t < horizon) {
      const e = q.shift();
      if (this._offline) e.fn(e.t);
      else if (e.t >= now - 0.05) e.fn(Math.max(e.t, now + 0.002));
    }
  }

  // --------------------------------------------------------------- fx voices
  //
  // A voice is one GainNode (never automated except by _release, so stealing
  // works) → panner → fx bus, with any number of sources/filters inside.

  _openVoice(list, limit, t, pan, tag) {
    const ctx = this.ctx;
    this._prune(list, t);
    if (list.length >= limit) {
      this._steal(list, t, 0.008, -1);
      if (list === this._fx) this.stats.fxSteals++; else this.stats.bedSteals++;
    }
    const gain = ctx.createGain();
    const v = { t0: t, end: t, gain, nodes: [gain], oscs: [], stops: [], bass: false, bar: -1, released: false, relT: 0, tag, keep: false, panner: null };
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      gain.connect(p); p.connect(this._fxBus);
      v.nodes.push(p); v.panner = p;
    } else gain.connect(this._fxBus);
    return v;
  }

  _closeVoice(list, v) {
    if (!v.oscs.length) { for (const n of v.nodes) { try { n.disconnect(); } catch { /* gone */ } } return; }
    this._finishVoice(v.nodes, v.oscs, v.stops, v);
    list.push(v);
    if (list === this._fx) { this.stats.fxNotes++; if (list.length > this.stats.maxFxVoices) this.stats.maxFxVoices = list.length; }
    else { this.stats.beds++; if (list.length > this.stats.maxBeds) this.stats.maxBeds = list.length; }
  }

  _source(v, node, t, stopAt, offset) {
    if (offset === undefined) node.start(t); else node.start(t, offset);
    node.stop(stopAt);
    v.nodes.push(node); v.oscs.push(node); v.stops.push(stopAt);
    return node;
  }

  // Looping fixed-seed white noise from a random point (deterministic per seed).
  _noiseSource(v, t, stopAt) {
    const src = this.ctx.createBufferSource();
    src.buffer = this._fxNoise;
    src.loop = true;
    return this._source(v, src, t, stopAt, this._random() * (this._fxNoise.duration - 0.01));
  }

  _filter(v, type, f, q) {
    const b = this.ctx.createBiquadFilter();
    b.type = type; b.frequency.value = f; b.Q.value = q;
    v.nodes.push(b);
    return b;
  }

  _gain(v, value) {
    const g = this.ctx.createGain();
    g.gain.value = value;
    v.nodes.push(g);
    return g;
  }

  // One exponentially decaying partial (sine or a PeriodicWave) into the voice.
  _partial(v, t, f, a, tau, attack, decays, wave) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    if (wave) o.setPeriodicWave(wave);
    o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(a, t + attack);
    g.gain.setTargetAtTime(0, t + attack, tau);
    o.connect(g); g.connect(v.gain);
    v.nodes.push(g);
    this._source(v, o, t, t + attack + tau * decays);
    return g;
  }

  // A fanfare note. type: pluck | warm | tink | bell | chip | pad.
  // o: { tag, pan, ring (decay scale), decays (stop at e^-decays), keep,
  //      attack/hold/rel (pad only) }.
  _toneNote(t, midi, amp, type, o = {}) {
    const ctx = this.ctx, f = mtof(midi), fMax = Math.min(16000, ctx.sampleRate * 0.45);
    const v = this._openVoice(this._fx, FX_VOICES, t, o.pan || 0, o.tag || "");
    v.keep = !!o.keep;
    const ring = o.ring || 1, decays = o.decays || 5.75;
    if (type === "pad") {
      // two detuned soft voices swelling in, holding, then letting go
      const att = o.attack ?? 0.1, hold = o.hold ?? 0.6, rel = o.rel ?? 0.3;
      const g = this._gain(v, 0);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(amp * 0.5, t + att);
      g.gain.setTargetAtTime(amp * 0.3, t + att, 0.5);
      g.gain.setTargetAtTime(0, t + att + hold, rel);
      g.connect(v.gain);
      const stopAt = t + att + hold + rel * decays;
      for (const det of [0.997, 1.003]) {
        const osc = ctx.createOscillator();
        osc.setPeriodicWave(this._waves.pad);
        osc.frequency.value = f * det;
        osc.connect(g);
        this._source(v, osc, t, stopAt);
      }
    } else {
      const spec = TONES[type] || TONES.pluck;
      const wave = spec.wave ? this._waves[spec.wave] : null;
      let norm = 0;
      for (const l of spec.levels) norm += l;
      if (spec.beat) norm += 0.45;
      for (let k = 0; k < spec.ratios.length; k++) {
        const fk = f * spec.ratios[k];
        if (fk > fMax) continue;
        const a = amp * spec.levels[k] / norm, tau = spec.taus[k] * ring;
        this._partial(v, t, fk, a, tau, spec.attack, decays, wave);
        if (spec.ratios[k] === 1 && spec.beat) this._partial(v, t, fk * spec.beat, a * 0.45, tau, spec.attack, decays, wave);
      }
    }
    this._closeVoice(this._fx, v);
    return v;
  }

  // Gold coin: struck-disc modes (inharmonic, one beating pair), a sharp
  // chink, and two little bounce re-hits ('ching-ch-ch'). Modes with similar
  // decay share one envelope (3 automated gains per coin, not 5).
  _coinNote(t, s, h, pan, tag) {
    const ctx = this.ctx, fMax = Math.min(16000, ctx.sampleRate * 0.45);
    const v = this._openVoice(this._fx, FX_VOICES, t, pan, tag);
    const f = COIN_BASE * (0.93 + 0.15 * ((h & 1023) / 1023));
    const ring = 0.85 + 0.3 * (((h >>> 10) & 255) / 255);
    const b1 = 0.035 + 0.03 * (((h >>> 18) & 63) / 63);
    const b2 = b1 + 0.025 + 0.02 * (((h >>> 24) & 63) / 63);
    const r1 = 0.32 + 0.18 * s, r2 = 0.14;
    const amp = COIN_LEVEL * (0.2 + 0.8 * s);
    let norm = 0;
    for (const l of COIN_LEVELS) norm += l;
    for (const group of COIN_GROUPS) {
      const tau = COIN_TAUS[group[0]] * ring, stopAt = t + b2 + tau * 5.75;
      const env = this._gain(v, 0);
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(amp, t + 0.0005);
      env.gain.setTargetAtTime(0, t + 0.0005, tau);
      env.gain.setTargetAtTime(amp * r1, t + b1, 0.0003);
      env.gain.setTargetAtTime(0, t + b1 + 0.0012, tau);
      env.gain.setTargetAtTime(amp * r2, t + b2, 0.0003);
      env.gain.setTargetAtTime(0, t + b2 + 0.0012, tau);
      env.connect(v.gain);
      for (const k of group) {
        const fk = f * COIN_RATIOS[k];
        if (fk > fMax) continue;
        const o = ctx.createOscillator();
        o.frequency.value = fk;
        const g = this._gain(v, COIN_LEVELS[k] / norm);
        o.connect(g); g.connect(env);
        this._source(v, o, t, stopAt);
      }
    }
    const src = this._noiseSource(v, t, t + b2 + 0.02);
    const hp = this._filter(v, "highpass", 5200, 0.7);
    const cg = this._gain(v, 0);
    cg.gain.setValueAtTime(0, t);
    cg.gain.linearRampToValueAtTime(amp * 0.6, t + 0.0004);
    cg.gain.setTargetAtTime(0, t + 0.0004, 0.0012);
    cg.gain.setTargetAtTime(amp * 0.6 * r1, t + b1, 0.0002);
    cg.gain.setTargetAtTime(0, t + b1 + 0.0006, 0.001);
    cg.gain.setTargetAtTime(amp * 0.6 * r2, t + b2, 0.0002);
    cg.gain.setTargetAtTime(0, t + b2 + 0.0006, 0.001);
    src.connect(hp); hp.connect(cg); cg.connect(v.gain);
    this._closeVoice(this._fx, v);
    this.stats.coins++;
  }

  // One voiced squeak syllable: pitch contour f[0] → f[1] (at 55 %) → f[2],
  // a soft harmonic source through a closing low-pass (bright 'y' → round 'u'),
  // an optional 'k' click (k = its level) and growing vibrato (depth, ratio).
  _syllable(v, t, dur, f, amp, lpFrom, lpTo, k, vibrato) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.setPeriodicWave(this._waves.voice);
    o.frequency.setValueAtTime(f[0], t);
    o.frequency.exponentialRampToValueAtTime(f[1], t + dur * 0.55);
    o.frequency.exponentialRampToValueAtTime(f[2], t + dur);
    const lp = this._filter(v, "lowpass", lpFrom, 1);
    lp.frequency.setValueAtTime(lpFrom, t);
    lp.frequency.exponentialRampToValueAtTime(lpTo, t + dur);
    const g = this._gain(v, 0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(amp, t + 0.012);
    g.gain.linearRampToValueAtTime(amp * 0.8, t + dur * 0.65);
    g.gain.linearRampToValueAtTime(0, t + dur);
    o.connect(lp); lp.connect(g); g.connect(v.gain);
    this._source(v, o, t, t + dur + 0.01);
    if (vibrato) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 6.5;
      const depth = this._gain(v, 0);
      depth.gain.setValueAtTime(0, t);
      depth.gain.linearRampToValueAtTime(f[1] * vibrato, t + dur);
      lfo.connect(depth); depth.connect(o.frequency);
      this._source(v, lfo, t, t + dur + 0.01);
    }
    if (k) {
      const src = this._noiseSource(v, t, t + 0.03);
      const bp = this._filter(v, "bandpass", 3400, 1.5);
      const kg = this._gain(v, 0);
      kg.gain.setValueAtTime(0, t);
      kg.gain.linearRampToValueAtTime(amp * 0.35 * k, t + 0.0006);
      kg.gain.setTargetAtTime(0, t + 0.0006, 0.0025);
      src.connect(bp); bp.connect(kg); kg.connect(v.gain);
    }
  }

  // The soft breathy 'h' of 흐.
  _breath(v, t, dur, amp) {
    const src = this._noiseSource(v, t, t + dur + 0.01);
    const bp = this._filter(v, "bandpass", 1600, 0.7);
    const g = this._gain(v, 0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(amp, t + dur * 0.45);
    g.gain.linearRampToValueAtTime(0, t + dur);
    src.connect(bp); bp.connect(g); g.connect(v.gain);
  }

  // Glittery high shimmer bed: two band-passed noises spread L/R with a fast flutter.
  _shimmer(t, dur, level, tag, fc) {
    const ctx = this.ctx;
    const v = this._openVoice(this._beds, BED_VOICES, t, 0, tag);
    const stopAt = t + dur * 0.45 + dur * 0.18 * 5 + 0.02;
    const env = this._gain(v, 0);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(level, t + Math.min(0.08, dur * 0.2));
    env.gain.setTargetAtTime(0, t + dur * 0.45, dur * 0.18);
    const trem = this._gain(v, 0.55);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 17 + 6 * this._random();
    const depth = this._gain(v, 0.45);
    lfo.connect(depth); depth.connect(trem.gain);
    this._source(v, lfo, t, stopAt);
    trem.connect(env); env.connect(v.gain);
    for (const side of [-0.6, 0.6]) {
      const src = this._noiseSource(v, t, stopAt);
      const bp = this._filter(v, "bandpass", fc * (side < 0 ? 0.92 : 1.08), 0.9);
      src.connect(bp);
      if (ctx.createStereoPanner) {
        const p = ctx.createStereoPanner();
        p.pan.value = side;
        bp.connect(p); p.connect(trem); v.nodes.push(p);
      } else bp.connect(trem);
    }
    this._closeVoice(this._beds, v);
  }

  // Rising airy swell under the rainbow glissando.
  _riser(t, dur, level, tag) {
    const v = this._openVoice(this._beds, BED_VOICES, t, 0, tag);
    const src = this._noiseSource(v, t, t + dur + 0.4);
    const bp = this._filter(v, "bandpass", 1200, 1.2);
    bp.frequency.setValueAtTime(1200, t);
    bp.frequency.exponentialRampToValueAtTime(9000, t + dur);
    const g = this._gain(v, 0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level * 0.15, t + dur * 0.3);
    g.gain.linearRampToValueAtTime(level, t + dur);
    g.gain.setTargetAtTime(0, t + dur, 0.06);
    src.connect(bp); bp.connect(g); g.connect(v.gain);
    this._closeVoice(this._beds, v);
  }
}
