// Orders (colour model, solvability, scoring, v8 order variety / conditions /
// kinds) and progress (coins, friendship, gacha upgrades, storage).
import {
  makeOrder, scoreOrder, rollOutcome, mixSigma, deltaE, nameColor, COLOR_NAMES, COLOR_FAMILIES, sigmaToHex,
  toleranceFor, colorScoreFor, GEM_SHAPE_LABELS, ORDER_ADDITIVE_MIN,
} from "../src/app/orders.js";
import { Progress, PULL_COST, WELCOME_COINS, LEVEL_REWARDS, RARE_COUNT, BUNDLE, COINS_BY_STARS, FULLNESS_MAX, levelForXp } from "../src/app/progress.js";
import { JellyWorld, PAINTS, BASES } from "../src/core/world.js";
import { signatureSigma } from "../src/core/shapes.js";

let failures = 0;
const check = (label, ok, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`); };
function rng(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const memoryStorage = () => { const store = new Map(); return { store, getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) }; };
const BASIC = ["red", "yellow", "blue", "pink", "purple", "sky", "water"];
const paintsAt = (l) => [...BASIC, ...(l >= 2 ? ["orange"] : []), ...(l >= 4 ? ["lime"] : []), ...(l >= 6 ? ["pearl"] : []), ...(l >= 8 ? ["glow"] : [])];
const additivesAt = (l) => [...(l >= 3 ? ["glitter"] : []), ...(l >= 5 ? ["stars"] : [])];
const shapesAt = (l) => ["flower", ...(l >= 2 ? ["pudding"] : []), ...(l >= 4 ? ["cake"] : []), ...(l >= 6 ? ["bear"] : []), ...(l >= 8 ? ["cat"] : []), ...(l >= 10 ? ["bird"] : [])];
const orderAt = (level, random, i, extra = {}) => makeOrder({ paints: paintsAt(level), additives: additivesAt(level), shapes: shapesAt(level), level, random, id: i, ...extra });
// The jelly that fulfils an order exactly (optionally with another colour / shape).
const perfect = (o, over = {}) => ({
  sigma: mixSigma(o.base, o.drops), shape: o.shape || "flower", texture: o.texture || "jelly",
  gems: (o.gems || []).flatMap((g) => Array(g.count).fill(g.shape)), rare: [], rareCount: 0,
  additives: { glitter: o.additive?.id === "glitter" ? o.additive.min : 0, stars: o.additive?.id === "stars" ? o.additive.min : 0 }, fx: [0, 0],
  ...over,
});
const extrasOf = (o) => [o.gems, o.additive, o.texture, o.shape].filter(Boolean).length;

// 1) the order colour model matches the real jelly
{
  const w = new JellyWorld({ base: "clear" });
  for (let t = 0; t < 0.5; t += 1 / 60) w.advance(1 / 60);
  const top = () => [w.body.center[0], w.body.bounds[4], w.body.center[2]];
  const recipe = { yellow: 2, blue: 1, water: 1 };
  for (const [id, n] of Object.entries(recipe)) if (id !== "water") for (let i = 0; i < n; i++) w.handle({ type: "drop", point: top(), paint: PAINTS.findIndex((p) => p.id === id) });
  for (let i = 0; i < recipe.water; i++) w.handle({ type: "drop", point: top(), paint: PAINTS.findIndex((p) => p.id === "water") });
  w.updateMeanDye();
  const predicted = mixSigma("clear", recipe), dE = deltaE(predicted, w.meanDye);
  check("order colour model predicts the real jelly colour (within the ⭐3 tolerance)", dE < 5, `ΔE ${dE.toFixed(2)}`);
}

// 2) colour names: 40+, each recipe nearest to itself, families, separated
{
  const V7 = ["딸기우유", "체리 소다", "복숭아 아이스티", "망고 스무디", "레몬 젤리", "멜론 소다", "민트초코", "청포도 에이드", "바다 젤리", "블루베리 요거트", "라벤더 라떼", "포도 주스", "베리 베리", "꿀 젤리", "오렌지 주스", "라임 모히또", "솜사탕", "자두 에이드", "수박 바", "투명 물방울"];
  check("40+ named colours, unique, the 20 v7 names kept", COLOR_NAMES.length >= 40 && new Set(COLOR_NAMES.map((c) => c.name)).size === COLOR_NAMES.length && V7.every((n) => COLOR_NAMES.some((c) => c.name === n)), `${COLOR_NAMES.length} names`);
  check("every name has a known family and a reachable recipe", COLOR_NAMES.every((c) => COLOR_FAMILIES.includes(c.family) && BASES[c.base] && Object.keys(c.drops).every((p) => PAINTS.some((x) => x.id === p))));
  check("every family is used", COLOR_FAMILIES.every((f) => COLOR_NAMES.some((c) => c.family === f)));
  check("named colours are self-consistent (each recipe is nearest to its own name)", COLOR_NAMES.every((c) => nameColor(mixSigma(c.base, c.drops)) === c.name));
  let min = Infinity, pair = "";
  for (let i = 0; i < COLOR_NAMES.length; i++) for (let j = i + 1; j < COLOR_NAMES.length; j++) {
    const a = COLOR_NAMES[i], b = COLOR_NAMES[j], d = deltaE(mixSigma(a.base, a.drops), mixSigma(b.base, b.drops));
    if (d < min) { min = d; pair = `${a.name} / ${b.name}`; }
  }
  check("names are well separated (min pairwise ΔE ≥ 6)", min >= 6, `min ΔE ${min.toFixed(1)} (${pair})`);
}

// 3) orders are solvable, varied and named (all levels, all kinds)
{
  const random = rng(7);
  const kinds = ["normal", "golden", "memory", "picky"];
  const orders = Array.from({ length: 240 }, (_, i) => orderAt(1 + (i % 12), random, i, { kind: kinds[i % 4] }));
  check("orders are v2 with a target colour, name and text", orders.every((o) => o.version === 2 && /^#[0-9a-f]{6}$/.test(o.hex) && o.name && o.text.endsWith("!") && o.text.includes(`${o.name}색`)));
  check("making the hidden recipe scores ⭐3", orders.every((o) => scoreOrder(o, perfect(o)).stars === 3));
  check("the untouched starting jelly never scores ⭐3 (even with every extra done)", orders.every((o) => scoreOrder(o, perfect(o, { sigma: mixSigma(o.base, {}), touched: false })).stars < 3));
  check("an untouched jelly is capped at ⭐2 even on the exact colour", orders.every((o) => scoreOrder(o, perfect(o, { touched: false })).stars <= 2 && scoreOrder(o, perfect(o, { touched: true })).stars === 3));
  check("orders vary", new Set(orders.map((o) => o.hex)).size > 150, `${new Set(orders.map((o) => o.hex)).size} distinct colours, ${new Set(orders.map((o) => o.name)).size} names`);
  check("only unlocked paints are used", orders.every((o, i) => Object.keys(o.drops).every((k) => paintsAt(1 + (i % 12)).includes(k))));
  check("total drops stay within the level's cap", orders.every((o, i) => Object.entries(o.drops).filter(([k]) => k !== "water").reduce((a, [, n]) => a + n, 0) <= 4 + Math.floor((1 + (i % 12)) / 2)));
  check("toppings only once unlocked, gem / topping minimums are sane", orders.every((o, i) => (!o.additive || additivesAt(1 + (i % 12)).includes(o.additive.id) && o.additive.min === ORDER_ADDITIVE_MIN[o.additive.id])
    && (!o.gems || (o.gems.length <= 2 && o.gems.every((g) => g.shape >= 0 && g.shape < GEM_SHAPE_LABELS.length && g.count >= 1 && g.count <= 3) && new Set(o.gems.map((g) => g.shape)).size === o.gems.length))));
  const o = orders.find((x) => x.gems);
  const half = scoreOrder(o, perfect(o, { gems: [] }));
  check("missing gems lower the score", half.stars < 3 && half.colorScore === 1 && half.checks.gems === 0, `${half.stars}⭐`);
  const t = orders.find((x) => x.additive);
  const noTop = scoreOrder(t, perfect(t, { additives: { glitter: 0, stars: 0 } }));
  check("a missing topping lowers the score", noTop.stars < 3 && noTop.checks.additive === 0);
  const sl = orders.find((x) => x.texture === "slime");
  check("the wrong texture lowers the score", scoreOrder(sl, perfect(sl, { texture: "jelly" })).stars < 3);
  const many = orders.find((x) => extrasOf(x) >= 3 && x.gems);
  const oneShort = perfect(many, { gems: perfect(many).gems.slice(1) });
  check("any unmet condition caps the order at ★2 (even with the rest perfect)", scoreOrder(many, oneShort).stars === 2 && scoreOrder(many, { ...oneShort, rareCount: 1 }).stars === 3, many.text);
  console.log("      e.g.", orders.slice(0, 6).map((x) => `${x.text} ${x.hex}`).join(" | "));
}

// 4) difficulty: k by level, golden / picky stricter
{
  const v8 = { 1: 1.6, 2: 1.6, 3: 1.4, 4: 1.4, 5: 1.2, 6: 1.2, 7: 1.0, 8: 1.0, 9: 0.9, 10: 0.9, 11: 0.8, 12: 0.8, 13: 0.7, 20: 0.7 };
  check("colour tolerance k = the v8 level curve × 4/3 (v9.2 ×2, v9.3 ×2/3)", Object.entries(v8).every(([l, k]) => Math.abs(toleranceFor(Number(l)) - k * 4 / 3) < 1e-12));
  check("colorScore = clamp01(1 − (ΔE − 5k)/(28k))", colorScoreFor(5, 1) === 1 && Math.abs(colorScoreFor(19, 1) - 0.5) < 1e-12 && Math.abs(colorScoreFor(8, 1.6) - 1) < 1e-12 && colorScoreFor(60, 1.6) === 0 && Math.abs(colorScoreFor(19, 0.7) - (1 - (19 - 3.5) / 19.6)) < 1e-12);
  const r = rng(21);
  const ks = ["normal", "golden", "memory", "picky"].map((kind) => orderAt(9, r, 1, { kind }).k);
  check("order.k = toleranceFor(level) × (golden 0.85 | picky 0.7 | 1)", Math.abs(ks[0] - 1.2) < 1e-12 && Math.abs(ks[1] - 1.2 * 0.85) < 1e-12 && Math.abs(ks[2] - 1.2) < 1e-12 && Math.abs(ks[3] - 1.2 * 0.7) < 1e-12, ks.map((k) => k.toFixed(3)).join(" "));
  const easy = orderAt(1, rng(3), 1), hard = { ...easy, k: 0.7 };
  const off = perfect(easy, { sigma: mixSigma(easy.base, { ...easy.drops, water: 2 }) });
  check("the same miss scores lower at a stricter k", scoreOrder(hard, off).colorScore <= scoreOrder(easy, off).colorScore && scoreOrder({ ...easy, k: undefined }, off).k === 1);
}

// 5) order variety: plain bases, no repeats, current shape irrelevant
{
  const random = rng(11), bases = {};
  const plain = Array.from({ length: 400 }, (_, i) => orderAt(1 + (i % 12), random, i)).filter((o) => !o.shape);
  for (const o of plain) bases[o.base] = (bases[o.base] || 0) + 1;
  check("plain orders start from varied plain bases, clear most often", ["clear", "berry", "mint", "honey"].every((b) => bases[b] > 0) && bases.clear > Math.max(bases.berry, bases.mint, bases.honey) && plain.every((o) => typeof o.base === "string"), JSON.stringify(bases));
  // the order sequence of a player: never a name of the last 5 orders
  const p = new Progress(memoryStorage(), rng(5));
  p.state.xp = 1500;
  const seq = Array.from({ length: 300 }, () => p.newOrder().name);
  check("orders never repeat a colour name of the last 5 orders", seq.every((n, i) => !seq.slice(Math.max(0, i - 5), i).includes(n)) && p.state.recentNames.length === 5, `${new Set(seq).size} names in 300 orders`);
  // the jelly's current shape does not change the order
  const a = new Progress(memoryStorage(), rng(77)), b = new Progress(memoryStorage(), rng(77));
  a.state.xp = b.state.xp = 1500;
  const same = Array.from({ length: 40 }, () => [a.newOrder({ currentShape: "flower" }), b.newOrder({ currentShape: "bear" })]).every(([x, y]) => x.text === y.text && x.hex === y.hex && x.kind === y.kind);
  check("plain orders do not depend on the jelly's current shape", same);
}

// 6) shape orders: only unlocked non-flower shapes, from the signature colour
{
  const shapes = [{ id: "flower", label: "꽃" }, { id: "bear", label: "곰젤리" }];
  const purple = [30, 70, 10];
  const sOrders = Array.from({ length: 200 }, (_, i) => makeOrder({ paints: ["red", "yellow", "blue", "pink", "water"], level: 6, random: rng(100 + i), id: i, shapes, shapeBase: (id) => (id === "bear" ? purple : null) }));
  const bearOrders = sOrders.filter((x) => x.shape === "bear");
  check("shape orders appear (~30 %) once a shape is unlocked", bearOrders.length > 40 && bearOrders.length < 85 && bearOrders.every((x) => x.text.startsWith("곰젤리 모양")), `${bearOrders.length}/200`);
  check("shape orders start from the shape's signature colour (solvable)", bearOrders.every((x) => x.base.join() === purple.join() && scoreOrder(x, perfect(x, { sigma: mixSigma(purple, x.drops), shape: "bear" })).stars === 3));
  check("wrong shape lowers the score (capped at ★2)", bearOrders.every((x) => scoreOrder(x, perfect(x, { sigma: mixSigma(purple, x.drops), shape: "flower" })).stars < 3));
  check("no shape orders with only the flower", Array.from({ length: 60 }, (_, i) => makeOrder({ paints: BASIC, level: 6, random: rng(i), shapes: ["flower"] })).every((x) => !x.shape));
  // the real signatures (ids are enough: labels come from core/shapes.js)
  const real = Array.from({ length: 300 }, (_, i) => orderAt(10, rng(500 + i), i)).filter((x) => x.shape);
  check("real shape orders use every unlocked shape's signature and are solvable", new Set(real.map((x) => x.shape)).size === 5
    && real.every((x) => x.base.join() === signatureSigma(x.shape).join() && scoreOrder(x, perfect(x)).stars === 3), `${real.length}/300`);
}

// 7) conditions grow with level; golden adds one
{
  const stats = (level, kind = "normal") => {
    const r = rng(level * 31 + kind.length), list = Array.from({ length: 400 }, (_, i) => orderAt(level, r, i, { kind }));
    const n = list.map(extrasOf);
    return { min: Math.min(...n), max: Math.max(...n), mean: n.reduce((a, b) => a + b, 0) / n.length, list };
  };
  const s1 = stats(1), s2 = stats(2), s4 = stats(4), s6 = stats(6), s9 = stats(9);
  check("Lv1–2: 0–1 extra condition (gems / shape)", s1.max <= 1 && s2.max <= 1 && s1.mean > 0.3 && s1.mean < 0.7 && s1.list.every((o) => !o.additive && !o.texture), `Lv1 mean ${s1.mean.toFixed(2)}`);
  check("Lv3–5: 1–2 extras", s4.min >= 1 && s4.max <= 2 && s4.mean > s1.mean, `Lv4 mean ${s4.mean.toFixed(2)}`);
  check("Lv6+: 1–3 extras", s6.min >= 1 && s6.max <= 3 && s9.max <= 3 && s6.mean > s4.mean, `Lv6 mean ${s6.mean.toFixed(2)}`);
  check("two gem kinds and the slime texture only from Lv4", stats(3).list.every((o) => (!o.gems || o.gems.length === 1) && !o.texture) && s6.list.some((o) => o.gems?.length === 2) && s6.list.some((o) => o.texture === "slime"));
  check("toppings appear from Lv3 (glitter) and Lv5 (star candies)", stats(3).list.some((o) => o.additive?.id === "glitter") && stats(3).list.every((o) => o.additive?.id !== "stars") && s6.list.some((o) => o.additive?.id === "stars"));
  const g6 = stats(6, "golden");
  check("golden orders ask for one condition more", g6.mean > s6.mean + 0.6 && g6.min >= 2, `golden Lv6 mean ${g6.mean.toFixed(2)} vs ${s6.mean.toFixed(2)}`);
  const full = s9.list.find((o) => o.shape && o.gems && o.additive) || s9.list.find((o) => o.gems && o.additive);
  check("order text reads naturally", /^(\S+ 모양 )?.+색 (젤리|슬랑이)에 .+ 보석 \d개.*, (글리터 듬뿍|별사탕 토핑)!$/.test(full.text), full.text);
}

// 8) order kinds: golden Lv3+ ~1/8 never twice in a row, memory Lv4+ ~1/5, picky Lv5+ ~1/10
{
  const p = new Progress(memoryStorage(), rng(8));
  p.state.xp = 400;   // Lv6
  const kinds = Array.from({ length: 4000 }, () => p.newOrder().kind);
  const freq = (k) => kinds.filter((x) => x === k).length / kinds.length;
  check("kind frequencies ≈ golden 1/8, memory 1/5, picky 1/10", Math.abs(freq("golden") - 1 / 8) < 0.02 && Math.abs(freq("memory") - 1 / 5) < 0.025 && Math.abs(freq("picky") - 1 / 10) < 0.02,
    ["golden", "memory", "picky", "normal"].map((k) => `${k} ${(freq(k) * 100).toFixed(1)} %`).join(", "));
  check("golden orders never come twice in a row", kinds.every((k, i) => !(k === "golden" && kinds[i - 1] === "golden")));
  const low = new Progress(memoryStorage(), rng(9));
  const lowKinds = new Set(Array.from({ length: 300 }, () => low.newOrder().kind));
  low.state.xp = 100;   // Lv3
  const l3 = new Set(Array.from({ length: 300 }, () => low.newOrder().kind));
  low.state.xp = 180;   // Lv4
  const l4 = new Set(Array.from({ length: 300 }, () => low.newOrder().kind));
  check("kinds unlock by level (Lv1 normal only, golden Lv3, memory Lv4, picky Lv5)", lowKinds.size === 1 && lowKinds.has("normal") && l3.has("golden") && !l3.has("memory") && l4.has("memory") && !l4.has("picky") && kinds.includes("picky"));
}

// 9) progress: welcome coins, feeding (halved coins), levels, gacha upgrades, storage
{
  const storage = memoryStorage();
  const p = new Progress(storage, rng(3));
  check("new players get welcome coins (one free pull)", p.coins === WELCOME_COINS && p.canPull);
  const r = p.pull();
  const firstGem = r.achievements.reduce((a, x) => a + x.coins, 0);
  check("a pull costs coins and gives a bundle of 10 of a new glitter gem", r.type === "gem" && r.kind === "new" && r.tier === 0 && r.added === BUNDLE && r.count === BUNDLE && p.coins === WELCOME_COINS - PULL_COST + firstGem && firstGem > 0, `${p.coins} (first-gem badge ${firstGem})`);
  check("no coins → no pull", p.pull() === null);
  const f1 = p.feed({ stars: 3, rareCount: 1 });
  check("⭐3 with a rare gem pays 35 coins (halved)", f1.coins === 35, `${f1.coins}`);
  const f2 = p.feed({ stars: 1 });
  check("⭐1 still pays 15 coins (sad bunny)", f2.coins === 15);
  check("coins add up (+ achievements / gift box)", p.coins === firstGem + f1.coinsTotal + f2.coinsTotal, `${p.coins}`);
  check("friendship levels up and unlocks the orange paint + pudding shape", p.level.level >= 2 && p.paints().includes("orange") && p.shapes().includes("pudding") && [...f1.levelUps, ...f2.levelUps].some((u) => u.rewards.some((x) => x.id === "orange") && u.gift));
  check("★ coins are the halved scale", COINS_BY_STARS.join() === "0,15,23,30,40");
  // upgrades: force the same gem
  const q = new Progress(storage, () => 0.5);
  q.state.coins = 1000;
  const pulls = [q.pull(), q.pull(), q.pull(), q.pull()];
  const kinds = pulls.map((x) => x.kind).join();
  check("duplicates add 10 and upgrade glitter → gold → rainbow, then just add 10", (kinds === "new,gold,rainbow,more" || kinds === "gold,rainbow,more,more") && pulls.every((x, i) => i === 0 || x.count === pulls[i - 1].count + 10), `${kinds} → ${pulls.map((x) => x.count).join("/")}`);
  const reloaded = new Progress(storage);
  check("progress survives a reload", reloaded.coins === q.coins && reloaded.state.rare.join() === q.state.rare.join() && reloaded.state.rareStock.join() === q.state.rareStock.join());
  const broken = new Progress({ getItem: () => "{oops", setItem: () => { throw new Error("quota"); } });
  check("corrupted storage starts fresh, full storage does not crash", broken.coins === WELCOME_COINS && (broken.feed({ stars: 2 }), true));
  check("all rewards are reachable by level 12", levelForXp(1480).level >= 12 && Object.keys(LEVEL_REWARDS).every((l) => Number(l) <= 12));
  check("level rewards include outfits (Lv3/5/7/9/12) and themes (Lv4/7/10)",
    [3, 5, 7, 9, 12].every((l) => LEVEL_REWARDS[l].some((x) => x.kind === "outfit")) && [4, 7, 10].every((l) => LEVEL_REWARDS[l].some((x) => x.kind === "theme")));
  check("25 rare gems", RARE_COUNT === 25);
  // album cap
  const a = new Progress(storage, rng(9));
  for (let i = 0; i < 70; i++) a.feed({ stars: 2, card: { id: i, hex: sigmaToHex(mixSigma("berry", {})) } });
  check("album keeps the latest 60 works", a.state.album.length === 60 && a.state.album[59].id === 69);
}

// 10) v8 rules: rare gem ★+1 (★4 special), ★1 spit / kick / eat
{
  const o = orderAt(3, rng(5), 1);
  const good = perfect(o);
  check("a rare gem turns ★3 into ★4 special", scoreOrder(o, { ...good, rareCount: 1 }).stars === 4 && scoreOrder(o, { ...good, rare: [{ index: 3, tier: 0 }], rareCount: undefined }).mood === "special");
  const bad = { sigma: [120, 4, 120], gems: [], texture: "jelly" };
  check("a rare gem lifts ★1 to ★2 (always eaten then)", scoreOrder(o, bad).stars === 1 && scoreOrder(o, { ...bad, rareCount: 3 }).stars === 2);
  const counts = { eat: 0, spit: 0, kick: 0 }, r = rng(11), N = 30000;
  for (let i = 0; i < N; i++) counts[rollOutcome(1, r)]++;
  check("★1 outcomes ≈ 1/3 spit, 1/5 kick, 7/15 eat", Math.abs(counts.spit / N - 1 / 3) < 0.012 && Math.abs(counts.kick / N - 1 / 5) < 0.01 && Math.abs(counts.eat / N - 7 / 15) < 0.012, JSON.stringify(counts));
  check("★2+ is always eaten", [2, 3, 4].every((s) => Array.from({ length: 200 }, () => rollOutcome(s, r)).every((x) => x === "eat")));
  const p = new Progress(memoryStorage(), rng(4));
  p.state.coins = 20;
  const sp = p.spit();
  check("spit takes 1–50 coins but never below 0", sp.rolled >= 1 && sp.rolled <= 50 && p.coins === Math.max(0, 20 - sp.rolled) && sp.lost === 20 - p.coins, JSON.stringify(sp));
  p.state.coins = 200;
  const rolls = Array.from({ length: 300 }, () => { p.state.coins = 200; return p.kick().lost; });
  check("kick takes 1–50 coins", rolls.every((x) => x >= 1 && x <= 50) && new Set(rolls).size > 30);
  check("the old refusal is gone", typeof p.refuse === "undefined" && !["refuse"].includes(rollOutcome(1, () => 0.4)));
  p.state.streak = 0;
  check("★4 pays 40 coins", p.feed({ stars: 4 }).coins === 40);
}

// 11) v9 star pipeline: scoreOrder → modifyStars (full −1 / happy +1) → rollOutcome → feed
{
  const o = orderAt(3, rng(12), 1), good = perfect(o), rare = { ...good, rareCount: 1 };
  const bad = { sigma: [120, 4, 120], gems: [], texture: "jelly" };
  const p = new Progress(memoryStorage(), rng(13));
  const pipe = (jelly, touched = true) => p.modifyStars(scoreOrder(o, jelly).stars, { touched });
  check("pipeline: neither full nor happy → the order's stars", pipe(good).stars === 3 && pipe(good).mod === null && pipe(rare).stars === 4);
  p.state.fullness = FULLNESS_MAX;
  check("pipeline full: ★3 → ★2, ★4 special → ★3, ★1 floor (then ★1 can be spat / kicked)", pipe(good).stars === 2 && pipe(rare).stars === 3 && pipe(bad).stars === 1
    && rollOutcome(pipe(bad).stars, () => 0.1) === "spit" && rollOutcome(pipe(bad).stars, () => 0.4) === "kick");
  check("pipeline full: a rare-lifted ★2 drops back to ★1 (hard mode)", scoreOrder(o, { ...bad, rareCount: 3 }).stars === 2 && pipe({ ...bad, rareCount: 3 }).stars === 1);
  p.state.fullness = FULLNESS_MAX;
  const trip = p.toilet();
  check("pipeline happy: ★3 → ★4, ★4 stays ★4 (+10), ★1 → ★2 (always eaten), untouched unchanged", trip.happyTurns === 5 && pipe(good).stars === 4 && pipe(rare).stars === 4 && pipe(rare).overflowCoins === 10
    && pipe(bad).stars === 2 && rollOutcome(pipe(bad).stars, () => 0.1) === "eat" && pipe(good, false).stars === 3 && pipe(good, false).mod === null);
  const m = pipe(rare), r = p.feed({ stars: m.stars, starMod: m, order: o, jelly: rare, elapsed: Infinity });
  check("pipeline happy feed: ★4 coins + 10 overflow, one turn used, gauge +1", r.coins === COINS_BY_STARS[4] + 5 + 10 && r.happyTurns === 4 && r.fullness === 1, `${r.coins}`);
}

console.log(failures ? `\n${failures} FAILED` : "\nALL GAME CHECKS PASSED");
process.exit(failures ? 1 : 0);
