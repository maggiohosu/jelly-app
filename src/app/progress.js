// Player progress: gold coins, the bunny's friendship level and its rewards,
// the rare-gem collection (glitter → gold → rainbow upgrades) and its stock
// (rare gems are consumable: a card gives a bundle of 10), shape cards, the
// album of eaten works, the current order and the v8 fun systems (combo
// streak, golden / memory / picky orders, time bonus, achievements, colour
// book, secret recipes, gift boxes, outfits, titles, themes — data in
// app/fun.js). Saved on the phone only (localStorage). Pure logic + storage;
// no DOM besides localStorage. Node-testable with a fake storage.
//
// The save format stays version 1: v8 fields are added on load (old saves:
// every owned rare gem gets a stock of 10, old-format orders are dropped,
// the colour book is seeded from the album, no retroactive gift boxes).
import { makeOrder, nameColor, familyOf, colorInfo, COLOR_NAMES, ORDER_KINDS } from "./orders.js";
import {
  OUTFITS, OUTFIT_SLOTS, THEMES, SECRET_RECIPES, COLOR_BOOK_REWARDS, ACHIEVEMENTS, SECRET_COINS,
  earnedAchievements, achievementView, findSecret, colorBookRewardsDue, rollGift, themeUnlocked,
} from "./fun.js";

export const PROGRESS_KEY = "mallang-jelly-progress-v1";
export const WELCOME_COINS = 100;
export const PULL_COST = 100;
export const COINS_BY_STARS = Object.freeze([0, 15, 23, 30, 40]);   // ★4 = 'special' (rare gem bonus on a ★3 work)
export const SPIT_COINS = Object.freeze([1, 50]);     // 퉤: coins taken away (never below 0)
export const KICK_COINS = Object.freeze([1, 50]);     // kicked off the tray: the same
export const RARE_BONUS = 5;                  // per rare gem in the eaten jelly …
export const RARE_BONUS_MAX = 8;              // … counting at most 8
export const RARE_COUNT = 25;
export const BUNDLE = 10;                     // rare gems per card / gift bundle
export const SHAPE_CARD_CHANCE = 0.01;        // a pull is a (still locked) shape card
export const OWNED_SHAPE_COINS = 25;          // a level's shape reward already owned via a shape card
export const MEMORY_PEEK_COST = 5;
export const RECENT_NAMES = 5;                // colour names an order may not repeat
export const TIER_LABELS = Object.freeze(["글리터", "금빛", "무지개빛"]);
// Order kinds: the level they start at and their band of one roll. Golden can
// never follow golden, so its band is 1/7 → 1 in 8 orders overall.
export const KIND_LEVEL = Object.freeze({ golden: 3, memory: 4, picky: 5 });
export const KIND_ODDS = Object.freeze({ golden: 1 / 7, memory: 1 / 5, picky: 1 / 10 });
export const KIND_COINS = Object.freeze({ normal: 1, memory: 1, golden: 3, picky: 2 });
const ALBUM_MAX = 60;

/** Coin multiplier of a ★3/★4 feed by the streak after counting it. */
export const comboMultiplier = (streak) => (streak >= 5 ? 2 : streak >= 3 ? 1.5 : streak >= 2 ? 1.2 : 1);
/** Extra coins (fraction) for feeding within 30 s / 60 s of the order. */
export const timeBonusFor = (seconds) => (seconds <= 30 ? 0.5 : seconds <= 60 ? 0.25 : 0);

// Friendship: XP per meal = 10 + 10 per star. Cumulative XP to reach each level
// (beyond the table: +200 per level).
export const LEVEL_XP = Object.freeze([0, 0, 40, 100, 180, 280, 400, 540, 700, 880, 1080]);
const PLAIN_REWARDS = {
  2: [{ kind: "paint", id: "orange", label: "주황 물감" }, { kind: "shape", id: "pudding", label: "푸딩 모양" }],
  3: [{ kind: "additive", id: "glitter", label: "글리터" }],
  4: [{ kind: "paint", id: "lime", label: "연두 물감" }, { kind: "shape", id: "cake", label: "케이크 모양" }],
  5: [{ kind: "additive", id: "stars", label: "별사탕 토핑" }],
  6: [{ kind: "paint", id: "pearl", label: "금펄 물감" }, { kind: "shape", id: "bear", label: "곰젤리 모양" }],
  8: [{ kind: "paint", id: "glow", label: "야광 물감" }, { kind: "shape", id: "cat", label: "고양이 모양" }],
  10: [{ kind: "shape", id: "bird", label: "새 모양" }],
};
// + the bunny's outfits (Lv3/5/7/9/12) and the plate themes (Lv4/7/10)
export const LEVEL_REWARDS = (() => {
  const out = {};
  const add = (level, r) => { (out[level] ||= []).push(Object.freeze(r)); };
  for (const [l, list] of Object.entries(PLAIN_REWARDS)) for (const r of list) add(l, r);
  for (const o of OUTFITS) if (o.level) add(o.level, { kind: "outfit", id: o.id, label: o.label });
  for (const t of THEMES) if (t.level) add(t.level, { kind: "theme", id: t.id, label: t.label });
  for (const l of Object.keys(out)) Object.freeze(out[l]);
  return Object.freeze(out);
})();
const SHAPE_REWARDS = Object.entries(LEVEL_REWARDS).flatMap(([l, list]) => list.filter((r) => r.kind === "shape").map((r) => ({ ...r, level: Number(l) })));
const SHAPE_IDS = ["flower", ...SHAPE_REWARDS.map((r) => r.id)];
const unlocked = (level, kind) => Object.entries(LEVEL_REWARDS).filter(([l]) => level >= Number(l)).flatMap(([, list]) => list.filter((r) => r.kind === kind).map((r) => r.id));
export const BASE_PAINTS = Object.freeze(["red", "yellow", "blue", "pink", "purple", "sky", "water"]);
const COLOR_HEX = new Map(COLOR_NAMES.map((c) => [c.name, colorInfo(c.name).hex]));

export function levelForXp(xp) {
  let level = 1;
  for (let l = 2; ; l++) {
    const need = levelStart(l);
    if (xp < need) return { level, xp, from: levelStart(level), to: need };
    level = l;
  }
}
function levelStart(level) {
  return level < LEVEL_XP.length ? LEVEL_XP[level] : LEVEL_XP[LEVEL_XP.length - 1] + (level - LEVEL_XP.length + 1) * 200;
}

const freshStats = () => ({
  star3: 0, star4: 0, spits: 0, kicks: 0, shapesFed: [], goldenStar3: 0, memoryStar3: 0, pickyStar3: 0,
  fastStar3: 0, slimeStar3: 0, maxGems: 0, maxRare: 0, gifts: 0,
});
const emptyOutfit = () => ({ head: null, face: null, neck: null, back: null });

export function freshProgress() {
  return {
    version: 1, coins: WELCOME_COINS, xp: 0,
    rare: new Array(RARE_COUNT).fill(-1), rareStock: new Array(RARE_COUNT).fill(0), shapeCards: [],
    album: [], order: null, feeds: 0, pulls: 0, seenLevel: 1, rewardedLevel: 1,
    streak: 0, bestStreak: 0, freeCards: 0, recentNames: [], orderSerial: 0, lastKind: "normal", peeks: 0,
    stats: freshStats(), achievements: {}, colorBook: [], colorRewards: [], secrets: [], outfit: emptyOutfit(), title: null,
  };
}

const count = (v, fallback = 0) => (Number.isFinite(v) ? Math.max(0, Math.floor(v)) : fallback);
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

/** A saved v1 state (v7 or v8) → a complete v8 state (additive migration). */
function migrate(saved) {
  const s = { ...freshProgress(), ...saved };
  s.coins = count(saved.coins, WELCOME_COINS);
  s.xp = count(saved.xp);
  const rare = Array.isArray(saved.rare) ? saved.rare : [];
  s.rare = Array.from({ length: RARE_COUNT }, (_, i) => (Number.isInteger(rare[i]) ? Math.max(-1, Math.min(2, rare[i])) : -1));
  // v7 saves have no stock: every owned rare gem starts with one bundle
  const stock = Array.isArray(saved.rareStock) ? saved.rareStock : null;
  s.rareStock = s.rare.map((tier, i) => (tier < 0 ? 0 : stock ? count(stock[i]) : BUNDLE));
  s.shapeCards = (Array.isArray(saved.shapeCards) ? saved.shapeCards : []).filter((id, i, a) => SHAPE_IDS.includes(id) && id !== "flower" && a.indexOf(id) === i);
  if (!Array.isArray(s.album)) s.album = [];
  s.order = saved.order && saved.order.version === 2 ? saved.order : null;
  for (const key of ["feeds", "pulls", "streak", "bestStreak", "freeCards", "orderSerial", "peeks"]) s[key] = count(saved[key]);
  s.seenLevel = count(saved.seenLevel, 1) || 1;
  s.recentNames = (Array.isArray(saved.recentNames) ? saved.recentNames : []).filter((n) => typeof n === "string").slice(-RECENT_NAMES);
  s.lastKind = ORDER_KINDS.includes(saved.lastKind) ? saved.lastKind : "normal";
  const stats = isObj(saved.stats) ? saved.stats : {};
  s.stats = freshStats();
  for (const key of Object.keys(s.stats)) if (key !== "shapesFed") s.stats[key] = count(stats[key]);
  s.stats.shapesFed = (Array.isArray(stats.shapesFed) ? stats.shapesFed : []).filter((id, i, a) => SHAPE_IDS.includes(id) && a.indexOf(id) === i);
  const done = isObj(saved.achievements) ? saved.achievements : {};
  s.achievements = Object.fromEntries(ACHIEVEMENTS.filter((a) => done[a.id]).map((a) => [a.id, true]));
  // the colour book: v7 saves start from the names on their album cards
  const book = Array.isArray(saved.colorBook) ? saved.colorBook : s.album.map((c) => c && c.name);
  s.colorBook = book.filter((n, i, a) => COLOR_HEX.has(n) && a.indexOf(n) === i);
  s.colorRewards = (Array.isArray(saved.colorRewards) ? saved.colorRewards : []).filter((id) => COLOR_BOOK_REWARDS.some((r) => r.id === id));
  s.secrets = (Array.isArray(saved.secrets) ? saved.secrets : []).filter((id, i, a) => SECRET_RECIPES.some((r) => r.id === id) && a.indexOf(id) === i);
  const outfit = isObj(saved.outfit) ? saved.outfit : {};
  s.outfit = emptyOutfit();
  for (const slot of OUTFIT_SLOTS) if (OUTFITS.some((o) => o.id === outfit[slot] && o.slot === slot)) s.outfit[slot] = outfit[slot];
  s.title = typeof saved.title === "string" ? saved.title : null;
  // v7 saves already got their level rewards: no retroactive gift boxes
  s.rewardedLevel = Number.isInteger(saved.rewardedLevel) ? saved.rewardedLevel : levelForXp(s.xp).level;
  return s;
}

export class Progress {
  constructor(storage = globalThis.localStorage, random = Math.random) {
    this.storage = storage;
    this.random = random;
    this.state = freshProgress();
    this.listeners = [];
    try {
      const saved = JSON.parse(storage?.getItem(PROGRESS_KEY) || "null");
      if (saved && saved.version === 1) this.state = migrate(saved);
    } catch { /* corrupted / private mode: start fresh */ }
  }

  onChange(fn) { this.listeners.push(fn); }
  emit() { for (const fn of this.listeners) fn(this); }

  save() {
    if (!this.storage) return;
    // Keep under the storage quota: drop the oldest album cards if needed.
    for (;;) {
      try { this.storage.setItem(PROGRESS_KEY, JSON.stringify(this.state)); return; }
      catch {
        if (!this.state.album.length) return;
        this.state.album.shift();
      }
    }
  }
  commit() { this.save(); this.emit(); }

  get coins() { return this.state.coins; }
  get level() { return levelForXp(this.state.xp); }
  get freeCards() { return this.state.freeCards; }
  get streak() { return this.state.streak; }
  /** A pull is possible with coins or with a free card. */
  get canPull() { return this.state.coins >= PULL_COST || this.state.freeCards > 0; }

  // ------------------------------------------------------------ unlocks
  /** Paint ids the player can use (base + unlocked by friendship). */
  paints() { return [...BASE_PAINTS, ...unlocked(this.level.level, "paint")]; }
  additives() { return unlocked(this.level.level, "additive"); }
  /** Unlocked shape ids (flower + by level + by shape card), in SHAPES order. */
  shapes() {
    const byLevel = unlocked(this.level.level, "shape");
    return SHAPE_IDS.filter((id) => id === "flower" || byLevel.includes(id) || this.state.shapeCards.includes(id));
  }
  lockedShapes() {
    const have = this.shapes();
    return SHAPE_REWARDS.filter((r) => !have.includes(r.id));
  }
  /** Unlocked outfit ids (by level or by achievement). */
  outfits() {
    const level = this.level.level;
    return OUTFITS.filter((o) => (o.level ? level >= o.level : !!this.state.achievements[o.achievement])).map((o) => o.id);
  }
  /** Unlocked plate / background theme ids. */
  themes() {
    const c = { level: this.level.level, colorBook: this.state.colorBook.length, shapes: this.shapes().length };
    return THEMES.filter((t) => themeUnlocked(t, c)).map((t) => t.id);
  }
  /** Titles the player can wear: [{id, label}] (from achievements and the colour book). */
  titles() {
    const out = ACHIEVEMENTS.filter((a) => a.title && this.state.achievements[a.id]).map((a) => ({ id: a.id, label: a.title }));
    for (const r of COLOR_BOOK_REWARDS) if (r.title && this.state.colorRewards.includes(r.id)) out.push({ id: r.id, label: r.title });
    return out;
  }

  // ------------------------------------------------------------ rare gems
  /** Owned rare gems in index order: [{index, tier, count}]. */
  ownedRare() { return this.state.rare.map((tier, index) => ({ index, tier, count: this.state.rareStock[index] })).filter((r) => r.tier >= 0); }
  /** Owned rare gems for the drawer: most left first (ties by index), empty ones last. */
  rareStock() { return this.ownedRare().sort((a, b) => (b.count - a.count) || (a.index - b.index)); }
  rareCountOf(index) { return this.state.rare[index] >= 0 ? this.state.rareStock[index] || 0 : 0; }
  /** One rare gem placed in the jelly: false (nothing used) when none is left. */
  useRare(index) {
    if (!(this.rareCountOf(index) > 0)) return false;
    this.state.rareStock[index]--;
    this.commit();
    return true;
  }
  /** Rare gems back to the stock (a jelly replaced without being fed): [{index}] or [index]. */
  refundRare(list = []) {
    let n = 0;
    for (const item of list) {
      const index = typeof item === "number" ? item : item?.index;
      if (!Number.isInteger(index) || !(this.state.rare[index] >= 0)) continue;
      this.state.rareStock[index]++; n++;
    }
    if (n) this.commit();
    return n;
  }
  // +BUNDLE of one rare gem; `upgrade` (card pulls) raises an owned gem's tier.
  addBundle(index, upgrade = true) {
    const st = this.state, had = st.rare[index];
    const tier = had < 0 ? 0 : upgrade ? Math.min(2, had + 1) : had;
    const kind = had < 0 ? "new" : !upgrade || had === 2 ? "more" : had === 0 ? "gold" : "rainbow";
    st.rare[index] = tier;
    st.rareStock[index] += BUNDLE;
    return { index, tier, kind, added: BUNDLE, count: st.rareStock[index] };
  }

  // ------------------------------------------------------------ orders
  /**
   * A new order for the current level (kind scheduling: golden Lv3+ ~1/8 and
   * never twice in a row, memory Lv4+ ~1/5, picky Lv5+ ~1/10, exclusive).
   * Stored as the current order; its colour name joins the recent names.
   * (A `currentShape` argument is accepted and ignored: plain orders do not
   * depend on the jelly's current shape.)
   */
  newOrder({ shapeBase = null, random = this.random } = {}) {
    const st = this.state, level = this.level.level, r = random();
    let kind = "normal";
    if (r < KIND_ODDS.golden) { if (level >= KIND_LEVEL.golden && st.lastKind !== "golden") kind = "golden"; }
    else if (r < KIND_ODDS.golden + KIND_ODDS.memory) { if (level >= KIND_LEVEL.memory) kind = "memory"; }
    else if (r < KIND_ODDS.golden + KIND_ODDS.memory + KIND_ODDS.picky) { if (level >= KIND_LEVEL.picky) kind = "picky"; }
    const order = makeOrder({
      paints: this.paints(), additives: this.additives(), level, shapes: this.shapes(), ...(shapeBase ? { shapeBase } : {}),
      random, id: st.orderSerial + 1, recentNames: st.recentNames, kind,
    });
    st.orderSerial++;
    this.storeOrder(order);
    this.commit();
    return order;
  }
  storeOrder(order) {
    const st = this.state;
    if (order && order.version === 2 && st.order?.id !== order.id) {
      st.recentNames = [...st.recentNames, order.name].slice(-RECENT_NAMES);
      st.lastKind = order.kind || "normal";
      st.peeks = 0;
    }
    st.order = order;
  }
  setOrder(order) { this.storeOrder(order); this.commit(); }
  /** The current order (null for none or an old-format order). */
  get order() { const o = this.state.order; return o && o.version === 2 ? o : null; }
  /** Re-show a hidden memory order for 5 s: −5 coins (false: not enough coins). */
  memoryPeek() {
    if (this.order?.kind !== "memory") return true;
    if (this.state.coins < MEMORY_PEEK_COST) return false;
    this.state.coins -= MEMORY_PEEK_COST;
    this.state.peeks++;
    this.commit();
    return true;
  }

  // ------------------------------------------------------------ the bunny eats
  randInt([lo, hi]) { return lo + Math.floor(this.random() * (hi - lo + 1)); }

  /**
   * The bunny ate a jelly. stars = final stars 1..4 (scoreOrder), order = the
   * order it was made for, jelly = the fed jelly descriptor, elapsed = seconds
   * of visible app time since the order appeared, peeks = memory re-peeks.
   * Applies coins (combo × kind × time bonus), XP, album card, golden free
   * card, colour book (+ milestones), secret recipe, level-ups (+ gift boxes)
   * and achievements; saves once.
   * → { coins, xp, levelUps, breakdown: {base, rare, combo, kind, time},
   *     streak, comboMult, freeCardsGained, newColor, colorRewards,
   *     achievements, secret, coinsTotal }
   * breakdown: base / rare = coins before multipliers, combo / kind =
   * multipliers, time = bonus fraction (0.5 / 0.25 / 0).
   */
  feed({ stars, order = this.order, result = null, jelly = null, card = null, elapsed = Infinity, peeks = 0, rareCount = 0 } = {}) {
    const st = this.state, stats = st.stats, before = this.level.level;
    const s = Math.max(1, Math.min(4, Math.round(stars ?? result?.stars ?? 1)));
    const kind = order?.kind || "normal";
    const rares = jelly ? (jelly.rareCount ?? jelly.rare?.length ?? 0) : rareCount;
    // combo streak: ★3/★4 count up, ★2 keeps it, ★1 breaks it
    if (s >= 3) st.streak++;
    else if (s === 1) st.streak = 0;
    st.bestStreak = Math.max(st.bestStreak, st.streak);
    const comboMult = s >= 3 ? comboMultiplier(st.streak) : 1;
    const kindMult = KIND_COINS[kind] || 1;
    const time = timeBonusFor(elapsed);
    const breakdown = { base: COINS_BY_STARS[s], rare: RARE_BONUS * Math.min(RARE_BONUS_MAX, rares), combo: comboMult, kind: kindMult, time };
    const coins = Math.round((breakdown.base + breakdown.rare) * comboMult * kindMult * (1 + time));
    const xp = 10 + 10 * s;
    st.coins += coins;
    st.xp += xp;
    st.feeds++;
    let coinsTotal = coins, freeCardsGained = 0;
    if (card) {
      st.album.push(card);
      while (st.album.length > ALBUM_MAX) st.album.shift();
    }
    // a fulfilled golden order also gives a free card
    if (kind === "golden" && s >= 3) { st.freeCards++; freeCardsGained++; }
    // stats for the achievements
    if (s >= 3) {
      stats.star3++;
      if (s === 4) stats.star4++;
      if (kind === "golden") stats.goldenStar3++;
      if (kind === "memory" && Math.max(peeks, st.peeks) === 0) stats.memoryStar3++;
      if (kind === "picky") stats.pickyStar3++;
      if (elapsed <= 30) stats.fastStar3++;
      if (jelly?.texture === "slime") stats.slimeStar3++;
    }
    let name = null, family = null, newColor = null;
    if (jelly) {
      const shape = jelly.shape || "flower";
      if (!stats.shapesFed.includes(shape)) stats.shapesFed.push(shape);
      stats.maxGems = Math.max(stats.maxGems, (jelly.gems?.length || 0) + rares);
      stats.maxRare = Math.max(stats.maxRare, rares);
      if (jelly.sigma) {
        name = nameColor(jelly.sigma);
        family = familyOf(name);
        if (!st.colorBook.includes(name)) { st.colorBook.push(name); newColor = name; }
      }
    }
    // colour book milestones
    const colorRewards = [];
    for (const r of colorBookRewardsDue(st.colorBook.length, st.colorRewards)) {
      st.colorRewards.push(r.id);
      if (r.coins) { st.coins += r.coins; coinsTotal += r.coins; }
      if (r.freeCards) { st.freeCards += r.freeCards; freeCardsGained += r.freeCards; }
      colorRewards.push({ id: r.id, at: r.at, ...(r.coins ? { coins: r.coins } : {}), ...(r.freeCards ? { freeCards: r.freeCards } : {}), ...(r.theme ? { theme: r.theme } : {}), ...(r.title ? { title: r.title } : {}) });
    }
    // a secret recipe (one discovery per meal)
    let secret = null;
    const found = findSecret(jelly, name, family, st.secrets);
    if (found) {
      st.secrets.push(found.id);
      st.coins += SECRET_COINS; coinsTotal += SECRET_COINS;
      secret = { id: found.id, label: found.label, emoji: found.emoji, coins: SECRET_COINS };
    }
    // level-ups open their gift boxes right away
    const ups = this.applyLevelUps(before);
    coinsTotal += ups.coins; freeCardsGained += ups.cards;
    const achievements = this.awardAchievements();
    coinsTotal += achievements.reduce((a, x) => a + x.coins, 0);
    this.commit();
    return { coins, xp, levelUps: ups.list, breakdown, streak: st.streak, comboMult, freeCardsGained, newColor, colorRewards, achievements, secret, coinsTotal };
  }

  /** ★1 and the bunny spits it out (퉤): 1–50 coins are taken away (never below 0). */
  spit() { return this.loseCoins(SPIT_COINS, "spits"); }
  /** ★1 and the bunny kicks the jelly away: 1–50 coins are taken away (never below 0). */
  kick() { return this.loseCoins(KICK_COINS, "kicks"); }
  loseCoins(range, stat) {
    const rolled = this.randInt(range), lost = Math.min(this.state.coins, rolled);
    this.state.coins -= lost;
    this.state.streak = 0;
    this.state.stats[stat]++;
    const achievements = this.awardAchievements();
    this.commit();
    return { lost, rolled, achievements };
  }

  // ------------------------------------------------------------ levels & gifts
  /**
   * Level-ups after `before`: [{ level, rewards: [{kind, id, label, owned?,
   * coins?}], gift }]. A shape reward already owned via a shape card becomes
   * owned: true + 25 coins. Gift boxes / owned-shape coins are applied right
   * away, once per level (calling it again lists the rewards with gift: null).
   */
  levelUpsSince(before) {
    const ups = this.applyLevelUps(before);
    if (ups.applied) this.commit();
    return ups.list;
  }
  applyLevelUps(before) {
    const st = this.state, now = this.level.level, list = [];
    let coins = 0, cards = 0, applied = false;
    for (let l = before + 1; l <= now; l++) {
      const fresh = l > st.rewardedLevel;
      const rewards = (LEVEL_REWARDS[l] || []).map((r) => {
        if (r.kind !== "shape" || !st.shapeCards.includes(r.id)) return { ...r };
        if (fresh) { st.coins += OWNED_SHAPE_COINS; coins += OWNED_SHAPE_COINS; }
        return { ...r, owned: true, coins: OWNED_SHAPE_COINS };
      });
      let gift = null;
      if (fresh) {
        gift = this.openGift();
        if (gift.kind === "coins") coins += gift.coins;
        if (gift.kind === "card") cards++;
        applied = true;
      }
      list.push({ level: l, rewards, gift });
    }
    if (now > st.rewardedLevel) st.rewardedLevel = now;
    return { list, coins, cards, applied };
  }
  /** One gift box: coins 15–50 | +10 of a random rare gem | a free card (applied). */
  openGift() {
    const g = rollGift(this.random);
    this.state.stats.gifts++;
    if (g.kind === "coins") { this.state.coins += g.coins; return g; }
    if (g.kind === "card") { this.state.freeCards++; return g; }
    const b = this.addBundle(g.index, false);
    return { kind: "rare", index: b.index, tier: b.tier, added: b.added, count: b.count, isNew: b.kind === "new" };
  }

  // ------------------------------------------------------------ card pulls
  /**
   * One card pull (the player picks one of three face-down cards; all three
   * are equal, the result is drawn when picked). Pays PULL_COST coins, or a
   * free card when `free` (or when coins are short). 1/100: a shape card for a
   * still-locked shape (none locked → a gem). Otherwise uniform over the 25
   * rare gems: a bundle of 10; a duplicate also upgrades glitter → gold →
   * rainbow ("more" at rainbow).
   * → null (cannot pay) | { type: "gem", index, tier, kind: "new"|"gold"|
   *   "rainbow"|"more", added, count, usedFree, achievements } | { type:
   *   "shape", id, label, usedFree, achievements }
   */
  pull({ free = false } = {}) {
    const st = this.state;
    let usedFree;
    if (free) { if (st.freeCards <= 0) return null; usedFree = true; }
    else if (st.coins >= PULL_COST) usedFree = false;
    else if (st.freeCards > 0) usedFree = true;
    else return null;
    if (usedFree) st.freeCards--; else st.coins -= PULL_COST;
    st.pulls++;
    let result = null;
    if (this.random() < SHAPE_CARD_CHANCE) {
      const locked = this.lockedShapes();
      if (locked.length) {
        const r = locked[Math.floor(this.random() * locked.length)];
        st.shapeCards.push(r.id);
        result = { type: "shape", id: r.id, label: r.label, usedFree };
      }
    }
    if (!result) {
      const g = this.addBundle(Math.floor(this.random() * RARE_COUNT));
      result = { type: "gem", ...g, usedFree };
    }
    result.achievements = this.awardAchievements();
    this.commit();
    return result;
  }

  // ------------------------------------------------------------ achievements
  facts() {
    const st = this.state, s = st.stats;
    return {
      feeds: st.feeds, star3: s.star3, star4: s.star4, bestStreak: st.bestStreak, spits: s.spits, kicks: s.kicks,
      shapesFed: s.shapesFed.length, rareKinds: st.rare.filter((t) => t >= 0).length, rainbow: st.rare.filter((t) => t === 2).length,
      shapeCards: st.shapeCards.length, goldenStar3: s.goldenStar3, memoryStar3: s.memoryStar3, pickyStar3: s.pickyStar3,
      fastStar3: s.fastStar3, slimeStar3: s.slimeStar3, maxGems: s.maxGems, maxRare: s.maxRare,
      colorBook: st.colorBook.length, colorTotal: COLOR_NAMES.length, secrets: st.secrets.length, secretTotal: SECRET_RECIPES.length,
      level: this.level.level,
    };
  }
  // Marks newly earned achievements done and credits their coins (no save).
  awardAchievements() {
    const got = earnedAchievements(this.facts(), this.state.achievements);
    for (const a of got) { this.state.achievements[a.id] = true; this.state.coins += a.coins; }
    return got.map(achievementView);
  }
  achievementList() {
    return ACHIEVEMENTS.map((a) => ({ id: a.id, label: a.label, desc: a.desc, coins: a.coins, title: a.title, unlock: a.unlock ? { ...a.unlock } : null, done: !!this.state.achievements[a.id] }));
  }
  colorBookList() {
    return COLOR_NAMES.map((c) => ({ name: c.name, hex: COLOR_HEX.get(c.name), family: c.family, found: this.state.colorBook.includes(c.name) }));
  }
  secretList() {
    return SECRET_RECIPES.map((r) => ({ id: r.id, label: r.label, emoji: r.emoji, hint: r.hint, found: this.state.secrets.includes(r.id) }));
  }

  // ------------------------------------------------------------ dress-up
  /** Put an unlocked outfit item on its slot (id null = empty the slot). */
  setOutfit(slot, id) {
    if (!OUTFIT_SLOTS.includes(slot)) return false;
    if (id != null) {
      const o = OUTFITS.find((x) => x.id === id);
      if (!o || o.slot !== slot || !this.outfits().includes(id)) return false;
    }
    this.state.outfit[slot] = id ?? null;
    this.commit();
    return true;
  }
  /** {head, face, neck, back}: ids of the worn (and still unlocked) items. */
  get outfit() {
    const have = this.outfits(), out = emptyOutfit();
    for (const slot of OUTFIT_SLOTS) if (have.includes(this.state.outfit[slot])) out[slot] = this.state.outfit[slot];
    return out;
  }
  setTitle(id) {
    if (id != null && !this.titles().some((t) => t.id === id)) return false;
    this.state.title = id ?? null;
    this.commit();
    return true;
  }
  /** The worn title {id, label} or null. */
  get title() { return this.titles().find((t) => t.id === this.state.title) || null; }

  reset() { this.state = freshProgress(); this.commit(); }
}
