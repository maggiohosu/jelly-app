// Bunny orders: "딸기우유색에 하트 보석 2개!" — generated from the same colour
// model the jelly uses, so every order can be made exactly.
//
// Colour model (see core/world.js): the jelly's mean absorption σ (1/m) is
// what the eye reads (the paint field diffuses but pigment is conserved, so
// the mass-weighted mean is exact whatever the mixing state). One paint drop
// adds DROP_GAIN·σ_paint to the mean; one water drop removes ~6 % of it.
// Displayed colour ≈ transmittance over the reference depth, T = exp(−σ·d).
//
// Pure functions, no DOM: unit-testable in Node.
import { PAINTS, BASES } from "../core/world.js";

const DROP_GAIN = 0.015 * 3;      // DROP_FRACTION × PAINT_STRENGTH in world.js
const WATER_KEEP = 0.94;          // 1 − WATER_STRENGTH
const DEPTH = 0.055;              // a typical light path through the jelly (looks like the jelly)
const GEM_SHAPE_LABELS = ["하트", "다이아", "별", "물방울", "달", "벚꽃", "사탕", "리본", "사과"];

// Named colours for orders and album cards: a name per region of colour space.
// Each is defined by a recipe (base + drops), so it is always reachable.
export const COLOR_NAMES = Object.freeze([
  { name: "딸기우유", base: "clear", drops: { pink: 2 } },
  { name: "체리 소다", base: "clear", drops: { red: 3 } },
  { name: "복숭아 아이스티", base: "clear", drops: { pink: 1, yellow: 1 } },
  { name: "망고 스무디", base: "clear", drops: { yellow: 2, red: 1 } },
  { name: "레몬 젤리", base: "clear", drops: { yellow: 2 } },
  { name: "멜론 소다", base: "clear", drops: { yellow: 2, sky: 2 } },
  { name: "민트초코", base: "mint", drops: {} },
  { name: "청포도 에이드", base: "clear", drops: { yellow: 3, blue: 1 } },
  { name: "바다 젤리", base: "clear", drops: { sky: 3 } },
  { name: "블루베리 요거트", base: "clear", drops: { blue: 1, pink: 1 } },
  { name: "라벤더 라떼", base: "clear", drops: { purple: 1, pink: 1 } },
  { name: "포도 주스", base: "clear", drops: { purple: 3 } },
  { name: "베리 베리", base: "berry", drops: {} },
  { name: "꿀 젤리", base: "honey", drops: {} },
  { name: "오렌지 주스", base: "clear", drops: { orange: 3 } },
  { name: "라임 모히또", base: "clear", drops: { lime: 3 } },
  { name: "솜사탕", base: "clear", drops: { pink: 1, sky: 1 } },
  { name: "자두 에이드", base: "berry", drops: { purple: 2 } },
  { name: "수박 바", base: "berry", drops: { red: 1 } },
  { name: "투명 물방울", base: "clear", drops: {} },
].map(Object.freeze));

const paintIndex = (id) => PAINTS.findIndex((p) => p.id === id);

/** Mean σ after dropping `drops` ({paintId: count}) into `base`, water last. */
export function mixSigma(base, drops) {
  const s = (BASES[base] || BASES.berry).slice();
  let water = 0;
  for (const [id, n] of Object.entries(drops)) {
    const p = PAINTS[paintIndex(id)];
    if (!p || !n) continue;
    if (!p.sigma) { water += n; continue; }
    for (let c = 0; c < 3; c++) s[c] += DROP_GAIN * p.sigma[c] * n;
  }
  const keep = Math.pow(WATER_KEEP, water);
  return s.map((v) => v * keep);
}

export const transmittance = (sigma) => sigma.map((v) => Math.exp(-v * DEPTH));

// What the jelly looks like (roughly): transmittance seen over a light
// background, slightly tinted; returned as sRGB 0..255.
export function sigmaToRgb(sigma) {
  const T = transmittance(sigma);
  return T.map((t) => Math.round(255 * linearToSrgb(0.06 + 0.92 * t)));
}
export const rgbToHex = (rgb) => "#" + rgb.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("");
export const sigmaToHex = (sigma) => rgbToHex(sigmaToRgb(sigma));

function linearToSrgb(x) { return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055; }
function srgbToLinear(x) { return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }

// CIE Lab (D65) of an sRGB 0..255 colour.
export function rgbToLab(rgb) {
  const [r, g, b] = rgb.map((v) => srgbToLinear(v / 255));
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
export function deltaE(sigmaA, sigmaB) {
  const a = rgbToLab(sigmaToRgb(sigmaA)), b = rgbToLab(sigmaToRgb(sigmaB));
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

const NAMED = COLOR_NAMES.map((c) => ({ ...c, sigma: mixSigma(c.base, c.drops) }));

/** The friendliest name for a jelly colour. */
export function nameColor(sigma) {
  let best = NAMED[0], bd = Infinity;
  for (const c of NAMED) { const d = deltaE(sigma, c.sigma); if (d < bd) { bd = d; best = c; } }
  return best.name;
}

/**
 * A new order. `paints` = ids of paints the player has unlocked; `level` =
 * bunny friendship level (orders get a little harder); `random` = RNG.
 * { id, base, drops (the hidden recipe), sigma, hex, name, gems: null | {shape, count}, texture: null | "slime", text }
 */
export function makeOrder({ paints, level = 1, random = Math.random, id = Date.now() }) {
  const usable = paints.filter((p) => PAINTS[paintIndex(p)]?.sigma);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const bases = ["berry", "mint", "honey", "clear", "clear", "clear"];
  for (let attempt = 0; attempt < 40; attempt++) {
    const base = pick(bases);
    const kinds = 1 + Math.floor(random() * Math.min(3, 1 + level / 3));
    const drops = {};
    let total = 0;
    for (let k = 0; k < kinds; k++) {
      const p = pick(usable);
      const n = 1 + Math.floor(random() * 3);
      drops[p] = (drops[p] || 0) + n; total += n;
    }
    if (level >= 3 && random() < 0.25) drops.water = 1 + Math.floor(random() * 2);
    if (total > 4 + Math.floor(level / 2)) continue;
    const sigma = mixSigma(base, drops);
    // must look different from the plain base (otherwise the order is trivial)
    if (deltaE(sigma, mixSigma(base, {})) < 10) continue;
    const gems = level >= 2 && random() < 0.6 ? { shape: Math.floor(random() * GEM_SHAPE_LABELS.length), count: 1 + Math.floor(random() * Math.min(3, level)) } : null;
    const texture = level >= 4 && random() < 0.3 ? "slime" : null;
    const name = nameColor(sigma);
    const parts = [`${name}색 ${texture ? "슬랑이" : "젤리"}`];
    if (gems) parts.push(`${GEM_SHAPE_LABELS[gems.shape]} 보석 ${gems.count}개`);
    return Object.freeze({ id, base, drops, sigma, hex: sigmaToHex(sigma), name, gems, texture, text: parts.join("에 ") + "!" });
  }
  const sigma = mixSigma("clear", { pink: 2 });
  return Object.freeze({ id, base: "clear", drops: { pink: 2 }, sigma, hex: sigmaToHex(sigma), name: "딸기우유", gems: null, texture: null, text: "딸기우유색 젤리!" });
}

/**
 * How happy the bunny is with what it gets.
 * jelly = { sigma: meanDye, gems: [shapeIndex…] (normal gems), rareCount, texture }
 * → { stars 1..3, score 0..1, colorScore, extraScore, dE, mood }
 */
export function scoreOrder(order, jelly) {
  const dE = deltaE(order.sigma, jelly.sigma);
  const colorScore = Math.max(0, Math.min(1, 1 - (dE - 5) / 28));
  const checks = [];
  if (order.gems) {
    const have = jelly.gems.filter((s) => s === order.gems.shape).length;
    checks.push(Math.min(1, have / order.gems.count));
  }
  if (order.texture) checks.push(jelly.texture === order.texture ? 1 : 0);
  const extraScore = checks.length ? checks.reduce((a, b) => a + b, 0) / checks.length : 1;
  const score = 0.7 * colorScore + 0.3 * extraScore;
  const stars = score >= 0.85 ? 3 : score >= 0.6 ? 2 : 1;
  return { stars, score, colorScore, extraScore, dE, mood: stars === 3 ? "happy" : stars === 2 ? "ok" : "sad" };
}
