// The fun systems around the bunny's orders (v8): achievements (뱃지) with
// coins / titles / unlocks, the bunny's outfits, plate & background themes,
// secret recipes, colour-book milestones and the level-up gift box. v9 adds
// the toilet badges and the two card-only outfits (witch hat, magic wand).
// Data + pure helpers only; app/progress.js keeps the state and applies them.
// Coins are on the halved v8 scale (a ★3 order pays 30).
import { COLOR_NAMES, GEM_HEART, GEM_DROPLET } from "./orders.js";

export const RARE_KINDS = 25;           // = progress.RARE_COUNT (rare-shapes.js RARE_GEM_INFO)
export const SHAPE_COUNT = 6;           // flower + 5 shaped jellies (core/shapes.js SHAPES)
export const SECRET_COINS = 25;

// ------------------------------------------------------------- achievements
// `test(f)` reads the facts object progress.facts() builds:
// { feeds, star3, star4, bestStreak, spits, kicks, shapesFed, rareKinds,
//   rainbow, shapeCards, goldenStar3, memoryStar3, pickyStar3, fastStar3,
//   slimeStar3, maxGems, maxRare, colorBook, colorTotal, secrets,
//   secretTotal, level, toilets }.
// Ids are stored in saves: never rename one. `title` = a title the player can
// wear (title id = the achievement id); `unlock` = an outfit / theme.
const A = (id, label, desc, coins, test, extra = {}) => Object.freeze({ id, label, desc, coins, title: null, unlock: null, ...extra, test });
export const ACHIEVEMENTS = Object.freeze([
  A("first_feed", "첫 냠냠", "토끼에게 처음으로 젤리를 먹였어요", 10, (f) => f.feeds >= 1),
  A("first_star3", "완벽한 주문", "처음으로 ★3을 받았어요", 15, (f) => f.star3 >= 1),
  A("first_star4", "특별한 젤리", "레어 보석으로 ★4 특별 젤리를 만들었어요", 20, (f) => f.star4 >= 1),
  A("star3_10", "주문 척척", "★3을 10번 받았어요", 25, (f) => f.star3 >= 10),
  A("star3_50", "젤리 장인", "★3을 50번 받았어요", 50, (f) => f.star3 >= 50, { title: "젤리 장인" }),
  A("combo_3", "3연속 콤보", "★3 이상을 3번 연속으로 받았어요", 15, (f) => f.bestStreak >= 3),
  A("combo_5", "5연속 콤보", "★3 이상을 5번 연속으로 받았어요", 25, (f) => f.bestStreak >= 5),
  A("combo_10", "콤보 마스터", "★3 이상을 10번 연속으로 받았어요", 50, (f) => f.bestStreak >= 10, { title: "콤보 마스터" }),
  A("spit_3", "퉤 전문가", "토끼가 젤리를 3번 뱉었어요", 10, (f) => f.spits >= 3, { title: "퉤 전문가" }),
  A("kick_3", "축구공 젤리", "토끼가 젤리를 3번 걷어찼어요", 10, (f) => f.kicks >= 3, { title: "축구공 젤리" }),
  A("shapes_3", "모양 탐험가", "서로 다른 모양 젤리 3가지를 먹였어요", 20, (f) => f.shapesFed >= 3),
  A("shapes_6", "모양 박사", "6가지 모양 젤리를 모두 먹였어요", 40, (f) => f.shapesFed >= SHAPE_COUNT, { title: "모양 박사" }),
  A("rare_first", "첫 반짝", "처음으로 레어 보석을 얻었어요", 10, (f) => f.rareKinds >= 1),
  A("rare_10", "보석 상자", "레어 보석 10종을 모았어요", 25, (f) => f.rareKinds >= 10),
  A("rare_25", "보석 수집가", "레어 보석 25종을 모두 모았어요", 50, (f) => f.rareKinds >= RARE_KINDS, { title: "보석 수집가" }),
  A("rainbow_5", "무지개 다섯", "무지개빛 레어 보석 5종을 모았어요", 40, (f) => f.rainbow >= 5),
  A("shape_card", "행운의 모양 카드", "카드 뽑기에서 모양 카드가 나왔어요", 30, (f) => f.shapeCards >= 1),
  A("golden_first", "황금 주문 성공", "황금 주문에서 처음으로 ★3을 받았어요", 20, (f) => f.goldenStar3 >= 1),
  A("golden_5", "황금 손", "황금 주문에서 ★3을 5번 받았어요", 50, (f) => f.goldenStar3 >= 5, { title: "황금 손" }),
  A("memory_star3", "기억력 대장", "기억 주문을 다시 보지 않고 ★3을 받았어요", 20, (f) => f.memoryStar3 >= 1),
  A("picky_star3", "미식가의 인정", "까다로운 날에 ★3을 받았어요", 25, (f) => f.pickyStar3 >= 1, { title: "미식가" }),
  A("speedy", "번개 손", "주문을 받고 30초 안에 ★3을 받았어요", 15, (f) => f.fastStar3 >= 1),
  A("slime_star3", "슬랑이 장인", "슬랑이로 ★3을 받았어요", 15, (f) => f.slimeStar3 >= 1),
  A("gems_24", "보석 가득", "보석 24개가 든 젤리를 먹였어요", 20, (f) => f.maxGems >= 24),
  A("rare_8", "보석 폭풍", "레어 보석 8개가 든 젤리를 먹였어요", 30, (f) => f.maxRare >= 8, { unlock: Object.freeze({ outfit: "cape" }) }),
  A("book_10", "색 탐험가", "색 도감에 색 10개를 모았어요", 15, (f) => f.colorBook >= 10),
  A("book_all", "색의 마법사", "색 도감을 모두 채웠어요", 30, (f) => f.colorBook >= f.colorTotal),
  A("secret_first", "비밀 레시피", "처음으로 숨은 레시피를 찾았어요", 20, (f) => f.secrets >= 1, { unlock: Object.freeze({ outfit: "flowerband" }) }),
  A("secret_all", "레시피 탐정", "숨은 레시피 8개를 모두 찾았어요", 50, (f) => f.secrets >= f.secretTotal, { title: "레시피 탐정" }),
  A("level_10", "토끼의 단짝", "토끼와 친구 레벨 10이 되었어요", 40, (f) => f.level >= 10, { title: "토끼의 단짝" }),
  // v9: the bunny's toilet trips (progress.toilet()); `toilets` is absent in
  // facts built before v9 → never earned by accident
  A("first_toilet", "첫 화장실", "배부른 토끼를 처음으로 화장실에 보내 줬어요", 15, (f) => (f.toilets || 0) >= 1),
  A("toilet_10", "화장실 10회", "토끼를 화장실에 10번 보내 줬어요", 30, (f) => (f.toilets || 0) >= 10),
]);

/** Achievements newly earned with these facts (not yet in `done`). */
export function earnedAchievements(facts, done = {}) {
  return ACHIEVEMENTS.filter((a) => !done[a.id] && a.test(facts));
}
/** What the UI / feed result shows for an achievement (no test function). */
export const achievementView = (a) => ({ id: a.id, label: a.label, desc: a.desc, coins: a.coins, ...(a.title ? { title: a.title } : {}), ...(a.unlock ? { unlock: { ...a.unlock } } : {}) });

// ------------------------------------------------------------------ outfits
// One item per slot; render/rabbit.js setOutfit({head, face, neck, back,
// wand}). Unlocked by `level`, by `achievement`, or (`card: true`) only by an
// outfit card from a card pull (progress.pull, OUTFIT_CARD_CHANCE). The v9
// "wand" slot is carried diagonally on the back, so it goes with wings / cape.
export const OUTFIT_SLOTS = Object.freeze(["head", "face", "neck", "back", "wand"]);
export const OUTFITS = Object.freeze([
  { id: "ribbon", slot: "head", label: "리본", emoji: "🎀", level: 3 },
  { id: "glasses", slot: "face", label: "동그란 안경", emoji: "👓", level: 5 },
  { id: "scarf", slot: "neck", label: "목도리", emoji: "🧣", level: 7 },
  { id: "crown", slot: "head", label: "왕관", emoji: "👑", level: 9 },
  { id: "wings", slot: "back", label: "요정 날개", emoji: "🧚", level: 12 },
  { id: "flowerband", slot: "head", label: "꽃 머리띠", emoji: "🌸", achievement: "secret_first" },
  { id: "cape", slot: "back", label: "별 망토", emoji: "⭐", achievement: "rare_8" },
  { id: "witchhat", slot: "head", label: "마녀 모자", emoji: "🧙", card: true },
  { id: "wand", slot: "wand", label: "마법지팡이", emoji: "🪄", card: true },
].map(Object.freeze));
/** Outfits that only come from outfit cards. */
export const CARD_OUTFITS = Object.freeze(OUTFITS.filter((o) => o.card));

// ------------------------------------------------------------------- themes
// render/stage.js setTheme(id). `cond(c)` with c = { level, colorBook, shapes
// (unlocked shape count) }; condText is the UI hint for a locked theme.
export const THEMES = Object.freeze([
  { id: "basic", label: "기본" },
  { id: "flower", label: "꽃무늬 접시", level: 4 },
  { id: "starry", label: "별밤", level: 7 },
  { id: "strawberry", label: "딸기 테이블", level: 10 },
  { id: "rainbow", label: "무지개 구름", cond: (c) => c.colorBook >= 20 || c.shapes >= SHAPE_COUNT, condText: "색 도감 20개 또는 모양 6종" },
].map(Object.freeze));
export function themeUnlocked(theme, c) {
  if (theme.level) return c.level >= theme.level;
  if (theme.cond) return theme.cond(c);
  return true;
}

// ----------------------------------------------------------- secret recipes
// test(jelly, name, family): jelly = the fed jelly descriptor (see orders.js
// scoreOrder), name / family = its colour name. Each is reachable in the real
// game (shapes Lv2–10, pearl Lv6, glow Lv8, star candies Lv5; a plain base on
// a shaped jelly via the base buttons); the hints stay vague on purpose.
const gemsOf = (j, shape) => (j.gems || []).filter((s) => s === shape).length;
const totalGems = (j) => (j.gems || []).length + (j.rareCount ?? j.rare?.length ?? 0);
const S = (id, label, emoji, hint, test) => Object.freeze({ id, label, emoji, hint, test });
export const SECRET_RECIPES = Object.freeze([
  S("rainbow_cat", "무지개 고양이", "🐱", "고양이는 가장 찬란하게 빛나는 보석을 좋아한대요",
    (j) => j.shape === "cat" && (j.rare || []).some((r) => r.tier === 2)),
  S("starry_night", "별밤 젤리", "🌌", "밤하늘 빛깔에 별을 뿌리고, 어둠 속에서 은은하게…",
    (j, name, family) => (family === "blue" || family === "purple") && (j.additives?.stars || 0) >= 9 && (j.fx?.[1] || 0) >= 0.2),
  S("strawberry_cake", "딸기 케이크", "🍰", "케이크엔 분홍 크림과 사랑이 두 개쯤",
    (j, name, family) => j.shape === "cake" && family === "pink" && gemsOf(j, GEM_HEART) >= 2),
  S("honey_bear", "꿀단지 곰", "🍯", "곰은 달콤하고 노르스름한 걸 참 좋아하죠",
    (j, name, family) => j.shape === "bear" && (family === "yellow" || family === "orange")),
  S("pearl_pudding", "진주 푸딩", "🍮", "푸딩에 진주처럼 은은한 광택을 입혀 봐요",
    (j) => j.shape === "pudding" && (j.fx?.[0] || 0) >= 0.2),
  S("sky_chick", "하늘 아기새", "🐦", "아기새는 하늘을 꼭 닮고 싶대요",
    (j, name, family) => j.shape === "bird" && (family === "sky" || family === "blue")),
  S("clear_drop", "투명 물방울", "💧", "아무 색도 없는 젤리에 물방울이 송골송골",
    (j, name, family) => family === "clear" && gemsOf(j, GEM_DROPLET) >= 3),
  S("gem_bomb", "보석 폭탄 슬랑이", "💣", "말랑한 슬랑이에 보석을 잔뜩, 아주 잔뜩!",
    (j) => j.texture === "slime" && totalGems(j) >= 20),
]);
/** The first secret this jelly reveals that is not in `found`, or null. */
export function findSecret(jelly, name, family, found = []) {
  if (!jelly) return null;
  return SECRET_RECIPES.find((s) => !found.includes(s.id) && s.test(jelly, name, family)) || null;
}

// ------------------------------------------------------- colour book rewards
// Claimed once each (progress.state.colorRewards keeps the ids). A title
// reward's title id = the reward id.
export const COLOR_BOOK_REWARDS = Object.freeze([
  { id: "book10", at: 10, coins: 25 },
  { id: "book20", at: 20, coins: 25, theme: "rainbow" },
  { id: "book30", at: 30, freeCards: 1 },
  { id: "bookAll", at: COLOR_NAMES.length, coins: 50, title: "색의 마법사", all: true },
].map(Object.freeze));
export function colorBookRewardsDue(count, claimed = []) {
  return COLOR_BOOK_REWARDS.filter((r) => count >= r.at && !claimed.includes(r.id));
}

// ---------------------------------------------------------------- gift box
// Each level-up opens one: coins (15–50) 50 %, a rare-gem bundle (+10 of a
// random rare gem, new or owned) 35 %, a free card 15 %.
export const GIFT_ODDS = Object.freeze({ coins: 0.5, rare: 0.35, card: 0.15 });
export const GIFT_COINS = Object.freeze([15, 50]);
export function rollGift(random = Math.random) {
  const r = random();
  if (r < GIFT_ODDS.coins) return { kind: "coins", coins: GIFT_COINS[0] + Math.floor(random() * (GIFT_COINS[1] - GIFT_COINS[0] + 1)) };
  if (r < GIFT_ODDS.coins + GIFT_ODDS.rare) return { kind: "rare", index: Math.floor(random() * RARE_KINDS) };
  return { kind: "card" };
}
