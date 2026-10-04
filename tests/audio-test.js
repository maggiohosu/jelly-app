// Offline tests for src/app/audio.js. Loaded by tests/audio.test.html; results
// go to the page and to window.__audioTest = { done, failures, lines, wav }.
import { JellyAudio } from "../src/app/audio.js";

const lines = [];
let failures = 0;
const logEl = document.getElementById("log");
const log = (s) => { lines.push(s); if (logEl) logEl.textContent += s + "\n"; };
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
};
const info = (s) => log(`INFO  ${s}`);
const fmt = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : String(x));
const dB = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- signal utils
function mono(buffer) {
  const n = buffer.length, m = new Float32Array(n);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const d = buffer.getChannelData(ch);
    for (let i = 0; i < n; i++) m[i] += d[i] / buffer.numberOfChannels;
  }
  return m;
}
function rmsOf(buffer, t0, t1) {
  const sr = buffer.sampleRate;
  const i0 = Math.max(0, Math.floor(t0 * sr)), i1 = Math.min(buffer.length, Math.floor(t1 * sr));
  let s = 0, n = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const d = buffer.getChannelData(ch);
    for (let i = i0; i < i1; i++) s += d[i] * d[i];
    n += Math.max(0, i1 - i0);
  }
  return Math.sqrt(s / Math.max(1, n));
}
function samplePeak(buffer, t0 = 0, t1 = Infinity) {
  const sr = buffer.sampleRate;
  const i0 = Math.max(0, Math.floor(t0 * sr)), i1 = Math.min(buffer.length, Math.floor(t1 * sr));
  let p = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const d = buffer.getChannelData(ch);
    for (let i = i0; i < i1; i++) { const a = Math.abs(d[i]); if (a > p) p = a; }
  }
  return p;
}
// 4× oversampled true-peak estimate (32-tap Hann-windowed sinc around loud samples).
function truePeak(buffer) {
  const H = 16, fracs = [0.25, 0.5, 0.75];
  const kernels = fracs.map((f) => {
    const k = new Float64Array(2 * H);
    for (let j = -H + 1; j <= H; j++) {
      const u = j - f;
      const sinc = u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u);
      k[j + H - 1] = sinc * 0.5 * (1 + Math.cos(Math.PI * u / H));
    }
    return k;
  });
  const sp = samplePeak(buffer);
  let tp = sp;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const d = buffer.getChannelData(ch);
    for (let i = H; i < d.length - H; i++) {
      if (Math.abs(d[i]) < sp * 0.5) continue;
      for (const k of kernels) {
        let y = 0;
        for (let j = -H + 1; j <= H; j++) y += d[i + j] * k[j + H - 1];
        if (Math.abs(y) > tp) tp = Math.abs(y);
      }
    }
  }
  return tp;
}
// Hann-windowed DFT power at one frequency.
function tonePower(x, start, N, f, sr) {
  let re = 0, im = 0;
  const w = (2 * Math.PI * f) / sr;
  const s0 = Math.max(0, Math.floor(start));
  for (let n = 0; n < N && s0 + n < x.length; n++) {
    const v = x[s0 + n] * (0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (N - 1)));
    re += v * Math.cos(w * n); im -= v * Math.sin(w * n);
  }
  return re * re + im * im;
}
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

function encodeWav(buffer) {
  const ch = buffer.numberOfChannels, n = buffer.length, sr = buffer.sampleRate;
  const bytes = new Uint8Array(44 + n * ch * 2);
  const v = new DataView(bytes.buffer);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + n * ch * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, n * ch * 2, true);
  const data = []; for (let c = 0; c < ch; c++) data.push(buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
    const s = Math.max(-1, Math.min(1, data[c][i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
  }
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// ------------------------------------------------- the old boing, for comparison
// Verbatim synthesis from the previous audio.js; only the time source differs
// (`self.when` instead of ctx.currentTime, so it can be scheduled offline).
function legacyGraph(ctx) {
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -18; compressor.ratio.value = 6;
  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(compressor).connect(ctx.destination);
  const length = Math.floor(ctx.sampleRate * 0.25);
  const noiseBuf = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = noiseBuf.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return { ctx, master, noise: noiseBuf };
}
function legacyBoing(self, strength, pitch = 1, kind = "drop") {
  const ctx = self.ctx;
  const now = self.when;
  const s = Math.max(0.05, Math.min(1, strength));
  const base = (kind === "bump" ? 150 : kind === "snap" ? 260 : 190) * pitch;
  const duration = kind === "snap" ? 0.32 : 0.42;
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
  osc.connect(tone).connect(env).connect(self.master);
  const noise = ctx.createBufferSource();
  noise.buffer = self.noise;
  const band = ctx.createBiquadFilter();
  band.type = "bandpass"; band.frequency.value = 700 * pitch; band.Q.value = 1.4;
  const noiseEnv = ctx.createGain();
  noiseEnv.gain.setValueAtTime(0.0001, now);
  noiseEnv.gain.exponentialRampToValueAtTime(0.09 * s, now + 0.006);
  noiseEnv.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);
  noise.connect(band).connect(noiseEnv).connect(self.master);
  osc.start(now); lfo.start(now); noise.start(now);
  osc.stop(now + duration + 0.02); lfo.stop(now + duration + 0.02); noise.stop(now + 0.1);
}

// ======================================================================= tests
const SR = 48000;
const C = JellyAudio.CHORDS;
const PENTA = new Set([0, 2, 4, 7, 9]);
const LIMITS = JellyAudio.VOICE_LIMITS;

async function testApi() {
  const a = new JellyAudio();
  const methods = ["unlock", "suspend", "resume", "setEnabled", "setVolumes", "boing", "setActivity", "onNote", "clink", "dispose"];
  check("API: all methods present", methods.every((m) => typeof a[m] === "function"), methods.filter((m) => typeof a[m] !== "function").join(","));
  check("API: default tempo 92", a.tempo === 92);
  a.tempo = 110; check("API: tempo setter", a.tempo === 110);
  a.setVolumes({ gems: 0.25 });
  const v = a.volumes;
  check("API: setVolumes keeps omitted keys / defaults", v.master === 0.9 && v.piano === 0.7 && v.gems === 0.25 && v.boing === 0.6, JSON.stringify(v));
  // Calls before unlock() must be harmless no-ops.
  let threw = null;
  try { a.setActivity(0.5, 0.5); a.boing(1, 1, "drop"); a.clink(1, 3); a.suspend(); a.resume(); a.setEnabled(false); a.setEnabled(true); a.dispose(); } catch (e) { threw = e; }
  check("API: safe to call everything before unlock()", !threw, threw ? threw.message : "");
  check("API: voice limits 10 piano / 6 gems", LIMITS.piano === 10 && LIMITS.gems === 6, JSON.stringify(LIMITS));
}

// Output stage: quiet signals at unity, overloads limited below 0 dBFS.
async function testOutputStage() {
  const run = async (amp) => {
    const ctx = new OfflineAudioContext(2, SR, SR);
    const audio = new JellyAudio({ context: ctx, random: mulberry32(1) });
    const osc = ctx.createOscillator(); osc.frequency.value = 997;
    const g = ctx.createGain(); g.gain.value = amp;
    osc.connect(g).connect(audio._musicIn); osc.start(0);
    const buf = await ctx.startRendering();
    return buf;
  };
  const quiet = await run(0.1);
  const gain = rmsOf(quiet, 0.3, 0.9) / (0.1 * 0.9 / Math.SQRT2);
  check("limiter: small-signal gain ≈ unity (make-up compensated)", Math.abs(dB(gain)) < 0.3, `${fmt(dB(gain), 2)} dB`);
  const loud = await run(4);  // +12 dBFS into the limiter
  const tp = truePeak(loud);
  check("limiter: +12 dBFS sine stays below 0 dBFS", tp < 1, `true peak ${fmt(dB(tp), 2)} dBFS`);
}

// boing(): identical synthesis, same level as before at default volumes.
async function testBoingMatchesLegacy() {
  for (const [kind, s, p] of [["drop", 0.8, 1.0], ["bump", 0.6, 0.9], ["snap", 1, 1.15]]) {
    const len = Math.floor(0.7 * SR);
    const realRandom = Math.random;
    Math.random = mulberry32(777);
    const oldCtx = new OfflineAudioContext(2, len, SR);
    const legacy = legacyGraph(oldCtx);
    legacy.when = 0.1;
    legacyBoing(legacy, s, p, kind);
    Math.random = mulberry32(777);
    const newCtx = new OfflineAudioContext(2, len, SR);
    const audio = new JellyAudio({ context: newCtx, random: mulberry32(5) });
    Math.random = realRandom;
    audio.advanceTo(0.1);
    audio.boing(s, p, kind);
    const [A, B] = await Promise.all([oldCtx.startRendering(), newCtx.startRendering()]);
    const a = A.getChannelData(0), b = B.getChannelData(0);
    // best lag (the output limiter adds a ~6 ms look-ahead delay)
    let best = -1, bestLag = 0, ea = 0;
    for (let i = 0; i < len; i++) ea += a[i] * a[i];
    for (let lag = 0; lag <= 600; lag++) {
      let ab = 0, eb = 0;
      for (let i = 0; i + lag < len; i++) { ab += a[i] * b[i + lag]; eb += b[i + lag] * b[i + lag]; }
      const r = ab / Math.sqrt(ea * eb + 1e-30);
      if (r > best) { best = r; bestLag = lag; }
    }
    const level = dB(rmsOf(B, 0, 0.7) / rmsOf(A, 0, 0.7));
    check(`boing '${kind}' identical to the old sound (after the 6 ms limiter look-ahead)`, best > 0.99999 && Math.abs(level) < 0.1 && Math.abs(bestLag / SR - 0.006) < 0.0005,
      `corr ${fmt(best, 7)} at ${fmt((bestLag / SR) * 1000, 2)} ms, level ${fmt(level, 2)} dB, old peak ${fmt(samplePeak(A), 3)}`);
  }
}

// Activity smoothing: ~0.15 s attack, ~1.2 s release, stale input → 0.
async function testSmoothing() {
  const ctx = new OfflineAudioContext(1, SR, SR);
  const a = new JellyAudio({ context: ctx });
  let t = 0;
  const run = (secs, act) => { for (let i = 0; i < secs * 60; i++) { t += 1 / 60; a.advanceTo(t); a.setActivity(act, 0.5); } };
  run(0.15, 1);
  const up = a.activity;
  run(1.2, 0);
  const down = a.activity;
  run(1, 0.8);
  for (let i = 0; i < 60; i++) { t += 1 / 60; a.advanceTo(t); }   // no setActivity for 1 s
  const stale = a.activity;
  check("activity: attack reaches ≥ 0.9 within 0.15 s", up >= 0.9, fmt(up));
  check("activity: release falls to ≤ 0.06 within 1.2 s", down <= 0.06, fmt(down));
  check("activity: stops when setActivity() is no longer called", stale < 0.3, fmt(stale));
}

let mainRender = null;

async function testMainRender() {
  const seconds = 12, eighth = 30 / 92;
  const act = (t) => (t < 1 ? 0 : t < 6 ? (0.8 * (t - 1)) / 5 : t < 9 ? 0.8 : 0);
  const reg = (t) => 0.5 + 0.2 * Math.sin(t * 0.7);
  const notes = [], clinks = [], burst = [];
  const clinkPlan = [[0.3, 0.6, 11], [2.0, 0.5, 3], [3.3, 0.9, 7], [5.1, 0.4, 21], [6.4, 0.7, 5], [7.05, 1, 9], [8.2, 0.6, 2], [10.0, 0.5, 17], [10.9, 0.8, 4]];
  const boingPlan = [[0.15, 0.7, 1.0, "drop"], [4.2, 0.5, 0.9, "bump"], [7.7, 0.9, 1.08, "snap"]];
  const near = (t, x) => Math.abs(t - x) < 0.5 / 60;
  let frame = 0;
  const t0 = performance.now();
  const { buffer, audio } = await JellyAudio.renderOffline(seconds, (a, t) => {
    frame++;
    a.setActivity(act(t), reg(t));
    for (const [ct, s, seed] of clinkPlan) if (near(t, ct)) clinks.push({ t, midi: a.clink(s, seed), chord: a.chordAt(t) });
    if (t >= 8.5 && t < 8.5 + 6 / 60) burst.push(a.clink(0.7, frame));
    for (const [bt, s, p, kind] of boingPlan) if (near(t, bt)) a.boing(s, p, kind);
  }, { sampleRate: SR, random: mulberry32(12345), setup: (a) => a.onNote((e) => notes.push(e)) });
  const renderMs = performance.now() - t0;
  mainRender = buffer;
  const origin = audio.gridOrigin;
  info(`main render: ${seconds} s in ${fmt(renderMs, 0)} ms (${fmt((seconds * 1000) / renderMs, 1)}× realtime, desktop Chromium), ${notes.length} melody notes, ${audio.stats.bassNotes} bass notes, stats ${JSON.stringify(audio.stats)}`);

  const activeRms = rmsOf(buffer, 3, 9);
  check("main: output not silent while active (RMS 3–9 s)", activeRms > 0.01, `${fmt(dB(activeRms), 1)} dBFS`);
  const tp = truePeak(buffer);
  check("main: true peak < 1.0", tp < 1, `${fmt(tp, 3)} (${fmt(dB(tp), 2)} dBFS), sample peak ${fmt(samplePeak(buffer), 3)}`);

  check("main: onNote fired for melody notes", notes.length >= 12, String(notes.length));
  check("main: no notes before activity starts (t < 1 s)", notes.every((n) => n.time >= 1));
  const first = notes[0]?.time ?? NaN;
  check("main: first note soon after activity rises (on the next 8th)", first > 1 && first < 2.2, `first at ${fmt(first)} s`);
  const sixteenth = eighth / 2;
  let worst = 0, on8 = 0;
  for (const n of notes) {
    const k = (n.time - origin) / sixteenth;
    worst = Math.max(worst, Math.abs(k - Math.round(k)) * sixteenth);
    if (Math.round(k) % 2 === 0) on8++;
  }
  check("main: every note on the grid (±10 ms)", worst <= 0.01, `worst ${fmt(worst * 1000, 3)} ms`);
  check("main: most notes on 8ths (16ths only as pickups/runs)", on8 / notes.length >= 0.75, `${on8}/${notes.length}`);
  const sixteenths = notes.filter((n) => Math.round((n.time - origin) / sixteenth) % 2 !== 0);
  check("main: 16th pickups only when activity is high", sixteenths.every((n) => act(n.time - 0.2) > 0.55 || act(n.time) > 0.55),
    `${sixteenths.length} sixteenths at ${sixteenths.map((n) => fmt(n.time, 2)).join(",")}`);
  const chordOf = (t) => (Math.floor((t - origin) / (8 * eighth) + 1e-6) % 4 + 4) % 4;
  check("main: onNote chord = I–V–vi–IV bar index", notes.every((n) => n.chord === chordOf(n.time)));
  check("main: melody stays in C major pentatonic", notes.every((n) => PENTA.has(n.midi % 12)));
  check("main: melody register C3..C7", notes.every((n) => n.midi >= 48 && n.midi <= 96), `${Math.min(...notes.map((n) => n.midi))}..${Math.max(...notes.map((n) => n.midi))}`);
  const downbeats = notes.filter((n) => Math.round((n.time - origin) / sixteenth) % 16 === 0);
  const dbChord = downbeats.filter((n) => C[n.chord].tones.includes(n.midi % 12)).length;
  check("main: beat-1 melody notes are chord tones", dbChord / Math.max(1, downbeats.length) >= 0.9, `${dbChord}/${downbeats.length}`);
  check("main: velocity follows activity", (() => {
    const lo = notes.filter((n) => n.time < 2.6), hi = notes.filter((n) => n.time > 6 && n.time < 9);
    const avg = (l) => l.reduce((s, n) => s + n.velocity, 0) / Math.max(1, l.length);
    return lo.length > 0 && hi.length > 0 && avg(hi) > avg(lo) + 0.2;
  })());
  const dens = (t0, t1) => notes.filter((n) => n.time >= t0 && n.time < t1).length / (t1 - t0);
  check("main: note density grows with activity", dens(6, 9) > dens(1.5, 3.5) * 1.5, `${fmt(dens(1.5, 3.5), 2)}/s → ${fmt(dens(6, 9), 2)}/s`);

  // The first note must actually sound when onNote says so (± 10 ms).
  if (notes.length) {
    const x = mono(buffer);
    const hop = Math.round(0.001 * SR);
    const energy = (i) => { let s = 0; for (let j = 0; j < hop; j++) s += x[i + j] * x[i + j]; return s / hop; };
    const startI = Math.floor((first - 0.06) * SR);
    let base = 0; for (let k = 0; k < 30; k++) base += energy(startI + k * hop); base /= 30;
    let onset = NaN;
    for (let i = startI + 30 * hop; i < startI + 0.2 * SR; i += hop) if (energy(i) > base * 30 + 1e-9) { onset = i / SR; break; }
    check("main: first note audible at its onNote time (±10 ms, incl. 6 ms limiter look-ahead)", Math.abs(onset - first) <= 0.012,
      `onset ${fmt(onset, 4)} s vs note ${fmt(first, 4)} s (${fmt((onset - first) * 1000, 1)} ms)`);
  }

  const lastNote = notes.length ? notes[notes.length - 1].time : 0;
  check("main: no new notes once activity has decayed (after 10.6 s)", lastNote < 10.6, `last note ${fmt(lastNote, 2)} s`);
  const tailRms = rmsOf(buffer, 11.5, 12);
  check("main: silent ≥ 2.5 s after activity went to 0 (RMS 11.5–12 s)", tailRms < 0.003 && tailRms < activeRms * 0.03,
    `${fmt(dB(tailRms), 1)} dBFS (active ${fmt(dB(activeRms), 1)} dBFS)`);

  const played = clinks.filter((c) => c.midi > 0);
  check("clink: planned clinks played", played.length === clinkPlan.length, `${played.length}/${clinkPlan.length}`);
  check("clink: pitch class ∈ current chord", played.every((c) => C[c.chord].tones.includes(c.midi % 12) && c.chord === chordOf(c.t)),
    played.map((c) => `${fmt(c.t, 2)}s:${C[c.chord].name}/${c.midi}`).join(" "));
  check("clink: high register C6–C7", played.every((c) => c.midi >= 84 && c.midi <= 96));
  const burstPlayed = burst.filter((m) => m > 0).length;
  check("clink: rate-limited (6 calls in 100 ms → ≤ 2 sound)", burstPlayed >= 1 && burstPlayed <= 2, `${burstPlayed} played`);
  const liveOsc = audio.stats.oscSeconds / seconds;
  check("cpu proxy: average live oscillators (main render) ≤ 40", liveOsc <= 40, fmt(liveOsc, 1));
  check("voices: piano ≤ 10, gems ≤ 6", audio.stats.maxPianoVoices <= LIMITS.piano && audio.stats.maxGemVoices <= LIMITS.gems,
    `max piano ${audio.stats.maxPianoVoices}, max gems ${audio.stats.maxGemVoices}, steals ${audio.stats.pianoSteals}/${audio.stats.gemSteals}`);
  const boingRms = rmsOf(buffer, 0.15, 0.5);
  check("boing: audible in the mix", boingRms > 0.01, `${fmt(dB(boingRms), 1)} dBFS`);

  // Spectral: each melody note has energy at its fundamental vs. ±1 semitone.
  const x = mono(buffer);
  let good = 0, total = 0;
  for (const n of notes) {
    const f = mtof(n.midi), N = 8192, s = (n.time + 0.03) * SR;
    if (s + N > x.length) continue;
    const p0 = tonePower(x, s, N, f, SR);
    const pl = tonePower(x, s, N, f * Math.pow(2, -1 / 12), SR), ph = tonePower(x, s, N, f * Math.pow(2, 1 / 12), SR);
    total++;
    if (p0 > 4 * Math.max(pl, ph)) good++;
  }
  check("spectrum: melody notes have energy at their fundamentals", total > 0 && good / total >= 0.75, `${good}/${total} notes ≥ 6 dB above ±1 semitone`);
  return { notes, audio };
}

// Isolated piano notes: pitch, partials, decay, velocity brightness.
async function testPianoNotes() {
  const renderNote = async (midi, vel) => {
    const { buffer } = await JellyAudio.renderOffline(1.6, null, { sampleRate: SR, random: mulberry32(midi), setup: (a) => a.playNote(midi, vel, 0.05) });
    return mono(buffer);
  };
  for (const midi of [48, 60, 72, 84]) {
    const x = await renderNote(midi, 0.7);
    const f = mtof(midi), N = 8192, B = 0.0004 * (1 + Math.max(0, midi - 60) / 36);
    const s0 = 0.07 * SR, NL = 32768;   // long window: resolves ±1 semitone at C3
    const p0L = tonePower(x, s0, NL, f, SR);
    const pn = Math.max(tonePower(x, s0, NL, f * Math.pow(2, -1 / 12), SR), tonePower(x, s0, NL, f * Math.pow(2, 1 / 12), SR));
    const p0 = tonePower(x, s0, N, f, SR);
    const part = (n) => tonePower(x, s0, N, n * f * Math.sqrt(1 + B * n * n), SR);
    const gap = (n) => tonePower(x, s0, N, (n + 0.5) * f, SR);
    const late = tonePower(x, 1.05 * SR, N, f, SR);
    const decayDb = 10 * Math.log10(late / p0);
    // attack: RMS over one period (phase-independent), sampled every 1 ms;
    // time from first sound to 70 % of the maximum, allowed ≤ max(5 ms, 1 period)
    const env = [], hop = SR / 1000, win = Math.max(hop, Math.round(SR / f));
    for (let i = 0; i < 0.3 * SR; i += hop) { let e = 0; for (let j = 0; j < win; j++) e += x[i + j] ** 2; env.push(Math.sqrt(e / win)); }
    const emax = Math.max(...env), on = env.findIndex((e) => e > emax * 0.01), rise = env.findIndex((e) => e >= emax * 0.7) - on;
    const allowed = Math.max(5, Math.ceil(1000 / f));
    check(`piano ${midi}: fundamental dominant`, p0L > 10 * pn, `${fmt(10 * Math.log10(p0L / pn), 1)} dB over ±1 st`);
    check(`piano ${midi}: partials 2–3 present`, part(2) > 20 * gap(2) && part(3) > 20 * gap(3),
      `${fmt(10 * Math.log10(part(2) / gap(2)), 1)} / ${fmt(10 * Math.log10(part(3) / gap(3)), 1)} dB`);
    check(`piano ${midi}: natural decay (fundamental −6…−40 dB after 1 s)`, decayDb < -6 && decayDb > -40, `${fmt(decayDb, 1)} dB`);
    check(`piano ${midi}: fast attack (70 % of peak level within max(5 ms, 1 period))`, rise <= allowed, `${rise} ms ≤ ${allowed} ms`);
  }
  const soft = await renderNote(60, 0.3), hard = await renderNote(60, 1.0);
  const f = mtof(60), s0 = 0.07 * SR, N = 8192;
  const brightness = (x) => (tonePower(x, s0, N, 4 * f, SR) + tonePower(x, s0, N, 5 * f, SR)) / tonePower(x, s0, N, f, SR);
  const bs = brightness(soft), bh = brightness(hard);
  check("piano: brighter at high velocity", bh > 2 * bs, `upper/fundamental ${fmt(10 * Math.log10(bs), 1)} dB → ${fmt(10 * Math.log10(bh), 1)} dB`);
  check("piano: louder at high velocity", samplePeak({ numberOfChannels: 1, length: hard.length, sampleRate: SR, getChannelData: () => hard }) >
    2 * samplePeak({ numberOfChannels: 1, length: soft.length, sampleRate: SR, getChannelData: () => soft }));
}

// One gem: inharmonic bell partials, upper ones decaying faster.
async function testGemTimbre() {
  let midi = -1;
  const { buffer, audio } = await JellyAudio.renderOffline(1.2, (a, t) => {
    if (Math.abs(t - 0.1) < 0.5 / 60) midi = a.clink(0.9, 1);
  }, { sampleRate: SR, random: mulberry32(9) });
  const x = mono(buffer), f = mtof(midi), N = 2048;
  const at = (ratio, t) => tonePower(x, t * SR, N, f * ratio, SR);
  const e1 = at(1, 0.105), e2 = at(2.76, 0.105), l1 = at(1, 0.4), l2 = at(2.76, 0.4), off = at(2.3, 0.105);
  check("gem: tuned to a chord tone of C (bar 1)", [0, 4, 7].includes(midi % 12) && midi >= 84 && midi <= 96, `midi ${midi}, chord ${C[audio.chordAt(0.1)].name}`);
  check("gem: inharmonic partial at 2.76·f", e2 > 30 * off, `${fmt(10 * Math.log10(e2 / off), 1)} dB over 2.3·f`);
  check("gem: upper partial decays faster", 10 * Math.log10(l2 / e2) < 10 * Math.log10(l1 / e1) - 6,
    `2.76·f ${fmt(10 * Math.log10(l2 / e2), 1)} dB vs f ${fmt(10 * Math.log10(l1 / e1), 1)} dB over 0.3 s`);
  const tail = rmsOf(buffer, 1.1, 1.2);
  check("gem: rings out within ~1 s", tail < 0.001, `${fmt(dB(tail), 1)} dBFS at 1.1 s`);
}

async function testRateLimit() {
  let n = 0;
  const { audio } = await JellyAudio.renderOffline(2, (a, t) => { if (t >= 0.5 && t < 1.5) n += a.clink(0.8, Math.round(t * 60)) > 0 ? 1 : 0; }, { sampleRate: SR, random: mulberry32(3) });
  check("clink: ~10/s when called every frame for 1 s", n >= 8 && n <= 13, `${n} clinks, max gem voices ${audio.stats.maxGemVoices}`);
}

// Everything at once: max activity, register sweep, gems every frame, boings.
async function testStress() {
  const t0 = performance.now();
  const { buffer, audio } = await JellyAudio.renderOffline(8, (a, t) => {
    a.setActivity(1, (Math.sin(t * 1.3) + 1) / 2);
    a.clink(1, Math.round(t * 600));
    if (Math.round(t * 60) % 6 === 0) a.boing(1, 1.2, "drop");
  }, { sampleRate: SR, random: mulberry32(99), setup: (a) => a.setVolumes({ master: 1, piano: 1, gems: 1, boing: 1 }) });
  const ms = performance.now() - t0;
  const tp = truePeak(buffer);
  check("stress (all volumes 1, max activity, gems every frame): true peak < 1.0", tp < 1, `${fmt(dB(tp), 2)} dBFS`);
  check("stress: voice limits hold", audio.stats.maxPianoVoices <= LIMITS.piano && audio.stats.maxGemVoices <= LIMITS.gems,
    `piano ${audio.stats.maxPianoVoices} (steals ${audio.stats.pianoSteals}), gems ${audio.stats.maxGemVoices} (steals ${audio.stats.gemSteals})`);
  const liveOsc = audio.stats.oscSeconds / 8;
  check("stress: cpu proxy — average live oscillators ≤ 100", liveOsc <= 100, fmt(liveOsc, 1));
  info(`stress: 8 s rendered in ${fmt(ms, 0)} ms (${fmt(8000 / ms, 1)}× realtime), ${audio.stats.notes} melody + ${audio.stats.bassNotes} bass notes, ${audio.stats.clinks} clinks`);
}

async function testSilenceAndDeterminism() {
  const { buffer } = await JellyAudio.renderOffline(3, (a) => a.setActivity(0, 0.5), { sampleRate: SR, random: mulberry32(1) });
  check("idle: no activity → digital silence", samplePeak(buffer) < 1e-5, `peak ${samplePeak(buffer)}`);
  const seq = async () => {
    const out = [];
    await JellyAudio.renderOffline(5, (a, t) => a.setActivity(0.6, t / 5), { sampleRate: 22050, random: mulberry32(42), setup: (a) => a.onNote((e) => out.push(e.midi + "@" + e.time.toFixed(4))) });
    return out.join(" ");
  };
  const s1 = await seq(), s2 = await seq();
  check("determinism: same seed → same melody", s1 === s2 && s1.length > 0, `${s1.split(" ").length} notes`);
}

async function testTempo() {
  const notes = [];
  await JellyAudio.renderOffline(7, (a, t) => {
    a.setActivity(0.9, 0.5);
    if (Math.abs(t - 3) < 0.5 / 60) a.tempo = 120;
  }, { sampleRate: 22050, random: mulberry32(8), setup: (a) => a.onNote((e) => notes.push(e.time)) });
  const after = notes.filter((t) => t > 3.4);
  let worst = 0;
  for (let i = 1; i < after.length; i++) { const k = (after[i] - after[0]) / 0.125; worst = Math.max(worst, Math.abs(k - Math.round(k)) * 0.125); }
  check("tempo: 120 BPM after a mid-run change (16th grid 125 ms)", after.length > 5 && worst < 0.002, `${after.length} notes, worst ${fmt(worst * 1000, 2)} ms`);
}

// Real AudioContext (Chromium with autoplay allowed): onNote fires when the
// note reaches the output (getOutputTimestamp-aligned setTimeout).
async function testRealtime() {
  if (!navigator.userActivation && !window.AudioContext) return;
  const audio = new JellyAudio();
  audio.unlock();
  const ctx = audio.ctx;
  const t0 = performance.now();
  while (ctx.state !== "running" && performance.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 20));
  if (ctx.state !== "running") { info(`realtime: AudioContext did not start (${ctx.state}); skipped`); audio.dispose(); return; }
  const recs = [];
  audio.onNote((e) => {
    const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
    recs.push({ perf: performance.now(), time: e.time, ts, now: ctx.currentTime });
  });
  const iv = setInterval(() => audio.setActivity(0.9, 0.5), 16);
  await new Promise((r) => setTimeout(r, 4000));
  clearInterval(iv);
  const lat = (ctx.outputLatency || ctx.baseLatency || 0);
  audio.dispose();
  const diffs = recs.map((r) => {
    if (r.ts && r.ts.performanceTime > 0) return r.perf - (r.ts.performanceTime + (r.time - r.ts.contextTime + 0.006) * 1000);
    return (r.now - r.time - lat - 0.006) * 1000;
  }).sort((a, b) => a - b);
  if (!diffs.length) { check("realtime: notes fired", false); return; }
  const med = diffs[Math.floor(diffs.length / 2)], p90 = Math.max(Math.abs(diffs[Math.floor(diffs.length * 0.05)]), Math.abs(diffs[Math.floor(diffs.length * 0.95)]));
  check("realtime: onNote fires when the note is heard (median ±10 ms)", Math.abs(med) <= 10,
    `${diffs.length} notes, median ${fmt(med, 1)} ms, 5–95 % within ±${fmt(p90, 1)} ms (headless timer jitter), latency ${fmt(lat * 1000, 1)} ms`);
}

async function main() {
  const steps = [testApi, testOutputStage, testBoingMatchesLegacy, testSmoothing, testMainRender, testPianoNotes, testGemTimbre, testRateLimit, testStress, testSilenceAndDeterminism, testTempo, testRealtime];
  for (const step of steps) {
    try { await step(); } catch (e) { check(`${step.name} threw`, false, e && e.stack ? e.stack : String(e)); }
  }
  log(failures ? `\n${failures} FAILED` : "\nALL AUDIO CHECKS PASSED");
  window.__audioTest = { done: true, failures, lines, wav: mainRender ? encodeWav(mainRender) : null };
  const btn = document.getElementById("listen");
  if (btn && mainRender) {
    btn.disabled = false;
    btn.onclick = () => {
      const ctx = new AudioContext();
      const src = ctx.createBufferSource(); src.buffer = mainRender; src.connect(ctx.destination); src.start();
    };
  }
}
main();
