// DOM side of the bunny game: coin / friendship HUD (title, combo chip, the
// v9 happy-buff chip and the v10 nope chip; the tummy itself is a secret), the order card (kinds, compact conditions, time bonus, memory hide / peek, the
// one-tap "new jelly for this order" button), the reward card after a meal
// (with its coin breakdown), follow-ups queued one after another (notices,
// level-up gift boxes), the card-pull overlay (three face-down cards → pick →
// shake → flip → celebration; gem bundles, the rare shape card and the v9
// outfit card), the book
// (rare gems + album + colour book + achievements / titles + secret recipes)
// and a small confetti engine. Every coin number comes from progress.js.
import { PULL_COST, TIER_LABELS, RARE_COUNT, MEMORY_PEEK_COST, comboMultiplier, timeBonusFor } from "./progress.js";
import { GEM_SHAPE_LABELS } from "./orders.js";
import { OUTFITS, COLOR_BOOK_REWARDS } from "./fun.js";
import { PAINTS, ADDITIVES } from "../core/world.js";
import { SHAPES } from "../core/shapes.js";
import { gemIconSVG } from "../render/gems.js";
import { shapeIconSVG } from "../render/shape-icons.js";
import { uniqueSvg } from "./ui.js";

const $ = (id) => document.getElementById(id);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const shapeLabel = (id) => SHAPES.find((s) => s.id === id)?.label || id;
const ORDER_GEM_HEX = "#f4a3c4";
const KIND_BADGE = Object.freeze({ golden: "✨ 황금 주문 ×3", picky: "🧐 까다로운 날 ×2", memory: "🙈 기억 주문" });
const ADDITIVE_NAMES = Object.freeze({ glitter: "글리터", stars: "별사탕" });

export function createGameUI({ progress, rareInfo, rareIcon, rareThumb, onPull, onTitle, themeLooks = {}, sounds }) {
  // rareInfo(index) → { label, color }; rareIcon(index, tier) → html (instant);
  // rareThumb(index, tier) → Promise<dataURL | null> (pretty 3D render).
  const confetti = new Confetti($("confetti"));

  // ------------------------------------------------- follow-up queue
  // Reward cards, notices and gift boxes play one after another (never two
  // popups at once); fn may return a promise.
  let queue = Promise.resolve();
  function enqueue(fn) {
    queue = queue.then(fn).catch((error) => console.warn("game ui", error));
    return queue;
  }

  // ---------------------------------------------------------------- HUD
  let shownCoins = progress.coins;
  function renderHud({ animateCoins = false } = {}) {
    if (!animateCoins) shownCoins = progress.coins;
    $("coin-count").textContent = String(shownCoins);
    $("gacha-coins").textContent = String(progress.coins);
    const lv = progress.level, title = progress.title;
    $("friend-level").textContent = `Lv${lv.level}`;
    $("friend-bar").style.width = `${Math.round(100 * (lv.xp - lv.from) / Math.max(1, lv.to - lv.from))}%`;
    $("title-tag").hidden = !title;
    $("title-tag").textContent = title ? title.label : "";
    $("friend").classList.toggle("titled", Boolean(title));
    $("friend").setAttribute("aria-label", `토끼 친밀도 Lv${lv.level}${title ? ` · 칭호 ${title.label}` : ""}`);
    const free = progress.freeCards;
    $("gacha-button").classList.toggle("ready", progress.canPull);
    $("gacha-free").hidden = !(free > 0);
    $("gacha-free").textContent = `🎴 무료 카드 ${free}장`;
    $("pull-button").disabled = !progress.canPull;
    $("pull-button").textContent = free > 0 ? `무료 카드로 뽑기 (${free}장)` : progress.canPull ? `금화 ${PULL_COST}개로 뽑기` : `금화가 ${PULL_COST - progress.coins}개 더 필요해요`;
    renderCombo();
    renderTummy();
  }
  // The tummy's chips on the order card (progress.js v9/v10): 😊 while
  // buffed meals are left, 🚽 after a trip for nothing (헛걸음) while its
  // penalised outcomes are left. Fullness itself is never shown (a secret:
  // the bunny's belly and its burp are the hints).
  function renderTummy() {
    const h = progress.happyTurns, chip = $("happy-chip");
    chip.hidden = !(h > 0);
    if (h > 0) { chip.textContent = `😊 기분 최고 ★+1 · 남은 ${h}회`; chip.setAttribute("aria-label", `토끼 기분 최고: 꾸민 젤리 별 +1, 남은 ${h}회`); }
    const n = progress.nopeTurns, nope = $("nope-chip");
    nope.hidden = !(n > 0);
    if (n > 0) { nope.textContent = `🚽 헛걸음 ★−1 · 남은 ${n}회`; nope.setAttribute("aria-label", `화장실 헛걸음: 별 −1, 남은 ${n}회`); }
  }
  // 🔥 combo chip (on the order card): visible while the ★3 streak is ≥ 2
  function renderCombo() {
    const s = progress.streak, chip = $("combo-chip");
    chip.hidden = !(s >= 2);
    if (s >= 2) { chip.textContent = `🔥${s} 콤보 ×${comboMultiplier(s)}`; chip.setAttribute("aria-label", `${s}연속 콤보, 금화 ${comboMultiplier(s)}배`); }
  }
  // one coin flew into the counter
  function addCoin(n = 1) {
    shownCoins = Math.min(progress.coins, shownCoins + n);
    $("coin-count").textContent = String(shownCoins);
    const pill = $("coins");
    pill.classList.remove("bump"); void pill.offsetWidth; pill.classList.add("bump");
  }
  function coinCounterNDC() {
    const r = $("coins").querySelector(".coin-icon").getBoundingClientRect();
    return { x: ((r.left + r.width / 2) / innerWidth) * 2 - 1, y: -(((r.top + r.height / 2) / innerHeight) * 2 - 1) };
  }

  // ---------------------------------------------------------------- order
  // kind badge, swatch, text, compact conditions (shape · gems ×n · topping
  // · slime), the ⚡ time-bonus chip + bar, and the memory order's hiding.
  // memoTimer / memoLeft: the memory order's pending hide; memoHolds > 0
  // (the toilet visit) freezes what is left of its 5 s.
  let currentOrder = null, memoTimer = 0, orderHidden = false, memoAt = 0, memoLeft = 0, memoHolds = 0;
  function condsHTML(o) {
    const parts = [];
    if (o.shape) parts.push(`<i class="cond shape" title="${esc(shapeLabel(o.shape))} 모양">${uniqueSvg(shapeIconSVG(o.shape))}</i>`);
    for (const g of o.gems || []) parts.push(`<i class="cond gem" title="${GEM_SHAPE_LABELS[g.shape]} 보석 ${g.count}개">${uniqueSvg(gemIconSVG(g.shape, ORDER_GEM_HEX))}<b>×${g.count}</b></i>`);
    if (o.additive) parts.push(`<i class="cond add add-${o.additive.id}" title="${ADDITIVE_NAMES[o.additive.id] || ""}"><span class="dot"></span><b>${ADDITIVE_NAMES[o.additive.id] || ""}</b></i>`);
    if (o.texture === "slime") parts.push(`<i class="cond slime" title="슬랑이"><b>슬랑이</b></i>`);
    return parts.join("");
  }
  function showOrder(order, { announce = true } = {}) {
    const el = $("order");
    clearTimeout(memoTimer); memoTimer = 0; memoLeft = 0;
    orderHidden = false;
    currentOrder = order;
    if (!order) { el.hidden = true; return; }
    el.hidden = false;
    el.className = `order kind-${order.kind || "normal"}`;
    const badge = $("order-kind");
    badge.hidden = !KIND_BADGE[order.kind];
    badge.textContent = KIND_BADGE[order.kind] || "";
    $("order-swatch").style.setProperty("--c", order.hex);
    $("order-text").textContent = order.text;
    $("order-conds").innerHTML = condsHTML(order);
    setOrderTime(0);
    renderCombo();
    if (order.kind === "memory") hideOrderLater();
    void el.offsetWidth; el.classList.add("pop");
    if (announce && order.kind === "golden") sounds.goldenOrder?.();
  }
  function setOrderTime(seconds) {
    const bonus = timeBonusFor(seconds), chip = $("order-time"), bar = $("order-timebar");
    chip.hidden = !(bonus > 0);
    chip.textContent = `⚡+${Math.round(bonus * 100)}%`;
    chip.classList.toggle("late", bonus > 0 && bonus < 0.5);
    chip.setAttribute("aria-label", bonus > 0 ? `빨리 주면 금화 ${Math.round(bonus * 100)}% 더` : "");
    bar.hidden = !(bonus > 0);
    bar.style.transform = `scaleX(${Math.max(0, Math.min(1, 1 - seconds / 60)).toFixed(3)})`;
    bar.classList.toggle("late", bonus > 0 && bonus < 0.5);
  }
  // memory orders: the text (and the colour / conditions) hide 5 s after shown
  function hideOrderLater(ms = 5000) {
    clearTimeout(memoTimer); memoTimer = 0;
    if (memoHolds > 0) { memoLeft = ms; return; }
    memoAt = performance.now() + ms;
    memoTimer = setTimeout(() => { memoTimer = 0; setOrderHidden(true); }, ms);
  }
  function holdMemo(on) {
    memoHolds = Math.max(0, memoHolds + (on ? 1 : -1));
    if (on && memoHolds === 1 && memoTimer) { memoLeft = Math.max(0, memoAt - performance.now()); clearTimeout(memoTimer); memoTimer = 0; }
    else if (!on && memoHolds === 0 && memoLeft > 0) { const ms = memoLeft; memoLeft = 0; hideOrderLater(ms); }
  }
  function setOrderHidden(hidden) {
    orderHidden = hidden;
    $("order").classList.toggle("memo-hidden", hidden);
    $("order-text").textContent = hidden ? `🙈 기억해요! 톡 누르면 다시 보여요 (금화 ${MEMORY_PEEK_COST}개)` : currentOrder?.text || "";
  }
  function peekOrder() { setOrderHidden(false); hideOrderLater(); }

  // ---------------------------------------------------------------- reward
  // kind: "eat" (stars 1..4, ★4 = special) | "spit" | "kick" (coins lost).
  // breakdown (eat): {base, rare, combo, kind, time, overflow} from progress.feed().
  // starMod (the tummy, progress.modifyStars()): the whole result, or just its
  // mod string. Badges: full → "🍮 배불러요 ★−1", nope → "🚽 헛걸음 ★−1",
  // happy → "😊 기분 최고 ★+1"; "cancel" shows the bonus and the penalty with
  // "= ±0". nopeTurns / happyTurns = turns left after this outcome ("· 남은
  // n회" when > 0). Stars are already the final ones.
  async function showReward({ kind = "eat", stars = 1, coins = 0, xp = 0, mood, levelUps = [], bonus = 0, breakdown = null, orderKind = "normal", streak = 0, starMod = null, nopeTurns = 0, happyTurns = 0 }) {
    const sm = typeof starMod === "string" ? { mod: starMod, full: starMod === "full", nope: starMod === "nope", happy: starMod === "happy" } : starMod || { mod: null };
    const smod = sm.mod;
    const card = $("reward"), inner = card.querySelector(".reward-card");
    inner.classList.toggle("spit", kind === "spit");
    inner.classList.toggle("kick", kind === "kick");
    inner.classList.toggle("golden", kind === "eat" && orderKind === "golden");
    const starsEl = $("reward-stars");
    starsEl.classList.toggle("special", stars === 4 && kind === "eat");
    starsEl.innerHTML = kind === "eat"
      ? [1, 2, 3, 4].filter((i) => i <= Math.max(3, stars)).map((i) => `<span class="${i <= stars ? "" : "off"}">★</span>`).join("")
      : kind === "kick" ? "🦶" : "💦";
    $("reward-text").textContent = kind === "kick" ? "뻥! 냄새만 맡고 차 버렸어요"
      : kind === "spit" ? "퉤! 토끼 입맛에 너무 안 맞았어요"
      : mood === "special" ? (bonus ? "최고예요!! 레어 보석까지 들어간 특별한 젤리!" : "최고예요!! 기분 좋은 날의 특별한 젤리!")
      : mood === "happy" ? (bonus ? "레어 보석 덕분에 별 하나 더! 맛있어요" : smod === "happy" ? "기분이 좋아서 별 하나 더! 맛있어요" : "완전 맛있어요! 주문 그대로예요")
      : mood === "ok" ? (bonus ? "레어 보석이 반짝여서 별 하나 더!" : smod === "happy" ? "기분이 좋아서 별 하나 더!" : "맛있어요! 조금 달랐지만 좋아요")
      : "음… 주문이랑 많이 달라요";
    const modEl = $("reward-mod"), left = (n) => (n > 0 ? ` · 남은 ${n}회` : "");
    const badges = [];
    const happyBadge = `<span class="happy">😊 기분 최고 ★+1${kind === "eat" ? left(happyTurns) : ""}</span>`;
    if (smod === "happy") badges.push(happyBadge);
    if (smod === "cancel" && (sm.happy ?? true)) badges.push(happyBadge);
    // the penalty: full wins the label (both together are still −1)
    if (smod === "full" || (smod === "cancel" && sm.full)) badges.push(`<span class="full">🍮 배불러요 ★−1</span>`);
    else if (smod === "nope" || (smod === "cancel" && sm.nope)) badges.push(`<span class="nope">🚽 헛걸음 ★−1${left(nopeTurns)}</span>`);
    if (smod === "cancel") badges.push(`<span class="net">= ±0</span>`);
    modEl.hidden = badges.length === 0;
    modEl.className = `reward-mod ${smod || ""}`;
    modEl.innerHTML = badges.join("");
    const loss = kind === "spit" || kind === "kick";
    const coinsEl = $("reward-coins");
    coinsEl.classList.toggle("loss", loss);
    coinsEl.textContent = loss ? `-${coins}` : `+${coins}`;
    $("reward-xp").textContent = xp ? `♥ +${xp}` : "";
    // 기본 + 레어 보석, then the multipliers (only when there is more than the base)
    const brk = $("reward-break"), b = kind === "eat" ? breakdown : null;
    const chips = [];
    if (b && (b.rare > 0 || b.combo > 1 || b.kind > 1 || b.time > 0 || b.overflow > 0)) {
      chips.push(`<span>기본 ${b.base}</span>`);
      if (b.rare > 0) chips.push(`<span class="rare">💎 레어 보석 +${b.rare}</span>`);
      if (b.combo > 1) chips.push(`<span class="combo">🔥 ${streak > 1 ? `${streak}연속 ` : ""}콤보 ×${b.combo}</span>`);
      if (b.kind > 1) chips.push(`<span class="kind">${orderKind === "picky" ? "🧐 까다로운 날" : "✨ 황금"} ×${b.kind}</span>`);
      if (b.time > 0) chips.push(`<span class="time">⚡ 시간 +${Math.round(b.time * 100)}%</span>`);
      if (b.overflow > 0) chips.push(`<span class="overflow">⭐ +${b.overflow} 넘친 별</span>`);
    }
    brk.hidden = chips.length === 0;
    brk.innerHTML = chips.join("");
    const lu = levelUps[levelUps.length - 1];
    $("levelup").hidden = !lu;
    if (lu) $("levelup").textContent = `토끼와 더 친해졌어요! Lv${lu.level} 🎁`;
    card.hidden = false;
    inner.style.animation = "none"; void inner.offsetWidth; inner.style.animation = "";
    if (kind === "eat" && stars === 4) { confetti.burst({ x: innerWidth / 2, y: innerHeight * 0.3, kind: "rainbow", count: 130 }); confetti.burst({ x: innerWidth / 2, y: innerHeight * 0.32, kind: "hearts", count: 50 }); confetti.rays({ x: innerWidth / 2, y: innerHeight * 0.28 }); }
    else if (kind === "eat" && stars === 3) confetti.burst({ x: innerWidth / 2, y: innerHeight * 0.3, kind: "hearts", count: 40 });
    if (kind === "eat" && orderKind === "golden" && stars >= 3) confetti.burst({ x: innerWidth / 2, y: innerHeight * 0.26, kind: "gold", count: 60 });
    if (lu) { confetti.burst({ x: innerWidth / 2, y: innerHeight * 0.35, kind: "rainbow", count: 70 }); sounds.levelUp?.(); }
    await wait((lu ? 3400 : stars === 4 ? 3200 : 2600) + (chips.length ? 600 : 0));
    card.hidden = true;
    await wait(150);
  }

  // A small popup in the reward card's place (new colour, achievement…):
  // icon (html), title, text; tone = an extra class ("gold", "secret").
  async function notice({ icon = "", title = "", text = "", tone = "", ms = 2400 }) {
    const box = $("notice"), card = $("notice-card");
    card.className = `reward-card notice-card ${tone}`;
    $("notice-icon").innerHTML = icon;
    $("notice-title").textContent = title;
    $("notice-text").textContent = text;
    $("notice-text").hidden = !text;
    box.hidden = false;
    card.style.animation = "none"; void card.offsetWidth; card.style.animation = "";
    await wait(ms);
    box.hidden = true;
    await wait(150);
  }
  // 🏅 achievements (feed / spit / kick / pull results), one notice each
  function showAchievements(list = []) {
    for (const a of list) {
      enqueue(() => {
        sounds.achievement?.();
        const r = $("notice").getBoundingClientRect?.();
        confetti.burst({ x: innerWidth / 2, y: (r && r.top > 0 ? r.top : 90) + 40, kind: "gold", count: 40 });
        const extra = [a.title ? `칭호 '${a.title}'` : "", a.unlock?.outfit ? `꾸미기 '${OUTFITS.find((o) => o.id === a.unlock.outfit)?.label || a.unlock.outfit}'` : ""].filter(Boolean).join(" · ");
        renderHud();
        return notice({ icon: "🏅", title: `${a.label} +${a.coins}`, text: `${a.desc}${extra ? ` · ${extra} 획득!` : ""}`, tone: "gold" });
      });
    }
  }

  // ---------------------------------------------------------------- gift box
  // One per level-up ({level, rewards, gift} from progress.feed().levelUps):
  // a wobbling box → tap to open → the gift (coins / a rare-gem bundle / a
  // free card) and the level's rewards (paints, shapes or "이미 있어요",
  // outfits, themes). Resolves when the player closes it.
  function rewardChip(r) {
    if (r.kind === "paint" || r.kind === "additive") {
      const hex = (r.kind === "paint" ? PAINTS : ADDITIVES).find((p) => p.id === r.id)?.hex || "#ddd";
      return `<span class="gift-chip"><i class="dot" style="--c:${hex}"></i>${esc(r.label)}</span>`;
    }
    if (r.kind === "shape") return `<span class="gift-chip">${uniqueSvg(shapeIconSVG(r.id))}${esc(r.label)}${r.owned ? ` <em>이미 있어요 +${r.coins}</em>` : ""}</span>`;
    if (r.kind === "outfit") return `<span class="gift-chip"><span class="emoji">${OUTFITS.find((o) => o.id === r.id)?.emoji || "🎀"}</span>${esc(r.label)}</span>`;
    if (r.kind === "theme") return `<span class="gift-chip"><i class="swatch" style="background:${themeLooks[r.id]?.swatch || "#eee"}"></i>${esc(r.label)} 테마</span>`;
    return `<span class="gift-chip">${esc(r.label)}</span>`;
  }
  function prizeHTML(gift) {
    if (!gift) return "";
    if (gift.kind === "coins") return `<i class="coin-icon big" aria-hidden="true"></i><b>+${gift.coins}</b><span>금화</span>`;
    if (gift.kind === "card") return `<span class="mini-card" aria-hidden="true">✦</span><b>+1</b><span>무료 카드</span>`;
    return `<span class="prize-gem" data-index="${gift.index}">${rareIcon(gift.index, gift.tier)}</span><b>+${gift.added}</b><span>${esc(rareInfo(gift.index).label)}${gift.isNew ? " · 새 보석!" : ""}</span>`;
  }
  function giftBox({ level, rewards = [], gift = null }) {
    return new Promise((resolve) => {
      const ov = $("gift"), box = $("gift-box"), content = $("gift-content");
      $("gift-title").textContent = `Lv${level}! 토끼가 선물을 줬어요`;
      $("gift-prize").innerHTML = prizeHTML(gift);
      $("gift-prize").hidden = !gift;
      $("gift-rewards").innerHTML = rewards.length ? `<b>Lv${level}에 새로 생긴 것</b><div>${rewards.map(rewardChip).join("")}</div>` : "";
      const tips = [];
      if (rewards.some((r) => r.kind === "outfit")) tips.push("⚙ 설정 → 토끼 꾸미기에서 입혀 보세요");
      if (rewards.some((r) => r.kind === "theme")) tips.push("⚙ 설정 → 접시·배경 테마에서 바꿀 수 있어요");
      $("gift-tip").hidden = !tips.length;
      $("gift-tip").textContent = tips.join(" · ");
      if (gift?.kind === "rare") rareThumb(gift.index, gift.tier).then((url) => { const el = $("gift-prize").querySelector(".prize-gem"); if (url && el) el.innerHTML = `<img alt="" src="${url}">`; }).catch(() => {});
      content.hidden = true;
      box.className = "gift-box";
      box.hidden = !gift;
      $("gift-hint").hidden = !gift;
      ov.hidden = false;
      let opened = false;
      const open = () => {
        if (opened) return;
        opened = true;
        if (gift) {
          sounds.giftOpen?.();
          box.classList.add("open");
          const r = box.getBoundingClientRect();
          confetti.burst({ x: r.left + r.width / 2, y: r.top + r.height / 2, kind: gift.kind === "coins" ? "gold" : "rainbow", count: 90 });
        }
        setTimeout(() => { box.hidden = true; content.hidden = false; $("gift-hint").hidden = true; renderHud(); }, gift ? 420 : 0);
      };
      box.onclick = open;
      $("gift-ok").onclick = () => { if (!opened) return; ov.hidden = true; box.onclick = null; resolve(); };
      if (!gift) open();
    });
  }

  // Coins being taken away: they hop out of the counter and fall off screen
  // while the number counts down.
  async function loseCoins(amount) {
    const icon = $("coins").querySelector(".coin-icon").getBoundingClientRect();
    const n = Math.min(18, Math.max(3, Math.round(amount / 6)));
    sounds.coinLoss?.(n);
    for (let i = 0; i < n; i++) {
      const c = document.createElement("i");
      c.className = "coin-fly";
      c.style.left = `${icon.left}px`; c.style.top = `${icon.top}px`;
      document.body.appendChild(c);
      const dx = (Math.random() - 0.3) * 160, up = 40 + Math.random() * 60;
      c.animate([
        { transform: "translate(0, 0) rotate(0deg)", opacity: 1 },
        { transform: `translate(${dx * 0.4}px, ${-up}px) rotate(${180 + i * 40}deg)`, opacity: 1, offset: 0.3 },
        { transform: `translate(${dx}px, ${innerHeight * 0.6}px) rotate(${540 + i * 60}deg)`, opacity: 0 },
      ], { duration: 1100 + Math.random() * 300, delay: i * 45, easing: "cubic-bezier(.3,.1,.6,1)" }).finished.then(() => c.remove());
    }
    const from = shownCoins, to = progress.coins, steps = 20;
    for (let k = 1; k <= steps; k++) { await wait(45); shownCoins = Math.round(from + (to - from) * k / steps); $("coin-count").textContent = String(shownCoins); }
    renderHud();
  }

  // ---------------------------------------------------------------- gacha
  let pulling = false;
  function openGacha() {
    $("gacha").hidden = false;
    resetCards();
    renderHud();
  }
  function closeGacha() { if (pulling) return; $("gacha").hidden = true; }
  function resetCards() {
    $("cards").textContent = "";
    $("gacha-result").hidden = true;
    $("gacha-hint").textContent = progress.freeCards > 0 ? "무료 카드가 있어요! 버튼을 눌러 받으세요" : progress.canPull ? "버튼을 눌러 카드를 받으세요" : "토끼에게 젤리를 먹여 금화를 모아요";
    $("pull-button").hidden = false;
  }
  async function deal() {
    if (pulling || !progress.canPull) return;
    pulling = true;
    $("pull-button").hidden = true;
    $("gacha-result").hidden = true;
    const cards = $("cards");
    cards.textContent = "";
    for (let i = 0; i < 3; i++) {
      const c = document.createElement("button");
      c.className = "card";
      c.setAttribute("aria-label", `카드 ${i + 1}`);
      c.innerHTML = `<div class="face back">✦</div><div class="face front"></div>`;
      c.addEventListener("click", () => pick(c), { once: true });
      cards.appendChild(c);
    }
    sounds.cardFlip?.();
    $("gacha-hint").textContent = "카드 한 장을 골라 보세요";
    pulling = "choosing";
  }
  async function pick(card) {
    if (pulling !== "choosing") return;
    pulling = true;
    const result = onPull();                 // progress.pull() + app side effects
    if (!result) { pulling = false; resetCards(); return; }
    renderHud();
    // the other two simply leave — they are never turned over
    for (const c of $("cards").children) if (c !== card) c.classList.add("gone");
    card.classList.add("picked");
    $("gacha-hint").textContent = "두근두근…";
    // shape and outfit cards are "special": no gem index / tier, gold glow
    const isShape = result.type === "shape", isOutfit = result.type === "outfit", special = isShape || isOutfit;
    const thumb = special ? Promise.resolve(null) : rareThumb(result.index, result.tier).catch(() => null);
    await wait(350);
    card.classList.add("shake");
    sounds.cardShake?.();
    const suspense = special ? 1500 : result.kind === "rainbow" ? 1300 : result.kind === "gold" ? 1000 : 750;
    const [img] = await Promise.all([thumb, wait(suspense)]);
    const front = card.querySelector(".front");
    if (isShape) front.innerHTML = `<span class="shape-face">${uniqueSvg(shapeIconSVG(result.id))}</span><span class="tier-label">모양 카드</span>`;
    else if (isOutfit) front.innerHTML = `<span class="outfit-face">${esc(result.emoji)}</span><span class="tier-label">꾸미기 카드</span>`;
    else front.innerHTML = (img ? `<img alt="" src="${img}">` : rareIcon(result.index, result.tier)) + `<span class="tier-label">${TIER_LABELS[result.tier]}</span><span class="bundle">×${result.added}</span>`;
    card.classList.remove("shake");
    card.classList.add("flip", ...(isShape ? ["shape-card"] : isOutfit ? ["shape-card", "outfit-card"] : [`t${result.tier}`]));
    sounds.cardFlip?.();
    await wait(380);
    const glow = special || result.kind === "gold" ? "gold" : result.kind === "rainbow" ? "rainbow" : result.kind === "more" ? "more" : "new";
    card.classList.add(`glow-${glow}`);
    sounds.reveal?.(special ? "rainbow" : result.kind === "more" ? "dupe" : result.kind);
    if (isOutfit) setTimeout(() => sounds.wandTwinkle?.(), 260);
    const r = card.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (special) { confetti.burst({ x: cx, y: cy, kind: "gold", count: 150 }); confetti.burst({ x: cx, y: cy, kind: "rainbow", count: 60 }); confetti.rays({ x: cx, y: cy }); }
    else if (result.kind === "rainbow") { confetti.burst({ x: cx, y: cy, kind: "rainbow", count: 160 }); confetti.rays({ x: cx, y: cy }); }
    else if (result.kind === "gold") confetti.burst({ x: cx, y: cy, kind: "gold", count: 110 });
    else if (result.kind === "new") confetti.burst({ x: cx, y: cy, kind: "sparkle", count: 70 });
    else confetti.burst({ x: cx, y: cy, kind: "gold", count: 30 });
    $("gacha-hint").textContent = result.usedFree ? "🎴 무료 카드를 썼어요" : "";
    if (isShape) {
      $("gacha-title").textContent = `${result.label} 획득!`;
      $("gacha-sub").textContent = "100장에 1장 나오는 모양 카드! 친밀도를 기다리지 않고 지금 바로 쓸 수 있어요";
    } else if (isOutfit) {
      $("gacha-title").textContent = `꾸미기 카드! ${result.emoji} ${result.label}`;
      $("gacha-sub").textContent = "카드에서만 나오는 옷이에요! ⚙ 설정 → 토끼 꾸미기에서 입혀 주세요";
    } else {
      const info = rareInfo(result.index), more = `+${result.added}개 (이제 ${result.count}개)`;
      $("gacha-title").textContent = result.kind === "new" ? `새 보석! ${info.label}` : result.kind === "more" ? `${info.label} +${result.added}개` : `${info.label} 업그레이드!`;
      $("gacha-sub").textContent = result.kind === "new" ? `글리터 등급 · ${result.added}개가 보석함에 들어갔어요`
        : result.kind === "gold" ? `글리터 → 금빛 ✨ · ${more}`
        : result.kind === "rainbow" ? `금빛 → 무지개빛 🌈 최고 등급! · ${more}`
        : `이미 무지개빛이라 보석만 ${more}`;
    }
    $("gacha-result").hidden = false;
    await wait(700);
    pulling = false;
    $("pull-button").hidden = false;
    renderHud();
    showAchievements(result.achievements);
  }
  $("gacha-button").addEventListener("click", openGacha);
  $("coins").addEventListener("click", openGacha);
  $("gacha-close").addEventListener("click", closeGacha);
  $("pull-button").addEventListener("click", deal);

  // ---------------------------------------------------------------- book
  let tab = "rare";
  const TABS = ["rare", "album", "colors", "achievements", "secrets"];
  const PANES = { rare: "book-rare", album: "book-album", colors: "book-colors", achievements: "book-achievements", secrets: "book-secrets" };
  async function openBook() {
    $("book").hidden = false;
    await renderBook();
  }
  function rewardText(r) {
    return [r.coins ? `금화 ${r.coins}` : "", r.theme ? `'${themeLooks[r.theme]?.label || r.theme}' 테마` : "", r.freeCards ? `무료 카드 ${r.freeCards}장` : "", r.title ? `칭호 '${r.title}'` : ""].filter(Boolean).join(" + ");
  }
  async function renderBook() {
    for (const b of $("book-tabs").children) { const on = b.dataset.tab === tab; b.classList.toggle("active", on); b.setAttribute("aria-selected", String(on)); }
    for (const t of TABS) $(PANES[t]).hidden = t !== tab;
    const count = $("book-count");
    if (tab === "rare") {
      const owned = progress.state.rare.filter((t) => t >= 0).length, rainbow = progress.state.rare.filter((t) => t === 2).length;
      count.textContent = `레어 보석 ${owned} / ${RARE_COUNT} · 무지개빛 ${rainbow}개`;
      const grid = $("book-rare");
      grid.textContent = "";
      for (let i = 0; i < RARE_COUNT; i++) {
        const tier = progress.state.rare[i], left = progress.rareCountOf(i), cell = document.createElement("div");
        cell.className = `book-cell ${tier < 0 ? "locked" : `t${tier}`}${tier >= 0 && !left ? " spent" : ""}`;
        cell.innerHTML = `<span class="gem-icon">${rareIcon(i, Math.max(0, tier))}</span><span>${tier < 0 ? "?" : esc(rareInfo(i).label)}</span>${tier >= 0 ? `<i class="count">×${left}</i>` : ""}`;
        grid.appendChild(cell);
        if (tier >= 0) rareThumb(i, tier).then((url) => { if (url) cell.firstElementChild.innerHTML = `<img alt="" src="${url}">`; }).catch(() => {});
      }
    } else if (tab === "album") {
      const album = progress.state.album;
      count.textContent = `토끼가 먹은 작품 ${album.length}개 (최근 60개)`;
      const grid = $("book-album");
      grid.innerHTML = album.length ? "" : `<p class="empty">아직 없어요. 젤리를 만들어 🥕 토끼에게 먹여 보세요!</p>`;
      for (const a of [...album].reverse()) {
        const card = document.createElement("div");
        card.className = "album-card";
        const date = new Date(a.date || Date.now());
        card.innerHTML = `${a.thumb ? `<img alt="" src="${a.thumb}">` : `<img alt="" style="background:${a.hex}">`}<b>${a.shapeLabel ? esc(a.shapeLabel) + " · " : ""}${esc(a.name || "젤리")}${a.texture === "slime" ? " 슬랑이" : ""}</b><span>${"★".repeat(a.stars || 1)}${"☆".repeat(Math.max(0, 3 - (a.stars || 1)))}</span><br><span class="small">${date.getMonth() + 1}월 ${date.getDate()}일</span>`;
        grid.appendChild(card);
      }
    } else if (tab === "colors") {
      const list = progress.colorBookList(), found = list.filter((c) => c.found).length;
      const next = COLOR_BOOK_REWARDS.find((r) => !progress.state.colorRewards.includes(r.id));
      count.innerHTML = `색 도감 <b>${found} / ${list.length}</b>${next ? `<br>다음 보상: ${next.all ? "모두 모으면" : `${next.at}개`} → ${esc(rewardText(next))}` : "<br>색 도감을 모두 채웠어요! 🎨"}`;
      const grid = $("book-colors");
      grid.textContent = "";
      for (const c of list) {
        const cell = document.createElement("div");
        cell.className = "color-cell" + (c.found ? "" : " unfound");
        cell.innerHTML = c.found ? `<i class="swatch" style="--c:${c.hex}"></i><span>${esc(c.name)}</span>` : `<i class="swatch">?</i><span>???</span>`;
        grid.appendChild(cell);
      }
    } else if (tab === "achievements") {
      const list = progress.achievementList(), done = list.filter((a) => a.done).length, titles = progress.titles(), worn = progress.title?.id || null;
      count.textContent = `업적 ${done} / ${list.length} · 칭호를 골라 친밀도 옆에 달 수 있어요`;
      const box = $("book-achievements");
      box.textContent = "";
      const row = document.createElement("div");
      row.className = "title-row";
      row.innerHTML = `<b>칭호</b>`;
      const chip = (id, label) => {
        const b = document.createElement("button");
        b.className = "title-chip" + ((worn || null) === id ? " active" : "");
        b.textContent = label;
        b.setAttribute("aria-pressed", String((worn || null) === id));
        b.addEventListener("click", () => setTitle(id));
        row.appendChild(b);
      };
      chip(null, "없음");
      for (const t of titles) chip(t.id, t.label);
      if (!titles.length) row.insertAdjacentHTML("beforeend", `<span class="small">업적을 모으면 칭호가 생겨요</span>`);
      box.appendChild(row);
      for (const a of list) {
        const el = document.createElement(a.done && a.title ? "button" : "div");
        el.className = "ach" + (a.done ? " done" : "") + (a.title && worn === a.id ? " worn" : "");
        const unlock = a.unlock?.outfit ? `꾸미기 '${OUTFITS.find((o) => o.id === a.unlock.outfit)?.label || ""}'` : "";
        const titleText = a.title ? `칭호 '${esc(a.title)}'${a.done ? (worn === a.id ? " · 달고 있어요 ✓" : " · 톡 해서 달기") : ""}` : "";
        el.innerHTML = `<span class="medal">${a.done ? "🏅" : "🔒"}</span><span class="ach-body"><b>${esc(a.label)}</b><span>${esc(a.desc)}</span>${titleText || unlock ? `<em>${titleText}${titleText && unlock ? " · " : ""}${esc(unlock)}</em>` : ""}</span><span class="ach-coins">+${a.coins}</span>`;
        if (a.done && a.title) el.addEventListener("click", () => setTitle(worn === a.id ? null : a.id));
        box.appendChild(el);
      }
    } else if (tab === "secrets") {
      const list = progress.secretList(), found = list.filter((s) => s.found).length;
      count.textContent = `숨은 레시피 ${found} / ${list.length} · 힌트를 보고 만들어 토끼에게 먹여 보세요`;
      const grid = $("book-secrets");
      grid.textContent = "";
      for (const s of list) {
        const cell = document.createElement("div");
        cell.className = "secret-card" + (s.found ? " found" : "");
        cell.innerHTML = s.found ? `<span class="emoji">${s.emoji}</span><b>${esc(s.label)}</b><span class="small">${esc(s.hint)}</span>` : `<span class="emoji">❔</span><b>???</b><span class="small">${esc(s.hint)}</span>`;
        grid.appendChild(cell);
      }
    }
  }
  function setTitle(id) {
    if (!progress.setTitle(id)) return;
    renderHud();
    renderBook();
    onTitle?.(progress.title);
  }
  $("book-button").addEventListener("click", openBook);
  $("book-close").addEventListener("click", () => { $("book").hidden = true; });
  $("book-tabs").addEventListener("click", (e) => { const t = e.target.closest("[data-tab]"); if (t) { tab = t.dataset.tab; renderBook(); } });

  return {
    renderHud, renderTummy, addCoin, loseCoins, coinCounterNDC, showOrder, setOrderTime, peekOrder, holdMemo, showReward, notice, giftBox,
    showAchievements, enqueue, renderBook, confetti,
    get orderHidden() { return orderHidden; },
    get busy() { return Boolean(pulling); },
  };
}

// ---------------------------------------------------------------- confetti
class Confetti {
  constructor(canvas) {
    this.canvas = canvas; this.ctx = canvas.getContext("2d"); this.parts = []; this.rayList = []; this.running = false;
    const resize = () => { const d = Math.min(2, devicePixelRatio || 1); canvas.width = innerWidth * d; canvas.height = innerHeight * d; this.dpr = d; };
    resize(); addEventListener("resize", resize);
  }
  burst({ x, y, kind = "rainbow", count = 80 }) {
    const palettes = {
      rainbow: ["#ff8fb1", "#ffd36b", "#8af0b4", "#7ec8ff", "#c49bff", "#ffffff"],
      gold: ["#ffd34d", "#ffe9a3", "#f0a400", "#fff6c8"],
      sparkle: ["#ffd6ea", "#ffffff", "#e7d6ff", "#cdeaff"],
      hearts: ["#ff8fb1", "#ff6b8b", "#ffc1d3"],
    };
    const colors = palettes[kind] || palettes.rainbow;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, sp = 3 + Math.random() * 9;
      this.parts.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 6, g: 0.28 + Math.random() * 0.12,
        size: 4 + Math.random() * 7, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4,
        color: colors[i % colors.length], life: 1, decay: 0.006 + Math.random() * 0.01,
        shape: kind === "hearts" ? "heart" : kind === "sparkle" || (kind === "gold" && i % 3 === 0) ? "star" : i % 4 === 0 ? "circle" : "rect",
      });
    }
    this.start();
  }
  rays({ x, y }) { this.rayList.push({ x, y, t: 0 }); this.start(); }
  start() {
    if (this.running) return;
    this.running = true;
    const step = () => {
      const c = this.ctx, d = this.dpr;
      c.clearRect(0, 0, this.canvas.width, this.canvas.height);
      for (const r of this.rayList) {
        r.t += 1 / 60;
        const alpha = Math.max(0, 1 - r.t / 2.2);
        c.save(); c.translate(r.x * d, r.y * d); c.rotate(r.t * 0.6);
        for (let k = 0; k < 12; k++) {
          c.rotate(Math.PI / 6);
          const grad = c.createLinearGradient(0, 0, 0, -innerHeight * d);
          grad.addColorStop(0, `hsla(${k * 30},100%,80%,${0.45 * alpha})`); grad.addColorStop(1, "hsla(0,0%,100%,0)");
          c.fillStyle = grad;
          c.beginPath(); c.moveTo(0, 0); c.lineTo(-40 * d, -innerHeight * d); c.lineTo(40 * d, -innerHeight * d); c.closePath(); c.fill();
        }
        c.restore();
      }
      this.rayList = this.rayList.filter((r) => r.t < 2.2);
      for (const p of this.parts) {
        p.vx *= 0.985; p.vy = p.vy * 0.985 + p.g; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.life -= p.decay;
        c.save(); c.globalAlpha = Math.max(0, Math.min(1, p.life * 1.5)); c.translate(p.x * d, p.y * d); c.rotate(p.rot); c.fillStyle = p.color;
        const s = p.size * d;
        if (p.shape === "rect") c.fillRect(-s / 2, -s / 4, s, s / 2);
        else if (p.shape === "circle") { c.beginPath(); c.arc(0, 0, s / 2.5, 0, 6.283); c.fill(); }
        else if (p.shape === "star") { c.beginPath(); for (let k = 0; k < 8; k++) { const rr = k % 2 ? s * 0.18 : s * 0.6, a = (k / 8) * 6.283; c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); } c.closePath(); c.fill(); }
        else { c.beginPath(); c.moveTo(0, s * 0.3); c.bezierCurveTo(s * 0.6, -s * 0.2, s * 0.25, -s * 0.6, 0, -s * 0.25); c.bezierCurveTo(-s * 0.25, -s * 0.6, -s * 0.6, -s * 0.2, 0, s * 0.3); c.fill(); }
        c.restore();
      }
      this.parts = this.parts.filter((p) => p.life > 0 && p.y < innerHeight + 40);
      if (this.parts.length || this.rayList.length) requestAnimationFrame(step);
      else { this.running = false; c.clearRect(0, 0, this.canvas.width, this.canvas.height); }
    };
    requestAnimationFrame(step);
  }
}
