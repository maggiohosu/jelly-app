// 말랑젤리 — app orchestration.
// Threads: main (render, input, audio), sim worker (240 Hz XPBD jelly, paint
// field, gems), optics worker (receiver shadow + view thickness).
import { createStage, TRAY_RADIUS } from "../render/stage.js";
import { createJellyView } from "../render/jelly-view.js";
import { createInput } from "../render/input.js";
import { createGemLibrary, GemLayer, GEM_SHAPES } from "../render/gems.js";
import { PAINTS } from "../core/world.js";
import { JellyAudio } from "./audio.js";
import { QualityGovernor } from "./quality.js";
import { buildUI, loadSettings, physicsParams } from "./ui.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

let toastTimer = 0;
function toast(message, ms = 2200) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}

function fatal(message) {
  $("start").hidden = true;
  $("fatal").hidden = false;
  if (message) $("fatal-message").textContent = message;
}

function once(worker, type) {
  return new Promise((resolve, reject) => {
    const handler = ({ data }) => {
      if (data.type === type) { worker.removeEventListener("message", handler); resolve(data); }
      else if (data.type === "error") { worker.removeEventListener("message", handler); reject(new Error(data.message)); }
    };
    worker.addEventListener("message", handler);
  });
}

async function boot() {
  if (!isStandalone && isIOS) $("install-hint").hidden = false;
  if (!isStandalone) $("install-hint-2").hidden = !isIOS;

  const canvas = $("stage");
  let stage;
  try {
    stage = await createStage(canvas, { forceWebGL: params.get("lite") === "1" });
  } catch (error) {
    console.error(error);
    fatal();
    return;
  }
  const { renderer, camera, isWebGPU, tray } = stage;
  const settings = loadSettings();

  // ---- workers ----
  const sim = new Worker(new URL("../workers/sim-worker.js", import.meta.url), { type: "module" });
  const optics = new Worker(new URL("../workers/optics-worker.js", import.meta.url), { type: "module" });
  let ready;
  try {
    const simReady = once(sim, "ready");
    sim.postMessage({ type: "init", wallRadius: TRAY_RADIUS, base: settings.base });
    ready = await simReady;
    const opticsReady = once(optics, "ready");
    optics.postMessage({ type: "init", size: 192 });
    await opticsReady;
  } catch (error) {
    console.error(error);
    fatal("물리 엔진을 시작하지 못했어요. 페이지를 새로고침해 주세요.");
    return;
  }

  const view = createJellyView(stage, ready, { caustics: params.get("caustics") !== "0" });
  const gemLibrary = createGemLibrary({ quality: "high" });
  const gemLayer = new GemLayer(tray, gemLibrary);
  gemLayer.setGlowScale(settings.glow);
  const audio = new JellyAudio();
  audio.setVolumes({ master: settings.master, piano: settings.piano, gems: settings.gems, boing: settings.boing });
  audio.tempo = settings.tempo;
  audio.onNote((note) => { view.pulse(0.12 + 0.3 * note.velocity); needsRender = true; });

  // GPU errors only affect the caustic passes: drop those. A lost device leaves
  // a frozen canvas: reload once; twice within a minute → WebGL2 lite mode.
  renderer.onError = (error) => {
    console.warn("GPU error:", error.message);
    if (view.hasCaustics) { view.disableCaustics(); updateStatus(); toast("이 기기에서는 무지갯빛 굴절광을 끄고 계속할게요"); needsRender = true; }
  };
  renderer.onDeviceLost = (info) => {
    console.warn("GPU device lost:", info.message);
    if (document.hidden) { document.addEventListener("visibilitychange", () => location.reload(), { once: true }); return; }
    let history = [];
    try { history = JSON.parse(sessionStorage.getItem("jelly-device-lost") || "[]"); } catch { /* private mode */ }
    const now = Date.now();
    history = history.filter((t) => now - t < 60000).concat(now);
    try { sessionStorage.setItem("jelly-device-lost", JSON.stringify(history)); } catch { /* private mode */ }
    const url = new URL(location.href);
    if (history.length >= 2) url.searchParams.set("lite", "1");
    location.replace(url.href);
  };

  if (!isWebGPU) { $("badge").hidden = false; $("badge").textContent = "라이트 모드"; }

  // ---- shared state ----
  const pendingEvents = [];
  const freeBuffers = [];
  const opticsPool = [];
  let topologySent = false;
  let simBusy = false, pendingDt = 0;
  let opticsBusy = false, opticsClock = 1, opticsDirty = true, causticClock = 1;
  let started = false, needsRender = true, running = false, frameId = 0;
  let lastTime = 0, lastAnimatedTime = 0;
  let asleep = false, grabbing = false, grabHeight = 0, lastStretch = 0;
  let lastGravity = null, lastGravitySent = 0;
  let soundOn = true;
  const eventLog = [];

  const governor = new QualityGovernor({
    onTier: (tier) => { applyTier(tier); if (started && governor.auto) toast(`화질을 '${tier.label}'(으)로 맞췄어요`); },
    onPhysicsRate: (hz) => { pendingEvents.push({ type: "rate", hz }); updateStatus(); toast("기기 부하가 커서 물리 계산을 절전 모드로 바꿨어요"); },
  });
  function applyTier(tier) {
    view.setCaustics(tier.caustics);
    stage.setBloom(tier.bloom);
    gemLibrary.setQuality(tier.gems);
    applyResolution();
    updateStatus();
  }
  function applyResolution() {
    const width = Math.max(1, canvas.clientWidth), height = Math.max(1, canvas.clientHeight);
    stage.resize(width, height, Math.min(window.devicePixelRatio || 1, governor.tier.maxDpr));
    needsRender = true; opticsDirty = true;
  }
  window.addEventListener("resize", applyResolution);
  screen.orientation?.addEventListener?.("change", applyResolution);

  function updateStatus() {
    const t = governor.tier;
    const backend = isWebGPU ? "WebGPU" : "WebGL2 라이트 모드";
    const fx = [view.causticsOn ? "코스틱" : null, stage.bloomOn ? "후광" : null].filter(Boolean).join("·") || "효과 최소";
    $("status-line").textContent = `${backend} · ${fx} · 화질 ${t.label}${governor.auto ? "(자동)" : ""} · 물리 ${governor.physicsHz}Hz`;
  }

  // ---- sim worker ----
  sim.onmessage = ({ data }) => {
    if (data.type === "error") { console.error(data.message); simBusy = false; return; }
    if (data.type !== "frame") return;
    simBusy = false;
    view.sync(data, (buffer) => freeBuffers.push(buffer));
    gemLayer.update(data.gems || EMPTY, data.gemCount);
    if (data.gems) freeBuffers.push(data.gems.buffer);
    asleep = data.asleep;
    if (data.positions || data.dye || data.gemCount) { needsRender = true; opticsDirty = opticsDirty || Boolean(data.positions); }
    grabbing = Boolean(data.grab);
    if (data.grab) {
      grabHeight = data.grab.target[1];
      lastStretch = Math.hypot(data.grab.point[0] - data.grab.target[0], data.grab.point[1] - data.grab.target[1], data.grab.point[2] - data.grab.target[2]);
    }
    if (data.stepMs) governor.physics(data.stepMs, performance.now());
    for (const e of data.events) {
      if (eventLog.push(e.type) > 200) eventLog.shift();
      switch (e.type) {
        case "release": if (e.stretch > 0.006) audio.boing(e.stretch / 0.03, 1.08, "snap"); break;
        case "clink": audio.clink(e.strength, e.seed); break;
        case "gemFull": toast("보석이 가득 찼어요"); break;
        case "gemIn": case "gemScatter": audio.clink(0.45, (e.gem || e.count || 1) * 13); break;
        case "recovered": toast("젤리가 너무 늘어나서 처음 모양으로 돌아왔어요"); break;
      }
    }
    if (data.impact > 0.22) audio.boing((data.impact - 0.18) / 0.6, 1, "drop");
    else if (data.wallImpact > 0.12) audio.boing((data.wallImpact - 0.1) / 0.4 * 0.7, 0.9, "bump");
  };
  const EMPTY = new Float32Array(0);

  // ---- optics worker ----
  optics.onmessage = ({ data }) => {
    if (data.type === "error") { console.error(data.message); opticsBusy = false; return; }
    if (data.type !== "field") return;
    opticsBusy = false;
    view.applyField(data);
    for (const buffer of data.returned) opticsPool.push(buffer);
    opticsPool.push(data.shadowBytes.buffer);
    needsRender = true;
  };
  function takeOpticsBuffer(bytes, Type) {
    const i = opticsPool.findIndex((b) => b.byteLength === bytes);
    return i >= 0 ? new Type(opticsPool.splice(i, 1)[0]) : null;
  }
  function sendOptics() {
    const position = view.geometry.attributes.position.array, normal = view.geometry.attributes.normal.array;
    const positions = takeOpticsBuffer(position.byteLength, Float32Array) || new Float32Array(position.length);
    const normals = takeOpticsBuffer(normal.byteLength, Float32Array) || new Float32Array(normal.length);
    positions.set(position); normals.set(normal);
    const body = { id: 0, positions, normals };
    if (!topologySent) { body.indices = view.geometry.index.array; topologySent = true; }
    const shadowBytes = takeOpticsBuffer(192 * 192 * 4, Uint8Array) || undefined;
    const transfer = [positions.buffer, normals.buffer];
    if (shadowBytes) transfer.push(shadowBytes.buffer);
    const tc = stage.syncTrayCamera();
    optics.postMessage({ type: "update", camera: [tc.position.x, tc.position.y, tc.position.z], bodies: [body], keep: [0], shadowBytes }, transfer);
    opticsBusy = true;
    opticsDirty = false;
  }

  // ---- input ----
  const input = createInput({
    canvas, stage, view,
    isEnabled: () => started,
    onGrabStart: (hit) => { pendingEvents.push({ type: "grabStart", a: hit.a, b: hit.b, c: hit.c, bary: hit.bary, point: hit.point }); grabbing = true; },
    onGrabMove: (point) => pendingEvents.push({ type: "target", point }),
    onGrabEnd: () => { pendingEvents.push({ type: "grabEnd" }); grabbing = false; },
    onTap: () => {},
    onTilt: (dir, angle) => {
      if (!dir || angle <= 0) { stage.tilt.goalAngle = 0; return; }
      stage.tilt.goalAxis.set(0, 1, 0).cross(dir).normalize();
      stage.tilt.goalAngle = angle;
      needsRender = true;
    },
    onInteract: dismissHint,
  });

  // ---- pipette: a droplet falls from the tip and colours the jelly on impact ----
  function releaseDrop(paint, hit) {
    const p = PAINTS[paint];
    view.dropPaint(hit.point, hit.normal, p.hex, () => {
      pendingEvents.push({ type: "drop", point: hit.point, paint });
      audio.drip(0.7, p.sigma ? 1 : 1.25);
      needsRender = true;
    });
    needsRender = true;
    dismissHint();
  }
  function pickAt(x, y) { return view.pick(x, y, canvas.getBoundingClientRect()); }
  function topHit() {
    // the jelly's top seen from the camera
    const v = view.state.center.clone(); v.y = view.geometry.boundingBox.max.y * 0.98;
    tray.localToWorld(v); v.project(camera);
    const r = canvas.getBoundingClientRect();
    return pickAt(r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height);
  }

  // ---- UI ----
  const sendParams = () => pendingEvents.push({ type: "params", params: physicsParams(settings) });
  sendParams();
  buildUI({
    settings,
    onSetting: (key, value) => {
      if (key === "softness" || key === "wobble" || key === "slippery") sendParams();
      else if (key === "glow") { gemLayer.setGlowScale(value); stage.setBloomStrength(Math.max(0.2, value)); needsRender = true; }
      else if (key === "tempo") audio.tempo = value;
      else if (["piano", "gems", "boing", "master"].includes(key)) audio.setVolumes({ [key]: value });
    },
    onPaintDrop: (paint, x, y, holding) => {
      const hit = pickAt(x, y);
      if (!hit) { if (!holding) toast("젤리 위에서 놓아 주세요"); return false; }
      releaseDrop(paint, hit);
      return true;
    },
    onPaintTap: (paint) => { const hit = topHit(); if (hit) releaseDrop(paint, hit); },
    onGemDrop: (shape, color, x, y) => {
      const hit = pickAt(x, y);
      if (!hit) { toast("젤리 위에 놓아 주세요"); return; }
      pendingEvents.push({ type: "gemAdd", a: hit.a, b: hit.b, c: hit.c, bary: hit.bary, shape, color, radius: gemRadius(shape) });
      dismissHint();
    },
    onGemTap: (shape, color) => pendingEvents.push({ type: "gemScatter", count: 1, shape, color, radius: gemRadius(shape) }),
    onScatter: (color) => pendingEvents.push({ type: "gemScatter", count: 6, shape: -1, color, radius: gemRadius(-1), shapes: GEM_SHAPES.length }),
    onBase: (base) => { pendingEvents.push({ type: "base", base }); needsRender = true; },
  });
  function gemRadius(shape) {
    const shapes = gemLibrary.shapes;
    const r = shape >= 0 ? shapes[shape].radius : shapes.reduce((m, s) => Math.max(m, s.radius), 0);
    return Math.max(0.0025, Math.min(0.0045, r * 0.85));
  }

  $("gems").addEventListener("click", () => {
    const drawer = $("gem-drawer"), open = drawer.hidden;
    drawer.hidden = !open;
    $("gems").setAttribute("aria-pressed", String(open));
    $("gems").classList.toggle("on", open);
    if (open) dismissHint();
  });
  $("nudge").addEventListener("click", () => { pendingEvents.push({ type: "nudge" }); dismissHint(); });
  $("reset").addEventListener("click", () => { pendingEvents.push({ type: "reset", base: settings.base }); });
  $("sound").addEventListener("click", () => {
    soundOn = !soundOn;
    audio.setEnabled(soundOn);
    if (soundOn) audio.unlock();
    $("sound").classList.toggle("on", soundOn);
    $("sound").setAttribute("aria-pressed", String(soundOn));
    $("sound").textContent = soundOn ? "🔊" : "🔇";
  });
  $("settings-button").addEventListener("click", () => { $("sheet").hidden = false; });
  $("sheet-close").addEventListener("click", () => { $("sheet").hidden = true; });
  $("sheet").addEventListener("click", (event) => { if (event.target === $("sheet")) $("sheet").hidden = true; });
  for (const button of document.querySelectorAll("[data-quality]")) {
    button.addEventListener("click", () => {
      governor.setManual(button.dataset.quality);
      for (const other of document.querySelectorAll("[data-quality]")) other.classList.toggle("active", other === button);
    });
  }

  let hintTimer = 0;
  function dismissHint() {
    const hint = $("hint");
    if (hint.hidden || hint.classList.contains("fade")) return;
    hint.classList.add("fade");
    clearTimeout(hintTimer);
    setTimeout(() => { hint.hidden = true; }, 450);
  }

  // ---- start (user gesture: audio unlock) ----
  const startButton = $("start-button");
  startButton.addEventListener("click", () => {
    if (started) return;
    audio.unlock();                          // must stay synchronous in the gesture
    started = true;
    $("start").classList.add("leaving");
    setTimeout(() => { $("start").hidden = true; }, 460);
    $("toolbar").hidden = false;
    $("hint").hidden = false;
    hintTimer = setTimeout(dismissHint, 8000);
  });

  // ---- tray tilt → gravity in tray coordinates ----
  function syncGravity(now) {
    const g = stage.trayGravity();
    const angle = stage.tilt.angle * 180 / Math.PI;
    const changed = (g === null) !== (lastGravity === null) || (g && lastGravity && Math.hypot(g[0] - lastGravity[0], g[1] - lastGravity[1], g[2] - lastGravity[2]) > 0.05);
    if (!changed || (now - lastGravitySent < 33 && g !== null)) return;
    lastGravity = g; lastGravitySent = now;
    const blend = Math.min(1, Math.max(0, (angle - 1.5) / 8));
    const base = physicsParams(settings).friction;
    const friction = g ? { staticFriction: (0.65 + (0.12 - 0.65) * blend) * base, dynamicFriction: (0.42 + (0.08 - 0.42) * blend) * base } : null;
    pendingEvents.push({ type: "gravity", vector: g, friction });
  }

  // ---- frame loop ----
  function frame(now) {
    frameId = requestAnimationFrame(frame);
    const dt = lastTime ? Math.min((now - lastTime) / 1000, 0.1) : 0;
    lastTime = now;
    const tier = governor.tier;

    const cameraMoved = stage.rig.update();
    const tilting = stage.updateTilt();
    if (cameraMoved || tilting) { needsRender = true; opticsDirty = true; }
    if (tilting || stage.tilt.goalAngle !== stage.tilt.angle) syncGravity(now);
    if (view.updateDrops(dt)) needsRender = true;

    // Physics: one tick in flight; wall time keeps accumulating meanwhile.
    pendingDt += dt;
    if (!simBusy && (!asleep || pendingEvents.length || grabbing)) {
      const free = freeBuffers.splice(0, 24);
      sim.postMessage({ type: "tick", dt: pendingDt, events: pendingEvents.splice(0), free }, free);
      simBusy = true;
      pendingDt = 0;
    } else if (asleep && !simBusy) pendingDt = 0;

    opticsClock += dt;
    if (!opticsBusy && opticsDirty && opticsClock >= 1 / tier.opticsHz) { opticsClock = 0; sendOptics(); }

    // Music follows how much the jelly moves (and how high the finger pulls).
    const activity = Math.min(1, view.state.energy / 0.05 + (grabbing ? 0.25 + lastStretch * 25 : 0));
    const register = grabbing ? Math.min(1, Math.max(0, grabHeight / 0.11)) : 0.45;
    audio.setActivity(started ? activity : 0, register);

    if (view.updateGlow(dt, settings.glow)) needsRender = true;

    const animating = !asleep || cameraMoved || tilting || grabbing;
    if (animating) {
      if (lastAnimatedTime) governor.sample(now - lastAnimatedTime, now);
      lastAnimatedTime = now;
    } else lastAnimatedTime = 0;

    if (!needsRender) return;
    needsRender = false;
    stage.syncTrayCamera();
    causticClock += dt;
    const allowTransport = tier.causticHz > 0 && causticClock >= 1 / tier.causticHz;
    if (allowTransport) causticClock = 0;
    view.updateCaustics(renderer, allowTransport);
    stage.render();
  }

  function startLoop() { if (running) return; running = true; lastTime = 0; lastAnimatedTime = 0; frameId = requestAnimationFrame(frame); }
  function stopLoop() { running = false; cancelAnimationFrame(frameId); }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopLoop();
      input.cancel();
      pendingEvents.push({ type: "pause", paused: true });
      if (!simBusy) { sim.postMessage({ type: "tick", dt: 0, events: pendingEvents.splice(0) }); simBusy = true; }
      audio.suspend();
    } else {
      pendingEvents.push({ type: "pause", paused: false });
      audio.resume();
      needsRender = true;
      startLoop();
    }
  });

  applyTier(governor.tier);
  // Prime one physics frame so the jelly exists before the first render.
  sim.postMessage({ type: "tick", dt: 0, events: pendingEvents.splice(0) });
  simBusy = true;
  await new Promise((resolve) => { const check = () => (simBusy ? setTimeout(check, 16) : resolve()); check(); });
  try { await renderer.compileAsync(stage.scene, camera); } catch (error) { console.warn("compileAsync failed", error); }
  sendOptics();
  startLoop();
  startButton.disabled = false;
  startButton.textContent = "시작하기";
  window.__jelly = { stage, view, governor, sim, optics, pendingEvents, gemLayer, audio, eventLog, get asleep() { return asleep; } };
}

boot().catch((error) => {
  console.error(error);
  fatal(String(error && error.message || error));
});

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("./sw.js").catch((error) => console.warn("SW registration failed", error));
}
