// Bunny orders: "곰젤리 모양 딸기우유색 슬랑이에 하트 보석 2개 + 별 보석 1개, 글리터 듬뿍!"
// — generated from the same colour model the jelly uses, so every order can
// be made exactly.
//
// Colour model (see core/world.js): the jelly's mean absorption σ (1/m) is
// what the eye reads (the paint field diffuses but pigment is conserved, so
// the mass-weighted mean is exact whatever the mixing state). One paint drop
// adds DROP_GAIN·σ_paint to the mean; one water drop removes ~6 % of it.
// Displayed colour ≈ transmittance over the reference depth, T = exp(−σ·d).
//
// Order v2 (see the shared contract): plain orders start from a varied plain
// base (clear / berry / mint / honey) whatever shape the jelly has now; shape
// orders start from the shape's signature colour. Extra conditions (gems of
// one or two kinds, a glitter / star-candy topping, the slime texture, the
// shape) grow with the friendship level; the colour tolerance factor k
// tightens with the level and with the order kind (golden / picky).
//
// Pure functions, no DOM: unit-testable in Node.
import { PAINTS, BASES } from "../core/world.js";
import { SHAPES, signatureSigma } from "../core/shapes.js";

const DROP_GAIN = 0.015 * 3;      // DROP_FRACTION × PAINT_STRENGTH in world.js
const WATER_KEEP = 0.94;          // 1 − WATER_STRENGTH
const DEPTH = 0.055;              // a typical light path through the jelly (looks like the jelly)
// Normal gem shapes (index = the gem's shape id in the world / gem drawer).
export const GEM_SHAPE_LABELS = Object.freeze(["하트", "다이아", "별", "물방울", "달", "벚꽃", "사탕", "리본", "사과"]);
export const GEM_HEART = 0, GEM_DROPLET = 3;
// Toppings an order can ask for: at least `min` flakes / candies in the jelly
// (one glitter drop adds ~90 flakes, one star-candy drop 9 candies).
export const ORDER_ADDITIVE_MIN = Object.freeze({ glitter: 60, stars: 9 });
const ADDITIVE_TEXT = Object.freeze({ glitter: "글리터 듬뿍", stars: "별사탕 토핑" });
// Plain order bases: clear most often (its pastels are the easiest to read).
const PLAIN_BASES = Object.freeze(["clear", "clear", "clear", "berry", "mint", "honey"]);
const SHAPE_ORDER_CHANCE = 0.3;
// Colour tolerance by order kind (multiplies the level's k).
const KIND_TOLERANCE = Object.freeze({ normal: 1, memory: 1, golden: 0.85, picky: 0.7 });
export const ORDER_KINDS = Object.freeze(["normal", "golden", "memory", "picky"]);

// Named colours for orders, album cards and the colour book: a name per
// region of colour space, each defined by a recipe (base + drops) so it is
// always reachable (orange / lime from Lv2 / Lv4). `family` groups them for
// the colour book and the secret recipes. The first 20 names are the v7 ones
// (album cards carry them); some recipes moved to keep the names apart.
// tests/game.test.mjs checks every recipe is nearest to its own name and the
// names stay ≥ 6 ΔE apart.
export const COLOR_NAMES = Object.freeze([
  { name: "딸기우유", family: "pink", base: "clear", drops: { pink: 2 } },
  { name: "체리 소다", family: "red", base: "clear", drops: { red: 3 } },
  { name: "복숭아 아이스티", family: "orange", base: "clear", drops: { pink: 2, orange: 2 } },
  { name: "망고 스무디", family: "orange", base: "clear", drops: { orange: 4, red: 1 } },
  { name: "레몬 젤리", family: "yellow", base: "clear", drops: { yellow: 3 } },
  { name: "멜론 소다", family: "green", base: "clear", drops: { sky: 4, lime: 2 } },
  { name: "민트초코", family: "mint", base: "mint", drops: {} },
  { name: "청포도 에이드", family: "green", base: "clear", drops: { lime: 2, yellow: 2 } },
  { name: "바다 젤리", family: "sky", base: "clear", drops: { sky: 3 } },
  { name: "블루베리 요거트", family: "blue", base: "clear", drops: { blue: 2, pink: 1 } },
  { name: "라벤더 라떼", family: "purple", base: "clear", drops: { purple: 2 } },
  { name: "포도 주스", family: "purple", base: "clear", drops: { purple: 4 } },
  { name: "베리 베리", family: "pink", base: "berry", drops: {} },
  { name: "꿀 젤리", family: "yellow", base: "honey", drops: {} },
  { name: "오렌지 주스", family: "orange", base: "clear", drops: { orange: 3 } },
  { name: "라임 모히또", family: "green", base: "clear", drops: { lime: 3 } },
  { name: "솜사탕", family: "pink", base: "clear", drops: { pink: 4, purple: 2 } },
  { name: "자두 에이드", family: "purple", base: "berry", drops: { blue: 3 } },
  { name: "수박 바", family: "red", base: "berry", drops: { yellow: 2 } },
  { name: "투명 물방울", family: "clear", base: "clear", drops: {} },
  // v8
  { name: "벚꽃 라떼", family: "pink", base: "clear", drops: { pink: 4 } },
  { name: "딸기잼", family: "red", base: "clear", drops: { red: 6 } },
  { name: "석류 주스", family: "red", base: "berry", drops: { lime: 3 } },
  { name: "자몽 에이드", family: "orange", base: "clear", drops: { red: 2, orange: 2 } },
  { name: "당근 주스", family: "orange", base: "clear", drops: { red: 4, yellow: 2 } },
  { name: "귤 마멀레이드", family: "orange", base: "honey", drops: { red: 3 } },
  { name: "바나나 우유", family: "yellow", base: "clear", drops: { yellow: 1 } },
  { name: "파인애플", family: "yellow", base: "clear", drops: { yellow: 6 } },
  { name: "키위 주스", family: "green", base: "clear", drops: { lime: 6 } },
  { name: "말차 라떼", family: "green", base: "clear", drops: { lime: 4, red: 2, blue: 1 } },
  { name: "쑥떡", family: "green", base: "honey", drops: { blue: 4 } },
  { name: "청사과", family: "green", base: "mint", drops: { yellow: 3 } },
  { name: "박하사탕", family: "mint", base: "clear", drops: { sky: 3, lime: 1 } },
  { name: "에메랄드 젤리", family: "mint", base: "mint", drops: { blue: 3 } },
  { name: "깊은 바다", family: "mint", base: "mint", drops: { blue: 6 } },
  { name: "하늘 소다", family: "sky", base: "clear", drops: { sky: 6, blue: 1 } },
  { name: "블루 하와이", family: "blue", base: "clear", drops: { blue: 4 } },
  { name: "블루베리 스무디", family: "blue", base: "clear", drops: { blue: 6, purple: 3 } },
  { name: "보라 고구마 라떼", family: "purple", base: "clear", drops: { purple: 6 } },
  { name: "포도 봉봉", family: "purple", base: "clear", drops: { purple: 8, blue: 2 } },
  { name: "오디 주스", family: "purple", base: "clear", drops: { purple: 8, red: 3 } },
  { name: "밀크티", family: "brown", base: "clear", drops: { red: 3, yellow: 3, blue: 2 } },
  { name: "모카 라떼", family: "brown", base: "clear", drops: { red: 4, yellow: 5, blue: 4 } },
  { name: "대추차", family: "brown", base: "clear", drops: { red: 5, yellow: 3, blue: 3 } },
  { name: "카라멜", family: "brown", base: "honey", drops: { purple: 3 } },
  { name: "초코 우유", family: "brown", base: "honey", drops: { purple: 3, blue: 2 } },
  { name: "팥빙수", family: "brown", base: "clear", drops: { red: 4, blue: 3, pink: 3 } },
].map((c) => Object.freeze({ ...c, drops: Object.freeze(c.drops) })));
export const COLOR_FAMILIES = Object.freeze(["pink", "red", "orange", "yellow", "green", "mint", "sky", "blue", "purple", "brown", "clear"]);

const paintIndex = (id) => PAINTS.findIndex((p) => p.id === id);

/** Mean σ after dropping `drops` ({paintId: count}) into `base` (a BASES id
 *  or a σ triple, e.g. a shape's signature colour), water last. */
export function mixSigma(base, drops) {
  const s = (Array.isArray(base) ? base : BASES[base] || BASES.berry).slice();
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

const NAMED = COLOR_NAMES.map((c) => {
  const sigma = mixSigma(c.base, c.drops);
  return { ...c, sigma, lab: rgbToLab(sigmaToRgb(sigma)) };
});
const BY_NAME = new Map(NAMED.map((c) => [c.name, c]));

/** The friendliest name for a jelly colour (nearest named colour in Lab). */
export function nameColor(sigma) {
  const lab = rgbToLab(sigmaToRgb(sigma));
  let best = NAMED[0], bd = Infinity;
  for (const c of NAMED) {
    const d = (lab[0] - c.lab[0]) ** 2 + (lab[1] - c.lab[1]) ** 2 + (lab[2] - c.lab[2]) ** 2;
    if (d < bd) { bd = d; best = c; }
  }
  return best.name;
}
/** Colour family of a name ("pink", "sky" …), null for an unknown name. */
export const familyOf = (name) => BY_NAME.get(name)?.family ?? null;
/** { name, family, hex, sigma, base, drops } of a named colour, or null. */
export function colorInfo(name) {
  const c = BY_NAME.get(name);
  return c ? { name: c.name, family: c.family, hex: sigmaToHex(c.sigma), sigma: c.sigma.slice(), base: c.base, drops: { ...c.drops } } : null;
}

/** Colour tolerance factor k by friendship level (1 = the v7 scale). v9.2
 * doubled the whole v8 curve (1.6 … 0.7 → 3.2 … 1.4): twice the colour
 * distance still counts as a perfect / passing colour at every level. */
export function toleranceFor(level = 1) {
  return level <= 2 ? 3.2 : level <= 4 ? 2.8 : level <= 6 ? 2.4 : level <= 8 ? 2.0 : level <= 10 ? 1.8 : level <= 12 ? 1.6 : 1.4;
}
/** colorScore of a ΔE under tolerance k: 1 up to 5k, 0 from 33k. */
export const colorScoreFor = (dE, k = 1) => Math.max(0, Math.min(1, 1 - (dE - 5 * k) / (28 * k)));

const shapeInfo = (s) => (typeof s === "string" ? SHAPES.find((x) => x.id === s) || { id: s, label: s } : s);

function orderText({ shapeLabel, name, texture, gems, additive }) {
  const head = `${shapeLabel ? shapeLabel + " 모양 " : ""}${name}색 ${texture === "slime" ? "슬랑이" : "젤리"}`;
  const gemText = gems ? gems.map((g) => `${GEM_SHAPE_LABELS[g.shape]} 보석 ${g.count}개`).join(" + ") : "";
  const addText = additive ? ADDITIVE_TEXT[additive.id] : "";
  if (gemText) return `${head}에 ${gemText}${addText ? ", " + addText : ""}!`;
  return addText ? `${head}에 ${addText}!` : `${head}!`;
}

// How many extra conditions: Lv1–2 0–1, Lv3–5 1–2, Lv6+ 1–3 (golden: +1).
function extraCount(level, random) {
  return level <= 2 ? Math.floor(random() * 2) : level <= 5 ? 1 + Math.floor(random() * 2) : 1 + Math.floor(random() * 3);
}

/**
 * A new order (Order v2, see the shared contract).
 * paints      ids of the paints the player has unlocked
 * additives   ids of the unlocked toppings ("glitter" Lv3, "stars" Lv5)
 * level       bunny friendship level (more conditions, stricter colour)
 * shapes      unlocked shapes (ids or {id, label}); shape orders only ask for
 *             non-flower shapes, ~30 % of the orders once one is unlocked
 * shapeBase   id → the shape's signature mean σ (a shape order's start colour)
 * recentNames colour names of the last orders: never asked again
 * kind        "normal" | "golden" (one more condition, k × 0.85) |
 *             "memory" (the UI hides the text) | "picky" (k × 0.7)
 * Plain orders do not depend on the jelly's current shape.
 */
export function makeOrder({ paints, additives = [], level = 1, shapes = [], shapeBase = signatureSigma, random = Math.random, id = Date.now(), recentNames = [], kind = "normal" } = {}) {
  if (!ORDER_KINDS.includes(kind)) kind = "normal";
  const usable = (paints || []).filter((p) => PAINTS[paintIndex(p)]?.sigma);
  if (!usable.length) usable.push("pink");
  const pick = (list) => list[Math.floor(random() * list.length)];
  const kLevel = toleranceFor(level), k = kLevel * KIND_TOLERANCE[kind];
  // The order colour must look clearly different from its starting colour:
  // ≥ 10 ΔE and the v8 distance (12 × the v8 k = 6 × today's doubled k), kept
  // so the order colours stay as varied as before. With the doubled
  // tolerance the untouched jelly could now pass the colour, so scoreOrder
  // caps an untouched jelly (jelly.touched === false) at ★2 instead.
  const minDiff = Math.max(10, 6 * kLevel);
  const cap = 4 + Math.floor(level / 2);
  const recent = new Set(recentNames);
  const others = (shapes || []).map(shapeInfo).filter((s) => s && s.id !== "flower" && shapeBase(s.id));

  // ---- conditions (decided once; the colour retries below do not bias them)
  const orderShape = others.length && random() < SHAPE_ORDER_CHANCE ? pick(others) : null;
  let n = extraCount(level, random) + (kind === "golden" ? 1 : 0);
  if (orderShape) n = Math.max(0, n - 1);   // the shape is one of the extras
  const toppings = additives.filter((a) => ORDER_ADDITIVE_MIN[a]);
  const pool = ["gems", ...(toppings.length ? ["additive"] : []), ...(level >= 4 ? ["texture"] : [])];
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const chosen = pool.slice(0, n), spare = n - chosen.length;
  let gems = null, additive = null, texture = null;
  if (chosen.includes("gems")) {
    // two kinds from Lv4 (always when the pool ran out of other conditions)
    const kinds = level >= 4 && (spare > 0 || random() < 0.4) ? 2 : 1;
    const first = Math.floor(random() * GEM_SHAPE_LABELS.length);
    const list = [];
    for (let g = 0; g < kinds; g++) {
      const shape = g === 0 ? first : (first + 1 + Math.floor(random() * (GEM_SHAPE_LABELS.length - 1))) % GEM_SHAPE_LABELS.length;
      list.push(Object.freeze({ shape, count: 1 + Math.floor(random() * Math.min(3, level)) }));
    }
    gems = Object.freeze(list);
  }
  if (chosen.includes("additive")) { const a = pick(toppings); additive = Object.freeze({ id: a, min: ORDER_ADDITIVE_MIN[a] }); }
  if (chosen.includes("texture")) texture = "slime";

  const build = (base, drops, sigma, name) => Object.freeze({
    id, version: 2, base: Array.isArray(base) ? Object.freeze(base.slice()) : base, drops: Object.freeze({ ...drops }),
    sigma: Object.freeze(sigma.slice()), hex: sigmaToHex(sigma), name,
    shape: orderShape ? orderShape.id : null, gems, additive, texture, kind, k,
    text: orderText({ shapeLabel: orderShape?.label, name, texture, gems, additive }),
  });

  // ---- colour: random drops into the base until it is new and distinct
  const signature = orderShape ? shapeBase(orderShape.id) : null;
  for (let attempt = 0; attempt < 300; attempt++) {
    const base = signature ? signature.slice() : pick(PLAIN_BASES);
    const kinds = 1 + Math.floor(random() * Math.min(3, 1 + level / 3));
    const drops = {};
    let total = 0;
    for (let i = 0; i < kinds; i++) {
      const p = pick(usable);
      const m = 1 + Math.floor(random() * 3);
      drops[p] = (drops[p] || 0) + m; total += m;
    }
    if (level >= 3 && random() < 0.25) drops.water = 1 + Math.floor(random() * 2);
    if (total > cap) continue;
    const sigma = mixSigma(base, drops);
    if (deltaE(sigma, mixSigma(base, {})) < minDiff) continue;
    const name = nameColor(sigma);
    if (recent.has(name)) continue;
    return build(base, drops, sigma, name);
  }
  // Fallback (practically never): a named colour's own recipe from a plain base.
  const fits = (c, strict) => Object.keys(c.drops).every((p) => usable.includes(p))
    && (!strict || (!recent.has(c.name) && Object.values(c.drops).reduce((a, b) => a + b, 0) <= cap))
    && deltaE(c.sigma, mixSigma(c.base, {})) >= 10;
  const list = NAMED.filter((c) => fits(c, true));
  const c = list.length ? pick(list) : NAMED.find((x) => fits(x, false)) || BY_NAME.get("딸기우유");
  return build(c.base, c.drops, c.sigma, c.name);
}

const gemList = (gems) => (Array.isArray(gems) ? gems : gems ? [gems] : []);

/**
 * How happy the bunny is with what it gets.
 * jelly = { sigma: meanDye, shape, texture: "jelly"|"slime", gems: [normal
 *   shape index…], rare: [{index, tier}…], rareCount, additives: {glitter,
 *   stars}, fx: [pearl, glow] }
 * → { stars 1..4, base 1..3, bonus (rare gem ★+1), score 0..1, colorScore,
 *     extraScore, dE, k, mood, checks: {color, gems, additive, texture, shape} }
 * checks: 0..1 per condition (1 = met), null when the order does not ask.
 * Any rare gem adds one star even if the order did not ask for it; a ★3 work
 * with a rare gem becomes ★4 "special". The wrong shape (and any other
 * condition not fully met) caps the base at ★2.
 */
export function scoreOrder(order, jelly) {
  const k = order.k > 0 ? order.k : 1;
  const dE = deltaE(order.sigma, jelly.sigma);
  const colorScore = colorScoreFor(dE, k);
  const have = jelly.gems || [];
  const wanted = gemList(order.gems);
  const checks = { color: colorScore, gems: null, additive: null, texture: null, shape: null };
  if (wanted.length) checks.gems = wanted.reduce((a, g) => a + Math.min(1, have.filter((s) => s === g.shape).length / g.count), 0) / wanted.length;
  if (order.additive) checks.additive = Math.min(1, (jelly.additives?.[order.additive.id] || 0) / order.additive.min);
  if (order.texture) checks.texture = (jelly.texture || "jelly") === order.texture ? 1 : 0;
  if (order.shape) checks.shape = (jelly.shape || "flower") === order.shape ? 1 : 0;
  const extras = [checks.gems, checks.additive, checks.texture, checks.shape].filter((v) => v !== null);
  const extraScore = extras.length ? extras.reduce((a, b) => a + b, 0) / extras.length : 1;
  const score = 0.7 * colorScore + 0.3 * extraScore;
  // the wrong shape — or any other unmet condition — can never be a perfect
  // order, nor can a jelly nothing went into (no paint, gem or topping)
  const unmet = extras.some((v) => v < 1) || jelly.touched === false;
  const base = Math.min(unmet ? 2 : 3, score >= 0.85 ? 3 : score >= 0.6 ? 2 : 1);
  const rareCount = jelly.rareCount ?? jelly.rare?.length ?? 0;
  const bonus = rareCount > 0 ? 1 : 0;
  const stars = Math.min(4, base + bonus);
  return { stars, base, bonus, score, colorScore, extraScore, dE, k, mood: stars === 4 ? "special" : stars === 3 ? "happy" : stars === 2 ? "ok" : "sad", checks };
}

/**
 * ★1 only: 1/3 the bunny takes one bite and spits it out (퉤), 1/5 it sniffs,
 * shakes its head and kicks the jelly away (no bite), otherwise it eats it.
 * Exclusive bands of one roll; ★2+ is always eaten.
 */
export const OUTCOME_ODDS = Object.freeze({ spit: 1 / 3, kick: 1 / 5 });
export function rollOutcome(stars, random = Math.random) {
  if (stars !== 1) return "eat";
  const r = random();
  return r < OUTCOME_ODDS.spit ? "spit" : r < OUTCOME_ODDS.spit + OUTCOME_ODDS.kick ? "kick" : "eat";
}
