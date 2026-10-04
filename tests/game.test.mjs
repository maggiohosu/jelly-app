// Orders (colour model, solvability, scoring) and progress (coins, friendship,
// gacha upgrades, storage).
import { makeOrder, scoreOrder, mixSigma, deltaE, nameColor, COLOR_NAMES, sigmaToHex } from "../src/app/orders.js";
import { Progress, PULL_COST, WELCOME_COINS, LEVEL_REWARDS, RARE_COUNT, levelForXp } from "../src/app/progress.js";
import { JellyWorld, PAINTS } from "../src/core/world.js";

let failures = 0;
const check = (label, ok, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`); };
function rng(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

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

// 2) orders are solvable, varied and named
{
  const random = rng(7), paints = ["red", "yellow", "blue", "pink", "purple", "sky", "water"];
  const orders = Array.from({ length: 60 }, (_, i) => makeOrder({ paints, level: 1 + (i % 8), random, id: i }));
  check("orders have a target colour, name and text", orders.every((o) => /^#[0-9a-f]{6}$/.test(o.hex) && o.name && o.text.endsWith("!")));
  check("making the hidden recipe scores ⭐3", orders.every((o) => scoreOrder(o, { sigma: mixSigma(o.base, o.drops), gems: o.gems ? Array(o.gems.count).fill(o.gems.shape) : [], texture: o.texture || "jelly" }).stars === 3));
  check("the plain base usually scores lower", orders.filter((o) => scoreOrder(o, { sigma: mixSigma(o.base, {}), gems: [], texture: "jelly" }).stars < 3).length >= 55);
  check("orders vary", new Set(orders.map((o) => o.hex)).size > 40, `${new Set(orders.map((o) => o.hex)).size} distinct colours`);
  check("only unlocked paints are used", orders.every((o) => Object.keys(o.drops).every((k) => paints.includes(k))));
  check("named colours are self-consistent", COLOR_NAMES.every((c) => nameColor(mixSigma(c.base, c.drops)) === c.name));
  const o = orders.find((x) => x.gems);
  const half = scoreOrder(o, { sigma: mixSigma(o.base, o.drops), gems: [], texture: o.texture || "jelly" });
  check("missing gems lower the score", half.stars < 3 && half.colorScore === 1, `${half.stars}⭐`);
  console.log("      e.g.", orders.slice(0, 4).map((x) => `${x.text} ${x.hex}`).join(" | "));
}

// 3) progress: welcome coins, feeding, levels, gacha upgrades, storage
{
  const store = new Map(), storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  const p = new Progress(storage, rng(3));
  check("new players get welcome coins (one free pull)", p.coins === WELCOME_COINS && p.canPull);
  const r = p.pull();
  check("a pull costs coins and gives a new glitter gem", r.kind === "new" && r.tier === 0 && p.coins === WELCOME_COINS - PULL_COST);
  check("no coins → no pull", p.pull() === null);
  const f1 = p.feed({ stars: 3, rareCount: 1 });
  check("⭐3 with a rare gem pays 70 coins", f1.coins === 70 && p.coins === 70);
  const f2 = p.feed({ stars: 1 });
  check("⭐1 still pays 30 coins (sad bunny)", f2.coins === 30 && p.coins === 100);
  check("two meals ≈ one pull", p.canPull);
  check("friendship levels up and unlocks the orange paint", p.level.level >= 2 && p.paints().includes("orange") && [...f1.levelUps, ...f2.levelUps].some((u) => u.reward?.id === "orange"));
  // upgrades: force the same gem
  const q = new Progress(storage, () => 0.5);
  q.state.coins = 1000;
  const kinds = [q.pull(), q.pull(), q.pull(), q.pull()].map((x) => x.kind);
  check("duplicates upgrade glitter → gold → rainbow, then refund", kinds.join() === "new,gold,rainbow,dupe" || kinds.join() === "gold,rainbow,dupe,dupe", kinds.join());
  const reloaded = new Progress(storage);
  check("progress survives a reload", reloaded.coins === q.coins && reloaded.state.rare.join() === q.state.rare.join());
  const broken = new Progress({ getItem: () => "{oops", setItem: () => { throw new Error("quota"); } });
  check("corrupted storage starts fresh, full storage does not crash", broken.coins === WELCOME_COINS && (broken.feed({ stars: 2 }), true));
  check("all rewards are reachable by level 8", levelForXp(700).level >= 8 && Object.keys(LEVEL_REWARDS).every((l) => Number(l) <= 8));
  check("25 rare gems", RARE_COUNT === 25);
  // album cap
  const a = new Progress(storage, rng(9));
  for (let i = 0; i < 70; i++) a.feed({ stars: 2, card: { id: i, hex: sigmaToHex(mixSigma("berry", {})) } });
  check("album keeps the latest 60 works", a.state.album.length === 60 && a.state.album[59].id === 69);
}

console.log(failures ? `\n${failures} FAILED` : "\nALL GAME CHECKS PASSED");
process.exit(failures ? 1 : 0);
