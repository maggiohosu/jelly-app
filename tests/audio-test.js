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

// In-place iterative radix-2 FFT.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}
// Power spectrum of x[t0, t1) (zero-padded to a power of two; rectangular
// window keeps band energies comparable between segments, Hann for tuning).
function spectrum(x, sr, t0, t1, hann = false) {
  const i0 = Math.max(0, Math.floor(t0 * sr)), i1 = Math.min(x.length, Math.floor(t1 * sr));
  const n = Math.max(2, i1 - i0);
  let N = 1; while (N < n) N <<= 1;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < n && i0 + i < x.length; i++) re[i] = x[i0 + i] * (hann ? 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) : 1);
  fft(re, im);
  const P = new Float64Array(N / 2);
  for (let k = 0; k < N / 2; k++) P[k] = (re[k] * re[k] + im[k] * im[k]) / N;   // /N: energies comparable across lengths
  return { P, df: sr / N };
}
function bandE(S, f0, f1) {
  let e = 0;
  for (let k = Math.max(1, Math.ceil(f0 / S.df)); k < S.P.length && k * S.df < f1; k++) e += S.P[k];
  return e;
}
function centroid(S, f0 = 100, f1 = 16000) {
  let num = 0, den = 0;
  for (let k = Math.max(1, Math.ceil(f0 / S.df)); k < S.P.length && k * S.df < f1; k++) { num += S.P[k] * k * S.df; den += S.P[k]; }
  return num / den;
}
function peakPow(S, f, tol) {   // strongest bin within f·(1 ± tol)
  let p = 0;
  for (let k = Math.max(1, Math.floor((f * (1 - tol)) / S.df)); k <= Math.ceil((f * (1 + tol)) / S.df) && k < S.P.length; k++) p = Math.max(p, S.P[k]);
  return p;
}
function peakFreq(S, f0, f1) {
  let best = -1, bk = 0;
  for (let k = Math.ceil(f0 / S.df); k < S.P.length && k * S.df < f1; k++) if (S.P[k] > best) { best = S.P[k]; bk = k; }
  const a = Math.log(S.P[bk - 1] + 1e-30), b = Math.log(S.P[bk] + 1e-30), c = Math.log(S.P[bk + 1] + 1e-30);
  return (bk + (0.5 * (a - c)) / (a - 2 * b + c || 1)) * S.df;
}
// 10 ms RMS envelope (dB) and the first/last time it is within `rel` dB of its maximum.
function envDb(x, sr, win = 0.01) {
  const w = Math.floor(win * sr), n = Math.floor(x.length / w), e = new Float64Array(n);
  for (let j = 0; j < n; j++) { let s = 0; for (let i = j * w; i < (j + 1) * w; i++) s += x[i] * x[i]; e[j] = 10 * Math.log10(s / w + 1e-30); }
  return e;
}
function soundSpan(x, sr, rel = -30, win = 0.01) {
  const e = envDb(x, sr, win);
  let max = -Infinity; for (const v of e) max = Math.max(max, v);
  let first = -1, last = -1;
  for (let j = 0; j < e.length; j++) if (e[j] >= max + rel) { if (first < 0) first = j; last = j; }
  return { start: first * win, end: (last + 1) * win, dur: (last + 1 - first) * win, max };
}
// Local maxima of the 5 ms envelope, ≥ minGap apart and within relDb of the loudest.
function onsetPeaks(x, sr, t0, t1, minGap = 0.07, relDb = -20) {
  const win = 0.005, e = envDb(x, sr, win), j0 = Math.floor(t0 / win), j1 = Math.min(e.length, Math.floor(t1 / win));
  let max = -Infinity; for (let j = j0; j < j1; j++) max = Math.max(max, e[j]);
  const half = Math.round(minGap / 2 / win), out = [];
  for (let j = j0; j < j1; j++) {
    if (e[j] < max + relDb) continue;
    let isMax = true;
    for (let i = Math.max(0, j - half); i <= Math.min(e.length - 1, j + half); i++) if (e[i] > e[j] || (e[i] === e[j] && i < j)) { isMax = false; break; }
    if (isMax) out.push({ t: j * win, db: e[j] });
  }
  return out;
}
// Pitch track (normalised square difference, McLeod-style): voiced frames only.
function pitchTrack(x, sr, t0, t1, fmin = 450, fmax = 2000) {
  const win = 1024, hop = 240, minLag = Math.floor(sr / fmax), maxLag = Math.ceil(sr / fmin);
  const frames = [];
  for (let i0 = Math.floor(t0 * sr); i0 + win + maxLag < Math.min(x.length, t1 * sr); i0 += hop) {
    let e = 0; for (let i = 0; i < win; i++) e += x[i0 + i] * x[i0 + i];
    frames.push({ i0, e });
  }
  let emax = 0; for (const f of frames) emax = Math.max(emax, f.e);
  const out = [];
  for (const { i0, e } of frames) {
    if (e < emax * 10 ** (-25 / 10)) continue;
    const n = new Float64Array(maxLag + 2);
    let best = 0;
    for (let lag = minLag; lag <= maxLag + 1; lag++) {
      let r = 0, m = 0;
      for (let i = 0; i < win; i++) { const a = x[i0 + i], b = x[i0 + i + lag]; r += a * b; m += a * a + b * b; }
      n[lag] = (2 * r) / (m || 1);
      if (lag <= maxLag && n[lag] > best) best = n[lag];
    }
    if (best < 0.8) continue;
    for (let lag = minLag + 1; lag <= maxLag; lag++) {
      if (n[lag] >= 0.9 * best && n[lag] >= n[lag - 1] && n[lag] >= n[lag + 1]) {
        const a = n[lag - 1], b = n[lag], c = n[lag + 1];
        const l = lag + (0.5 * (a - c)) / (a - 2 * b + c || 1);
        out.push({ t: (i0 + win / 2) / sr, f: sr / l });
        break;
      }
    }
  }
  return out;
}
// Least-squares slope of log2(f) over time (octaves per second).
function pitchSlope(track) {
  const n = track.length;
  let st = 0, sy = 0, stt = 0, sty = 0;
  for (const { t, f } of track) { const y = Math.log2(f); st += t; sy += y; stt += t * t; sty += t * y; }
  return (n * sty - st * sy) / (n * stt - st * st);
}
const median = (a) => { const s = [...a].sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };

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
const PENTA = new Set([0, 2, 4, 7, 9]);
const LIMITS = JellyAudio.VOICE_LIMITS;

async function testApi() {
  const a = new JellyAudio();
  const methods = ["unlock", "suspend", "resume", "setEnabled", "setVolumes", "boing", "setActivity", "onNote", "clink", "crunch", "squelch", "pop", "setTexture", "dispose"];
  check("API: all methods present", methods.every((m) => typeof a[m] === "function"), methods.filter((m) => typeof a[m] !== "function").join(","));
  check("API: no piano left", a.playNote === undefined && a.tempo === undefined);
  a.setVolumes({ gems: 0.25 });
  const v = a.volumes;
  check("API: setVolumes keeps omitted keys / defaults", v.master === 0.9 && v.crunch === 0.8 && v.gems === 0.25 && v.boing === 0.6, JSON.stringify(v));
  let threw = null;
  try { a.setActivity(0.5, 0.5); a.boing(1, 1, "drop"); a.clink(1, 3); a.crunch(1); a.squelch(1); a.pop(1); a.setTexture("slime"); a.suspend(); a.resume(); a.setEnabled(false); a.setEnabled(true); a.dispose(); } catch (e) { threw = e; }
  check("API: safe to call everything before unlock()", !threw, threw ? threw.message : "");
  check("API: voice limits 28 grains / 6 gems", LIMITS.grains === 28 && LIMITS.gems === 6, JSON.stringify(LIMITS));
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
  const seconds = 12;
  const act = (t) => (t < 1 ? 0 : t < 6 ? (0.8 * (t - 1)) / 5 : t < 9 ? 0.8 : 0);
  const pulses = [], clinks = [], burst = [];
  const clinkPlan = [[0.3, 0.6, 11], [2.0, 0.5, 3], [3.3, 0.9, 7], [5.1, 0.4, 21], [6.4, 0.7, 5], [7.05, 1, 9], [8.2, 0.6, 2], [10.0, 0.5, 17], [10.9, 0.8, 4]];
  const boingPlan = [[0.15, 0.7, 1.0, "drop"], [4.2, 0.5, 0.9, "bump"], [7.7, 0.9, 1.08, "snap"]];
  const fxPlan = [[3.6, "squelch", 0.8], [5.5, "pop", 0.7], [6.8, "crunch", 0.9]];
  const near = (t, x) => Math.abs(t - x) < 0.5 / 60;
  let frame = 0, bursts = [];
  const t0 = performance.now();
  const { buffer, audio } = await JellyAudio.renderOffline(seconds, (a, t) => {
    frame++;
    a.setActivity(act(t), 0.5);
    for (const [ct, s, seed] of clinkPlan) if (near(t, ct)) clinks.push({ t, midi: a.clink(s, seed) });
    if (t >= 8.5 && t < 8.5 + 6 / 60) burst.push(a.clink(0.7, frame));
    for (const [bt, s, p, kind] of boingPlan) if (near(t, bt)) a.boing(s, p, kind);
    for (const [ft, kind, s] of fxPlan) if (near(t, ft)) a[kind](s);
    if (Math.abs(t - Math.round(t)) < 0.5 / 60) bursts.push([t, a.stats.bursts]);
  }, { sampleRate: SR, random: mulberry32(12345), setup: (a) => a.onNote((e) => pulses.push(e)) });
  const renderMs = performance.now() - t0;
  mainRender = buffer;
  info(`main render: ${seconds} s in ${fmt(renderMs, 0)} ms (${fmt((seconds * 1000) / renderMs, 1)}× realtime), stats ${JSON.stringify(audio.stats)}`);

  const activeRms = rmsOf(buffer, 3, 9);
  check("main: output not silent while active (RMS 3–9 s)", activeRms > 0.01, `${fmt(dB(activeRms), 1)} dBFS`);
  const tp = truePeak(buffer);
  check("main: true peak < 1.0", tp < 1, `${fmt(tp, 3)} (${fmt(dB(tp), 2)} dBFS)`);
  const at = (t) => (bursts.find(([bt]) => Math.abs(bt - t) < 0.02) || [0, 0])[1];
  const low = (at(3) - at(1)) / 2, high = (at(9) - at(6)) / 3;
  check("crunch: bursts while the jelly moves", audio.stats.bursts > 60, `${audio.stats.bursts} bursts, ${audio.stats.grains} grains`);
  check("crunch: denser with more activity", high > low * 1.5, `${fmt(low, 1)}/s → ${fmt(high, 1)}/s`);
  check("crunch: nothing before activity starts", at(1) === 0 || (pulses[0] && pulses[0].time >= 1));
  check("crunch: grain voice limit holds", audio.stats.maxGrains <= LIMITS.grains, `max ${audio.stats.maxGrains}, dropped ${audio.stats.grainDrops}`);
  check("crunch: onNote pulses for the glow", pulses.length > 20, `${pulses.length}`);
  // A crunch is a transient: most of a burst's energy is above 1.5 kHz.
  const x = mono(buffer);
  const hi = tonePower(x, 7.0 * SR, 4096, 3000, SR) + tonePower(x, 7.0 * SR, 4096, 4500, SR);
  const lo = tonePower(x, 7.0 * SR, 4096, 150, SR);
  check("crunch: bright, crackly spectrum", hi > lo, `${fmt(10 * Math.log10(hi / lo), 1)} dB (3–4.5 kHz vs 150 Hz)`);
  const lastPulse = pulses.length ? pulses[pulses.length - 1].time : 0;
  check("crunch: stops once activity has decayed (after 10.6 s)", lastPulse < 10.6, `last ${fmt(lastPulse, 2)} s`);
  const tailRms = rmsOf(buffer, 11.5, 12);
  check("main: silent ≥ 2.5 s after activity went to 0 (RMS 11.5–12 s)", tailRms < 0.003 && tailRms < activeRms * 0.03,
    `${fmt(dB(tailRms), 1)} dBFS (active ${fmt(dB(activeRms), 1)} dBFS)`);

  const played = clinks.filter((c) => c.midi > 0);
  check("clink: planned clinks played", played.length === clinkPlan.length, `${played.length}/${clinkPlan.length}`);
  check("clink: C-major pentatonic, C6–C7", played.every((c) => PENTA.has(c.midi % 12) && c.midi >= 84 && c.midi <= 96));
  const burstPlayed = burst.filter((m) => m > 0).length;
  check("clink: rate-limited (6 calls in 100 ms → ≤ 2 sound)", burstPlayed >= 1 && burstPlayed <= 2, `${burstPlayed} played`);
  const boingRms = rmsOf(buffer, 0.15, 0.5);
  check("boing: audible in the mix", boingRms > 0.01, `${fmt(dB(boingRms), 1)} dBFS`);
}

// Squelch / pop / textures in isolation.
async function testFx() {
  const one = async (kind, texture) => (await JellyAudio.renderOffline(0.6, (a, t) => { if (Math.abs(t - 0.05) < 0.5 / 60) a[kind](0.8); }, { sampleRate: SR, random: mulberry32(4), setup: (a) => a.setTexture(texture) })).buffer;
  for (const kind of ["squelch", "pop", "crunch"]) {
    const b = await one(kind, "jelly");
    check(`${kind}: audible`, rmsOf(b, 0.05, 0.35) > 0.003, `${fmt(dB(rmsOf(b, 0.05, 0.35)), 1)} dBFS`);
    check(`${kind}: short (−30 dB by 0.5 s, room tail only)`, rmsOf(b, 0.5, 0.6) < rmsOf(b, 0.05, 0.35) * 0.03, `${fmt(dB(rmsOf(b, 0.5, 0.6) / rmsOf(b, 0.05, 0.35)), 1)} dB`);
  }
  const centroid = (b) => { const x = mono(b); let num = 0, den = 0; for (let f = 150; f <= 10000; f += 75) { const p = tonePower(x, 0.05 * SR, 4096, f, SR); num += p * f; den += p; } return num / den; };
  const j = centroid(await one("squelch", "jelly")), sl = centroid(await one("squelch", "slime"));
  check("texture: slime sounds lower/wetter than jelly", sl < j, `${fmt(j, 0)} Hz → ${fmt(sl, 0)} Hz`);
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
  check("gem: tuned to C-major pentatonic, C6–C7", PENTA.has(midi % 12) && midi >= 84 && midi <= 96, `midi ${midi}`);
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

// Everything at once: max activity, gems every frame, stretches, boings.
async function testStress() {
  const t0 = performance.now();
  const { buffer, audio } = await JellyAudio.renderOffline(8, (a, t) => {
    a.setActivity(1, 0.5);
    a.clink(1, Math.round(t * 600));
    a.squelch(1); a.pop(1);
    if (Math.round(t * 60) % 6 === 0) { a.boing(1, 1.2, "drop"); a.crunch(1); }
  }, { sampleRate: SR, random: mulberry32(99), setup: (a) => { a.setVolumes({ master: 1, crunch: 1, gems: 1, boing: 1 }); a.setTexture("slime"); } });
  const ms = performance.now() - t0;
  const tp = truePeak(buffer);
  check("stress (all volumes 1, max activity, everything every frame): true peak < 1.0", tp < 1, `${fmt(dB(tp), 2)} dBFS`);
  check("stress: voice limits hold", audio.stats.maxGrains <= LIMITS.grains && audio.stats.maxGemVoices <= LIMITS.gems,
    `grains ${audio.stats.maxGrains} (dropped ${audio.stats.grainDrops}), gems ${audio.stats.maxGemVoices}`);
  info(`stress: 8 s rendered in ${fmt(ms, 0)} ms (${fmt(8000 / ms, 1)}× realtime), ${audio.stats.grains} grains, ${audio.stats.clinks} clinks`);
}

async function testSilenceAndDeterminism() {
  const { buffer } = await JellyAudio.renderOffline(3, (a) => a.setActivity(0, 0.5), { sampleRate: SR, random: mulberry32(1) });
  check("idle: no activity → digital silence", samplePeak(buffer) < 1e-5, `peak ${samplePeak(buffer)}`);
  const seq = async () => {
    const out = [];
    await JellyAudio.renderOffline(4, (a, t) => a.setActivity(0.6, 0.5), { sampleRate: 22050, random: mulberry32(42), setup: (a) => a.onNote((e) => out.push(e.time.toFixed(4))) });
    return out.join(" ");
  };
  const s1 = await seq(), s2 = await seq();
  check("determinism: same seed → same crunch timing", s1 === s2 && s1.length > 0, `${s1.split(" ").length} pulses`);
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
  check("realtime: onNote fires when the crunch is heard (median ±10 ms)", Math.abs(med) <= 10,
    `${diffs.length} pulses, median ${fmt(med, 1)} ms, 5–95 % within ±${fmt(p90, 1)} ms (headless timer jitter), latency ${fmt(lat * 1000, 1)} ms`);
}

// ======================================================== bunny / coins / cards
const FX_METHODS = ["munch", "chew", "squeak", "coin", "coinShower", "cardFlip", "reveal", "levelUp", "cardShake", "spit", "splat", "special", "coinLoss"];
// Jelly motions, bunny sniff/kick and the fun-system jingles.
// v9: the bunny's toilet trip (hop, strain, flush, happy chime, burp, wand).
const MOTION_METHODS = ["catYawn", "catPunch", "birdChirp", "birdFlap", "birdPlop", "sniff", "kick", "giftOpen", "comboUp", "achievement", "discovery", "goldenOrder",
  "toiletHop", "strain", "flush", "happyChime", "burp", "wandTwinkle"];
const fireMotions = (a, f = 0) => [a.catYawn(), a.catPunch(f % 3 === 2 ? undefined : f % 3), a.birdChirp(1 + (f % 8)), a.birdFlap(0.3 + (f % 4)), a.birdPlop(), a.sniff(), a.kick(),
  a.giftOpen(), a.comboUp(1 + (f % 12)), a.achievement(), a.discovery(), a.goldenOrder(),
  a.toiletHop(), a.strain(), a.flush(), a.happyChime(), a.burp(), a.wandTwinkle()];
const fireAll = (a, f = 0) => [a.munch(1), a.chew(0.6), a.squeak(["happy", "ok", "sad", "no", "grumpy"][f % 5]), a.coin(1, f), a.coinShower(40, 1),
  a.cardFlip(), a.cardShake(), a.reveal(["new", "gold", "rainbow", "dupe"][f % 4]), a.levelUp(), a.spit(1), a.splat(1), a.special(), a.coinLoss(20), ...fireMotions(a, f)];

// Render `seconds`; plan = [[time, (audio, t) => result], …] runs each once on the frame nearest `time`.
async function fxRender(seconds, plan, { seed = 7, texture = "jelly", volumes, setup, sampleRate = SR } = {}) {
  const results = new Array(plan.length);
  const { buffer, audio } = await JellyAudio.renderOffline(seconds, (a, t) => {
    plan.forEach(([at, fn], i) => { if (Math.abs(t - at) < 0.5 / 60) results[i] = fn(a, t); });
  }, { sampleRate, random: mulberry32(seed), setup: (a) => { a.setTexture(texture); if (volumes) a.setVolumes(volumes); if (setup) setup(a); } });
  return { buffer, audio, x: mono(buffer), results };
}

async function testFxApi() {
  const a = new JellyAudio();
  check("fx API: munch/chew/squeak/coin/coinShower/cardFlip/reveal/levelUp/cardShake/spit/splat/special/coinLoss present", FX_METHODS.every((m) => typeof a[m] === "function"),
    FX_METHODS.filter((m) => typeof a[m] !== "function").join(","));
  check(`fx API: ${MOTION_METHODS.join("/")} present`, MOTION_METHODS.every((m) => typeof a[m] === "function"),
    MOTION_METHODS.filter((m) => typeof a[m] !== "function").join(","));
  let threw = null, res = [];
  try { res = fireAll(a).concat([a.squeak("sad"), a.reveal("rainbow"), a.coin(0.5)]); a.dispose(); res = res.concat(fireAll(a)); } catch (e) { threw = e; }
  check("fx API: safe before unlock() / after dispose() (no-ops returning false)", !threw && res.every((r) => r === false), threw ? threw.message : JSON.stringify(res));
  check("fx API: DEFAULT_VOLUMES keys unchanged", JSON.stringify(Object.keys(JellyAudio.DEFAULT_VOLUMES)) === '["master","crunch","gems","boing"]');
  const b = new JellyAudio();
  const v0 = b.volumes;
  b.setVolumes({ effects: 0.3 });
  const v1 = b.volumes;
  check("fx API: 'effects' level (default 0.8) settable without touching the others", v0.effects === 0.8 && v1.effects === 0.3 && v1.master === 0.9 && v1.crunch === 0.8 && v1.gems === 0.6 && v1.boing === 0.6, JSON.stringify(v1));
  check("fx API: voice limits 20 fx notes / 6 noise beds", LIMITS.fx === 20 && LIMITS.beds === 6, JSON.stringify(LIMITS));

  // disabled engine: everything is a no-op
  const off = await fxRender(1.2, [[0.05, (au) => fireAll(au)]], { setup: (au) => au.setEnabled(false) });
  check("fx: disabled → every new sound is a no-op (digital silence)", samplePeak(off.buffer) < 1e-6 && off.results[0].every((r) => r === false), `peak ${samplePeak(off.buffer)}`);
  // disabling mid-fanfare drops the queued parts
  const full = await fxRender(2.6, [[0.05, (au) => au.reveal("rainbow")]]);
  const cut = await fxRender(2.6, [[0.05, (au) => au.reveal("rainbow")], [0.3, (au) => au.setEnabled(false)]]);
  const fullR = rmsOf(full.buffer, 1.0, 2.0), cutR = rmsOf(cut.buffer, 1.0, 2.0);
  check("fx: setEnabled(false) drops queued parts", cutR < fullR * 0.01, `${fmt(dB(cutR / fullR), 1)} dB vs the full reveal`);

  // buses: eating follows crunch; squeak/coins/cards/fanfares follow effects; all under master
  const lvl = async (fn, volumes) => { const r = await fxRender(1.3, [[0.4, fn]], { volumes }); return samplePeak(r.buffer); };   // after the 20 ms volume glide
  const munchCrunch0 = await lvl((au) => au.munch(1), { crunch: 0 });
  const munchFx0 = await lvl((au) => { au.munch(1); au.chew(0.5); }, { effects: 0, gems: 0 });
  const coinFx0 = await lvl((au) => { au.coin(1, 2); au.squeak(); au.cardFlip(); au.reveal("gold"); }, { effects: 0 });
  const coinCrunch0 = await lvl((au) => au.coin(1, 2), { crunch: 0, gems: 0, boing: 0 });
  const master0 = await lvl((au) => fireAll(au), { master: 0 });
  const motFx0 = await lvl((au) => fireMotions(au, 2), { effects: 0 });
  const motOthers0 = await lvl((au) => fireMotions(au, 2), { crunch: 0, gems: 0, boing: 0 });
  const motHalf = await lvl((au) => fireMotions(au, 2), { effects: 0.4 });
  check("fx volumes: munch/chew follow the crunch volume", munchCrunch0 < 1e-5 && munchFx0 > 0.05, `crunch 0 → ${munchCrunch0.toExponential(1)}, effects 0 → ${fmt(munchFx0)}`);
  check("fx volumes: squeak/coin/card/reveal follow the effects level", coinFx0 < 1e-5 && coinCrunch0 > 0.03, `effects 0 → ${coinFx0.toExponential(1)}, others 0 → ${fmt(coinCrunch0)}`);
  check("fx volumes: cat/bird/sniff/kick/gift/combo/badge/discovery/golden follow the effects level", motFx0 < 1e-5 && motOthers0 > 0.03 && motHalf < motOthers0 * 0.7,
    `effects 0 → ${motFx0.toExponential(1)}, others 0 → ${fmt(motOthers0)}, effects 0.4 → ${fmt(motHalf)}`);
  check("fx volumes: everything sits under master", master0 < 1e-5, `master 0 → ${master0.toExponential(1)}`);
}

async function testMunchChew() {
  const one = (fn, texture = "jelly") => fxRender(0.7, [[0.05, fn]], { seed: 4, texture });
  const m = await one((a) => a.munch(0.8)), c = await one((a) => a.crunch(0.8));
  const mR = rmsOf(m.buffer, 0.05, 0.4), cR = rmsOf(c.buffer, 0.05, 0.4);
  check("munch: louder than crunch()", dB(mR / cR) >= 6, `${fmt(dB(mR), 1)} vs ${fmt(dB(cR), 1)} dBFS (+${fmt(dB(mR / cR), 1)} dB)`);
  check("munch: denser than crunch() (many bead grains)", m.audio.stats.grains >= 15 && m.audio.stats.grains >= 4 * c.audio.stats.grains,
    `${m.audio.stats.grains} grains vs ${c.audio.stats.grains}`);
  const span = soundSpan(m.x, SR);
  check("munch: short bite (−30 dB span ≤ 0.45 s), ends in silence", span.dur <= 0.45 && rmsOf(m.buffer, 0.6, 0.7) < mR * 0.01, `${fmt(span.dur, 2)} s`);
  const S = spectrum(m.x, SR, 0.05, 0.5), Sc = spectrum(c.x, SR, 0.05, 0.5);
  const crack = bandE(S, 1500, 6000) / bandE(S, 200, 20000);
  check("munch: crackle concentrated in 1.5–6 kHz", crack >= 0.5, `${fmt(crack * 100, 0)} % of the energy above 200 Hz`);
  const thump = bandE(S, 50, 180), thumpC = bandE(Sc, 50, 180);
  check("munch: soft low thump (50–180 Hz) under the crunch", thump >= 10 * thumpC && thump >= 0.01 * bandE(S, 1500, 6000),
    `${fmt(10 * Math.log10(thump / thumpC), 1)} dB over crunch(), ${fmt(10 * Math.log10(thump / bandE(S, 1500, 6000)), 1)} dB re crackle`);
  const hiFirst = bandE(spectrum(m.x, SR, 0.05, 0.18), 1500, 6000), hiAll = bandE(spectrum(m.x, SR, 0.05, 0.6), 1500, 6000);
  check("munch: the crunch is one 60–120 ms cluster", hiFirst / hiAll >= 0.7, `${fmt((hiFirst / hiAll) * 100, 0)} % of the 1.5–6 kHz energy in the first 130 ms`);
  check("munch: no limiting at default volume", samplePeak(m.buffer) < 0.6, `peak ${fmt(samplePeak(m.buffer))}`);
  const ms = await one((a) => a.munch(0.8), "slime");
  const cj = centroid(S, 150, 12000), cs = centroid(spectrum(ms.x, SR, 0.05, 0.5), 150, 12000);
  check("munch: slime wetter/lower than jelly", cs < cj * 0.85, `${fmt(cj, 0)} Hz → ${fmt(cs, 0)} Hz`);
  const rl = await fxRender(0.5, [[0.05, (a) => a.munch(1)], [0.05 + 1 / 60, (a) => a.munch(1)], [0.2, (a) => a.munch(1)]]);
  check("munch: rate-limited (≥ 0.1 s apart)", rl.results[0] === true && rl.results[1] === false && rl.results[2] === true, JSON.stringify(rl.results));

  // chew: ~7/s soft, muffled, fading out
  const bites = [];
  const ch = await fxRender(1.7, [[0.05, (a) => a.chew(1.2)]], { seed: 4, setup: (a) => { const f = a._chewBite; a._chewBite = function (t, v) { bites.push(t); return f.call(this, t, v); }; } });
  const rate = (bites.length - 1) / (bites[bites.length - 1] - bites[0]);
  check("chew: rhythmic, 6–8 bites per second", rate >= 6 && rate <= 8 && bites.length >= 7, `${bites.length} bites, ${fmt(rate, 2)}/s`);
  const peaks = onsetPeaks(ch.x, SR, 0.04, 1.3, 0.09, -26);
  check("chew: one audible crunch per bite", Math.abs(peaks.length - bites.length) <= 1, `${peaks.length} envelope peaks for ${bites.length} bites`);
  const biteLv = bites.map((t) => samplePeak(ch.buffer, t, t + 0.08));
  check("chew: fades out over the duration", dB(biteLv[biteLv.length - 1] / biteLv[0]) <= -8, `last bite ${fmt(dB(biteLv[biteLv.length - 1] / biteLv[0]), 1)} dB re first`);
  const chC = centroid(spectrum(ch.x, SR, 0.05, 1.3), 150, 12000), crC = centroid(Sc, 150, 12000);
  check("chew: muffled (darker than crunch())", chC < crC * 0.7, `${fmt(chC, 0)} Hz vs crunch ${fmt(crC, 0)} Hz`);
  check("chew: softer than a munch", samplePeak(ch.buffer) < samplePeak(m.buffer) * 0.7, `peak ${fmt(samplePeak(ch.buffer))} vs ${fmt(samplePeak(m.buffer))}`);
  const short = await fxRender(1.2, [[0.05, (a) => a.chew(0.4)]], { seed: 4 });
  const sSpan = soundSpan(short.x, SR);
  check("chew(0.4): over within the duration (+ ring)", sSpan.end <= 0.05 + 0.4 + 0.25 && rmsOf(short.buffer, 0.9, 1.2) < 1e-4, `ends ${fmt(sSpan.end, 2)} s`);
  const ext = [];
  await fxRender(1.4, [[0.05, (a) => a.chew(0.4)], [0.25, (a) => a.chew(0.4)], [0.27, (a) => a.chew(0.4)]], { seed: 4, setup: (a) => { const f = a._chewBite; a._chewBite = function (t, v) { ext.push(t); return f.call(this, t, v); }; } });
  let minGap = Infinity; for (let i = 1; i < ext.length; i++) minGap = Math.min(minGap, ext[i] - ext[i - 1]);
  check("chew: calling again extends the chewing without doubling bites", minGap >= 0.11 && ext[ext.length - 1] > 0.45, `${ext.length} bites, min gap ${fmt(minGap * 1000, 0)} ms, last ${fmt(ext[ext.length - 1], 2)} s`);
}

async function testSqueak() {
  const res = {};
  for (const mood of ["happy", "ok", "sad"]) {
    const r = await fxRender(0.9, [[0.05, (a) => a.squeak(mood)]], { seed: 11 });
    const span = soundSpan(r.x, SR), track = pitchTrack(r.x, SR, 0.04, 0.8);
    const f = track.map((p) => p.f), med = median(f), slope = pitchSlope(track);
    res[mood] = { span, med, slope, track };
    check(`squeak '${mood}': audible, short (< 0.6 s)`, rmsOf(r.buffer, 0.05, 0.3) > 0.005 && span.dur < 0.6, `${fmt(dB(rmsOf(r.buffer, 0.05, 0.3)), 1)} dBFS, ${fmt(span.dur, 2)} s`);
    check(`squeak '${mood}': fundamental 600–1600 Hz`, track.length >= 5 && med >= 600 && med <= 1600 && Math.min(...f) > 550 && Math.max(...f) < 1700,
      `median ${fmt(med, 0)} Hz (${fmt(Math.min(...f), 0)}–${fmt(Math.max(...f), 0)}, ${track.length} frames)`);
  }
  check("squeak: 'happy' rises, 'sad' falls", res.happy.slope > 0.5 && res.sad.slope < -0.5, `${fmt(res.happy.slope, 2)} vs ${fmt(res.sad.slope, 2)} oct/s`);
  check("squeak: 'ok' is the short one", res.ok.span.dur < res.happy.span.dur && res.ok.span.dur < res.sad.span.dur,
    `ok ${fmt(res.ok.span.dur, 2)} s, happy ${fmt(res.happy.span.dur, 2)} s, sad ${fmt(res.sad.span.dur, 2)} s`);
  // vibrato on the sad tail: the pitch wobbles around its falling trend
  const tail = res.sad.track.filter((p) => p.t > 0.3 && p.t < 0.55);
  let wiggles = 0;
  if (tail.length > 6) {
    const n = tail.length, t = tail.map((p) => p.t), y = tail.map((p) => 1200 * Math.log2(p.f));
    // quadratic trend by least squares (normal equations, 3×3)
    const S = [0, 0, 0, 0, 0], Y = [0, 0, 0];
    for (let i = 0; i < n; i++) { let p = 1; for (let k = 0; k < 5; k++) { S[k] += p; if (k < 3) Y[k] += p * y[i]; p *= t[i]; } }
    const A = [[S[0], S[1], S[2], Y[0]], [S[1], S[2], S[3], Y[1]], [S[2], S[3], S[4], Y[2]]];
    for (let c = 0; c < 3; c++) for (let r = c + 1; r < 3; r++) { const m = A[r][c] / A[c][c]; for (let k = c; k < 4; k++) A[r][k] -= m * A[c][k]; }
    const co = [0, 0, 0];
    for (let r = 2; r >= 0; r--) { let s = A[r][3]; for (let k = r + 1; k < 3; k++) s -= A[r][k] * co[k]; co[r] = s / A[r][r]; }
    const resid = y.map((v, i) => v - (co[0] + co[1] * t[i] + co[2] * t[i] * t[i]));
    for (let i = 1; i < n; i++) if (Math.sign(resid[i]) !== Math.sign(resid[i - 1])) wiggles++;
  }
  check("squeak 'sad': a little vibrato", wiggles >= 2, `${wiggles} wiggles in ${tail.length} frames`);
  const rl = await fxRender(0.6, [[0.05, (a) => a.squeak()], [0.1, (a) => a.squeak()], [0.3, (a) => a.squeak("ok")]]);
  check("squeak: rate-limited (≥ 0.2 s apart)", rl.results.join() === "true,false,true", rl.results.join());
}

async function testCoins() {
  const one = (seed, s = 0.8) => fxRender(0.8, [[0.05, (a) => a.coin(s, seed)]], { seed: 3 });
  const c1 = await one(1), c2 = await one(2), c1b = await one(1);
  const S = spectrum(c1.x, SR, 0.05, 0.6);
  const hi = bandE(S, 2000, 20000) / bandE(S, 40, 20000);
  check("coin: audible, bright (≥ 90 % of the energy above 2 kHz)", rmsOf(c1.buffer, 0.05, 0.3) > 0.003 && hi >= 0.9, `${fmt(hi * 100, 1)} %, ${fmt(dB(rmsOf(c1.buffer, 0.05, 0.3)), 1)} dBFS`);
  const f1 = peakFreq(S, 1800, 2900);
  const inh = peakPow(S, 2.31 * f1, 0.02), h2 = peakPow(S, 2 * f1, 0.01), h3 = peakPow(S, 3 * f1, 0.01);
  check("coin: metallic, inharmonic partials (2.31·f ≫ 2·f, 3·f)", inh > 30 * h2 && inh > 30 * h3,
    `f ${fmt(f1, 0)} Hz; 2.31·f +${fmt(10 * Math.log10(inh / h2), 1)} dB over 2·f, +${fmt(10 * Math.log10(inh / h3), 1)} dB over 3·f`);
  const f2 = peakFreq(spectrum(c2.x, SR, 0.05, 0.6), 1800, 2900), f1b = peakFreq(spectrum(c1b.x, SR, 0.05, 0.6), 1800, 2900);
  check("coin: seed varies the pitch a little, same seed same pitch", Math.abs(f1 - f1b) < 0.5 && Math.abs(f2 / f1 - 1) > 0.005 && Math.abs(f2 / f1 - 1) < 0.18,
    `${fmt(f1, 0)} / ${fmt(f2, 0)} / ${fmt(f1b, 0)} Hz`);
  const gem = await fxRender(1.2, [[0.05, (a) => a.clink(0.8, 1)]], { seed: 3 });
  const gC = centroid(spectrum(gem.x, SR, 0.05, 0.6)), cC = centroid(S);
  const cSpan = soundSpan(c1.x, SR), gSpan = soundSpan(gem.x, SR);
  check("coin: distinct from the gem clink (brighter, shorter)", cC > gC + 1000 && cSpan.dur < gSpan.dur,
    `centroid ${fmt(cC, 0)} vs ${fmt(gC, 0)} Hz, ${fmt(cSpan.dur, 2)} vs ${fmt(gSpan.dur, 2)} s, peak ${fmt(samplePeak(c1.buffer))} vs ${fmt(samplePeak(gem.buffer))}`);
  check("coin: short ring (−30 dB within 0.6 s), then silence", cSpan.dur <= 0.6 && rmsOf(c1.buffer, 0.7, 0.8) < 1e-4, `${fmt(cSpan.dur, 2)} s`);
  const bounces = onsetPeaks(c1.x, SR, 0.04, 0.2, 0.02, -24);
  check("coin: lands with a little bounce (ching-ch-ch)", bounces.length >= 2, `${bounces.length} hits in 160 ms`);
  let n = 0;
  await JellyAudio.renderOffline(1.6, (a, t) => { if (t >= 0.5 && t < 1.5) n += a.coin(0.8, Math.round(t * 60)) ? 1 : 0; }, { sampleRate: SR, random: mulberry32(3) });
  check("coin: rate-limited (~16/s when called every frame)", n >= 12 && n <= 21, `${n} coins in 1 s`);

  // shower
  const times = [];
  const sh = await fxRender(2.8, [[0.05, (a) => a.coinShower(12, 1.2)]], { seed: 5, setup: (a) => { const f = a._coinNote; a._coinNote = function (t, ...r) { times.push(t); return f.call(this, t, ...r); }; } });
  const sp = times[times.length - 1] - times[0];
  const mid = times[0] + sp / 2, firstHalf = times.filter((t) => t < mid).length;
  check("coinShower: 12 coins over ~1.2 s", times.length === 12 && sp > 0.8 && sp <= 1.2, `${times.length} coins over ${fmt(sp, 2)} s`);
  check("coinShower: dense at first, thinning out", firstHalf >= 2 * (times.length - firstHalf), `${firstHalf} in the first half, ${times.length - firstHalf} in the second`);
  const shSpan = soundSpan(sh.x, SR);
  check("coinShower: audible and rings out (≤ duration + 0.6 s)", rmsOf(sh.buffer, 0.05, 1.3) > 0.003 && shSpan.end <= 0.05 + 1.2 + 0.6 && rmsOf(sh.buffer, 2.5, 2.8) < 1e-4,
    `${fmt(dB(rmsOf(sh.buffer, 0.05, 1.3)), 1)} dBFS, ends ${fmt(shSpan.end, 2)} s`);
  const shS = spectrum(sh.x, SR, 0.1, 1.2), shimmer = bandE(shS, 6500, 11000) / bandE(shS, 40, 20000);
  check("coinShower: light shimmer bed (6.5–11 kHz)", sh.audio.stats.maxBeds >= 1 && shimmer > 0.05, `${fmt(shimmer * 100, 1)} % of the energy`);
  check("coinShower: voice limits hold", sh.audio.stats.maxFxVoices <= LIMITS.fx && sh.audio.stats.maxBeds <= LIMITS.beds, `fx ${sh.audio.stats.maxFxVoices}, beds ${sh.audio.stats.maxBeds}`);
}

async function testCards() {
  const fl = await fxRender(0.7, [[0.05, (a) => a.cardFlip()]], { seed: 6 });
  const fSpan = soundSpan(fl.x, SR), S = spectrum(fl.x, SR, 0.05, 0.4);
  check("cardFlip: audible, short (−30 dB span ≤ 0.35 s)", rmsOf(fl.buffer, 0.05, 0.3) > 0.003 && fSpan.dur <= 0.35, `${fmt(dB(rmsOf(fl.buffer, 0.05, 0.3)), 1)} dBFS, ${fmt(fSpan.dur, 2)} s`);
  check("cardFlip: papery, broadband whoosh (0.6–8 kHz)", bandE(S, 600, 8000) / bandE(S, 40, 20000) > 0.6, `${fmt((bandE(S, 600, 8000) / bandE(S, 40, 20000)) * 100, 0)} %`);
  const sh = await fxRender(2.1, [[0.05, (a) => a.cardShake()]], { seed: 6 });
  const sSpan = soundSpan(sh.x, SR);
  check("cardShake: short anticipation (0.5–0.95 s), then silence", sSpan.dur >= 0.5 && sSpan.dur <= 0.95 && rmsOf(sh.buffer, 1.95, 2.1) < 1e-4, `${fmt(sSpan.dur, 2)} s`);
  const early = rmsOf(sh.buffer, 0.08, 0.3), late = rmsOf(sh.buffer, 0.5, 0.72);
  const cE = centroid(spectrum(sh.x, SR, 0.08, 0.3), 60, 12000), cL = centroid(spectrum(sh.x, SR, 0.5, 0.72), 60, 12000);
  check("cardShake: rising (louder and brighter)", late > 2 * early && cL > cE * 1.2, `+${fmt(dB(late / early), 1)} dB, centroid ${fmt(cE, 0)} → ${fmt(cL, 0)} Hz`);
  const rattle = onsetPeaks(sh.x, SR, 0.05, 0.75, 0.02, -30).length;
  check("cardShake: rattles", rattle >= 8, `${rattle} rattle hits`);
}

async function testReveal() {
  const r = {};
  for (const kind of ["new", "gold", "rainbow", "dupe"]) {
    const out = await fxRender(4.4, [[0.05, (a) => a.reveal(kind)]], { seed: 8 });
    r[kind] = { ...out, span: soundSpan(out.x, SR) };
    check(`reveal '${kind}': audible, ends in silence`, rmsOf(out.buffer, 0.05, 0.5) > 0.004 && rmsOf(out.buffer, 4.2, 4.4) < 1e-4,
      `${fmt(dB(rmsOf(out.buffer, 0.05, 0.5)), 1)} dBFS, −30 dB span ${fmt(r[kind].span.dur, 2)} s, voices fx ${out.audio.stats.maxFxVoices}/${LIMITS.fx} beds ${out.audio.stats.maxBeds}/${LIMITS.beds}`);
  }
  const d = (k) => r[k].span.dur;
  check("reveal: durations new ~1 s, gold ~1.5 s, rainbow ~2 s, dupe short", d("new") >= 0.6 && d("new") <= 1.3 && d("gold") >= 1 && d("gold") <= 2 && d("rainbow") >= 1.6 && d("rainbow") <= 3 && d("dupe") <= 1,
    `new ${fmt(d("new"), 2)}, gold ${fmt(d("gold"), 2)}, rainbow ${fmt(d("rainbow"), 2)}, dupe ${fmt(d("dupe"), 2)} s`);
  check("reveal: 'rainbow' longer and bigger than 'new'", d("rainbow") > d("new") + 0.5 && r.rainbow.audio.stats.fxNotes > 2 * r.new.audio.stats.fxNotes,
    `${fmt(d("rainbow"), 2)} vs ${fmt(d("new"), 2)} s, ${r.rainbow.audio.stats.fxNotes} vs ${r.new.audio.stats.fxNotes} notes`);
  const tuned = (x, t0, t1, played, off) => {
    const S = spectrum(x, SR, t0, t1, true);
    const pp = Math.min(...played.map((m) => peakPow(S, mtof(m), 0.008))), po = Math.max(...off.map((m) => peakPow(S, mtof(m), 0.008)));
    return 10 * Math.log10(pp / po);
  };
  const tn = tuned(r.new.x, 0.05, 1.0, [84, 88, 91, 96], [85, 87, 89, 90, 92, 94, 95]);
  check("reveal 'new': C-major pentatonic arpeggio (C6 E6 G6 C7 ≫ off-scale semitones)", tn >= 20, `${fmt(tn, 1)} dB`);
  const tr = tuned(r.rainbow.x, 0.8, 1.7, [72, 76, 79, 84], [73, 75, 77, 78, 80, 82, 83]);
  check("reveal 'rainbow': major chord bloom in tune (C5 E5 G5 C6)", tr >= 15, `${fmt(tr, 1)} dB`);
  const hiGl = centroid(spectrum(r.rainbow.x, SR, 0.45, 0.68), 300, 12000), loGl = centroid(spectrum(r.rainbow.x, SR, 0.05, 0.25), 300, 12000);
  check("reveal 'rainbow': glissando rises", hiGl > loGl * 1.5, `centroid ${fmt(loGl, 0)} → ${fmt(hiGl, 0)} Hz`);
  const gS = spectrum(r.gold.x, SR, 0.4, 1.2), nS = spectrum(r.new.x, SR, 0.25, 1.0);
  const gB = bandE(gS, 200, 1200) / bandE(gS, 200, 16000), nB = bandE(nS, 200, 1200) / bandE(nS, 200, 16000);
  check("reveal 'gold': warmer than 'new' (bell hum + chord)", gB > 2 * nB, `${fmt(gB * 100, 1)} % vs ${fmt(nB * 100, 1)} % below 1.2 kHz`);
  // a new reveal cuts the previous one (skipping through cards)
  const skip = await fxRender(4.4, [[0.05, (a) => a.reveal("rainbow")], [0.45, (a) => a.reveal("new")]], { seed: 8 });
  const skipSpan = soundSpan(skip.x, SR);
  check("reveal: a new reveal replaces the previous one", skipSpan.end < 0.45 + d("new") + 0.3 && rmsOf(skip.buffer, 2.0, 2.5) < rmsOf(r.rainbow.buffer, 2.0, 2.5) * 0.05,
    `ends ${fmt(skipSpan.end, 2)} s`);
  const lv = await fxRender(2.8, [[0.05, (a) => a.levelUp()]], { seed: 8 });
  const lSpan = soundSpan(lv.x, SR);
  check("levelUp: audible ~1 s jingle", rmsOf(lv.buffer, 0.05, 0.6) > 0.004 && lSpan.dur >= 0.7 && lSpan.dur <= 1.4 && rmsOf(lv.buffer, 2.6, 2.8) < 1e-4,
    `${fmt(dB(rmsOf(lv.buffer, 0.05, 0.6)), 1)} dBFS, ${fmt(lSpan.dur, 2)} s`);
  const tl = tuned(lv.x, 0.05, 1.0, [79, 84, 88, 91, 96], [80, 82, 83, 85, 87, 89, 90, 92, 94, 95]);
  check("levelUp: C-major pentatonic", tl >= 15, `${fmt(tl, 1)} dB`);
}

// spit/splat, squeak 'no'/'grumpy', special(), coinLoss()
async function testBunnyExtras() {
  // 퉤: a plosive burst and a wet spray; the chunk lands ~0.35 s later
  const sp = await fxRender(1.2, [[0.05, (a) => a.spit(0.8, 0)]], { seed: 12 });
  const spSpan = soundSpan(sp.x, SR), spS = spectrum(sp.x, SR, 0.05, 0.35);
  check("spit: audible 퉤, short (−30 dB span ≤ 0.3 s), then silence", rmsOf(sp.buffer, 0.05, 0.3) > 0.003 && spSpan.dur <= 0.3 && rmsOf(sp.buffer, 1.05, 1.2) < 1e-4,
    `${fmt(dB(rmsOf(sp.buffer, 0.05, 0.3)), 1)} dBFS, ${fmt(spSpan.dur, 2)} s`);
  const hiFrac = bandE(spS, 2000, 20000) / bandE(spS, 40, 20000);
  check("spit: wet spray (≥ 50 % of the energy above 2 kHz)", hiFrac >= 0.5, `${fmt(hiFrac * 100, 0)} %`);
  const env1 = envDb(sp.x, SR, 0.002);
  let pk = 0; for (let j = 0; j < 0.3 / 0.002; j++) if (env1[j] > env1[pk]) pk = j;
  check("spit: opens with the plosive (loudest within 20 ms of the call)", pk * 0.002 - 0.05 <= 0.02, `peak at +${fmt((pk * 0.002 - 0.05) * 1000, 0)} ms`);
  const sl = await fxRender(1.2, [[0.05, (a) => a.splat(0.8)]], { seed: 12 });
  const slSpan = soundSpan(sl.x, SR), slC = centroid(spectrum(sl.x, SR, 0.05, 0.3), 60, 12000), spC = centroid(spS, 60, 12000);
  check("splat: audible, short (≤ 0.25 s), a wet low plop (darker than the spit)", rmsOf(sl.buffer, 0.05, 0.25) > 0.003 && slSpan.dur <= 0.25 && slC < spC * 0.6 && rmsOf(sl.buffer, 1.05, 1.2) < 1e-4,
    `${fmt(dB(rmsOf(sl.buffer, 0.05, 0.25)), 1)} dBFS, ${fmt(slSpan.dur, 2)} s, centroid ${fmt(slC, 0)} vs spit ${fmt(spC, 0)} Hz`);
  const both = await fxRender(1.6, [[0.05, (a) => a.spit(0.8)]], { seed: 12 });
  const land = onsetPeaks(both.x, SR, 0.3, 0.6, 0.05, -12);
  check("spit(): the chunk lands ~0.35 s later (splat); spit(s, 0) has none", land.some((q) => Math.abs(q.t - 0.403) < 0.03) && rmsOf(sp.buffer, 0.38, 0.6) < rmsOf(both.buffer, 0.38, 0.6) * 0.05,
    `peaks at ${land.map((q) => fmt(q.t, 3)).join(", ")} s`);
  const rl = await fxRender(0.6, [[0.05, (a) => a.spit()], [0.2, (a) => a.spit()], [0.4, (a) => a.splat()], [0.4 + 1 / 60, (a) => a.splat()]]);
  check("spit/splat: rate-limited", rl.results.join() === "true,false,false,false", rl.results.join());

  // 흥흥 / 흥!
  const happy = await fxRender(1.0, [[0.05, (a) => a.squeak("happy")]], { seed: 11 });
  const hC = centroid(spectrum(happy.x, SR, 0.05, 0.4), 100, 12000);
  const sq = {};
  for (const mood of ["no", "grumpy"]) {
    const r = await fxRender(1.0, [[0.05, (a) => a.squeak(mood)]], { seed: 11 });
    const span = soundSpan(r.x, SR), track = pitchTrack(r.x, SR, 0.04, 0.8, 400, 1200);
    const f = track.map((q) => q.f), med = median(f);
    sq[mood] = { ...r, span, track };
    check(`squeak '${mood}': audible, short (${mood === "no" ? "≤ 0.5" : "≤ 0.25"} s)`, rmsOf(r.buffer, 0.05, 0.25) > 0.003 && span.dur <= (mood === "no" ? 0.5 : 0.25),
      `${fmt(dB(rmsOf(r.buffer, 0.05, 0.25)), 1)} dBFS, ${fmt(span.dur, 2)} s`);
    const c = centroid(spectrum(r.x, SR, 0.05, 0.45), 100, 12000);
    check(`squeak '${mood}': a falling, nasal grunt (450–850 Hz, darker than 'happy')`, track.length >= 5 && pitchSlope(track) < -0.3 && med > 450 && med < 850 && c < hC * 0.75,
      `median ${fmt(med, 0)} Hz, ${fmt(pitchSlope(track), 2)} oct/s, centroid ${fmt(c, 0)} vs ${fmt(hC, 0)} Hz`);
  }
  const grunts = onsetPeaks(sq.no.x, SR, 0.03, 0.6, 0.15, -15);
  const f1 = median(sq.no.track.filter((q) => q.t < 0.26).map((q) => q.f)), f2 = median(sq.no.track.filter((q) => q.t > 0.28).map((q) => q.f));
  check("squeak 'no': two grunts (흥흥), the second lower", grunts.length === 2 && f2 < f1 * 0.97, `${grunts.length} grunts, ${fmt(f1, 0)} → ${fmt(f2, 0)} Hz`);
  check("squeak 'grumpy': one grunt, shorter than 'no'", onsetPeaks(sq.grumpy.x, SR, 0.03, 0.6, 0.15, -15).length === 1 && sq.grumpy.span.dur < sq.no.span.dur * 0.7,
    `${fmt(sq.grumpy.span.dur, 2)} vs ${fmt(sq.no.span.dur, 2)} s`);

  // ★4 special
  const [spc, gold, rainbow] = await Promise.all(["special", "gold", "rainbow"].map((k) => fxRender(3.6, [[0.05, (a) => (k === "special" ? a.special() : a.reveal(k))]], { seed: 8 })));
  const d = (r) => soundSpan(r.x, SR).dur;
  check("special: audible ~1.6 s, ends in silence", rmsOf(spc.buffer, 0.05, 1.0) > 0.004 && d(spc) >= 1.3 && d(spc) <= 2.1 && rmsOf(spc.buffer, 3.4, 3.6) < 1e-4,
    `${fmt(dB(rmsOf(spc.buffer, 0.05, 1.0)), 1)} dBFS, −30 dB span ${fmt(d(spc), 2)} s, voices fx ${spc.audio.stats.maxFxVoices}/${LIMITS.fx} beds ${spc.audio.stats.maxBeds}/${LIMITS.beds}`);
  const rS = rmsOf(spc.buffer, 0.05, 1.5), rG = rmsOf(gold.buffer, 0.05, 1.5);
  check("special: grander than reveal('gold') (louder, more notes)", rS > rG * 1.2 && spc.audio.stats.fxNotes > 1.5 * gold.audio.stats.fxNotes,
    `+${fmt(dB(rS / rG), 1)} dB, ${spc.audio.stats.fxNotes} vs ${gold.audio.stats.fxNotes} notes`);
  const trend = (r) => centroid(spectrum(r.x, SR, 0.3, 0.44), 300, 12000) / centroid(spectrum(r.x, SR, 0.05, 0.17), 300, 12000);
  check("special: distinct from 'rainbow' (opening cascade falls where the rainbow rises; shorter)", trend(spc) < 0.8 && trend(rainbow) > 1.25 && d(spc) < d(rainbow) - 0.2,
    `opening centroid ×${fmt(trend(spc), 2)} vs rainbow ×${fmt(trend(rainbow), 2)}, ${fmt(d(spc), 2)} vs ${fmt(d(rainbow), 2)} s`);
  const Sb = spectrum(spc.x, SR, 0.5, 1.3, true);
  const pp = Math.min(...[72, 76, 79, 81].map((m) => peakPow(Sb, mtof(m), 0.008))), po = Math.max(...[73, 75, 77, 78, 80, 82, 83].map((m) => peakPow(Sb, mtof(m), 0.008)));
  check("special: C-major pentatonic bloom (C5 E5 G5 A5 ≫ off-scale semitones)", 10 * Math.log10(pp / po) >= 15, `${fmt(10 * Math.log10(pp / po), 1)} dB`);

  // coins taken away
  const lost = [];
  const cl = await fxRender(2.4, [[0.05, (a) => a.coinLoss(10)]], { seed: 5, setup: (a) => { const f = a._coinNote; a._coinNote = function (t, s, h, pan, tag, pitch) { lost.push({ t, pitch }); return f.call(this, t, s, h, pan, tag, pitch); }; } });
  const clSpan = soundSpan(cl.x, SR);
  check("coinLoss: 10 coins, audible, ~0.9 s then silence", lost.length === 10 && rmsOf(cl.buffer, 0.05, 0.7) > 0.003 && clSpan.dur >= 0.6 && clSpan.dur <= 1.2 && rmsOf(cl.buffer, 2.2, 2.4) < 1e-4,
    `${lost.length} coins, ${fmt(dB(rmsOf(cl.buffer, 0.05, 0.7)), 1)} dBFS, ${fmt(clSpan.dur, 2)} s`);
  const fE = peakFreq(spectrum(cl.x, SR, 0.05, 0.2), 1300, 2800), fL = peakFreq(spectrum(cl.x, SR, 0.5, 0.75), 1300, 2800);
  check("coinLoss: the clinks fall in pitch", fE / fL > 1.2 && lost.every((q, i) => !i || q.pitch < lost[i - 1].pitch), `${fmt(fE, 0)} → ${fmt(fL, 0)} Hz`);
  const wE = centroid(spectrum(cl.x, SR, 0.06, 0.18), 200, 1300), wL = centroid(spectrum(cl.x, SR, 0.3, 0.46), 200, 1300);
  check("coinLoss: a little 'whoop' down", wE > wL * 1.4, `${fmt(wE, 0)} → ${fmt(wL, 0)} Hz`);
  const rl2 = await fxRender(1.0, [[0.05, (a) => a.coinLoss()], [0.3, (a) => a.coinLoss()], [0.5, (a) => a.coinLoss()]]);
  check("coinLoss: rate-limited (≥ 0.4 s apart)", rl2.results.join() === "true,false,true", rl2.results.join());
}

// Everything at max volume: spammed every frame, then fired together every 0.5 s.
async function testFxStress() {
  const t0 = performance.now();
  let frame = 0;
  const { buffer, audio } = await JellyAudio.renderOffline(4.5, (a, t) => {
    frame++;
    a.setActivity(1, 0.5);
    a.clink(1, frame);
    if (t < 2.5) {
      a.squelch(1); a.pop(1);
      if (frame % 6 === 0) { a.boing(1, 1.2, "drop"); a.crunch(1); }
      fireAll(a, frame);
    } else if (frame % 30 === 0) {
      a.boing(1, 1, "drop"); a.crunch(1);
      fireAll(a, frame / 30);
    }
    if (frame === 200) a.setTexture("jelly");
  }, { sampleRate: SR, random: mulberry32(2024), setup: (a) => { a.setVolumes({ master: 1, crunch: 1, gems: 1, boing: 1, effects: 1 }); a.setTexture("slime"); } });
  const ms = performance.now() - t0;
  const tp = truePeak(buffer);
  check("fx stress (all volumes 1, every sound every frame): true peak < 1.0", tp < 1, `${fmt(dB(tp), 2)} dBFS`);
  const s = audio.stats;
  check("fx stress: voice limits hold (grains, gems, fx notes, beds)", s.maxGrains <= LIMITS.grains && s.maxGemVoices <= LIMITS.gems && s.maxFxVoices <= LIMITS.fx && s.maxBeds <= LIMITS.beds,
    `grains ${s.maxGrains}/${LIMITS.grains}, gems ${s.maxGemVoices}/${LIMITS.gems}, fx ${s.maxFxVoices}/${LIMITS.fx} (${s.fxSteals} stolen), beds ${s.maxBeds}/${LIMITS.beds} (${s.bedSteals} stolen)`);
  check("fx stress: queue stays bounded", audio._fxQueue.length <= 256, `${audio._fxQueue.length} pending at the end`);
  info(`fx stress: 4.5 s rendered in ${fmt(ms, 0)} ms (${fmt(4500 / ms, 1)}× realtime, offline: every scheduled node lives in the graph for the whole render): ${s.munches} munches, ${s.chewBites} chew bites, ${s.squeaks} squeaks, ${s.coins} coins (${s.coinDrops} rate-limited), ${s.reveals} reveals, ${s.fxNotes} fx notes, ${s.beds} beds`);
}

async function testFxDeterminism() {
  const plan = (a, t) => {
    const at = (x) => Math.abs(t - x) < 0.5 / 60;
    if (at(0.05)) { a.squeak("happy"); a.munch(0.9); a.chew(0.6); }
    if (at(0.4)) a.coinShower(10, 0.8);
    if (at(0.5)) a.cardShake();
    if (at(1.2)) { a.cardFlip(); a.reveal("rainbow"); }
    if (at(1.6)) { a.coin(0.7, 5); a.squeak("sad"); a.levelUp(); }
    if (at(2.2)) { a.spit(0.9); a.coinLoss(8); }
    if (at(2.5)) { a.squeak("no"); a.special(); }
    if (at(3.0)) { a.squeak("grumpy"); a.splat(0.7); }
  };
  const run = async (seed) => (await JellyAudio.renderOffline(4, plan, { sampleRate: 24000, random: mulberry32(seed) })).buffer;
  const [a, b, c] = [await run(77), await run(77), await run(78)];
  const diff = (p, q) => { let m = 0; for (let ch = 0; ch < 2; ch++) { const x = p.getChannelData(ch), y = q.getChannelData(ch); for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - y[i])); } return m; };
  const same = diff(a, b), other = diff(a, c);
  check("fx determinism: same seed → identical render (to float precision; Chromium varies ~1e-5)", same < 5e-5 && rmsOf(a, 0, 4) > 0.003, `max diff ${same.toExponential(1)}`);
  check("fx determinism: another seed → a different take", other > 1e-3, `max diff ${fmt(other, 4)}`);
}

// ================================== jelly motions, bunny sniff/kick, fun jingles
// Each new sound alone: [name, call, render length, expected −30 dB span (s)].
const MOTION_SOUNDS = [
  ["catYawn", (a) => a.catYawn(), 2.0, [0.9, 1.4]],
  ["catPunch", (a) => a.catPunch(), 1.6, [0.35, 0.6]],
  ["catPunch-1", (a) => a.catPunch(1), 1.2, [0.1, 0.3]],
  ["birdChirp", (a) => a.birdChirp(3), 1.5, [0.35, 0.65]],
  ["birdFlap", (a) => a.birdFlap(1.6), 2.6, [1.3, 1.75]],
  ["birdPlop", (a) => a.birdPlop(), 1.2, [0.06, 0.3]],
  ["sniff", (a) => a.sniff(), 1.3, [0.25, 0.4]],
  ["kick", (a) => a.kick(), 1.4, [0.15, 0.45]],
  ["giftOpen", (a) => a.giftOpen(), 2.4, [0.8, 1.6]],
  ["comboUp-5", (a) => a.comboUp(5), 2.0, [0.3, 1.0]],
  ["achievement", (a) => a.achievement(), 2.4, [0.8, 1.6]],
  ["discovery", (a) => a.discovery(), 2.8, [1.1, 2.0]],
  ["goldenOrder", (a) => a.goldenOrder(), 2.2, [0.6, 1.4]],
  ["toiletHop", (a) => a.toiletHop(), 1.0, [0.15, 0.35]],
  ["strain", (a) => a.strain(), 1.8, [0.45, 0.8]],
  ["flush", (a) => a.flush(), 2.6, [1.3, 1.75]],
  ["happyChime", (a) => a.happyChime(), 2.0, [0.6, 1.2]],
  ["burp", (a) => a.burp(), 1.3, [0.22, 0.45]],
  ["wandTwinkle", (a) => a.wandTwinkle(), 1.8, [0.5, 1.1]],
];
const motionWavs = {}, motionBuffers = {};
const allFinite = (buffer) => { for (let ch = 0; ch < buffer.numberOfChannels; ch++) for (const v of buffer.getChannelData(ch)) if (!Number.isFinite(v)) return false; return true; };
// Short-time peak frequency (Hann, `win` s, `hop` s) in [f0, f1], frames within relDb of the loudest.
function peakTrack(x, sr, t0, t1, f0, f1, win = 0.008, hop = 0.002, relDb = -12) {
  const out = [];
  for (let t = t0; t + win <= t1; t += hop) {
    const S = spectrum(x, sr, t, t + win, true);
    out.push({ t, f: peakFreq(S, f0, f1), e: bandE(S, f0, f1) });
  }
  const emax = Math.max(...out.map((q) => q.e));
  return out.filter((q) => q.e >= emax * 10 ** (relDb / 10));
}
// Repetition rate of the 2 ms RMS envelope in [t0, t1] (autocorrelation peak between fmin and fmax).
function envRate(x, sr, t0, t1, fmin, fmax) {
  const w = Math.floor(0.002 * sr), i0 = Math.floor(t0 * sr), n = Math.floor((t1 - t0) * sr / w), e = new Float64Array(n);
  for (let j = 0; j < n; j++) { let s = 0; for (let i = i0 + j * w; i < i0 + (j + 1) * w; i++) s += x[i] * x[i]; e[j] = Math.sqrt(s / w); }
  let m = 0; for (const v of e) m += v / n;
  for (let j = 0; j < n; j++) e[j] -= m;
  const ac = (lag) => { let s = 0; for (let j = 0; j + lag < n; j++) s += e[j] * e[j + lag]; return s / (n - lag); };
  const l0 = Math.floor(1 / fmax / 0.002), l1 = Math.ceil(1 / fmin / 0.002);
  let best = l0, bv = -Infinity;
  for (let lag = l0; lag <= l1; lag++) { const v = ac(lag); if (v > bv) { bv = v; best = lag; } }
  const a = ac(best - 1), b = bv, c = ac(best + 1);
  const lag = best + (0.5 * (a - c)) / (a - 2 * b + c || 1);
  return { rate: 1 / (lag * 0.002), strength: bv / ac(0) };
}

async function testMotionSounds() {
  const out = {};
  for (const [name, fn, len, [dMin, dMax]] of MOTION_SOUNDS) {
    let threw = null, r = null;
    try { r = await fxRender(len, [[0.05, fn]], { seed: 21 }); } catch (e) { threw = e; }
    if (threw) { check(`${name}: renders without throwing`, false, threw.stack || String(threw)); continue; }
    const span = soundSpan(r.x, SR), finite = allFinite(r.buffer);
    const rms = rmsOf(r.buffer, span.start, span.end), peak = samplePeak(r.buffer), tp = truePeak(r.buffer), tail = rmsOf(r.buffer, len - 0.15, len);
    out[name] = { ...r, span };
    motionBuffers[name] = r.buffer;
    motionWavs[name] = encodeWav(r.buffer);
    info(`${name}: −30 dB span ${fmt(span.dur, 2)} s (${fmt(span.start, 2)}–${fmt(span.end, 2)} s), RMS ${fmt(dB(rms), 1)} dBFS over it, peak ${fmt(peak, 3)} (${fmt(dB(peak), 1)} dBFS), true peak ${fmt(dB(tp), 1)} dBFS, voices fx ${r.audio.stats.maxFxVoices} beds ${r.audio.stats.maxBeds}`);
    check(`${name}: sounds (returns true), finite, audible, soft (peak < 0.5, no limiting), ${dMin}–${dMax} s, then silence`,
      r.results[0] === true && finite && rms > 0.003 && peak < 0.5 && tp < 1 && span.dur >= dMin && span.dur <= dMax && tail < 1e-4,
      `returned ${r.results[0]}, finite ${finite}, RMS ${fmt(dB(rms), 1)} dBFS, peak ${fmt(peak, 3)}, ${fmt(span.dur, 2)} s, tail ${fmt(dB(tail), 1)} dBFS`);
  }
  const o = (k) => out[k];
  // 냐아아암~: pitch up then down; the mouth (spectral centroid) opens then closes
  if (o("catYawn")) {
    const y = o("catYawn"), tr = pitchTrack(y.x, SR, 0.05, 1.05, 300, 1100);
    const fAt = (a, b) => median(tr.filter((q) => q.t >= a && q.t < b).map((q) => q.f));
    const fS = fAt(0.08, 0.2), fM = fAt(0.35, 0.5), fE = fAt(0.82, 0.96);
    check("catYawn: pitch rises then falls (냐 ↗ 아 ↘ 암)", tr.length >= 20 && fM > fS * 1.15 && fM > fE * 1.3 && fS > 400 && fM < 950,
      `${fmt(fS, 0)} → ${fmt(fM, 0)} → ${fmt(fE, 0)} Hz (${tr.length} voiced frames)`);
    const c = (a, b) => centroid(spectrum(y.x, SR, a, b), 200, 8000);
    const cS = c(0.055, 0.12), cM = c(0.33, 0.6), cE = c(0.86, 0.98);
    check("catYawn: formant/mouth opens then closes (centroid up, then down)", cM > cS * 1.3 && cM > cE * 1.5, `${fmt(cS, 0)} → ${fmt(cM, 0)} → ${fmt(cE, 0)} Hz`);
    const S = spectrum(y.x, SR, 0.33, 0.6, true), fPk = peakFreq(S, 900, 2600), Se = spectrum(y.x, SR, 0.86, 0.98, true), fPkE = peakFreq(Se, 400, 2600);
    info(`catYawn: strongest component 0.33–0.6 s ${fmt(fPk, 0)} Hz (open 'a'), 0.86–0.98 s ${fmt(fPkE, 0)} Hz (closed 'm')`);
    const breath = rmsOf(y.buffer, 1.0, 1.25), Sb = spectrum(y.x, SR, 1.0, 1.25);
    check("catYawn: breathy '하~' tail after the voice", breath > 1e-3 && bandE(Sb, 800, 4000) / bandE(Sb, 40, 20000) > 0.6, `${fmt(dB(breath), 1)} dBFS, ${fmt((bandE(Sb, 800, 4000) / bandE(Sb, 40, 20000)) * 100, 0)} % in 0.8–4 kHz`);
  }
  // 냥냥: two short bright meows 0.3 s apart, the second a touch higher
  if (o("catPunch")) {
    const p = o("catPunch"), pk = onsetPeaks(p.x, SR, 0.03, 0.7, 0.15, -12);
    const tr = pitchTrack(p.x, SR, 0.05, 0.6, 500, 1700);
    const f1 = median(tr.filter((q) => q.t < 0.3).map((q) => q.f)), f2 = median(tr.filter((q) => q.t >= 0.33).map((q) => q.f));
    check("catPunch: two '냥!'s ~0.3 s apart, bright (700–1400 Hz), the second higher", pk.length === 2 && Math.abs(pk[1].t - pk[0].t - 0.3) < 0.04 && f1 > 700 && f1 < 1400 && f2 > f1 * 1.03,
      `${pk.length} onsets at ${pk.map((q) => fmt(q.t, 3)).join(", ")} s, ${fmt(f1, 0)} → ${fmt(f2, 0)} Hz`);
    const one = await fxRender(0.8, [[0.05, (a) => a.catPunch(0)]], { seed: 21 });
    const cP = centroid(spectrum(p.x, SR, 0.05, 0.25), 200, 12000), cY = o("catYawn") ? centroid(spectrum(o("catYawn").x, SR, 0.05, 1.0), 200, 12000) : 0;
    check("catPunch(0): a single '냥!' (per-cue sync); punches brighter than the sleepy yawn", onsetPeaks(one.x, SR, 0.03, 0.7, 0.15, -12).length === 1 && soundSpan(one.x, SR).dur < 0.3 && cP > cY,
      `${fmt(soundSpan(one.x, SR).dur, 2)} s, centroid ${fmt(cP, 0)} vs yawn ${fmt(cY, 0)} Hz`);
  }
  // 짹짹짹: three high up-down sweeps in the kHz range, each at its own pitch
  if (o("birdChirp")) {
    const b = o("birdChirp"), pk = onsetPeaks(b.x, SR, 0.03, 0.8, 0.12, -15);
    const S = spectrum(b.x, SR, 0.05, 0.6), hi = bandE(S, 2500, 6500) / bandE(S, 200, 20000);
    check("birdChirp(3): three chirps, ≥ 80 % of the energy in 2.5–6.5 kHz", pk.length === 3 && hi >= 0.8, `${pk.length} chirps at ${pk.map((q) => fmt(q.t, 3)).join(", ")} s, ${fmt(hi * 100, 0)} %`);
    const gaps = pk.slice(1).map((q, i) => q.t - pk[i].t);
    const sweeps = pk.map((q) => {
      const tk = peakTrack(b.x, SR, q.t - 0.04, q.t + 0.08, 1500, 9000);
      const f = tk.map((z) => z.f), lo = Math.min(...f), hiF = Math.max(...f), at = tk[f.indexOf(hiF)].t;
      return { lo, hi: hiF, dur: tk[tk.length - 1].t + 0.008 - tk[0].t, upThenDown: f[0] < hiF * 0.85 && f[f.length - 1] < hiF * 0.9 && at > tk[0].t && at < tk[tk.length - 1].t };
    });
    info(`birdChirp: sweeps ${sweeps.map((s) => `${fmt(s.lo, 0)}–${fmt(s.hi, 0)} Hz/${fmt(s.dur * 1000, 0)} ms`).join(", ")}, onset gaps ${gaps.map((g) => fmt(g * 1000, 0)).join(", ")} ms`);
    check("birdChirp: each chirp sweeps up then down within ~2.8–5.4 kHz (≥ 30 %), ~50–110 ms, ~0.17–0.22 s apart",
      sweeps.every((s) => s.lo > 2800 && s.hi < 5400 && s.hi / s.lo >= 1.3 && s.upThenDown && s.dur >= 0.05 && s.dur <= 0.11) && gaps.every((g) => g > 0.17 && g < 0.23),
      sweeps.map((s) => `${fmt(s.lo, 0)}–${fmt(s.hi, 0)}${s.upThenDown ? "" : " (not ∧)"}`).join(", "));
    const tops = sweeps.map((s) => s.hi);
    check("birdChirp: a slightly different pitch per chirp", Math.max(...tops) / Math.min(...tops) > 1.01 && Math.max(...tops) / Math.min(...tops) < 1.2, tops.map((f) => fmt(f, 0)).join(" / ") + " Hz");
    const one = await fxRender(0.6, [[0.05, (a) => a.birdChirp(1)]], { seed: 21 }), eight = await fxRender(2.4, [[0.05, (a) => a.birdChirp(99)]], { seed: 21 });
    const none = await fxRender(0.3, [[0.05, (a) => a.birdChirp(0)]], { seed: 21 });
    const n1 = onsetPeaks(one.x, SR, 0.03, 0.5, 0.12, -15).length, n8 = onsetPeaks(eight.x, SR, 0.03, 2.2, 0.12, -15).length;
    check("birdChirp(count): 1 → one chirp, 99 → clamped to 8, 0 → nothing (false)", n1 === 1 && n8 === 8 && none.results[0] === false && samplePeak(none.buffer) < 1e-6, `${n1}, ${n8}, ${none.results[0]}`);
  }
  // 푸드득: soft noise flaps at ~10–12 Hz, swelling in and fading out
  if (o("birdFlap")) {
    const f = o("birdFlap"), r = envRate(f.x, SR, 0.15, 1.4, 5, 20);
    const S = spectrum(f.x, SR, 0.1, 1.5), c = centroid(S, 100, 12000);
    const early = rmsOf(f.buffer, 0.05, 0.12), mid = rmsOf(f.buffer, 0.4, 0.9), late = rmsOf(f.buffer, 1.45, 1.62);
    check("birdFlap(1.6): flaps at 10–12 Hz", r.rate >= 10 && r.rate <= 12 && r.strength > 0.3, `${fmt(r.rate, 2)} Hz (autocorrelation ${fmt(r.strength, 2)})`);
    check("birdFlap: soft airy noise (centroid 0.7–3 kHz), swells in and fades out", c > 700 && c < 3000 && mid > early * 1.5 && mid > late * 2, `centroid ${fmt(c, 0)} Hz, ${fmt(dB(early), 1)} → ${fmt(dB(mid), 1)} → ${fmt(dB(late), 1)} dBFS`);
    const short = await fxRender(1.0, [[0.05, (a) => a.birdFlap(0.4)]], { seed: 21 });
    check("birdFlap(0.4): follows the duration", soundSpan(short.x, SR).dur <= 0.45 && rmsOf(short.buffer, 0.7, 1.0) < 1e-4, `${fmt(soundSpan(short.x, SR).dur, 2)} s`);
  }
  if (o("birdPlop")) {
    const p = o("birdPlop"), c = centroid(spectrum(p.x, SR, 0.05, 0.3), 60, 12000);
    const tr = pitchTrack(p.x, SR, 0.045, 0.2, 200, 900);
    check("birdPlop: a round low '퐁' (centroid < 1.5 kHz), pitch falling", c < 1500 && tr.length >= 3 && pitchSlope(tr) < -1, `centroid ${fmt(c, 0)} Hz, ${tr.length ? fmt(tr[0].f, 0) + " → " + fmt(tr[tr.length - 1].f, 0) : "-"} Hz, ${fmt(pitchSlope(tr), 2)} oct/s`);
  }
  // 킁킁: two short noisy inhales that swell and stop
  if (o("sniff")) {
    const s = o("sniff"), pk = onsetPeaks(s.x, SR, 0.03, 0.6, 0.12, -12);
    const S = spectrum(s.x, SR, 0.05, 0.4), c = centroid(S, 100, 12000);
    const swell = [0.053, 0.253].map((t0) => { const e = envDb(s.x.subarray(Math.floor(t0 * SR), Math.floor((t0 + 0.13) * SR)), SR, 0.005); return e.indexOf(Math.max(...e)) * 0.005; });
    check("sniff: two inhales ~0.2 s apart, noisy 1–4 kHz, each swelling (loudest ≥ 50 ms in)", pk.length === 2 && Math.abs(pk[1].t - pk[0].t - 0.2) < 0.03 && c > 1000 && c < 4000 && swell.every((q) => q >= 0.05),
      `${pk.length} onsets at ${pk.map((q) => fmt(q.t, 3)).join(", ")} s, centroid ${fmt(c, 0)} Hz, loudest at +${swell.map((q) => fmt(q * 1000, 0)).join("/+")} ms`);
    const tr = pitchTrack(s.x, SR, 0.05, 0.4, 400, 2000);
    info(`sniff: ${tr.length} pitched frames (noise: few expected)`);
  }
  // 뻥!: thud right away, then a whoosh
  if (o("kick")) {
    const k = o("kick"), e = envDb(k.x, SR, 0.002);
    let pk = 0; for (let j = 0; j < 0.4 / 0.002; j++) if (e[j] > e[pk]) pk = j;
    const S = spectrum(k.x, SR, 0.05, 0.13), low = bandE(S, 40, 260) / bandE(S, 40, 20000);
    const Sw = spectrum(k.x, SR, 0.14, 0.32), cw = centroid(Sw, 100, 12000);
    check("kick: '뻥' thud at once (loudest within 25 ms), ≥ 40 % of the hit below 260 Hz, then a whoosh (centroid > 450 Hz)", pk * 0.002 - 0.05 <= 0.025 && low >= 0.4 && cw > 450 && rmsOf(k.buffer, 0.14, 0.32) > 1e-3,
      `peak at +${fmt((pk * 0.002 - 0.05) * 1000, 0)} ms, ${fmt(low * 100, 0)} % low, whoosh centroid ${fmt(cw, 0)} Hz at ${fmt(dB(rmsOf(k.buffer, 0.14, 0.32)), 1)} dBFS`);
  }
  // jingles: in tune (C-major pentatonic), shaped as described
  const tuned = (x, t0, t1, played, off) => {
    const S = spectrum(x, SR, t0, t1, true);
    const pp = Math.min(...played.map((m) => peakPow(S, mtof(m), 0.008))), po = Math.max(...off.map((m) => peakPow(S, mtof(m), 0.008)));
    return 10 * Math.log10(pp / po);
  };
  if (o("giftOpen")) {
    const g = o("giftOpen"), tn = tuned(g.x, 0.1, 1.0, [84, 88, 91, 96], [85, 87, 89, 90, 92, 94, 95]);
    const c1 = centroid(spectrum(g.x, SR, 0.14, 0.26), 300, 12000), c2 = centroid(spectrum(g.x, SR, 0.3, 0.42), 300, 12000);
    const popPk = envDb(g.x, SR, 0.002).slice(Math.floor(0.05 / 0.002), Math.floor(0.09 / 0.002));
    check("giftOpen: a pop, then a rising C-major pentatonic arpeggio", tn >= 15 && c2 > c1 * 1.2 && Math.max(...popPk) > soundSpan(g.x, SR).max - 15,
      `${fmt(tn, 1)} dB in tune, arpeggio centroid ${fmt(c1, 0)} → ${fmt(c2, 0)} Hz`);
  }
  // comboUp(level): one pentatonic step up per level, clamped to 1..10
  {
    const steps = [84, 86, 88, 91, 93, 96, 98, 100, 103, 105];
    const fOf = async (level) => { const r = await fxRender(0.8, [[0.05, (a) => a.comboUp(level)]], { seed: 21 }); return { f: peakFreq(spectrum(r.x, SR, 0.13, 0.5, true), 900, 4600), r }; };
    const got = [];
    for (const l of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) got.push((await fOf(l)).f);
    const rising = got.every((f, i) => !i || f > got[i - 1] * 1.05), inTune = got.every((f, i) => Math.abs(1200 * Math.log2(f / mtof(steps[i]))) < 15);
    check("comboUp(1..10): the chime steps up a pentatonic step per level (C6 … A7), in tune", rising && inTune, got.map((f) => fmt(f, 0)).join(" < ") + " Hz");
    const [z, big, nan] = [await fOf(0), await fOf(42), await fOf(NaN)];
    check("comboUp: level clamped (0 / NaN → 1, 42 → 10)", Math.abs(z.f / got[0] - 1) < 0.01 && Math.abs(nan.f / got[0] - 1) < 0.01 && Math.abs(big.f / got[9] - 1) < 0.01, `${fmt(z.f, 0)}, ${fmt(nan.f, 0)}, ${fmt(big.f, 0)} Hz`);
    const lv1 = rmsOf((await fOf(1)).r.buffer, 0.05, 0.6), lv10 = rmsOf((await fOf(10)).r.buffer, 0.05, 0.6);
    check("comboUp: higher levels a little fuller, never much louder (≤ +6 dB)", lv10 >= lv1 * 0.9 && dB(lv10 / lv1) <= 6, `level 1 ${fmt(dB(lv1), 1)} dBFS, level 10 ${fmt(dB(lv10), 1)} dBFS`);
  }
  if (o("achievement")) {
    const a = o("achievement"), dings = onsetPeaks(a.x, SR, 0.03, 0.33, 0.1, -10);
    const tn = tuned(a.x, 0.35, 1.0, [84, 88, 91, 96], [85, 87, 89, 90, 92, 94, 95]);
    check("achievement: ding-ding (two hits ~0.15 s apart) and an in-tune C-major bloom", dings.length === 2 && Math.abs(dings[1].t - dings[0].t - 0.15) < 0.03 && tn >= 15,
      `${dings.length} dings at ${dings.map((q) => fmt(q.t, 3)).join(", ")} s, bloom ${fmt(tn, 1)} dB in tune`);
  }
  if (o("discovery")) {
    const d = o("discovery");
    const c1 = centroid(spectrum(d.x, SR, 0.06, 0.2), 300, 12000), c2 = centroid(spectrum(d.x, SR, 0.26, 0.42), 300, 12000);
    const S = spectrum(d.x, SR, 0.5, 1.3), sh = bandE(S, 6500, 12000) / bandE(S, 40, 20000);
    const tn = tuned(d.x, 0.45, 1.3, [72, 76, 81, 96], [73, 75, 77, 78, 80, 82, 83]);
    check("discovery: magic glissando rises, shimmer above 6.5 kHz, in tune", c2 > c1 * 1.4 && sh > 0.03 && tn >= 15, `centroid ${fmt(c1, 0)} → ${fmt(c2, 0)} Hz, shimmer ${fmt(sh * 100, 1)} %, ${fmt(tn, 1)} dB in tune`);
  }
  if (o("goldenOrder")) {
    const g = o("goldenOrder"), c = centroid(spectrum(g.x, SR, 0.05, 0.5), 300, 14000);
    const tn = tuned(g.x, 0.27, 1.0, [91, 96], [90, 92, 94, 95, 97]);
    check("goldenOrder: a bright twinkle (centroid > 2.5 kHz) with an in-tune bell", c > 2500 && tn >= 12, `centroid ${fmt(c, 0)} Hz, ${fmt(tn, 1)} dB in tune`);
  }
  // v9 toilet trip
  if (o("toiletHop")) {
    const h = o("toiletHop"), tr = pitchTrack(h.x, SR, 0.05, 0.14, 300, 1200), pk = onsetPeaks(h.x, SR, 0.03, 0.4, 0.08, -20);
    const f0 = median(tr.filter((q) => q.t < 0.085).map((q) => q.f)), f1 = median(tr.filter((q) => q.t >= 0.085).map((q) => q.f));
    check("toiletHop: a rising '뿅' then a soft landing ~0.13 s later", tr.length >= 3 && f1 > f0 * 1.3 && pk.length === 2 && Math.abs(pk[1].t - pk[0].t - 0.13) < 0.03,
      `${fmt(f0, 0)} → ${fmt(f1, 0)} Hz, onsets ${pk.map((q) => fmt(q.t, 3)).join(", ")} s`);
  }
  if (o("strain") && o("burp")) {
    const st = o("strain"), bu = o("burp");
    const tS = pitchTrack(st.x, SR, 0.2, 0.6, 300, 1000), tB = pitchTrack(bu.x, SR, 0.1, 0.3, 180, 700);
    const fS = median(tS.map((q) => q.f)), fB = median(tB.map((q) => q.f));
    const cS = centroid(spectrum(st.x, SR, 0.2, 0.6), 100, 8000), cQ = centroid(spectrum((await fxRender(0.6, [[0.05, (a) => a.squeak("happy")]], { seed: 21 })).x, SR, 0.05, 0.3), 100, 8000);
    check("strain: a voiced, closed-mouth '끄응' (450–700 Hz), darker than a happy squeak", tS.length >= 20 && fS > 450 && fS < 700 && cS < cQ, `${fmt(fS, 0)} Hz (${tS.length} voiced frames), centroid ${fmt(cS, 0)} vs squeak ${fmt(cQ, 0)} Hz`);
    const rr = envRate(bu.x, SR, 0.1, 0.3, 15, 60);
    check("burp: a low round '끄억' (220–400 Hz, below the strain) with a ~30 Hz rattle", fB > 220 && fB < 400 && fB < fS && rr.rate > 25 && rr.rate < 40,
      `${fmt(fB, 0)} Hz (${tB.length} frames), rattle ${fmt(rr.rate, 1)} Hz (strength ${fmt(rr.strength, 2)})`);
  }
  if (o("flush")) {
    const f = o("flush"), S = spectrum(f.x, SR, 0.2, 1.2), water = bandE(S, 150, 3000) / bandE(S, 40, 20000);
    const mid = rmsOf(f.buffer, 0.5, 0.9), late = rmsOf(f.buffer, 1.3, 1.5), pk = onsetPeaks(f.x, SR, 0.2, 1.4, 0.03, -18);
    const c1 = centroid(spectrum(f.x, SR, 0.2, 0.6), 100, 8000), c2 = centroid(spectrum(f.x, SR, 1.1, 1.45), 100, 8000);
    check("flush: a ~1.5 s water rush (mostly 150 Hz–3 kHz) that swells, bubbles and drains lower", water > 0.75 && mid > late * 2 && pk.length >= 4 && c2 < c1,
      `${fmt(water * 100, 0)} % in 150–3000 Hz, mid ${fmt(dB(mid), 1)} vs end ${fmt(dB(late), 1)} dBFS, ${pk.length} bubble onsets, centroid ${fmt(c1, 0)} → ${fmt(c2, 0)} Hz`);
  }
  if (o("happyChime")) {
    const g = o("happyChime"), tn = tuned(g.x, 0.25, 0.9, [84, 88, 96], [85, 87, 89, 90, 92, 94, 95]);
    const c1 = centroid(spectrum(g.x, SR, 0.05, 0.11), 300, 12000), c2 = centroid(spectrum(g.x, SR, 0.17, 0.25), 300, 12000);
    check("happyChime: a rising, in-tune C-major '방긋' sparkle", tn >= 15 && c2 > c1 * 1.1, `${fmt(tn, 1)} dB in tune, centroid ${fmt(c1, 0)} → ${fmt(c2, 0)} Hz`);
  }
  if (o("wandTwinkle")) {
    const w = o("wandTwinkle"), c = centroid(spectrum(w.x, SR, 0.05, 0.6), 300, 16000), pk = onsetPeaks(w.x, SR, 0.03, 0.6, 0.03, -15);
    check("wandTwinkle: bright star dust (centroid > 3 kHz, a run of twinkles)", c > 3000 && pk.length >= 5, `centroid ${fmt(c, 0)} Hz, ${pk.length} onsets`);
  }
  // reference: existing sounds measured the same way (for level balance)
  for (const [name, fn, len] of [["squeak-happy", (a) => a.squeak("happy"), 1], ["spit", (a) => a.spit(0.8, 0), 1], ["levelUp", (a) => a.levelUp(), 2.4], ["reveal-new", (a) => a.reveal("new"), 2.4], ["coin", (a) => a.coin(0.8, 1), 1]]) {
    const r = await fxRender(len, [[0.05, fn]], { seed: 21 }), span = soundSpan(r.x, SR);
    info(`(reference) ${name}: −30 dB span ${fmt(span.dur, 2)} s, RMS ${fmt(dB(rmsOf(r.buffer, span.start, span.end)), 1)} dBFS over it, peak ${fmt(samplePeak(r.buffer), 3)} (${fmt(dB(samplePeak(r.buffer)), 1)} dBFS)`);
  }
}

// Rate limits, replacement and spamming of the new sounds.
async function testMotionLimits() {
  const pairs = [["catYawn", (a) => a.catYawn(), 0.5], ["catPunch", (a) => a.catPunch(0), 0.1], ["birdChirp", (a) => a.birdChirp(1), 0.12], ["birdFlap", (a) => a.birdFlap(0.5), 0.3],
    ["birdPlop", (a) => a.birdPlop(), 0.12], ["sniff", (a) => a.sniff(), 0.35], ["kick", (a) => a.kick(), 0.3], ["giftOpen", (a) => a.giftOpen(), 0.3], ["comboUp", (a) => a.comboUp(3), 0.12],
    ["achievement", (a) => a.achievement(), 0.3], ["discovery", (a) => a.discovery(), 0.3], ["goldenOrder", (a) => a.goldenOrder(), 0.3],
    ["toiletHop", (a) => a.toiletHop(), 0.15], ["strain", (a) => a.strain(), 0.4], ["flush", (a) => a.flush(), 0.5], ["happyChime", (a) => a.happyChime(), 0.3],
    ["burp", (a) => a.burp(), 0.4], ["wandTwinkle", (a) => a.wandTwinkle(), 0.25]];
  const bad = [];
  for (const [name, fn, gap] of pairs) {
    const r = await fxRender(0.2 + gap + 0.1, [[0.05, fn], [0.05 + 1 / 60, fn], [0.05 + gap + 2 / 60, fn]], { seed: 3 });
    if (r.results.join() !== "true,false,true") bad.push(`${name} ${r.results.join()}`);
  }
  check("motions/jingles: rate-limited (a 2nd call within the gap is dropped, false)", bad.length === 0, bad.join("; ") || pairs.map(([n, , g]) => `${n} ${g * 1000} ms`).join(", "));
  // a new yawn / flutter replaces the old one instead of stacking
  const one = await fxRender(2.4, [[0.05, (a) => a.birdFlap(1.6)]], { seed: 3 }), two = await fxRender(2.4, [[0.05, (a) => a.birdFlap(1.6)], [0.6, (a) => a.birdFlap(1.6)]], { seed: 3 });
  const s2 = soundSpan(two.x, SR);
  check("birdFlap: a new flutter replaces the old (no doubling)", rmsOf(two.buffer, 0.7, 1.0) < rmsOf(one.buffer, 0.4, 0.9) * 1.4 && s2.end < 0.6 + 1.7 && s2.end > 2.0,
    `${fmt(dB(rmsOf(two.buffer, 0.7, 1.0) / rmsOf(one.buffer, 0.4, 0.9)), 1)} dB vs a single flutter, ends ${fmt(s2.end, 2)} s`);
  // per-cue punches: catPunch(0) + catPunch(1) 0.3 s apart ≈ catPunch()
  const full = await fxRender(1.0, [[0.05, (a) => a.catPunch()]], { seed: 3 }), cue = await fxRender(1.0, [[0.05, (a) => a.catPunch(0)], [0.35, (a) => a.catPunch(1)]], { seed: 3 });
  const pf = onsetPeaks(full.x, SR, 0.03, 0.8, 0.15, -12).map((q) => q.t), pc = onsetPeaks(cue.x, SR, 0.03, 0.8, 0.15, -12).map((q) => q.t);
  check("catPunch(0)+catPunch(1) per cue ≈ catPunch()", pf.length === 2 && pc.length === 2 && Math.abs(pf[1] - pc[1]) < 0.025 && Math.abs(dB(rmsOf(full.buffer, 0, 1) / rmsOf(cue.buffer, 0, 1))) < 1.5,
    `onsets ${pf.map((t) => fmt(t, 3)).join("/")} vs ${pc.map((t) => fmt(t, 3)).join("/")} s`);

  // all of them every frame for 3 s at all volumes 1, with the bunny eating
  const t0 = performance.now();
  let frame = 0;
  const { buffer, audio } = await JellyAudio.renderOffline(3, (a, t) => {
    frame++;
    fireMotions(a, frame);
    if (frame % 20 === 0) { a.munch(1); a.squeak("happy"); a.coin(1, frame); }
  }, { sampleRate: SR, random: mulberry32(808), setup: (a) => a.setVolumes({ master: 1, crunch: 1, gems: 1, boing: 1, effects: 1 }) });
  const ms = performance.now() - t0, s = audio.stats, tp = truePeak(buffer);
  check("motions stress (every new sound every frame, all volumes 1): finite, true peak < 1.0, voice limits and queue hold",
    allFinite(buffer) && tp < 1 && s.maxFxVoices <= LIMITS.fx && s.maxBeds <= LIMITS.beds && s.maxGrains <= LIMITS.grains && audio._fxQueue.length <= 256,
    `true peak ${fmt(dB(tp), 2)} dBFS, fx ${s.maxFxVoices}/${LIMITS.fx} (${s.fxSteals} stolen), beds ${s.maxBeds}/${LIMITS.beds} (${s.bedSteals} stolen), queue ${audio._fxQueue.length}`);
  info(`motions stress: 3 s rendered in ${fmt(ms, 0)} ms, ${s.fxNotes} fx notes, ${s.beds} beds`);

  // determinism
  const plan = (a, t) => {
    const at = (x) => Math.abs(t - x) < 0.5 / 60;
    if (at(0.05)) { a.catYawn(); a.birdChirp(4); }
    if (at(0.5)) { a.catPunch(); a.sniff(); }
    if (at(0.9)) { a.birdFlap(0.8); a.comboUp(4); }
    if (at(1.7)) { a.birdPlop(); a.kick(); a.goldenOrder(); }
    if (at(2.0)) { a.giftOpen(); a.achievement(); }
    if (at(2.4)) a.discovery();
    if (at(2.6)) { a.toiletHop(); a.burp(); }
    if (at(2.9)) { a.strain(); a.wandTwinkle(); }
    if (at(3.2)) { a.flush(); a.happyChime(); }
  };
  const run = async (seed) => (await JellyAudio.renderOffline(4, plan, { sampleRate: 24000, random: mulberry32(seed) })).buffer;
  const [a, b, c] = [await run(5), await run(5), await run(6)];
  const diff = (p, q) => { let m = 0; for (let ch = 0; ch < 2; ch++) { const x = p.getChannelData(ch), y = q.getChannelData(ch); for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - y[i])); } return m; };
  check("motions determinism: same seed → identical render; another seed → a different take", diff(a, b) < 5e-5 && diff(a, c) > 1e-3 && rmsOf(a, 0, 4) > 0.003,
    `max diff ${diff(a, b).toExponential(1)} / ${fmt(diff(a, c), 4)}`);
}

let demoRender = null;
// A short listening demo: bunny eats (와삭 냠냠 ×4), squeaks, coins rain, a card shakes, flips, goes rainbow, level up;
// then a grumpy bunny spits a bite out (퉤), refuses (흥흥), coins are taken away, and a ★4 special.
async function testDemo() {
  const plan = [[0.2, (a) => a.squeak("happy")]];
  [0.7, 1.5, 2.3, 3.1].forEach((t, i) => plan.push([t, (a) => { a.munch(i === 2 ? 1 : 0.8); a.chew(i === 3 ? 0.8 : 0.55); }]));
  plan.push([4.1, (a) => a.squeak("happy")], [4.6, (a) => a.coinShower(14, 1.3)], [6.2, (a) => a.cardShake()], [6.95, (a) => a.cardFlip()],
    [7.05, (a) => a.reveal("rainbow")], [9.3, (a) => a.levelUp()], [10.25, (a) => a.squeak("happy")],
    [11.0, (a) => { a.munch(0.8); }], [11.35, (a) => a.squeak("grumpy")], [11.75, (a) => a.spit(0.9)], [12.6, (a) => a.squeak("no")],
    [13.2, (a) => a.coinLoss(10)], [14.4, (a) => a.special()]);
  const DEMO = 16.5;
  const t0 = performance.now();
  const out = await fxRender(DEMO, plan, { seed: 2025 });
  const ms = performance.now() - t0;
  demoRender = out.buffer;
  const tp = truePeak(out.buffer);
  check("demo render (eat, squeak, coins, shake, flip, rainbow, level up, 흥 퉤 흥흥, coins lost, ★4 special): audible, true peak < 1.0", rmsOf(out.buffer, 0, DEMO) > 0.005 && tp < 1,
    `${fmt(dB(rmsOf(out.buffer, 0, DEMO)), 1)} dBFS RMS, true peak ${fmt(dB(tp), 2)} dBFS`);
  info(`demo: ${DEMO} s rendered in ${fmt(ms, 0)} ms (${fmt((DEMO * 1000) / ms, 1)}× realtime)`);
  // CPU proxy for a busy gacha moment: two big showers, a rainbow reveal, a level-up and munching at once
  const t1 = performance.now();
  const busy = await fxRender(4, [[0.1, (a) => { a.coinShower(40, 2); a.reveal("rainbow"); a.munch(1); a.chew(2); a.cardFlip(); a.squeak("happy"); }],
    [1.0, (a) => { a.levelUp(); a.munch(1); }], [1.5, (a) => { a.coinShower(40, 2); a.munch(1); }]], { seed: 9 });
  const bms = performance.now() - t1, bs = busy.audio.stats;
  info(`busy gacha moment: 4 s rendered in ${fmt(bms, 0)} ms (${fmt(4000 / bms, 1)}× realtime), fx voices ${bs.maxFxVoices}/${LIMITS.fx}, beds ${bs.maxBeds}/${LIMITS.beds}, grains ${bs.maxGrains}/${LIMITS.grains}, true peak ${fmt(dB(truePeak(busy.buffer)), 2)} dBFS`);
}

async function main() {
  let steps = [testApi, testOutputStage, testBoingMatchesLegacy, testSmoothing, testMainRender, testFx, testGemTimbre, testRateLimit, testStress, testSilenceAndDeterminism,
    testFxApi, testMunchChew, testSqueak, testCoins, testCards, testReveal, testBunnyExtras, testFxStress, testFxDeterminism, testMotionSounds, testMotionLimits, testDemo, testRealtime];
  // ?only=testMotionSounds,testMotionLimits runs a subset (node tests/audio.test.mjs testMotionSounds …)
  const only = new URLSearchParams(location.search).get("only");
  if (only) { const names = only.split(","); steps = steps.filter((s) => names.includes(s.name)); info(`only: ${steps.map((s) => s.name).join(", ")}`); }
  for (const step of steps) {
    try { await step(); } catch (e) { check(`${step.name} threw`, false, e && e.stack ? e.stack : String(e)); }
  }
  log(failures ? `\n${failures} FAILED` : "\nALL AUDIO CHECKS PASSED");
  window.__audioTest = { done: true, failures, lines, wav: mainRender ? encodeWav(mainRender) : null, demoWav: demoRender ? encodeWav(demoRender) : null, soundWavs: motionWavs };
  const play = (buffer) => () => {
    const ctx = new AudioContext();
    const src = ctx.createBufferSource(); src.buffer = buffer; src.connect(ctx.destination); src.start();
  };
  const btn = document.getElementById("listen");
  if (btn && mainRender) {
    btn.disabled = false;
    btn.onclick = play(mainRender);
  }
  if (btn && demoRender) {
    const demo = document.createElement("button");
    demo.textContent = "▶ play bunny/gacha demo";
    demo.onclick = play(demoRender);
    btn.after(" ", demo);
  }
  const names = Object.keys(motionBuffers);
  if (names.length && btn) {
    const row = document.createElement("p");
    for (const name of names) {
      const b = document.createElement("button");
      b.textContent = `▶ ${name}`;
      b.onclick = play(motionBuffers[name]);
      row.append(b, " ");
    }
    btn.parentElement.after(row);
  }
}
main();
