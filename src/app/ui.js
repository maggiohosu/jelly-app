// DOM for the pipette palette (drag a paint onto the jelly, hold to keep
// dripping, tap to drop on top), the gem drawer (drag a gem in, or tap), the
// settings sliders, and persisted per-device settings.
import { GEM_SHAPES, GEM_COLORS, gemIconSVG } from "../render/gems.js";
import { PAINTS, ADDITIVES } from "../core/world.js";
import { SHAPES } from "../core/shapes.js";
import { shapeIconSVG } from "../render/shape-icons.js";

const $ = (id) => document.getElementById(id);
// The same SVG icon can appear twice (toolbar + a hidden drawer); url(#id)
// resolves to the first element with that id, which may be display:none —
// give every inserted copy its own ids.
let svgCopies = 0;
export function uniqueSvg(svg) {
  const tag = `-c${++svgCopies}`;
  return svg.replace(/id="([^"]+)"/g, `id="$1${tag}"`).replace(/url\(#([^)]+)\)/g, `url(#$1${tag})`).replace(/href="#([^"]+)"/g, `href="#$1${tag}"`);
}
const STORAGE_KEY = "mallang-jelly-settings-v3";
const HOLD_MS = 350, DRIP_MS = 230;

export const DEFAULT_SETTINGS = Object.freeze({
  softness: 0.33,   // 0 firm … 1 very soft  → shear 1200 … 300 Pa (0.33 ≈ original 600)
  wobble: 0.5,      // 0 short … 1 long      → damping 6 … 1 /s (0.5 ≈ original 3.5)
  slippery: 0.3,    // 0 grippy … 1 icy      → friction ×1.4 … ×0.3
  glow: 1,          // 0 … 2
  crunch: 0.8, gems: 0.6, boing: 0.6, effects: 0.8, master: 0.9,
  texture: "jelly", // 'jelly' | 'slime' (슬랑이)
  shape: "flower",  // jelly shape id (core/shapes.js)
  gemColor: 0,      // index into GEM_COLORS, -1 = random
  base: "berry",
});

export function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
export function saveSettings(settings) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
}
export function physicsParams(s) {
  return { shear: 1200 - 900 * s.softness, damping: 6 - 5 * s.wobble, friction: 1.4 - 1.1 * s.slippery };
}

function pipetteSVG(hex, water = false) {
  return `<svg viewBox="0 0 48 64" aria-hidden="true">
    <defs><linearGradient id="g${hex.slice(1)}" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity=".85"/><stop offset=".35" stop-color="#fff" stop-opacity=".25"/><stop offset="1" stop-color="#fff" stop-opacity=".6"/></linearGradient></defs>
    <rect x="15" y="2" width="18" height="15" rx="7" fill="#3a4a53"/>
    <rect x="13" y="15" width="22" height="4" rx="2" fill="#2a363d"/>
    <path d="M17 19h14v26l-4 10h-6l-4-10z" fill="${water ? "#dff1fb" : hex}" opacity="${water ? 0.9 : 0.95}"/>
    <path d="M17 19h14v26l-4 10h-6l-4-10z" fill="url(#g${hex.slice(1)})"/>
    <path d="M21 55h6l-2 6h-2z" fill="${water ? "#bfe3f5" : hex}"/>
    <path d="M17 19h14v26l-4 10h-6l-4-10z" fill="none" stroke="#ffffff" stroke-opacity=".9" stroke-width="1.5"/>
  </svg>`;
}

function slider(container, { key, label, min, max, step, value }, onInput) {
  const row = document.createElement("label");
  row.className = "slider";
  row.innerHTML = `<span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${value}" aria-label="${label}">`;
  const input = row.querySelector("input");
  input.addEventListener("input", () => onInput(key, Number(input.value)));
  container.appendChild(row);
}

// Shared drag helper: pointer capture on the source button, a ghost that
// follows the finger (drawn above it so the finger never hides the tip),
// tap vs drag, and an optional "hold still to repeat" callback.
function draggable(button, { ghostHTML, onTap, onDrop, onHold }) {
  const ghost = $("drag-ghost");
  let drag = null;
  const ghostAt = (x, y) => { ghost.style.left = x + "px"; ghost.style.top = (y - 46) + "px"; };
  const tip = (x, y) => [x, y - 46 + 30]; // the pipette tip / gem centre in client px
  const stopHold = () => { if (drag?.timer) { clearTimeout(drag.timer); clearInterval(drag.timer); drag.timer = 0; } };
  const armHold = () => {
    stopHold();
    if (!onHold) return;
    drag.timer = setTimeout(() => {
      if (!drag) return;
      const [x, y] = tip(drag.x, drag.y);
      if (!onHold(x, y)) return;
      drag.held = true;
      drag.timer = setInterval(() => { if (drag) { const [hx, hy] = tip(drag.x, drag.y); onHold(hx, hy); } }, DRIP_MS);
    }, HOLD_MS);
  };
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    drag = { x0: event.clientX, y0: event.clientY, x: event.clientX, y: event.clientY, moved: false, held: false, timer: 0, still: { x: event.clientX, y: event.clientY } };
  });
  button.addEventListener("pointermove", (event) => {
    if (!drag) return;
    drag.x = event.clientX; drag.y = event.clientY;
    if (!drag.moved && Math.hypot(event.clientX - drag.x0, event.clientY - drag.y0) > 8) {
      drag.moved = true;
      ghost.innerHTML = ghostHTML();
      ghost.hidden = false;
      armHold();
    }
    if (drag.moved) {
      ghostAt(event.clientX, event.clientY);
      if (Math.hypot(event.clientX - drag.still.x, event.clientY - drag.still.y) > 10) {
        drag.still = { x: event.clientX, y: event.clientY };
        armHold();
      }
    }
  });
  const end = (event, cancelled) => {
    if (!drag) return;
    stopHold();
    const d = drag; drag = null; ghost.hidden = true;
    if (cancelled) return;
    if (!d.moved) { onTap(); return; }
    const [x, y] = tip(event.clientX, event.clientY);
    if (!d.held || Math.hypot(event.clientX - d.still.x, event.clientY - d.still.y) > 10) onDrop(x, y);
  };
  button.addEventListener("pointerup", (event) => end(event, false));
  button.addEventListener("pointercancel", (event) => end(event, true));
}

export function buildUI({ settings, onSetting, onTexture, onShape, onPaintDrop, onPaintTap, onAdditiveDrop, onAdditiveTap, onGemDrop, onGemTap, onRareDrop, onRareTap, onScatter, onBase }) {
  const change = (key, value) => { settings[key] = value; saveSettings(settings); onSetting(key, value); };

  // ---- pipette palette (paints the player has, then additives) ----
  const paints = $("paints");
  function setPalette(paintIds, additiveIds = [], fresh = []) {
    paints.textContent = "";
    // water stays last among the paints
    const order = [...paintIds.filter((id) => id !== "water"), ...(paintIds.includes("water") ? ["water"] : [])];
    for (const id of order) {
      const i = PAINTS.findIndex((p) => p.id === id), p = PAINTS[i];
      if (!p) continue;
      const b = document.createElement("button");
      b.className = "paint" + (p.sigma ? "" : " water") + (p.pearl ? " pearl" : "") + (p.glow ? " glow" : "") + (fresh.includes(id) ? " new" : "");
      b.style.setProperty("--c", p.hex);
      b.setAttribute("aria-label", `${p.label} 스포이드`);
      b.innerHTML = `<i></i><span>${p.label}</span>`;
      paints.appendChild(b);
      draggable(b, {
        ghostHTML: () => pipetteSVG(p.hex, !p.sigma),
        onTap: () => { b.classList.remove("new"); onPaintTap(i); },
        onDrop: (x, y) => { b.classList.remove("new"); onPaintDrop(i, x, y); },
        onHold: (x, y) => onPaintDrop(i, x, y, true),
      });
    }
    for (const id of additiveIds) {
      const a = ADDITIVES.find((x) => x.id === id);
      if (!a) continue;
      const b = document.createElement("button");
      b.className = `paint additive add-${id}` + (fresh.includes(id) ? " new" : "");
      b.style.setProperty("--c", a.hex);
      b.setAttribute("aria-label", a.label);
      b.innerHTML = `<i></i><span>${a.label}</span>`;
      paints.appendChild(b);
      draggable(b, {
        ghostHTML: () => pipetteSVG(a.hex),
        onTap: () => { b.classList.remove("new"); onAdditiveTap(id); },
        onDrop: (x, y) => { b.classList.remove("new"); onAdditiveDrop(id, x, y); },
      });
    }
    if (fresh.length) paints.lastElementChild?.scrollIntoView?.({ behavior: "smooth", inline: "end", block: "nearest" });
  }
  setPalette(PAINTS.slice(0, 7).map((p) => p.id));

  // ---- rare gems the player owns (gem drawer) ----
  const rareRow = $("rare-row"), rareBox = $("rare-gems");
  function setRareGems(list) {          // [{ index, tier, label, icon (html) }]
    rareRow.hidden = list.length === 0;
    rareBox.textContent = "";
    for (const r of list) {
      const b = document.createElement("button");
      b.className = `tier-${r.tier}`;
      b.setAttribute("aria-label", r.label);
      b.title = r.label;
      b.innerHTML = r.icon;
      rareBox.appendChild(b);
      draggable(b, { ghostHTML: () => r.icon, onTap: () => onRareTap(r.index, r.tier), onDrop: (x, y) => onRareDrop(r.index, r.tier, x, y) });
    }
  }

  // ---- texture toggle (toolbar): 젤리 ↔ 슬랑이 ----
  const textureButton = $("texture");
  const paintTexture = () => {
    const slime = settings.texture === "slime";
    textureButton.textContent = slime ? "슬랑이" : "젤리";
    textureButton.classList.toggle("on", slime);
    textureButton.setAttribute("aria-pressed", String(slime));
    textureButton.setAttribute("aria-label", slime ? "슬랑이 질감 (누르면 젤리로)" : "젤리 질감 (누르면 슬랑이로)");
  };
  paintTexture();
  textureButton.addEventListener("click", () => {
    change("texture", settings.texture === "slime" ? "jelly" : "slime");
    paintTexture();
    onTexture(settings.texture);
  });

  // ---- shape picker (toolbar button + drawer; locked shapes show their level) ----
  const shapeButton = $("shape-button"), shapeDrawer = $("shape-drawer"), shapeGrid = $("shape-grid");
  let unlockedShapes = ["flower"];
  const paintShapeButton = () => { shapeButton.innerHTML = uniqueSvg(shapeIconSVG(settings.shape)); shapeButton.setAttribute("aria-label", `모양: ${SHAPES.find((x) => x.id === settings.shape)?.label || "꽃"}`); };
  function setShapes(unlocked, fresh = []) {
    unlockedShapes = unlocked;
    shapeGrid.textContent = "";
    for (const sh of SHAPES) {
      const open = unlocked.includes(sh.id), b = document.createElement("button");
      b.className = (open ? "" : "locked") + (sh.id === settings.shape ? " active" : "") + (fresh.includes(sh.id) ? " new" : "");
      b.setAttribute("aria-label", open ? sh.label : `${sh.label} (토끼 친밀도 Lv${sh.level})`);
      b.innerHTML = `${uniqueSvg(shapeIconSVG(sh.id, { locked: !open }))}<span>${sh.label}</span>${open ? "" : `<i class="lv">Lv${sh.level}</i>`}`;
      b.addEventListener("click", () => {
        if (!open) { onShape(null, sh); return; }
        b.classList.remove("new");
        change("shape", sh.id);
        for (const other of shapeGrid.children) other.classList.toggle("active", other === b);
        paintShapeButton();
        shapeDrawer.hidden = true; shapeButton.classList.remove("on");
        onShape(sh.id, sh);
      });
      shapeGrid.appendChild(b);
    }
    paintShapeButton();
  }
  shapeButton.addEventListener("click", () => {
    const open = shapeDrawer.hidden;
    shapeDrawer.hidden = !open;
    shapeButton.classList.toggle("on", open);
    shapeButton.setAttribute("aria-pressed", String(open));
    if (open) { $("gem-drawer").hidden = true; $("gems").classList.remove("on"); }
  });
  setShapes(unlockedShapes);

  // ---- base colour (settings) ----
  for (const button of document.querySelectorAll("[data-base]")) {
    button.classList.toggle("active", button.dataset.base === settings.base);
    button.addEventListener("click", () => {
      change("base", button.dataset.base);
      for (const other of document.querySelectorAll("[data-base]")) other.classList.toggle("active", other === button);
      onBase(button.dataset.base);
    });
  }

  // ---- sliders ----
  const jelly = $("sliders-jelly"), fx = $("sliders-fx");
  slider(jelly, { key: "softness", label: "말랑함", min: 0, max: 1, step: 0.01, value: settings.softness }, change);
  slider(jelly, { key: "wobble", label: "출렁임 지속", min: 0, max: 1, step: 0.01, value: settings.wobble }, change);
  slider(jelly, { key: "slippery", label: "미끄러움", min: 0, max: 1, step: 0.01, value: settings.slippery }, change);
  slider(fx, { key: "glow", label: "빛 세기", min: 0, max: 2, step: 0.01, value: settings.glow }, change);
  slider(fx, { key: "crunch", label: "크런치 소리", min: 0, max: 1, step: 0.01, value: settings.crunch }, change);
  slider(fx, { key: "gems", label: "보석 소리", min: 0, max: 1, step: 0.01, value: settings.gems }, change);
  slider(fx, { key: "boing", label: "출렁 소리", min: 0, max: 1, step: 0.01, value: settings.boing }, change);
  slider(fx, { key: "effects", label: "토끼·금화", min: 0, max: 1, step: 0.01, value: settings.effects }, change);

  // ---- gem colours ----
  const colors = $("gem-colors");
  const colorButtons = [];
  const pickColor = () => (settings.gemColor >= 0 ? settings.gemColor : Math.floor(Math.random() * GEM_COLORS.length));
  GEM_COLORS.forEach((c, i) => {
    const b = document.createElement("button");
    b.style.setProperty("--c", c.hex); b.setAttribute("aria-label", c.label); b.setAttribute("role", "radio");
    b.addEventListener("click", () => { change("gemColor", i); paintGems(); });
    colors.appendChild(b); colorButtons.push(b);
  });
  const random = document.createElement("button");
  random.className = "random"; random.setAttribute("aria-label", "랜덤 색");
  random.addEventListener("click", () => { change("gemColor", -1); paintGems(); });
  colors.appendChild(random); colorButtons.push(random);

  // ---- gem shapes ----
  const grid = $("gem-shapes");
  const shapeButtons = GEM_SHAPES.map((shape, i) => {
    const b = document.createElement("button");
    b.setAttribute("aria-label", shape.label);
    b.title = shape.label;
    grid.appendChild(b);
    let color = 0;
    b.addEventListener("pointerdown", () => { color = pickColor(); }, { capture: true });
    draggable(b, {
      ghostHTML: () => gemIconSVG(i, GEM_COLORS[color].hex),
      onTap: () => onGemTap(i, color),
      onDrop: (x, y) => onGemDrop(i, color, x, y),
    });
    return b;
  });
  function paintGems() {
    colorButtons.forEach((b, i) => b.classList.toggle("active", (i === GEM_COLORS.length ? -1 : i) === settings.gemColor));
    const hex = GEM_COLORS[Math.max(0, settings.gemColor)].hex;
    shapeButtons.forEach((b, i) => { b.innerHTML = gemIconSVG(i, hex); });
  }
  paintGems();
  $("gem-scatter").addEventListener("click", () => onScatter(settings.gemColor));
  return { setPalette, setRareGems, setShapes };
}
