// 말랑젤리 — app orchestration.
// Threads: main (render, input, audio), sim worker (240 Hz XPBD jelly, paint
// field, gems), optics worker (receiver shadow + view thickness).
import * as THREE from "three/webgpu";
import { createStage, TRAY_RADIUS } from "../render/stage.js";
import { createJellyView } from "../render/jelly-view.js";
import { createInput } from "../render/input.js";
import { createGemLibrary, GemLayer, GEM_SHAPES } from "../render/gems.js";
import { BeadLayer } from "../render/beads.js";
import { AdditiveLayer } from "../render/additives.js";
import { CoinShower } from "../render/coins.js";
import { Rabbit } from "../render/rabbit.js";
import { createRareGemLibrary, RareGemLayer, RARE_GEMS, RARE_SIZE, rareGemIconSVG } from "../render/rare-gems.js";
import { createThumbnailer } from "../render/thumbnail.js";
import { PAINTS } from "../core/world.js";
import { Progress } from "./progress.js";
import { makeOrder, scoreOrder, rollOutcome, nameColor, sigmaToHex } from "./orders.js";
import { SHAPES, signatureSigma } from "../core/shapes.js";
import { DecorLayer } from "../render/decor.js";
import { createGameUI } from "./game-ui.js";
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
  // progress (coins, friendship…) — also decides which shapes may be used
  const progress = new Progress();
  if (!progress.shapes().includes(settings.shape)) settings.shape = "flower";

  // ---- workers ----
  const sim = new Worker(new URL("../workers/sim-worker.js", import.meta.url), { type: "module" });
  const optics = new Worker(new URL("../workers/optics-worker.js", import.meta.url), { type: "module" });
  let ready;
  try {
    const simReady = once(sim, "ready");
    sim.postMessage({ type: "init", wallRadius: TRAY_RADIUS, base: settings.base, texture: settings.texture, shape: settings.shape });
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
  const beadLayer = new BeadLayer(tray);
  const decorLayer = new DecorLayer(tray);
  const additiveLayer = new AdditiveLayer(tray);
  const rareLibrary = createRareGemLibrary({ quality: "high" });
  const rareLayer = new RareGemLayer(tray, rareLibrary);
  rareLayer.setGlowScale?.(settings.glow);
  const coinShower = new CoinShower(tray, camera);
  const rabbit = new Rabbit(tray, { quality: "high" });
  const thumbnailer = createThumbnailer(renderer);
  const audio = new JellyAudio();
  audio.setVolumes({ master: settings.master, crunch: settings.crunch, gems: settings.gems, boing: settings.boing, effects: settings.effects });
  audio.setTexture(settings.texture);
  audio.onNote((pulse) => { view.pulse(0.08 + 0.22 * pulse.velocity); needsRender = true; });

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

  if (!isWebGPU) { $("badge").hidden = false; $("badge").textContent = "라이트"; $("badge").title = "라이트 모드 (WebGL2)"; }

  // ---- shared state ----
  const pendingEvents = [];
  const freeBuffers = [];
  const opticsPool = [];
  let topologySent = false, opticsBody = 0;    // a new optics body per surface topology (shape)
  let simBusy = false, pendingDt = 0;
  let opticsBusy = false, opticsClock = 1, opticsDirty = true, causticClock = 1;
  let started = false, needsRender = true, running = false, frameId = 0;
  let lastTime = 0, lastAnimatedTime = 0;
  let asleep = false, grabbing = false, grabHeight = 0, lastStretch = 0, stretchTime = 0;
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
    rareLibrary.setQuality(tier.gems);
    // fur shells are fill-heavy: full fur only on the top tier
    rabbit.setQuality(tier.id === "high" ? "high" : tier.gems === "low" ? "low" : "medium");
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
    if (data.type === "topology") {
      // the jelly changed shape: new surface topology for the view, shadow and caustics
      view.setTopology(data);
      opticsBody++; topologySent = false; opticsDirty = true; needsRender = true;
      return;
    }
    if (data.type !== "frame") return;
    simBusy = false;
    view.sync(data, (buffer) => freeBuffers.push(buffer));
    splitGems(data.gems, data.gemCount);
    if (data.decor && !view.hidden) { decorLayer.update(data.decor, data.decorCount || 0); needsRender = true; }
    if (data.additives && !view.hidden) { additiveLayer.update(data.additives); if (data.additives.length) freeBuffers.push(data.additives.buffer); needsRender = true; }
    if (data.beads && !view.hidden) { beadLayer.update(data.beads); if (data.beads.length) freeBuffers.push(data.beads.buffer); needsRender = true; }
    if (data.gems) freeBuffers.push(data.gems.buffer);
    asleep = data.asleep;
    lastFrame = { center: data.center, bounds: data.bounds };
    if (data.positions || data.dye || data.gemCount) { needsRender = true; opticsDirty = opticsDirty || Boolean(data.positions); }
    grabbing = Boolean(data.grab);
    if (data.grab) {
      grabHeight = data.grab.target[1];
      const stretch = Math.hypot(data.grab.point[0] - data.grab.target[0], data.grab.point[1] - data.grab.target[1], data.grab.point[2] - data.grab.target[2]);
      // pulling it out further: the sticky '쩍' of the stretching strand
      const now = performance.now(), rate = (stretch - lastStretch) / Math.max(0.008, (now - stretchTime) / 1000);
      if (rate > 0.03 && stretch > 0.004) audio.squelch(Math.min(1, rate / 0.12));
      lastStretch = stretch; stretchTime = now;
    } else lastStretch = 0;
    if (data.stepMs) governor.physics(data.stepMs, performance.now());
    for (const e of data.events) {
      if (eventLog.push(e.type) > 200) eventLog.shift();
      switch (e.type) {
        case "release": audio.pop(0.35 + Math.min(0.65, e.stretch / 0.03)); break;
        case "clink": audio.clink(e.strength, e.seed); break;
        case "gemFull": toast("보석이 가득 찼어요"); break;
        case "rareFull": toast("레어 보석은 젤리 하나에 4개까지 넣을 수 있어요"); break;
        case "additiveFull": toast(e.kind === "glitter" ? "글리터가 가득해요" : "별사탕이 가득해요"); break;
        case "additive": audio.drip(0.5, e.kind === "glitter" ? 1.6 : 1.3); audio.crunch(0.35); break;
        case "gemIn": case "gemScatter": audio.clink(e.rare ? 0.8 : 0.45, (e.gem || e.count || 1) * 13); break;
        case "bounced": audio.boing(0.5 + 0.3 * Math.min(1, e.strength), 1.25, "drop"); break;
        case "recovered": toast("젤리가 너무 늘어나서 처음 모양으로 돌아왔어요"); break;
      }
    }
    if (data.impact > 0.22) audio.crunch((data.impact - 0.12) / 0.6);
    else if (data.wallImpact > 0.12) audio.crunch((data.wallImpact - 0.08) / 0.4 * 0.7);
  };
  const EMPTY = new Float32Array(0);
  // Gem states (stride 10) carry both kinds: colour ≥ 100 marks a rare gem.
  const normalStates = new Float32Array(24 * 10), rareStates = new Float32Array(8 * 10);
  const jellyGems = { shapes: [], rareCount: 0 };
  function splitGems(states, count = 0) {
    let n = 0, r = 0;
    jellyGems.shapes.length = 0;
    for (let i = 0; i < count; i++) {
      const o = i * 10;
      if (states[o + 1] >= 100) {
        if (r < 8) { rareStates.set(states.subarray(o, o + 10), r * 10); rareStates[r * 10 + 1] = states[o + 1] - 100; r++; }
      } else if (n < 24) { normalStates.set(states.subarray(o, o + 10), n * 10); jellyGems.shapes.push(states[o]); n++; }
    }
    jellyGems.rareCount = r;
    gemLayer.update(normalStates, n);
    rareLayer.update(rareStates, r);
  }

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
    const body = { id: opticsBody, positions, normals };
    if (!topologySent) { body.indices = view.geometry.index.array; topologySent = true; }
    const shadowBytes = takeOpticsBuffer(192 * 192 * 4, Uint8Array) || undefined;
    const transfer = [positions.buffer, normals.buffer];
    if (shadowBytes) transfer.push(shadowBytes.buffer);
    const tc = stage.syncTrayCamera();
    optics.postMessage({ type: "update", camera: [tc.position.x, tc.position.y, tc.position.z], bodies: [body], keep: [opticsBody], shadowBytes }, transfer);
    opticsBusy = true;
    opticsDirty = false;
  }

  // ---- input ----
  const input = createInput({
    canvas, stage, view,
    isEnabled: () => started && !eating,
    onGrabStart: (id, hit) => { audio.crunch(0.55); pendingEvents.push({ type: "grabStart", id, a: hit.a, b: hit.b, c: hit.c, bary: hit.bary, point: hit.point }); grabbing = true; },
    onGrabMove: (id, point) => pendingEvents.push({ type: "target", id, point }),
    onGrabEnd: (id, flick) => { pendingEvents.push({ type: "grabEnd", id, flick }); grabbing = input?.grabbing ?? false; },
    onTap: () => {},
    onDoubleTap: () => bounce(1),
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
  const ui = buildUI({
    settings,
    onSetting: (key, value) => {
      if (key === "softness" || key === "wobble" || key === "slippery") sendParams();
      else if (key === "glow") { gemLayer.setGlowScale(value); stage.setBloomStrength(Math.max(0.2, value)); needsRender = true; }
      else if (["crunch", "gems", "boing", "effects", "master"].includes(key)) audio.setVolumes({ [key]: value });
    },
    onTexture: (texture) => {
      pendingEvents.push({ type: "texture", texture });
      audio.setTexture(texture);
      audio.squelch(0.7);
      toast(texture === "slime" ? "슬랑이로 바꿨어요 — 쭉 늘려 보세요" : "말랑 젤리로 돌아왔어요");
      dismissHint();
    },
    onPaintDrop: (paint, x, y, holding) => {
      const hit = pickAt(x, y);
      if (!hit) { if (!holding) toast("젤리 위에서 놓아 주세요"); return false; }
      releaseDrop(paint, hit);
      return true;
    },
    onPaintTap: (paint) => { const hit = topHit(); if (hit) releaseDrop(paint, hit); },
    onAdditiveDrop: (kind, x, y) => {
      const hit = pickAt(x, y);
      if (!hit) { toast("젤리 위에서 놓아 주세요"); return; }
      pendingEvents.push({ type: "additive", kind, point: hit.point }); dismissHint();
    },
    onAdditiveTap: (kind) => { const hit = topHit(); if (hit) pendingEvents.push({ type: "additive", kind, point: hit.point }); },
    onRareDrop: (index, tier, x, y) => {
      const hit = pickAt(x, y);
      if (!hit) { toast("젤리 위에 놓아 주세요"); return; }
      pendingEvents.push({ type: "gemAdd", a: hit.a, b: hit.b, c: hit.c, bary: hit.bary, shape: index, color: 0, radius: rareRadius(index), rare: { index, tier } });
    },
    onRareTap: (index, tier) => pendingEvents.push({ type: "gemScatter", count: 1, shape: index, color: 0, radius: rareRadius(index), rare: { index, tier } }),
    onGemDrop: (shape, color, x, y) => {
      const hit = pickAt(x, y);
      if (!hit) { toast("젤리 위에 놓아 주세요"); return; }
      pendingEvents.push({ type: "gemAdd", a: hit.a, b: hit.b, c: hit.c, bary: hit.bary, shape, color, radius: gemRadius(shape) });
      dismissHint();
    },
    onGemTap: (shape, color) => pendingEvents.push({ type: "gemScatter", count: 1, shape, color, radius: gemRadius(shape) }),
    onScatter: (color) => pendingEvents.push({ type: "gemScatter", count: 6, shape: -1, color, radius: gemRadius(-1), shapes: GEM_SHAPES.length }),
    onBase: (base) => { pendingEvents.push({ type: "base", base }); needsRender = true; },
    onShape: (id, info) => {
      if (!id) { toast(`🐰 토끼와 Lv${info.level}까지 친해지면 '${info.label}' 모양이 열려요`); return; }
      if (eating) return;
      pendingEvents.push({ type: "shape", shape: id, base: settings.base });
      toast(`${info.label} 모양 젤리가 나왔어요`);
      dismissHint();
    },
  });
  function rareRadius(index) {
    const r = rareLibrary.gems?.[index]?.radius || RARE_SIZE / 2;
    return Math.max(0.0038, Math.min(0.0058, r * 0.85));
  }
  function gemRadius(shape) {
    const shapes = gemLibrary.shapes;
    const r = shape >= 0 ? shapes[shape].radius : shapes.reduce((m, s) => Math.max(m, s.radius), 0);
    return Math.max(0.0025, Math.min(0.0045, r * 0.85));
  }

  $("gems").addEventListener("click", () => {
    $("shape-drawer").hidden = true; $("shape-button").classList.remove("on");
    const drawer = $("gem-drawer"), open = drawer.hidden;
    drawer.hidden = !open;
    $("gems").setAttribute("aria-pressed", String(open));
    $("gems").classList.toggle("on", open);
    if (open) dismissHint();
  });
  function bounce(strength) { pendingEvents.push({ type: "bounce", strength }); dismissHint(); }
  $("nudge").addEventListener("click", () => bounce(1));
  $("reset").addEventListener("click", () => { if (eating) return; pendingEvents.push({ type: "reset", base: settings.base, lift: 0.05 }); $("sheet").hidden = true; });
  $("sound").addEventListener("click", () => {
    soundOn = !soundOn;
    audio.setEnabled(soundOn);
    if (soundOn) audio.unlock();
    $("sound").classList.toggle("on", soundOn);
    $("sound").setAttribute("aria-pressed", String(soundOn));
    $("sound").textContent = soundOn ? "🔊 소리 켜짐" : "🔇 소리 꺼짐";
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

  // Every touch re-checks the audio context (iOS home-screen apps return from
  // the background with audio interrupted, and only a gesture can resume it).
  const kickAudio = () => { if (started && soundOn && !audio.running) audio.unlock(); };
  for (const type of ["pointerdown", "touchend", "click"]) document.addEventListener(type, kickAudio, { capture: true, passive: true });

  // ---- the bunny game: orders, feeding, coins, cards, book ----
  let eating = false, lastFrame = null, carrying = false;
  const thumbCache = new Map();
  function rareThumb(index, tier) {
    const key = `${index}:${tier}`;
    if (!thumbCache.has(key)) {
      const object = rareLibrary.makeObject(index, tier);
      thumbCache.set(key, thumbnailer.renderObject(object, { size: 256 }).catch((error) => { console.warn("thumbnail", error); thumbCache.delete(key); return null; }));
    }
    return thumbCache.get(key);
  }
  const gameUI = createGameUI({
    progress,
    rareInfo: (i) => RARE_GEMS[i],
    rareIcon: (i, t) => rareGemIconSVG(i, t),
    rareThumb,
    onPull: () => { const r = progress.pull(); if (r) refreshRareDrawer(); return r; },
    sounds: { cardFlip: () => audio.cardFlip?.(), cardShake: () => audio.cardShake?.(), reveal: (k) => audio.reveal?.(k), levelUp: () => audio.levelUp?.(), coinLoss: (n) => audio.coinLoss?.(n) },
  });
  function refreshRareDrawer() {
    const owned = progress.ownedRare();
    ui.setRareGems(owned.map((r) => ({ ...r, label: `${RARE_GEMS[r.index].label} (${["글리터", "금빛", "무지개빛"][r.tier]})`, icon: rareGemIconSVG(r.index, r.tier) })));
    // swap in the 3D renders once they are ready
    owned.forEach((r) => rareThumb(r.index, r.tier).then((url) => {
      if (!url) return;
      const btn = document.querySelector(`#rare-gems button[title^="${RARE_GEMS[r.index].label} "]`);
      if (btn) { btn.innerHTML = `<img alt="" src="${url}">`; }
    }));
  }
  function refreshPalette(fresh = []) { ui.setPalette(progress.paints(), progress.additives(), fresh); }
  // A shape's signature colour (mean σ of its look) — the starting colour of
  // orders for that shape; null for plain shapes (they take the base colour).
  // a shape's signature colour (mean σ) is an order's starting colour
  const shapeBase = (id) => signatureSigma(id);
  function newOrder() {
    const shapes = progress.shapes().map((id) => SHAPES.find((x) => x.id === id)).filter(Boolean);
    const order = makeOrder({ paints: progress.paints(), level: progress.level.level, id: Date.now(), shapes, shape: settings.shape, shapeBase });
    progress.setOrder(order);
    gameUI.showOrder(order);
    return order;
  }

  // Album card: a square render of the jelly from the current view direction.
  async function captureWork() {
    try {
      const c = view.state.center, target = tray.localToWorld(c.clone());
      const cam = new THREE.PerspectiveCamera(30, 1, 0.005, 2);
      const dir = camera.position.clone().sub(target).normalize();
      cam.position.copy(target).addScaledVector(dir, 0.2);
      cam.lookAt(target);
      cam.updateMatrixWorld();
      return await thumbnailer.renderScene(stage.scene, cam, { width: 192, height: 192, mime: "image/webp", quality: 0.8 });
    } catch (error) { console.warn("capture", error); return null; }
  }

  async function feed() {
    if (eating || rabbit.busy || coinShower.busy || view.hidden || !lastFrame) return;
    eating = true;
    $("feed").disabled = true;
    input.cancel();
    dismissHint();
    $("gem-drawer").hidden = true; $("gems").classList.remove("on");
    $("shape-drawer").hidden = true; $("shape-button").classList.remove("on");
    const order = progress.order || newOrder();
    const sigma = view.state.meanDye.slice();
    const rareCount = jellyGems.rareCount;
    const result = scoreOrder(order, { sigma, gems: jellyGems.shapes, texture: settings.texture, rareCount, shape: settings.shape });
    // ★1 only: 1/20 퉤 (coins taken), 1/5 a head-shake after one bite (a few coins)
    // (?outcome=refuse|spit|eat forces an outcome — for testing the animations)
    const forced = params.get("outcome");
    const outcome = ["eat", "refuse", "spit"].includes(forced) ? forced : rollOutcome(result.stars);
    const thumb = outcome === "eat" ? await captureWork() : null;
    const shapeInfo = SHAPES.find((x) => x.id === settings.shape);
    const card = { id: Date.now(), date: Date.now(), stars: result.stars, name: nameColor(sigma), hex: sigmaToHex(sigma), texture: settings.texture, shape: settings.shape, shapeLabel: settings.shape !== "flower" ? shapeInfo?.label : "", thumb, gems: jellyGems.shapes.length + rareCount };
    // the bunny sits behind the jelly, a little to the side, facing the camera
    const toCam = tray.worldToLocal(camera.position.clone()).setY(0).normalize();
    const side = new THREE.Vector3(-toCam.z, 0, toCam.x);
    const seat = toCam.clone().multiplyScalar(-0.108).addScaledVector(side, 0.024);   // clear of the rim
    const b = lastFrame.bounds, jc = lastFrame.center.slice();
    let reward = null;
    carrying = false;
    rabbit.play({
      position: [seat.x, 0, seat.z],
      faceTo: [toCam.x * 0.3, 0.04, toCam.z * 0.3],
      jelly: { center: lastFrame.center.slice(), width: b[3] - b[0], height: b[4] - b[1] },
      bites: outcome === "eat" ? 4 : 1, mood: result.mood, outcome,
      jellyColor: sigmaToHex(sigma),
      onEvent: (type, data = {}) => {
        needsRender = true;
        switch (type) {
          case "arrive": audio.squeak?.("happy"); break;
          case "grab":
            // held as a whole (no stretching): the bunny's hold point drives the jelly's centre
            carrying = true;
            if (data.hold) pendingEvents.push({ type: "carry", target: data.hold });
            audio.squelch(0.4);
            break;
          case "bite": {
            // bite a little into the jelly from where the mouth is
            const m = data.mouth, c = lastFrame.center;
            pendingEvents.push({ type: "bite", center: [m[0] + (c[0] - m[0]) * 0.3, m[1] + (c[1] - m[1]) * 0.3, m[2] + (c[2] - m[2]) * 0.3] });
            audio.munch(0.9);
            view.pulse(0.5);
            break;
          }
          case "chew": audio.chew(data.duration || 0.4); break;
          case "release":
            carrying = false;
            pendingEvents.push({ type: "carry", target: null });
            break;
          case "finish":
            carrying = false;
            pendingEvents.push({ type: "carry", target: null });
            view.setHidden(true); hideCarried(true);
            pendingEvents.push({ type: "reset", base: Array.isArray(order.base) ? settings.base : order.base, lift: 0.4 }, { type: "pause", paused: true });
            break;
          case "refuse": {
            audio.squeak?.("no");
            reward = progress.refuse();
            gameUI.showReward({ kind: "refuse", coins: reward.coins, xp: reward.xp, levelUps: reward.levelUps });
            coinShower.pour({
              count: reward.coins, at: [jc[0], 0.04, jc[2]],
              collectAt: () => gameUI.coinCounterNDC(),
              onCollect: () => { gameUI.addCoin(1); audio.coin(0.3, 7); },
              onDone: () => gameUI.renderHud(),
            });
            break;
          }
          case "spit": {
            {
              // 퉤 now, splat when the chunk lands (ballistic time to the tray)
              const from = data.from, v = data.velocity;
              const land = from && v ? Math.max(0.15, Math.min(1.5, (v[1] + Math.sqrt(v[1] * v[1] + 2 * 9.81 * Math.max(0, from[1]))) / 9.81)) : 0.35;
              audio.spit(0.8, land);
            }
            const lost = progress.spit();
            gameUI.showReward({ kind: "spit", coins: lost.lost });
            if (lost.lost > 0) gameUI.loseCoins(lost.lost);
            break;
          }
          case "react": {
            if (outcome !== "eat") { audio.squeak?.("grumpy"); break; }
            audio.squeak?.(result.mood === "special" ? "happy" : result.mood);
            if (result.stars === 4) audio.special?.();
            reward = progress.feed({ stars: result.stars, rareCount, card });
            gameUI.showReward({ kind: "eat", ...result, coins: reward.coins, xp: reward.xp, levelUps: reward.levelUps });
            const per = Math.max(1, Math.round(reward.coins / 14)), n = Math.ceil(reward.coins / per);
            let collected = 0;
            coinShower.pour({
              count: n, at: [jc[0], 0.04, jc[2]],
              collectAt: () => gameUI.coinCounterNDC(),
              onCollect: () => { collected++; gameUI.addCoin(per); if (collected % 2) audio.coin(0.3, collected); },
              onDone: () => gameUI.renderHud(),
            });
            audio.coinShower?.(n, 1.2);
            break;
          }
          case "done": {
            carrying = false;
            if (reward?.levelUps?.length) applyLevelUps(reward.levelUps);
            if (outcome === "eat") {
              // a fresh jelly drops in for the next order
              const next = newOrder();
              pendingEvents.push({ type: "pause", paused: false }, { type: "reset", base: Array.isArray(next.base) ? settings.base : next.base, lift: 0.06 });
              view.setHidden(false); hideCarried(false);
            } else {
              // refused / spat out: the (bitten) jelly stays — fix it and try again
              pendingEvents.push({ type: "carry", target: null });
            }
            eating = false; $("feed").disabled = false;
            gameUI.renderHud();
            break;
          }
        }
      },
    });
  }
  function applyLevelUps(levelUps) {
    const fresh = levelUps.flatMap((u) => u.rewards.map((r) => r.id));
    refreshPalette(fresh);
    ui.setShapes(progress.shapes(), fresh);
  }
  function hideCarried(hidden) {
    for (const m of gemLayer.meshes) if (hidden) m.visible = false;
    rareLayer.setHidden?.(hidden);
    decorLayer.setHidden(hidden);
    beadLayer.mesh.visible = !hidden && beadLayer.mesh.count > 0;
    additiveLayer.glitter.visible = !hidden && additiveLayer.glitter.count > 0;
    additiveLayer.stars.visible = !hidden && additiveLayer.stars.count > 0;
  }
  refreshPalette();
  refreshRareDrawer();
  $("feed").addEventListener("click", feed);
  $("order").addEventListener("click", () => toast(progress.order ? `🐰 ${progress.order.text} 비슷할수록 금화를 많이 줘요` : "", 2800));

  // ---- start (user gesture: audio unlock) ----
  const startButton = $("start-button");
  startButton.addEventListener("click", () => {
    if (started) return;
    audio.unlock();                          // must stay synchronous in the gesture
    started = true;
    $("start").classList.add("leaving");
    setTimeout(() => { $("start").hidden = true; }, 460);
    $("toolbar").hidden = false;
    $("hud").hidden = false; $("brand").hidden = true;
    $("gacha-button").hidden = false; $("book-button").hidden = false;
    gameUI.renderHud();
    ui.setShapes(progress.shapes());
    gameUI.showOrder(progress.order || newOrder());
    if (progress.state.feeds === 0 && progress.state.pulls === 0) setTimeout(() => toast("🐰 토끼 주문서대로 젤리를 만들고 🥕를 눌러 보세요! 첫 카드 뽑기 금화도 드려요", 4200), 900);
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
    if (rabbit.busy && lastFrame) {
      const r = rabbit.update(dt, { center: lastFrame.center, bounds: lastFrame.bounds });
      if (carrying && r?.hold) pendingEvents.push({ type: "carry", target: r.hold });
      needsRender = true;
    }
    if (coinShower.update(dt)) needsRender = true;

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

    const animating = !asleep || cameraMoved || tilting || grabbing || rabbit.busy || coinShower.busy;
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
  try { await rabbit.precompile?.(renderer, camera, stage.scene); } catch (error) { console.warn("rabbit precompile failed", error); }
  sendOptics();
  startLoop();
  startButton.disabled = false;
  startButton.textContent = "시작하기";
  window.__jelly = { stage, view, governor, sim, optics, pendingEvents, gemLayer, rareLayer, audio, eventLog, progress, rabbit, coinShower, feed, gameUI, get eating() { return eating; }, get asleep() { return asleep; } };
}

boot().catch((error) => {
  console.error(error);
  fatal(String(error && error.message || error));
});

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("./sw.js").catch((error) => console.warn("SW registration failed", error));
}
