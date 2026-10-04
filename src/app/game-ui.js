// DOM side of the bunny game: coin / friendship HUD, the order card, the
// reward card after a meal, the card-pull overlay (three face-down cards →
// pick → shake → flip → celebration), the book (rare gems + album) and a
// small confetti engine.
import { PULL_COST, TIER_LABELS, RARE_COUNT } from "./progress.js";
import { gemIconSVG } from "../render/gems.js";

const $ = (id) => document.getElementById(id);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function createGameUI({ progress, rareInfo, rareIcon, rareThumb, onPull, sounds }) {
  // rareInfo(index) → { label, color }; rareIcon(index, tier) → html (instant);
  // rareThumb(index, tier) → Promise<dataURL | null> (pretty 3D render).
  const confetti = new Confetti($("confetti"));

  // ---------------------------------------------------------------- HUD
  let shownCoins = progress.coins;
  function renderHud({ animateCoins = false } = {}) {
    if (!animateCoins) shownCoins = progress.coins;
    $("coin-count").textContent = String(shownCoins);
    $("gacha-coins").textContent = String(progress.coins);
    const lv = progress.level;
    $("friend-level").textContent = `Lv${lv.level}`;
    $("friend-bar").style.width = `${Math.round(100 * (lv.xp - lv.from) / Math.max(1, lv.to - lv.from))}%`;
    $("gacha-button").classList.toggle("ready", progress.canPull);
    $("pull-button").disabled = !progress.canPull;
    $("pull-button").textContent = progress.canPull ? `금화 ${PULL_COST}개로 뽑기` : `금화가 ${PULL_COST - progress.coins}개 더 필요해요`;
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
  function showOrder(order) {
    const el = $("order");
    if (!order) { el.hidden = true; return; }
    el.hidden = false;
    $("order-swatch").style.setProperty("--c", order.hex);
    $("order-text").textContent = order.text;
    $("order-gem").innerHTML = order.gems ? gemIconSVG(order.gems.shape, "#f4a3c4") : "";
    el.classList.remove("pop"); void el.offsetWidth; el.classList.add("pop");
  }

  // ---------------------------------------------------------------- reward
  async function showReward({ stars, coins, xp, mood, levelUps }) {
    const card = $("reward");
    $("reward-stars").innerHTML = [1, 2, 3].map((i) => `<span class="${i <= stars ? "" : "off"}">★</span>`).join("");
    $("reward-text").textContent = mood === "happy" ? "완전 맛있어요! 주문 그대로예요" : mood === "ok" ? "맛있어요! 조금 달랐지만 좋아요" : "음… 주문이랑 많이 달라요";
    $("reward-coins").textContent = `+${coins}`;
    $("reward-xp").textContent = `♥ +${xp}`;
    const lu = levelUps[levelUps.length - 1];
    $("levelup").hidden = !lu;
    if (lu) $("levelup").textContent = `토끼와 더 친해졌어요! Lv${lu.level}` + (lu.reward ? ` · ${lu.reward.label} 생김` : "");
    card.hidden = false;
    if (stars === 3) confetti.burst({ x: innerWidth / 2, y: innerHeight * 0.3, kind: "hearts", count: 40 });
    if (lu) { confetti.burst({ x: innerWidth / 2, y: innerHeight * 0.35, kind: "rainbow", count: 70 }); sounds.levelUp?.(); }
    await wait(lu ? 3600 : 2600);
    card.hidden = true;
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
    $("gacha-hint").textContent = progress.canPull ? "버튼을 눌러 카드를 받으세요" : "토끼에게 젤리를 먹여 금화를 모아요";
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
    const thumb = rareThumb(result.index, result.tier).catch(() => null);
    await wait(350);
    card.classList.add("shake");
    sounds.cardShake?.();
    const [img] = await Promise.all([thumb, wait(result.kind === "rainbow" ? 1300 : result.kind === "gold" ? 1000 : 750)]);
    const front = card.querySelector(".front"), info = rareInfo(result.index);
    front.innerHTML = (img ? `<img alt="" src="${img}">` : rareIcon(result.index, result.tier)) + `<span class="tier-label">${TIER_LABELS[result.tier]}</span>`;
    card.classList.remove("shake");
    card.classList.add("flip", `t${result.tier}`);
    sounds.cardFlip?.();
    await wait(380);
    const glow = result.kind === "rainbow" || (result.kind === "dupe") ? "rainbow" : result.kind === "gold" ? "gold" : "new";
    card.classList.add(`glow-${glow}`);
    sounds.reveal?.(result.kind);
    const r = card.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (result.kind === "rainbow") { confetti.burst({ x: cx, y: cy, kind: "rainbow", count: 160 }); confetti.rays({ x: cx, y: cy }); }
    else if (result.kind === "gold") confetti.burst({ x: cx, y: cy, kind: "gold", count: 110 });
    else if (result.kind === "new") confetti.burst({ x: cx, y: cy, kind: "sparkle", count: 70 });
    else confetti.burst({ x: cx, y: cy, kind: "gold", count: 30 });
    $("gacha-hint").textContent = "";
    $("gacha-title").textContent = result.kind === "new" ? `새 보석! ${info.label}` : result.kind === "dupe" ? `${info.label} · 이미 무지개빛이에요` : `${info.label} 업그레이드!`;
    $("gacha-sub").textContent = result.kind === "new" ? "글리터 등급 · 보석함에 들어갔어요" : result.kind === "gold" ? "글리터 → 금빛 ✨" : result.kind === "rainbow" ? "금빛 → 무지개빛 🌈 최고 등급!" : `금화 ${result.refund}개를 돌려받았어요`;
    $("gacha-result").hidden = false;
    await wait(700);
    pulling = false;
    $("pull-button").hidden = false;
    renderHud();
  }
  $("gacha-button").addEventListener("click", openGacha);
  $("coins").addEventListener("click", openGacha);
  $("gacha-close").addEventListener("click", closeGacha);
  $("pull-button").addEventListener("click", deal);

  // ---------------------------------------------------------------- book
  let tab = "rare";
  async function openBook() {
    $("book").hidden = false;
    await renderBook();
  }
  async function renderBook() {
    for (const b of $("book-tabs").children) b.classList.toggle("active", b.dataset.tab === tab);
    $("book-rare").hidden = tab !== "rare"; $("book-album").hidden = tab !== "album";
    if (tab === "rare") {
      const owned = progress.state.rare.filter((t) => t >= 0).length, rainbow = progress.state.rare.filter((t) => t === 2).length;
      $("book-count").textContent = `레어 보석 ${owned} / ${RARE_COUNT} · 무지개빛 ${rainbow}개`;
      const grid = $("book-rare");
      grid.textContent = "";
      for (let i = 0; i < RARE_COUNT; i++) {
        const tier = progress.state.rare[i], cell = document.createElement("div");
        cell.className = `book-cell ${tier < 0 ? "locked" : `t${tier}`}`;
        cell.innerHTML = `${rareIcon(i, Math.max(0, tier))}<span>${tier < 0 ? "?" : rareInfo(i).label}</span>`;
        grid.appendChild(cell);
        if (tier >= 0) rareThumb(i, tier).then((url) => { if (url) cell.firstElementChild.outerHTML = `<img alt="" src="${url}">`; }).catch(() => {});
      }
    } else {
      const album = progress.state.album;
      $("book-count").textContent = `토끼가 먹은 작품 ${album.length}개 (최근 60개)`;
      const grid = $("book-album");
      grid.innerHTML = album.length ? "" : `<p class="empty">아직 없어요. 젤리를 만들어 🥕 토끼에게 먹여 보세요!</p>`;
      for (const a of [...album].reverse()) {
        const card = document.createElement("div");
        card.className = "album-card";
        const date = new Date(a.date || Date.now());
        card.innerHTML = `${a.thumb ? `<img alt="" src="${a.thumb}">` : `<img alt="" style="background:${a.hex}">`}<b>${a.name || "젤리"}${a.texture === "slime" ? " 슬랑이" : ""}</b><span>${"★".repeat(a.stars || 1)}${"☆".repeat(3 - (a.stars || 1))}</span><br><span class="small">${date.getMonth() + 1}월 ${date.getDate()}일</span>`;
        grid.appendChild(card);
      }
    }
  }
  $("book-button").addEventListener("click", openBook);
  $("book-close").addEventListener("click", () => { $("book").hidden = true; });
  $("book-tabs").addEventListener("click", (e) => { const t = e.target.closest("[data-tab]"); if (t) { tab = t.dataset.tab; renderBook(); } });

  return { renderHud, addCoin, coinCounterNDC, showOrder, showReward, confetti, get busy() { return Boolean(pulling); } };
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
