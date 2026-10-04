// Player progress: gold coins, the bunny's friendship level and its rewards,
// the rare-gem collection (glitter → gold → rainbow upgrades), the album of
// eaten works, and the current order. Saved on the phone only (localStorage).
// Pure logic + storage; no DOM besides localStorage. Node-testable with a
// fake storage.

export const PROGRESS_KEY = "mallang-jelly-progress-v1";
export const WELCOME_COINS = 100;
export const PULL_COST = 100;
export const DUPE_REFUND = 30;
export const COINS_BY_STARS = Object.freeze([0, 30, 45, 60]);
export const RARE_BONUS = 10;                 // per rare gem in the eaten jelly
export const RARE_COUNT = 25;
export const TIER_LABELS = Object.freeze(["글리터", "금빛", "무지개빛"]);
const ALBUM_MAX = 60;

// Friendship: XP per meal = 10 + 10 per star. Cumulative XP to reach each level.
export const LEVEL_XP = Object.freeze([0, 0, 40, 100, 180, 280, 400, 540, 700, 880, 1080]);
export const LEVEL_REWARDS = Object.freeze({
  2: { kind: "paint", id: "orange", label: "주황 물감" },
  3: { kind: "additive", id: "glitter", label: "글리터" },
  4: { kind: "paint", id: "lime", label: "연두 물감" },
  5: { kind: "additive", id: "stars", label: "별사탕 토핑" },
  6: { kind: "paint", id: "pearl", label: "금펄 물감" },
  8: { kind: "paint", id: "glow", label: "야광 물감" },
});
export const BASE_PAINTS = Object.freeze(["red", "yellow", "blue", "pink", "purple", "sky", "water"]);

export function levelForXp(xp) {
  let level = 1;
  for (let l = 2; ; l++) {
    const need = l < LEVEL_XP.length ? LEVEL_XP[l] : LEVEL_XP[LEVEL_XP.length - 1] + (l - LEVEL_XP.length + 1) * 200;
    if (xp < need) return { level, xp, from: levelStart(level), to: need };
    level = l;
  }
}
function levelStart(level) {
  return level < LEVEL_XP.length ? LEVEL_XP[level] : LEVEL_XP[LEVEL_XP.length - 1] + (level - LEVEL_XP.length + 1) * 200;
}

export function freshProgress() {
  return { version: 1, coins: WELCOME_COINS, xp: 0, rare: new Array(RARE_COUNT).fill(-1), album: [], order: null, feeds: 0, pulls: 0, seenLevel: 1 };
}

export class Progress {
  constructor(storage = globalThis.localStorage, random = Math.random) {
    this.storage = storage;
    this.random = random;
    this.state = freshProgress();
    this.listeners = [];
    try {
      const saved = JSON.parse(storage?.getItem(PROGRESS_KEY) || "null");
      if (saved && saved.version === 1) {
        this.state = { ...freshProgress(), ...saved };
        const rare = Array.isArray(saved.rare) ? saved.rare : [];
        this.state.rare = Array.from({ length: RARE_COUNT }, (_, i) => (Number.isInteger(rare[i]) ? Math.max(-1, Math.min(2, rare[i])) : -1));
        if (!Array.isArray(this.state.album)) this.state.album = [];
      }
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

  get coins() { return this.state.coins; }
  get level() { return levelForXp(this.state.xp); }
  get canPull() { return this.state.coins >= PULL_COST; }

  /** Paint ids the player can use (base + unlocked by friendship). */
  paints() {
    const out = [...BASE_PAINTS], lvl = this.level.level;
    for (const [l, r] of Object.entries(LEVEL_REWARDS)) if (r.kind === "paint" && lvl >= Number(l)) out.push(r.id);
    return out;
  }
  additives() {
    const out = [], lvl = this.level.level;
    for (const [l, r] of Object.entries(LEVEL_REWARDS)) if (r.kind === "additive" && lvl >= Number(l)) out.push(r.id);
    return out;
  }
  ownedRare() { return this.state.rare.map((tier, index) => ({ index, tier })).filter((r) => r.tier >= 0); }

  /**
   * The bunny ate a jelly. → { coins, xp, levelUps: [{level, reward}] }
   */
  feed({ stars, rareCount = 0, card = null }) {
    const before = this.level.level;
    const coins = COINS_BY_STARS[Math.max(1, Math.min(3, stars))] + RARE_BONUS * Math.min(4, rareCount);
    const xp = 10 + 10 * stars;
    this.state.coins += coins;
    this.state.xp += xp;
    this.state.feeds++;
    if (card) {
      this.state.album.push(card);
      while (this.state.album.length > ALBUM_MAX) this.state.album.shift();
    }
    const after = this.level.level, levelUps = [];
    for (let l = before + 1; l <= after; l++) levelUps.push({ level: l, reward: LEVEL_REWARDS[l] || null });
    this.save(); this.emit();
    return { coins, xp, levelUps };
  }

  /**
   * One card pull (the player picks one of three face-down cards; all three
   * are equal, the result is drawn when picked). Uniform over the 25 rare
   * gems; owning one upgrades it glitter → gold → rainbow; a rainbow dupe
   * refunds coins.
   * → null (not enough coins) | { index, tier, kind: "new" | "gold" | "rainbow" | "dupe", refund }
   */
  pull() {
    if (this.state.coins < PULL_COST) return null;
    this.state.coins -= PULL_COST;
    this.state.pulls++;
    const index = Math.floor(this.random() * RARE_COUNT);
    const had = this.state.rare[index];
    let result;
    if (had < 0) { this.state.rare[index] = 0; result = { index, tier: 0, kind: "new", refund: 0 }; }
    else if (had < 2) { this.state.rare[index] = had + 1; result = { index, tier: had + 1, kind: had === 0 ? "gold" : "rainbow", refund: 0 }; }
    else { this.state.coins += DUPE_REFUND; result = { index, tier: 2, kind: "dupe", refund: DUPE_REFUND }; }
    this.save(); this.emit();
    return result;
  }

  setOrder(order) { this.state.order = order; this.save(); this.emit(); }
  get order() { return this.state.order; }

  reset() { this.state = freshProgress(); this.save(); this.emit(); }
}
