// v8 fun systems: consumable rare-gem stock, migration of v7 saves, card
// pulls (bundles, tier ups, 1/100 shape cards), level rewards / gift boxes,
// combo / time bonus / golden / picky / memory, colour book, secret recipes,
// achievements, outfits / themes / titles. Pure logic: `node tests/fun.test.mjs`.
import { mixSigma, nameColor, familyOf, COLOR_NAMES, ORDER_ADDITIVE_MIN, GEM_HEART, GEM_DROPLET } from "../src/app/orders.js";
import {
  Progress, PROGRESS_KEY, PULL_COST, BUNDLE, COINS_BY_STARS, OWNED_SHAPE_COINS, MEMORY_PEEK_COST, LEVEL_REWARDS,
  comboMultiplier, timeBonusFor,
} from "../src/app/progress.js";
import {
  ACHIEVEMENTS, OUTFITS, THEMES, SECRET_RECIPES, COLOR_BOOK_REWARDS, GIFT_ODDS, rollGift, findSecret,
} from "../src/app/fun.js";
import { JellyWorld, PAINTS } from "../src/core/world.js";

let failures = 0;
const check = (label, ok, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`); };
function rng(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const memoryStorage = () => { const store = new Map(); return { store, getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) }; };
const seq = (values, rest = 0.5) => { let i = 0; return () => (i < values.length ? values[i++] : rest); };
const jellyOf = (over = {}) => ({ sigma: mixSigma("berry", {}), shape: "flower", texture: "jelly", gems: [], rare: [], rareCount: 0, additives: { glitter: 0, stars: 0 }, fx: [0, 0], ...over });
const order = (kind = "normal") => ({ id: 1, version: 2, kind, k: 1, name: "베리 베리", sigma: mixSigma("berry", {}) });
const sum = (list, key = "coins") => list.reduce((a, x) => a + (x[key] || 0), 0);

// 1) rare-gem stock: consume, refund, drawer order
{
  const p = new Progress(memoryStorage(), rng(1));
  const own = (i, tier, n) => { p.state.rare[i] = tier; p.state.rareStock[i] = n; };
  own(3, 0, 2); own(7, 1, 10); own(1, 2, 0); own(20, 0, 10);
  check("drawer: owned rare gems by count (desc), ties by index, empty ones last", p.rareStock().map((r) => `${r.index}:${r.count}`).join() === "7:10,20:10,3:2,1:0", p.rareStock().map((r) => `${r.index}:${r.count}`).join());
  const used = [p.useRare(3), p.useRare(3), p.useRare(3)];
  check("useRare deducts one per gem and refuses at 0", used.join() === "true,true,false" && p.rareCountOf(3) === 0);
  check("unowned / empty rare gems cannot be used", p.useRare(5) === false && p.useRare(1) === false && p.rareCountOf(5) === 0);
  const back = p.refundRare([{ index: 3 }, { index: 3, tier: 0 }, 5, 7]);
  check("refundRare returns gems of a replaced jelly (owned ones only)", back === 3 && p.rareCountOf(3) === 2 && p.rareCountOf(7) === 11 && p.rareCountOf(5) === 0);
  const reloaded = new Progress(p.storage);
  check("the stock is saved (an empty owned gem stays empty)", reloaded.rareCountOf(1) === 0 && reloaded.rareCountOf(7) === 11 && reloaded.state.rare[1] === 2);
}

// 2) migration of a v7 save
{
  const v7 = {
    version: 1, coins: 245, xp: 310, rare: [0, -1, 2, -1, 1, ...Array(20).fill(-1)],
    album: [
      { id: 1717000000000, date: 1717000000000, stars: 3, name: "딸기우유", hex: "#f7e9ef", texture: "jelly", shape: "flower", shapeLabel: "", thumb: "data:image/webp;base64,UklGRg==", gems: 2 },
      { id: 1717000100000, date: 1717000100000, stars: 2, name: "꿀 젤리", hex: "#e2ae58", texture: "slime", shape: "pudding", shapeLabel: "푸딩", thumb: null, gems: 0 },
      { id: 1717000200000, date: 1717000200000, stars: 3, name: "딸기우유", hex: "#f6e8ee", texture: "jelly", shape: "flower", shapeLabel: "", thumb: null, gems: 1 },
      { id: 1717000300000, date: 1717000300000, stars: 1, name: "없어진 이름", hex: "#000000", texture: "jelly", shape: "flower", shapeLabel: "", thumb: null, gems: 0 },
    ],
    order: { id: 1717000400000, base: "clear", drops: { pink: 2 }, sigma: [0.935, 3.56, 2.4], hex: "#f7e9ef", name: "딸기우유", gems: { shape: 0, count: 2 }, texture: null, shape: null, text: "딸기우유색 젤리에 하트 보석 2개!" },
    feeds: 14, pulls: 3, seenLevel: 1,
  };
  const storage = memoryStorage();
  storage.setItem(PROGRESS_KEY, JSON.stringify(v7));
  const p = new Progress(storage, rng(2));
  check("a v7 save loads: coins, XP, album and tiers kept", p.coins === 245 && p.state.xp === 310 && p.level.level === 5 && p.state.album.length === 4 && p.state.rare.slice(0, 5).join() === "0,-1,2,-1,1");
  check("every owned rare gem gets a stock of 10, others 0", p.state.rareStock.slice(0, 5).join() === "10,0,10,0,10" && p.state.rareStock.slice(5).every((n) => n === 0) && p.rareStock().length === 3);
  check("the old-format order is discarded (a new one is made)", p.order === null && p.state.order === null && p.newOrder().version === 2);
  check("the colour book starts from the album's (known) names", p.state.colorBook.join() === "딸기우유,꿀 젤리");
  check("v8 fields default sensibly", p.state.streak === 0 && p.freeCards === 0 && p.state.shapeCards.length === 0 && p.state.secrets.length === 0 && Object.keys(p.state.achievements).length === 0 && p.outfit.head === null && p.title === null);
  const f = p.feed({ stars: 2, order: p.order, jelly: jellyOf() });
  const ids = f.achievements.map((a) => a.id);
  check("no retroactive gift boxes; earned badges are caught up on the next meal (once)", f.levelUps.length === 0 && ids.includes("first_feed") && ids.includes("rare_first") && p.feed({ stars: 2 }).achievements.every((a) => !ids.includes(a.id)), ids.join());
  const again = new Progress(storage);
  check("a migrated save reloads unchanged", again.state.rareStock.join() === p.state.rareStock.join() && again.state.colorBook.join() === p.state.colorBook.join() && again.coins === p.coins);
}

// 3) card pulls: bundles and tier ups
{
  const p = new Progress(memoryStorage(), () => 0.5);   // always gem #12, never a shape card
  p.state.coins = 1000;
  const r = [p.pull(), p.pull(), p.pull(), p.pull(), p.pull()];
  check("dupe pulls add 10 and tier up glitter → gold → rainbow, then +10 only",
    r.map((x) => `${x.kind}/${x.tier}/${x.count}`).join() === "new/0/10,gold/1/20,rainbow/2/30,more/2/40,more/2/50" && r.every((x) => x.type === "gem" && x.index === 12 && x.added === BUNDLE && !x.usedFree) && p.coins === 1000 - 5 * PULL_COST + sum(r.flatMap((x) => x.achievements)));
  const q = new Progress(memoryStorage(), rng(3));
  q.state.coins = 0; q.state.freeCards = 1;
  check("a free card pulls without coins", q.canPull && q.pull().usedFree === true && q.freeCards === 0 && q.pull() === null && q.pull({ free: true }) === null);
  q.state.coins = 150; q.state.freeCards = 1;
  const free = q.pull({ free: true });
  check("pull({ free: true }) uses the free card first", free.usedFree && q.coins === 150 + sum(free.achievements) && q.freeCards === 0);
}

// 4) shape cards: 1/100, only still-locked shapes, none when all are unlocked
{
  const p = new Progress(memoryStorage(), rng(2024));
  p.state.coins = 1e9;
  let shapes = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) { const r = p.pull(); if (r.type === "shape") { shapes++; p.state.shapeCards = []; } }
  check("≈ 1 % of pulls are shape cards", Math.abs(shapes / N - 0.01) < 0.0025, `${shapes}/${N}`);
  const q = new Progress(memoryStorage(), () => 0.005);   // every pull rolls a shape card
  q.state.coins = 1e6; q.state.xp = 400;                     // Lv6: cat and bird still locked
  const got = [q.pull(), q.pull(), q.pull()];
  check("shape cards only give still-locked shapes, then gems", got[0].type === "shape" && got[1].type === "shape" && new Set([got[0].id, got[1].id]).size === 2 && [got[0].id, got[1].id].every((id) => id === "cat" || id === "bird") && got[2].type === "gem", got.map((x) => x.id || x.type).join());
  check("a shape card unlocks the shape right away", q.shapes().join() === "flower,pudding,cake,bear,cat,bird" && got[0].label.endsWith("모양"));
  const all = new Progress(memoryStorage(), () => 0.005);
  all.state.coins = 1e6; all.state.xp = 1080;               // Lv10: everything unlocked
  check("no shape cards once every shape is unlocked", Array.from({ length: 20 }, () => all.pull()).every((x) => x.type === "gem"));
}

// 5) level rewards: owned shape → 25 coins; gift boxes once per level
{
  const p = new Progress(memoryStorage(), rng(5));
  p.state.xp = 390; p.state.shapeCards = ["bear"];           // Lv5, bear from a shape card
  const before = p.coins;
  const f = p.feed({ stars: 1 });                            // +20 XP → Lv6
  const up = f.levelUps[0];
  const bear = up?.rewards.find((r) => r.id === "bear");
  check("reaching a shape owned via a shape card: '이미 있어요' + 25 coins", f.levelUps.length === 1 && up.level === 6 && bear.owned === true && bear.coins === OWNED_SHAPE_COINS && up.rewards.find((r) => r.id === "pearl")?.owned === undefined);
  check("each level-up opens a gift box, applied with the coins", !!up.gift && ["coins", "rare", "card"].includes(up.gift.kind) && p.coins - before === f.coinsTotal
    && f.coinsTotal === f.coins + OWNED_SHAPE_COINS + (up.gift.coins || 0) + sum(f.achievements), JSON.stringify(up.gift));
  const coins = p.coins, again = p.levelUpsSince(5);
  check("listing the same level-up again gives no second gift", again.length === 1 && again[0].gift === null && p.coins === coins);
  // the gift box itself
  const counts = { coins: 0, rare: 0, card: 0 }, r = rng(6), G = 20000;
  let coinRange = true, idx = true;
  for (let i = 0; i < G; i++) { const g = rollGift(r); counts[g.kind]++; if (g.kind === "coins" && !(g.coins >= 15 && g.coins <= 50)) coinRange = false; if (g.kind === "rare" && !(g.index >= 0 && g.index < 25)) idx = false; }
  check("gift box odds ≈ coins 50 % / rare bundle 35 % / free card 15 %", Math.abs(counts.coins / G - GIFT_ODDS.coins) < 0.015 && Math.abs(counts.rare / G - GIFT_ODDS.rare) < 0.015 && Math.abs(counts.card / G - GIFT_ODDS.card) < 0.012 && coinRange && idx, JSON.stringify(counts));
  const q = new Progress(memoryStorage(), seq([0.6, 0.0, 0.6, 0.05]));   // rare bundle of gem 0, then of gem 1
  q.state.rare[0] = 1; q.state.rareStock[0] = 3;
  const g1 = q.openGift(), g2 = q.openGift();
  check("a rare gift bundle adds 10 (owned: same tier; new: tier 0)", g1.kind === "rare" && g1.index === 0 && q.state.rare[0] === 1 && q.rareCountOf(0) === 13 && g2.index === 1 && g2.isNew && q.state.rare[1] === 0 && q.rareCountOf(1) === 10);
  const c = new Progress(memoryStorage(), seq([0.95]));
  check("a card gift adds a free card", c.openGift().kind === "card" && c.freeCards === 1);
}

// 6) combo streak, time bonus, golden / picky / memory
{
  const p = new Progress(memoryStorage(), rng(7));
  p.state.xp = 100000;   // far beyond the reward table: no level-ups in between
  p.state.rewardedLevel = p.level.level;
  const stars = [3, 3, 3, 2, 3, 1, 3, 3, 3, 3, 3, 4];
  const res = stars.map((s) => p.feed({ stars: s }));
  check("combo: ★3/★4 count up, ★2 keeps, ★1 breaks", res.map((r) => r.streak).join() === "1,2,3,3,4,0,1,2,3,4,5,6");
  check("combo multipliers ×1.2 (2) ×1.5 (3–4) ×2 (5+), ★2 / ★1 ×1", res.map((r) => r.comboMult).join() === "1,1.2,1.5,1,1.5,1,1,1.2,1.5,1.5,2,2"
    && res.map((r) => r.coins).join() === [30, 36, 45, 23, 45, 15, 30, 36, 45, 45, 60, 80].join() && p.state.bestStreak === 6, res.map((r) => r.coins).join());
  check("comboMultiplier / timeBonusFor helpers", comboMultiplier(1) === 1 && comboMultiplier(2) === 1.2 && comboMultiplier(4) === 1.5 && comboMultiplier(9) === 2 && timeBonusFor(30) === 0.5 && timeBonusFor(31) === 0.25 && timeBonusFor(60) === 0.25 && timeBonusFor(61) === 0 && timeBonusFor(Infinity) === 0);
  const t = (elapsed, kind = "normal", s = 3) => { p.state.streak = 0; return p.feed({ stars: s, order: order(kind), elapsed }); };
  const fast = t(20), mid = t(45), slow = t(90);
  check("time bonus: ≤30 s +50 %, ≤60 s +25 %, later none", fast.coins === 45 && mid.coins === 38 && slow.coins === 30 && fast.breakdown.time === 0.5 && slow.breakdown.time === 0, `${fast.coins}/${mid.coins}/${slow.coins}`);
  const cards = p.freeCards, gold = t(Infinity, "golden");
  check("golden order: coins ×3 and a free card", gold.coins === 90 && gold.breakdown.kind === 3 && gold.freeCardsGained === 1 && p.freeCards === cards + 1);
  const gold2 = t(Infinity, "golden", 2);
  check("a golden order not met (★2) pays ×3 but no free card", gold2.coins === 69 && gold2.freeCardsGained === 0);
  check("picky day: coins ×2", t(Infinity, "picky").coins === 60);
  check("everything multiplies: (base + rare) × combo × kind × time", (() => { p.state.streak = 4; const r = p.feed({ stars: 4, order: order("golden"), jelly: jellyOf({ rareCount: 2 }), elapsed: 10 }); return r.coins === Math.round((40 + 10) * 2 * 3 * 1.5) && r.breakdown.rare === 10; })());
  // memory: peeking costs 5 coins
  const m = new Progress(memoryStorage(), rng(8));
  m.setOrder({ ...order("memory"), id: 99 });
  m.state.coins = 7;
  check("memory peek costs 5 coins, refused when short", m.memoryPeek() === true && m.coins === 7 - MEMORY_PEEK_COST && m.memoryPeek() === false && m.coins === 2);
  m.setOrder({ ...order("normal"), id: 100 });
  check("peeking a normal order is free", m.memoryPeek() === true && m.coins === 2);
  m.setOrder({ ...order("memory"), id: 101 });
  m.state.coins = 50; m.memoryPeek();
  const peeked = m.feed({ stars: 3, order: m.order, jelly: jellyOf() });
  m.setOrder({ ...order("memory"), id: 102 });
  const clean = m.feed({ stars: 3, order: m.order, jelly: jellyOf() });
  check("memory ★3 badge only without re-peeking", !peeked.achievements.some((a) => a.id === "memory_star3") && clean.achievements.some((a) => a.id === "memory_star3"));
}

// 7) colour book: discoveries and milestones
{
  const p = new Progress(memoryStorage(), rng(9));
  p.state.xp = 100000; p.state.rewardedLevel = p.level.level;
  const results = COLOR_NAMES.map((c) => p.feed({ stars: 2, jelly: jellyOf({ sigma: mixSigma(c.base, c.drops) }) }));
  check("each new colour name is a discovery ('새 색 발견!')", results.every((r, i) => r.newColor === COLOR_NAMES[i].name) && p.feed({ stars: 2, jelly: jellyOf({ sigma: mixSigma("clear", { pink: 2 }) }) }).newColor === null);
  const at = (n) => results[n - 1].colorRewards;
  check("10 colours: +25 coins", at(10).length === 1 && at(10)[0].coins === 25 && results.slice(0, 9).every((r) => !r.colorRewards.length));
  check("20 colours: rainbow theme + 25 coins", at(20)[0].theme === "rainbow" && at(20)[0].coins === 25 && p.themes().includes("rainbow"));
  check("30 colours: a free card", at(30)[0].freeCards === 1 && results[29].freeCardsGained >= 1);
  const last = results[results.length - 1];
  check("all colours: title '색의 마법사' + 50 coins", last.colorRewards.some((r) => r.title === "색의 마법사" && r.coins === 50) && p.titles().some((t) => t.label === "색의 마법사"));
  check("colour book badges", results[9].achievements.some((a) => a.id === "book_10") && last.achievements.some((a) => a.id === "book_all"));
  const list = p.colorBookList();
  check("colorBookList: name, hex, family, found", list.length === COLOR_NAMES.length && list.every((c) => c.found && /^#[0-9a-f]{6}$/.test(c.hex) && c.family));
  check("milestones are claimed once", p.feed({ stars: 2, jelly: jellyOf() }).colorRewards.length === 0 && COLOR_BOOK_REWARDS.every((r) => p.state.colorRewards.includes(r.id)));
}

// 8) secret recipes: each reachable with a jelly the game can make
{
  const c = (drops, base = "clear") => mixSigma(base, drops);
  const jellies = {
    rainbow_cat: jellyOf({ sigma: c({ pink: 2 }), shape: "cat", rare: [{ index: 5, tier: 2 }], rareCount: 1 }),
    starry_night: jellyOf({ sigma: c({ blue: 4, glow: 1 }), additives: { glitter: 0, stars: 9 }, fx: [0, 0.48] }),
    strawberry_cake: jellyOf({ sigma: c({ pink: 2 }), shape: "cake", gems: [GEM_HEART, GEM_HEART, 4] }),
    honey_bear: jellyOf({ sigma: c({}, "honey"), shape: "bear" }),
    pearl_pudding: jellyOf({ sigma: c({ pearl: 1 }, "berry"), shape: "pudding", fx: [0.48, 0] }),
    sky_chick: jellyOf({ sigma: c({ sky: 3 }), shape: "bird" }),
    clear_drop: jellyOf({ sigma: c({}), gems: [GEM_DROPLET, GEM_DROPLET, GEM_DROPLET] }),
    gem_bomb: jellyOf({ texture: "slime", gems: Array(16).fill(1), rare: Array(4).fill({ index: 0, tier: 0 }), rareCount: 4 }),
  };
  const misses = {
    rainbow_cat: { rare: [{ index: 5, tier: 1 }] }, starry_night: { fx: [0, 0.1] }, strawberry_cake: { gems: [GEM_HEART] },
    honey_bear: { sigma: c({ blue: 4 }) }, pearl_pudding: { fx: [0.1, 0] }, sky_chick: { shape: "cat" },
    clear_drop: { sigma: c({ pink: 4 }) }, gem_bomb: { texture: "jelly" },
  };
  const solo = (j) => { const n = nameColor(j.sigma); return findSecret(j, n, familyOf(n)); };
  check("8 secret recipes with label and hint", SECRET_RECIPES.length === 8 && SECRET_RECIPES.every((s) => s.label && s.hint && jellies[s.id]));
  for (const s of SECRET_RECIPES) {
    const hit = solo(jellies[s.id]), miss = solo({ ...jellies[s.id], ...misses[s.id] });
    check(`secret "${s.label}" is found by its recipe, not by a near miss`, hit?.id === s.id && miss?.id !== s.id, `${nameColor(jellies[s.id].sigma)} / ${familyOf(nameColor(jellies[s.id].sigma))}`);
  }
  const p = new Progress(memoryStorage(), rng(10));
  p.state.xp = 100000; p.state.rewardedLevel = p.level.level;
  const found = SECRET_RECIPES.map((s) => p.feed({ stars: 2, jelly: jellies[s.id] }));
  check("feeding a secret: discovery + 25 coins, once each", found.every((r, i) => r.secret?.id === SECRET_RECIPES[i].id && r.secret.coins === 25) && p.feed({ stars: 2, jelly: jellies.honey_bear }).secret === null && p.secretList().every((s) => s.found && s.hint));
  check("first secret → flower band outfit; all 8 → '레시피 탐정'", found[0].achievements.some((a) => a.id === "secret_first" && a.unlock?.outfit === "flowerband") && p.outfits().includes("flowerband")
    && found[7].achievements.some((a) => a.id === "secret_all" && a.title === "레시피 탐정"));
  // the ingredients really behave like that in the jelly world (flower; one drop each)
  const w = new JellyWorld({ base: "clear" });
  for (let t = 0; t < 0.3; t += 1 / 60) w.advance(1 / 60);
  const top = () => [w.body.center[0], w.body.bounds[4], w.body.center[2]];
  for (const id of ["pearl", "glow"]) w.handle({ type: "drop", point: top(), paint: PAINTS.findIndex((x) => x.id === id) });
  w.addAdditive({ kind: "stars", point: top() });
  w.addAdditive({ kind: "glitter", point: top() });
  w.updateMeanDye();
  const fx = w.meanFx || [NaN, NaN];
  check("one pearl / glow drop gives fx ≥ 0.2; one topping drop meets an order's minimum", fx[0] >= 0.2 && fx[1] >= 0.2 && w.additives.stars.length >= ORDER_ADDITIVE_MIN.stars && w.additives.glitter.length >= ORDER_ADDITIVE_MIN.glitter,
    `fx ${fx.map((v) => v.toFixed(2)).join("/")}, stars ${w.additives.stars.length}, glitter ${w.additives.glitter.length}`);
}

// 9) achievements: ~30, stable ids, fire once
{
  check("~30 achievements, unique ids, coins 10–50 (halved scale)", ACHIEVEMENTS.length >= 28 && ACHIEVEMENTS.length <= 32 && new Set(ACHIEVEMENTS.map((a) => a.id)).size === ACHIEVEMENTS.length && ACHIEVEMENTS.every((a) => a.label && a.desc && a.coins >= 10 && a.coins <= 50));
  const p = new Progress(memoryStorage(), rng(11));
  const f1 = p.feed({ stars: 3, jelly: jellyOf() }), f2 = p.feed({ stars: 3, jelly: jellyOf() });
  check("first feed / first ★3 fire once", ["first_feed", "first_star3"].every((id) => f1.achievements.some((a) => a.id === id)) && !f2.achievements.some((a) => a.id === "first_feed" || a.id === "first_star3"));
  const sp = [p.spit(), p.spit(), p.spit(), p.spit()].map((r) => r.achievements.map((a) => a.id));
  check("spat on 3× → '퉤 전문가' (once), spit resets the combo", sp[2].includes("spit_3") && !sp[3].includes("spit_3") && !sp[0].length && p.streak === 0);
  const ki = [p.kick(), p.kick(), p.kick()];
  check("kicked 3× → '축구공 젤리'", ki[2].achievements.some((a) => a.id === "kick_3" && a.title === "축구공 젤리") && p.state.stats.kicks === 3);
  const c3 = [p.feed({ stars: 3 }), p.feed({ stars: 3 }), p.feed({ stars: 3 })];
  check("combo 3 badge", c3.some((r) => r.achievements.some((a) => a.id === "combo_3")));
  const shapes = ["pudding", "cake", "bear", "cat", "bird"].map((shape) => p.feed({ stars: 2, jelly: jellyOf({ shape }) }));
  check("fed 3 / all 6 shapes", shapes[1].achievements.some((a) => a.id === "shapes_3") && shapes[4].achievements.some((a) => a.id === "shapes_6"));
  const big = p.feed({ stars: 4, jelly: jellyOf({ gems: Array(16).fill(2), rare: Array(8).fill({ index: 1, tier: 0 }), rareCount: 8 }) });
  check("24 gems / 8 rare gems at once (→ star cape)", big.achievements.some((a) => a.id === "gems_24") && big.achievements.some((a) => a.id === "rare_8" && a.unlock?.outfit === "cape") && p.outfits().includes("cape") && big.achievements.some((a) => a.id === "first_star4"));
  const fast = p.feed({ stars: 3, jelly: jellyOf({ texture: "slime" }), elapsed: 12 });
  check("★3 within 30 s, slime ★3", fast.achievements.some((a) => a.id === "speedy") && fast.achievements.some((a) => a.id === "slime_star3"));
  p.state.streak = 0;
  const gold = Array.from({ length: 5 }, () => p.feed({ stars: 3, order: order("golden") }));
  check("golden ★3 first / ×5 ('황금 손')", gold[0].achievements.some((a) => a.id === "golden_first") && gold[4].achievements.some((a) => a.id === "golden_5" && a.title === "황금 손"));
  check("picky ★3", p.feed({ stars: 3, order: order("picky") }).achievements.some((a) => a.id === "picky_star3"));
  const q = new Progress(memoryStorage(), () => 0.98);   // gem #24, the last one missing
  q.state.coins = 1e6;
  for (let i = 0; i < 25; i++) q.state.rare[i] = i < 24 ? (i < 5 ? 2 : 0) : -1;
  const pulled = q.pull();
  check("rare collection badges: all 25 ('보석 수집가'), 5 rainbow", pulled.achievements.some((a) => a.id === "rare_25" && a.title === "보석 수집가") && pulled.achievements.some((a) => a.id === "rare_10") && pulled.achievements.some((a) => a.id === "rainbow_5"));
  q.state.xp = 1080;
  check("level 10 badge", q.feed({ stars: 2 }).achievements.some((a) => a.id === "level_10"));
  const done = p.achievementList();
  check("achievementList: all, with done flags", done.length === ACHIEVEMENTS.length && done.filter((a) => a.done).length === Object.keys(p.state.achievements).length && done.every((a) => "title" in a && "coins" in a));
}

// 10) outfits, themes, titles
{
  const p = new Progress(memoryStorage(), rng(12));
  check("fresh: no outfits, the basic theme, no titles", p.outfits().length === 0 && p.themes().join() === "basic" && p.titles().length === 0);
  p.state.xp = 540;   // Lv7
  check("outfits / themes by level", p.outfits().join() === "ribbon,glasses,scarf" && p.themes().join() === "basic,flower,starry");
  check("setOutfit: unlocked items on their own slot only", p.setOutfit("head", "ribbon") && !p.setOutfit("head", "glasses") && !p.setOutfit("head", "crown") && !p.setOutfit("back", "cape") && p.setOutfit("face", "glasses") && p.outfit.head === "ribbon" && p.outfit.face === "glasses" && p.setOutfit("head", null) && p.outfit.head === null);
  p.state.xp = 1480;   // Lv12
  check("all level outfits by Lv12, strawberry theme by Lv10 (+ rainbow: all 6 shapes by then)", ["ribbon", "glasses", "scarf", "crown", "wings"].every((id) => p.outfits().includes(id)) && p.themes().join() === "basic,flower,starry,strawberry,rainbow");
  const cards = new Progress(memoryStorage());
  const noRainbow = !cards.themes().includes("rainbow");
  cards.state.shapeCards = ["pudding", "cake", "bear", "cat", "bird"];
  check("rainbow theme once all 6 shapes are unlocked (also via shape cards)", noRainbow && cards.shapes().length === 6 && cards.themes().join() === "basic,rainbow");
  check("5 themes: basic, flower (Lv4), starry (Lv7), strawberry (Lv10), rainbow", THEMES.map((t) => `${t.id}${t.level || ""}`).join() === "basic,flower4,starry7,strawberry10,rainbow" && THEMES.every((t) => t.label));
  check("outfit data matches the bunny's slots", OUTFITS.length === 7 && OUTFITS.every((o) => ["head", "face", "neck", "back"].includes(o.slot) && o.emoji && (o.level || o.achievement)));
  check("setTitle: only earned titles", !p.setTitle("golden_5") && p.title === null);
  for (let i = 0; i < 3; i++) p.spit();
  check("wearing an earned title", p.setTitle("spit_3") && p.title.label === "퉤 전문가" && p.setTitle(null) && p.title === null);
  const r = new Progress(p.storage);
  check("outfits / titles are saved", r.outfit.face === "glasses");
}

// 11) everything together: one full feed result
{
  const p = new Progress(memoryStorage(), rng(13));
  const o = p.newOrder();
  const j = jellyOf({ sigma: o.sigma.slice(), shape: o.shape || "flower" });
  const r = p.feed({ stars: 3, order: o, result: { stars: 3 }, jelly: j, card: { id: 1 }, elapsed: 12, peeks: 0 });
  const keys = ["coins", "xp", "levelUps", "breakdown", "streak", "comboMult", "freeCardsGained", "newColor", "colorRewards", "achievements", "secret", "coinsTotal"];
  check("feed returns the full result", keys.every((k) => k in r) && ["base", "rare", "combo", "kind", "time"].every((k) => k in r.breakdown) && r.coins === Math.round(COINS_BY_STARS[3] * 1.5) && r.newColor === o.name && r.xp === 40);
  check("LEVEL_REWARDS stay frozen data", Object.isFrozen(LEVEL_REWARDS) && Object.isFrozen(LEVEL_REWARDS[3]));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL FUN CHECKS PASSED");
process.exit(failures ? 1 : 0);
