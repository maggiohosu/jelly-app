// 말랑젤리 — app orchestration.
// Threads: main (render + input), sim worker (240 Hz XPBD), optics worker
// (receiver shadow + view thickness). See README for the data flow.
import { createStage, TRAY_RADIUS } from "../render/stage.js";
import { createJellyView, LOOKS } from "../render/jelly-view.js";
import { createInput } from "../render/input.js";
import { JellyAudio } from "./audio.js";
import { MotionSensors } from "./sensors.js";
import { QualityGovernor } from "./quality.js";

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

function spawnWorker(path) {
  return new Worker(new URL(path, import.meta.url), { type: "module" });
}

function once(worker, type) {
  return new Promise((resolve, reject) => {
    const handler = ({ data }) => {
      if (data.type === type) { worker.removeEventListener("message", handler); resolve(data); }
      else if (data.type === "error") { worker.removeEventListener("message", handler); reject(new Error(data.message)); }
    };
    worker.addEventListener("message", handler);
    worker.addEventListener("error", (event) => reject(event.error || new Error(event.message || "worker failed")), { once: true });
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
  const { renderer, scene, camera, controls, isWebGPU } = stage;

  // ---- workers ----
  const sim = spawnWorker("../workers/sim-worker.js");
  const optics = spawnWorker("../workers/optics-worker.js");
  let init;
  try {
    const ready = once(sim, "ready");
    sim.postMessage({ type: "init", wallRadius: TRAY_RADIUS, lift: 0 });
    init = await ready;
    const opticsReady = once(optics, "ready");
    optics.postMessage({ type: "init", positions: init.positions, normals: init.normals, indices: init.indices });
    await opticsReady;
  } catch (error) {
    console.error(error);
    fatal("물리 엔진을 시작하지 못했어요. 페이지를 새로고침해 주세요.");
    return;
  }

  const view = createJellyView(stage, init, { caustics: params.get("caustics") !== "0" });
  const audio = new JellyAudio();

  // GPU errors: a validation error (e.g. a limit an older GPU lacks) only
  // affects the caustic passes, so drop those. A lost device (memory pressure,
  // driver reset) leaves a frozen canvas: reload once, and if it happens again
  // within a minute fall back to the WebGL2 lite renderer.
  renderer.onError = (error) => {
    console.warn("GPU error:", error.message);
    if (view.hasCaustics) {
      view.disableCaustics();
      updateStatus();
      toast("이 기기에서는 무지갯빛 굴절광을 끄고 계속할게요");
      needsRender = true;
    }
  };
  renderer.onDeviceLost = (info) => {
    console.warn("GPU device lost:", info.message);
    // iOS may reclaim the GPU while the app is in the background; that is not
    // a reason to degrade, just restart when the user comes back.
    if (document.hidden) {
      document.addEventListener("visibilitychange", () => location.reload(), { once: true });
      return;
    }
    let history = [];
    try { history = JSON.parse(sessionStorage.getItem("jelly-device-lost") || "[]"); } catch { /* private mode */ }
    const now = Date.now();
    history = history.filter((t) => now - t < 60000).concat(now);
    try { sessionStorage.setItem("jelly-device-lost", JSON.stringify(history)); } catch { /* private mode */ }
    const url = new URL(location.href);
    if (history.length >= 2) url.searchParams.set("lite", "1");
    location.replace(url.href);
  };

  const badge = $("badge");
  if (!isWebGPU) { badge.hidden = false; badge.textContent = "라이트 모드"; }

  // ---- state shared with the loop ----
  const pendingEvents = [];
  const positionPool = [];
  const opticsPool = [];
  let simBusy = false, pendingDt = 0, rawTarget = null;
  let opticsBusy = false, opticsClock = 1, opticsDirty = true;
  let causticClock = 1;
  let started = false, needsRender = true, running = false, frameId = 0;
  let lastTime = 0, lastAnimatedTime = 0;
  let awake = true, lastGrab = null, lastGrabStretch = 0;
  let tiltEnabled = true, soundEnabled = true;
  const cameraPosition = [0, 0, 0];

  const governor = new QualityGovernor({
    onTier: (tier) => {
      applyResolution();
      updateStatus();
      if (started && governor.auto) toast(`화질을 '${tier.label}'(으)로 맞췄어요`);
    },
    onPhysicsRate: (hz) => {
      pendingEvents.push({ type: "rate", hz });
      updateStatus();
      toast("기기 부하가 커서 물리 계산을 절전 모드로 바꿨어요");
    },
  });

  function applyResolution() {
    const width = Math.max(1, canvas.clientWidth), height = Math.max(1, canvas.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, governor.tier.maxDpr);
    stage.resize(width, height, dpr);
    needsRender = true;
    opticsDirty = true;
  }
  window.addEventListener("resize", applyResolution);
  screen.orientation?.addEventListener?.("change", applyResolution);
  applyResolution();

  function updateStatus() {
    const backend = isWebGPU ? (view.hasCaustics ? "WebGPU · 코스틱 켜짐" : "WebGPU · 코스틱 꺼짐") : "WebGL2 라이트 모드 (코스틱 없음)";
    $("status-line").textContent = `${backend} · 화질 ${governor.tier.label}${governor.auto ? "(자동)" : ""} · 물리 ${governor.physicsHz}Hz`;
  }
  updateStatus();

  // ---- sim worker ----
  sim.onmessage = ({ data }) => {
    if (data.type === "error") { console.error(data.message); return; }
    if (data.type !== "frame") return;
    simBusy = false;
    if (data.positions) {
      view.applyFrame(data);
      positionPool.push({ positions: data.positions, normals: data.normals });
      needsRender = true;
      opticsDirty = true;
    } else {
      view.applyFrame(data);
      if (data.returned) positionPool.push(data.returned);
    }
    awake = !data.sleeping;
    if (data.grab) {
      lastGrab = data.grab;
      const p = data.grab.point, t = data.grab.target;
      lastGrabStretch = Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2]);
    }
    if (data.stepMs) governor.physics(data.stepMs, performance.now());
    if (data.resetHappened) toast("젤리가 너무 늘어나서 처음 모양으로 돌아왔어요");
    const pitch = LOOKS[view.flavour].pitch;
    if (data.impact > 0.22) audio.boing((data.impact - 0.18) / 0.6, pitch, "drop");
    else if (data.wallImpact > 0.12) audio.boing((data.wallImpact - 0.1) / 0.4 * 0.7, pitch * 0.9, "bump");
  };

  // ---- optics worker ----
  optics.onmessage = ({ data }) => {
    if (data.type === "error") { console.error(data.message); opticsBusy = false; return; }
    if (data.type !== "field") return;
    opticsBusy = false;
    view.applyField(data);
    opticsPool.push({ positions: data.positions, normals: data.normals, shadowBytes: data.shadowBytes, thickness: data.thickness });
    needsRender = true;
  };

  function sendOptics() {
    const buffers = opticsPool.pop() || {
      positions: new Float32Array(view.positionAttribute.array.length),
      normals: new Float32Array(view.normalAttribute.array.length),
    };
    buffers.positions.set(view.positionAttribute.array);
    buffers.normals.set(view.normalAttribute.array);
    camera.updateMatrixWorld();
    cameraPosition[0] = camera.position.x; cameraPosition[1] = camera.position.y; cameraPosition[2] = camera.position.z;
    const transfer = [buffers.positions.buffer, buffers.normals.buffer];
    if (buffers.shadowBytes) transfer.push(buffers.shadowBytes.buffer, buffers.thickness.buffer);
    optics.postMessage({ type: "update", camera: cameraPosition, ...buffers }, transfer);
    opticsBusy = true;
    opticsDirty = false;
  }

  // ---- input ----
  createInput({
    canvas, camera, controls, view,
    isEnabled: () => started,
    onGrabStart: (hit) => { pendingEvents.push({ type: "grabStart", ...hit }); rawTarget = hit.point; },
    onGrabMove: (point) => { rawTarget = point; },
    onGrabEnd: () => {
      pendingEvents.push({ type: "grabEnd" });
      rawTarget = null;
      if (lastGrabStretch > 0.006) audio.boing(lastGrabStretch / 0.03, LOOKS[view.flavour].pitch * 1.08, "snap");
      lastGrabStretch = 0; lastGrab = null;
    },
    onInteract: dismissHint,
  });

  // ---- sensors ----
  const sensors = new MotionSensors({
    onGravity: (vector, friction) => pendingEvents.push({ type: "gravity", vector, friction }),
    onShake: (v) => { pendingEvents.push({ type: "impulse", v }); dismissHint(); },
  });

  // ---- UI ----
  for (const chip of document.querySelectorAll("[data-flavour]")) {
    chip.addEventListener("click", () => {
      view.setFlavour(chip.dataset.flavour);
      for (const other of document.querySelectorAll("[data-flavour]")) {
        other.classList.toggle("active", other === chip);
        other.setAttribute("aria-checked", String(other === chip));
      }
      causticClock = 1; opticsDirty = true; needsRender = true;
    });
  }
  $("nudge").addEventListener("click", () => { pendingEvents.push({ type: "nudge" }); dismissHint(); });
  $("reset").addEventListener("click", () => pendingEvents.push({ type: "reset", lift: 0.02 }));
  $("tilt").addEventListener("click", () => setTilt(!tiltEnabled, true));
  $("sound").addEventListener("click", () => {
    soundEnabled = !soundEnabled;
    audio.setEnabled(soundEnabled);
    if (soundEnabled) audio.unlock();
    $("sound").classList.toggle("on", soundEnabled);
    $("sound").setAttribute("aria-pressed", String(soundEnabled));
    $("sound").textContent = soundEnabled ? "🔊" : "🔇";
  });
  $("info-button").addEventListener("click", () => { $("sheet").hidden = false; });
  $("sheet-close").addEventListener("click", () => { $("sheet").hidden = true; });
  $("sheet").addEventListener("click", (event) => { if (event.target === $("sheet")) $("sheet").hidden = true; });
  for (const button of document.querySelectorAll("[data-quality]")) {
    button.addEventListener("click", () => {
      governor.setManual(button.dataset.quality);
      for (const other of document.querySelectorAll("[data-quality]")) other.classList.toggle("active", other === button);
    });
  }

  function setTilt(on, fromUser = false) {
    tiltEnabled = on;
    $("tilt").classList.toggle("on", on);
    $("tilt").setAttribute("aria-pressed", String(on));
    if (on) {
      if (fromUser) {
        sensors.requestPermission().then((result) => {
          if (result === "granted") sensors.start();
          else { setTilt(false); toast("모션 권한이 없어요 · 설정 › 앱 › Safari › 모션 및 방향 접근"); }
        });
      } else sensors.start();
    } else {
      sensors.stop();
    }
  }

  let hintTimer = 0;
  function dismissHint() {
    const hint = $("hint");
    if (hint.hidden || hint.classList.contains("fade")) return;
    hint.classList.add("fade");
    clearTimeout(hintTimer);
    setTimeout(() => { hint.hidden = true; }, 450);
  }

  // ---- start (user gesture: permissions + audio unlock) ----
  const startButton = $("start-button");
  startButton.addEventListener("click", () => {
    if (started) return;
    audio.unlock();                          // must stay synchronous in the gesture
    const permission = sensors.available ? sensors.requestPermission() : Promise.resolve("unsupported");
    started = true;
    $("start").classList.add("leaving");
    setTimeout(() => { $("start").hidden = true; }, 460);
    $("toolbar").hidden = false;
    $("hint").hidden = false;
    hintTimer = setTimeout(dismissHint, 6000);
    pendingEvents.push({ type: "reset", lift: 0.025 }); // little drop-in
    permission.then((result) => {
      if (result === "granted") setTilt(true);
      else {
        setTilt(false);
        $("hint-tilt").hidden = true;
        if (result === "denied") toast("기울기 센서 없이 시작해요 (📱 버튼으로 다시 시도)");
      }
      // Desktop browsers expose the API but never fire it: hide the toggle.
      setTimeout(() => { if (tiltEnabled && !sensors.receivedOrientation) { setTilt(false); $("tilt").hidden = true; $("hint-tilt").hidden = true; } }, 1500);
    });
  });

  // ---- frame loop ----
  function frame(now) {
    frameId = requestAnimationFrame(frame);
    const dt = lastTime ? Math.min((now - lastTime) / 1000, 0.1) : 0;
    lastTime = now;
    const tier = governor.tier;

    const cameraMoved = controls.update();
    if (cameraMoved) { needsRender = true; opticsDirty = true; }

    // Physics: one tick in flight at a time; time keeps accumulating meanwhile.
    pendingDt += dt;
    if (!simBusy && (awake || pendingEvents.length || rawTarget)) {
      const buffers = positionPool.pop() || null;
      const message = { type: "tick", dt: pendingDt, rawTarget, buffers, events: pendingEvents.splice(0) };
      sim.postMessage(message, buffers ? [buffers.positions.buffer, buffers.normals.buffer] : []);
      simBusy = true;
      pendingDt = 0;
    } else if (!awake && !simBusy) {
      pendingDt = 0;
    }

    // Receiver shadow + view thickness at the tier rate, only when something changed.
    opticsClock += dt;
    if (!opticsBusy && opticsDirty && opticsClock >= 1 / tier.opticsHz) {
      opticsClock = 0;
      sendOptics();
    }

    // Frame pacing is sampled while something is animating, whether or not
    // this particular rAF had a new physics frame to draw.
    const animating = awake || cameraMoved || rawTarget !== null;
    if (animating) {
      if (lastAnimatedTime) governor.sample(now - lastAnimatedTime, now);
      lastAnimatedTime = now;
    } else {
      lastAnimatedTime = 0;
    }

    if (!needsRender) return;
    needsRender = false;

    causticClock += dt;
    const allowTransport = causticClock >= 1 / tier.causticHz;
    if (allowTransport) causticClock = 0;
    view.updateCaustics(renderer, allowTransport);
    renderer.render(scene, camera);
  }

  function startLoop() {
    if (running) return;
    running = true;
    lastTime = 0; lastAnimatedTime = 0;
    frameId = requestAnimationFrame(frame);
  }
  function stopLoop() {
    running = false;
    cancelAnimationFrame(frameId);
  }

  // Background: stop everything (battery, thermal) and resume cleanly.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopLoop();
      pendingEvents.push({ type: "pause", paused: true });
      if (!simBusy) { sim.postMessage({ type: "tick", dt: 0, events: pendingEvents.splice(0) }); simBusy = true; }
      if (tiltEnabled) sensors.stop();
      audio.suspend();
    } else {
      pendingEvents.push({ type: "pause", paused: false });
      if (tiltEnabled && started) sensors.start();
      audio.resume();
      needsRender = true;
      startLoop();
    }
  });

  try {
    await renderer.compileAsync(scene, camera);
  } catch (error) {
    console.warn("compileAsync failed", error);
  }
  sendOptics();
  startLoop();
  startButton.disabled = false;
  startButton.textContent = "시작하기";
  window.__jelly = { stage, view, governor, sim, optics, pendingEvents, get awake() { return awake; } };
}

boot().catch((error) => {
  console.error(error);
  fatal(String(error && error.message || error));
});

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("./sw.js").catch((error) => console.warn("SW registration failed", error));
}
