// Small pastel icons (48×48 SVG) for the jelly / 슬랑이 shapes the player can
// pick: flower jelly, fluted pudding, rainbow cake slice with a cherry, gummy
// bear, glitter cat and iridescent bird. `locked` draws the same silhouette in
// grey with a tiny padlock. Strings are cached; gradient ids are unique per
// shape + state, so many icons can live in one document.

export const SHAPE_ICON_IDS = Object.freeze(["flower", "pudding", "cake", "bear", "cat", "bird"]);

const cache = new Map();
const warned = new Set();
const f1 = (x) => (Math.round(x * 10) / 10).toString();

// Closed polar outline (SVG path) — r(θ) around (cx, cy), y squashed by sy.
function polarPath(cx, cy, r, sy = 1, n = 64) {
  let d = "";
  for (let i = 0; i < n; i += 1) {
    const t = (i / n) * Math.PI * 2, rr = r(t);
    d += `${i ? "L" : "M"}${f1(cx + Math.cos(t) * rr)} ${f1(cy + Math.sin(t) * rr * sy)}`;
  }
  return d + "Z";
}

const SPARK = (x, y, s = 1, o = 1) => `<path d="M${f1(x)} ${f1(y - 2.6 * s)}l${f1(0.7 * s)} ${f1(1.9 * s)} ${f1(1.9 * s)} ${f1(0.7 * s)}-${f1(1.9 * s)} ${f1(0.7 * s)}-${f1(0.7 * s)} ${f1(1.9 * s)}-${f1(0.7 * s)}-${f1(1.9 * s)}-${f1(1.9 * s)}-${f1(0.7 * s)} ${f1(1.9 * s)}-${f1(0.7 * s)}z" fill="#fff" opacity="${o}"/>`;

// Each icon: { sil: silhouette path markup (no fill), art: (p) => full-colour markup } (p = id prefix).
const ICONS = {
  flower: (() => {
    const lobes = (k) => (t) => k * (1 + 0.17 * Math.cos(5 * (t + Math.PI / 2)) + 0.02 * Math.cos(10 * (t + Math.PI / 2)));
    const top = polarPath(24, 21, lobes(17), 0.74);
    const sides = [6, 4, 2].map((dy) => polarPath(24, 21 + dy, lobes(17), 0.74));
    const inner = polarPath(24, 20.6, lobes(9), 0.74);
    return {
      sil: sides.map((d) => `<path d="${d}"/>`).join("") + `<path d="${top}"/>`,
      art: (p) => `<defs>
        <radialGradient id="${p}t" cx=".42" cy=".36" r=".72"><stop offset="0" stop-color="#fff1f6"/><stop offset=".55" stop-color="#ffc2d8"/><stop offset="1" stop-color="#ff8db5"/></radialGradient>
        <linearGradient id="${p}s" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#ff86b0"/><stop offset="1" stop-color="#f0608f"/></linearGradient></defs>
        ${sides.map((d, i) => `<path d="${d}" fill="url(#${p}s)" opacity="${[0.9, 0.95, 1][i]}"/>`).join("")}
        <path d="${top}" fill="url(#${p}t)" stroke="#fff" stroke-opacity=".7" stroke-width=".8"/>
        <path d="${inner}" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="1"/>
        <ellipse cx="16" cy="15.5" rx="5.2" ry="2.3" transform="rotate(-22 16 15.5)" fill="#fff" opacity=".85"/>
        <circle cx="31.5" cy="25.5" r="1.1" fill="#fff" opacity=".8"/>
        ${SPARK(36, 12, 0.9)}`,
    };
  })(),

  pudding: (() => {
    const body = "M13.5 12.5C12.5 20 7.5 27 6.6 34.5C6.2 38 8.5 40.6 12 41.2C15 42.6 19 43.3 24 43.3C29 43.3 33 42.6 36 41.2C39.5 40.6 41.8 38 41.4 34.5C40.5 27 35.5 20 34.5 12.5Z";
    const crown = polarPath(24, 12.2, (t) => 11 * (1 + 0.07 * Math.cos(6 * t)), 0.4, 72);
    const flutes = [-0.95, -0.55, -0.15, 0.25, 0.65].map((a) => {
      const xt = 24 + 10.5 * Math.sin(a + 0.2), xb = 24 + 17 * Math.sin(a + 0.2);
      return `M${f1(xt)} 14.6C${f1(xt + (xb - xt) * 0.25)} 24 ${f1(xb)} 31 ${f1(xb)} 39`;
    });
    const grooves = [-0.75, -0.35, 0.05, 0.45, 0.85].map((a) => {
      const xt = 24 + 10.5 * Math.sin(a + 0.2), xb = 24 + 17 * Math.sin(a + 0.2);
      return `M${f1(xt)} 15C${f1(xt + (xb - xt) * 0.25)} 24 ${f1(xb)} 31 ${f1(xb)} 40.5`;
    });
    return {
      sil: `<path d="${body}"/><path d="${crown}"/>`,
      art: (p) => `<defs>
        <linearGradient id="${p}b" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#ee5790"/><stop offset=".45" stop-color="#ff96bd"/><stop offset="1" stop-color="#ffe8f0"/></linearGradient>
        <radialGradient id="${p}c" cx=".5" cy=".55" r=".6"><stop offset="0" stop-color="#ff9cc2"/><stop offset="1" stop-color="#e84f88"/></radialGradient></defs>
        <path d="${body}" fill="url(#${p}b)"/>
        <g fill="none" stroke-linecap="round">
          <path d="${grooves.join("")}" stroke="#d93f78" stroke-opacity=".35" stroke-width="1"/>
          <path d="${flutes.join("")}" stroke="#fff" stroke-opacity=".42" stroke-width="2.4"/>
        </g>
        <path d="M8.6 39.6Q12 42.6 16 41.6Q20 43.6 24 42.4Q28 43.6 32 41.6Q36 42.6 39.4 39.6" fill="none" stroke="#fff" stroke-opacity=".8" stroke-width="1.1" stroke-linecap="round"/>
        <path d="${crown}" fill="url(#${p}c)" stroke="#fff" stroke-opacity=".75" stroke-width=".8"/>
        <ellipse cx="24" cy="12.2" rx="4.2" ry="1.3" fill="#fff" opacity=".45"/>
        <path d="M12.6 19.5C10.8 25 9.6 29 9.4 33.5" fill="none" stroke="#fff" stroke-opacity=".9" stroke-width="2" stroke-linecap="round"/>
        <circle cx="29.5" cy="20" r="1.3" fill="#fff" opacity=".85"/>
        ${SPARK(36.5, 9.5, 0.85)}`,
    };
  })(),

  cake: (() => {
    const A = [4, 23], B = [43.5, 16.5], C = [35.5, 28];
    const Ab = [4, 35.5], Cb = [35.5, 42.5], Bb = [43.5, 30.5];
    const pts = (...p) => p.map((q) => `${f1(q[0])},${f1(q[1])}`).join(" ");
    const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const bands = ["#ffd3e3", "#cdb8ff", "#ffc6a8", "#fff1a3", "#bff2cc", "#b6dcff", "#ffd3e3"];
    const stops = [0, 0.1, 0.27, 0.43, 0.59, 0.75, 0.9, 1];
    const face = (L0, L1, R0, R1, light) => bands.map((c, i) => {
      const a = lerp(L0, L1, stops[i]), b = lerp(R0, R1, stops[i]), cc = lerp(R0, R1, stops[i + 1]), d = lerp(L0, L1, stops[i + 1]);
      return `<polygon points="${pts(a, b, cc, d)}" fill="${c}"${light ? ` opacity=".82"` : ""}/>`;
    }).join("");
    const seps = (L0, L1, R0, R1) => stops.slice(1, -1).map((s) => { const a = lerp(L0, L1, s), b = lerp(R0, R1, s); return `M${f1(a[0])} ${f1(a[1])}L${f1(b[0])} ${f1(b[1])}`; }).join("");
    return {
      sil: `<polygon points="${pts(A, B, Bb, Cb, Ab)}"/><circle cx="25" cy="17" r="6.2"/><path d="M25.5 12C27 7 30.5 4 34.5 2.6" fill="none" stroke="#000" stroke-width="1.6" stroke-linecap="round"/>`,
      art: (p) => `<defs>
        <radialGradient id="${p}r" cx=".36" cy=".34" r=".75"><stop offset="0" stop-color="#ff7d8e"/><stop offset=".55" stop-color="#e8132f"/><stop offset="1" stop-color="#a9001e"/></radialGradient>
        <linearGradient id="${p}t" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#fff4f9"/><stop offset="1" stop-color="#ffd2e4"/></linearGradient></defs>
        ${face(A, Ab, C, Cb, false)}
        ${face(C, Cb, B, Bb, true)}
        <path d="${seps(A, Ab, C, Cb)}${seps(C, Cb, B, Bb)}" stroke="#fff" stroke-opacity=".75" stroke-width=".7"/>
        <polygon points="${pts(A, B, C)}" fill="url(#${p}t)"/>
        <path d="M${pts(Ab, A, B, Bb)}M${pts(A, C, Cb)}M${pts(C, B)}" fill="none" stroke="#fff" stroke-width=".9" stroke-linejoin="round"/>
        <path d="M6.5 26.5L33.5 31" stroke="#fff" stroke-opacity=".7" stroke-width="1.1" stroke-linecap="round"/>
        <ellipse cx="25" cy="22.6" rx="5" ry="1.4" fill="#ff8aa0" opacity=".35"/>
        <path d="M25.5 12C27 7 30.5 4 34.5 2.6" fill="none" stroke="#c4ab3c" stroke-width="1.2" stroke-linecap="round"/>
        <circle cx="34.6" cy="2.6" r="1" fill="#8b2a1c"/>
        <circle cx="25" cy="17" r="6" fill="url(#${p}r)"/>
        <ellipse cx="22.6" cy="14.6" rx="2" ry="1.3" transform="rotate(-30 22.6 14.6)" fill="#fff" opacity=".95"/>
        <circle cx="27.8" cy="19.6" r=".7" fill="#fff" opacity=".7"/>
        ${SPARK(9, 13, 0.8)}${SPARK(40, 37, 0.6, 0.9)}`,
    };
  })(),

  bear: (() => {
    const head = "M24 12.5C34 12.5 41.5 18.5 41.5 27.5C41.5 36 34 41.5 24 41.5C14 41.5 6.5 36 6.5 27.5C6.5 18.5 14 12.5 24 12.5Z";
    return {
      sil: `<circle cx="11.5" cy="13.5" r="6.5"/><circle cx="36.5" cy="13.5" r="6.5"/><path d="${head}"/>`,
      art: (p) => `<defs>
        <radialGradient id="${p}h" cx=".38" cy=".32" r=".8"><stop offset="0" stop-color="#f1e4ff"/><stop offset=".5" stop-color="#cfaef7"/><stop offset="1" stop-color="#9e72e2"/></radialGradient>
        <radialGradient id="${p}e" cx=".4" cy=".35" r=".75"><stop offset="0" stop-color="#e6d3ff"/><stop offset="1" stop-color="#a47ce4"/></radialGradient></defs>
        <circle cx="11.5" cy="13.5" r="6.5" fill="url(#${p}e)"/><circle cx="36.5" cy="13.5" r="6.5" fill="url(#${p}e)"/>
        <circle cx="11.8" cy="13.8" r="3.4" fill="none" stroke="#fff" stroke-opacity=".6" stroke-width="1.1"/><circle cx="36.2" cy="13.8" r="3.4" fill="none" stroke="#fff" stroke-opacity=".6" stroke-width="1.1"/>
        <path d="${head}" fill="url(#${p}h)"/>
        <ellipse cx="12.6" cy="32" rx="3.2" ry="1.9" fill="#ff9cc4" opacity=".75"/><ellipse cx="35.4" cy="32" rx="3.2" ry="1.9" fill="#ff9cc4" opacity=".75"/>
        <circle cx="17" cy="27.4" r="2.7" fill="#2a1838"/><circle cx="31" cy="27.4" r="2.7" fill="#2a1838"/>
        <circle cx="16" cy="26.4" r="1" fill="#fff"/><circle cx="30" cy="26.4" r="1" fill="#fff"/>
        <circle cx="17.9" cy="28.5" r=".45" fill="#fff"/><circle cx="31.9" cy="28.5" r=".45" fill="#fff"/>
        <path d="M22.2 29.9Q24 29.3 25.8 29.9Q25.4 31.6 24 31.9Q22.6 31.6 22.2 29.9Z" fill="#2a1838"/>
        <path d="M24 31.9V33M21.6 33Q22.8 34.8 24 33Q25.2 34.8 26.4 33" fill="none" stroke="#2a1838" stroke-width=".9" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M11.5 22.5Q14 16.5 21 15.4" fill="none" stroke="#fff" stroke-opacity=".9" stroke-width="2" stroke-linecap="round"/>
        <circle cx="35.5" cy="22" r="1.2" fill="#fff" opacity=".75"/><circle cx="27" cy="37.5" r=".9" fill="#fff" opacity=".6"/>`,
    };
  })(),

  cat: (() => {
    const head = "M24 15C35 15 42 21 42 29C42 36.5 34.5 41.5 24 41.5C13.5 41.5 6 36.5 6 29C6 21 13 15 24 15Z";
    const earL = "M7.8 24L9.6 7.6Q10.2 5.2 12.3 6.4L22.5 16.2Z", earR = "M40.2 24L38.4 7.6Q37.8 5.2 35.7 6.4L25.5 16.2Z";
    const glitter = [[13, 21, "#ffd76a"], [19, 18.5, "#9fdcff"], [29, 18, "#ffb3d6"], [35, 22, "#b9f0c8"], [10, 30, "#c7b5ff"], [38, 31, "#ffd76a"], [15, 38, "#9fdcff"], [33, 38, "#ffb3d6"], [24, 17, "#c7b5ff"], [27.5, 22.5, "#ffd76a"], [21, 23, "#b9f0c8"], [39, 26.5, "#9fdcff"], [8.5, 26, "#ffb3d6"], [12, 9.5, "#ffd76a"], [36, 10, "#9fdcff"]];
    const pearls = [[16.5, 20.5], [31.5, 20.8], [11, 34.5], [37, 34.8], [24, 21]];
    return {
      sil: `<path d="${earL}"/><path d="${earR}"/><path d="${head}"/>`,
      art: (p) => `<defs>
        <radialGradient id="${p}h" cx=".4" cy=".3" r=".85"><stop offset="0" stop-color="#fffaff"/><stop offset=".6" stop-color="#ecdffd"/><stop offset="1" stop-color="#c9b5f0"/></radialGradient>
        <radialGradient id="${p}p" cx=".35" cy=".3" r=".7"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#d9d3e6"/></radialGradient></defs>
        <path d="${earL}" fill="url(#${p}h)" stroke="#c9b5f0" stroke-width=".6" stroke-linejoin="round"/><path d="${earR}" fill="url(#${p}h)" stroke="#c9b5f0" stroke-width=".6" stroke-linejoin="round"/>
        <path d="M11 19.5L12 10.4Q12.3 9 13.4 9.7L19.3 15.6Z" fill="#ffb0c9"/><path d="M37 19.5L36 10.4Q35.7 9 34.6 9.7L28.7 15.6Z" fill="#ffb0c9"/>
        <path d="${head}" fill="url(#${p}h)"/>
        ${glitter.map(([x, y, c], i) => (i % 3 === 2 ? `<rect x="${f1(x - 0.6)}" y="${f1(y - 0.6)}" width="1.2" height="1.2" transform="rotate(30 ${x} ${y})" fill="${c}"/>` : `<circle cx="${x}" cy="${y}" r="${i % 2 ? 0.55 : 0.75}" fill="${c}"/>`)).join("")}
        ${pearls.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.25" fill="url(#${p}p)"/>`).join("")}
        <path d="M24 30.5C21 29 15.5 29.5 15.5 34C15.5 38 20 39.2 24 37.6C28 39.2 32.5 38 32.5 34C32.5 29.5 27 29 24 30.5Z" fill="#fff" opacity=".95"/>
        <circle cx="16.5" cy="27" r="2.8" fill="#1f1628"/><circle cx="31.5" cy="27" r="2.8" fill="#1f1628"/>
        <circle cx="15.5" cy="26" r="1.05" fill="#fff"/><circle cx="30.5" cy="26" r="1.05" fill="#fff"/>
        <circle cx="17.4" cy="28.2" r=".45" fill="#fff"/><circle cx="32.4" cy="28.2" r=".45" fill="#fff"/>
        <path d="M22.7 31.3Q24 30.8 25.3 31.3Q25 32.6 24 32.8Q23 32.6 22.7 31.3Z" fill="#ff86aa"/>
        <path d="M24 32.8V33.6M22.3 33.6Q23.1 34.8 24 33.6Q24.9 34.8 25.7 33.6" fill="none" stroke="#e57a9a" stroke-width=".75" stroke-linecap="round"/>
        <path d="M11 24Q13 18.5 19 17.4" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>
        ${SPARK(40.5, 16, 0.75)}`,
    };
  })(),

  bird: (() => {
    const body = "M20 11C29 9.5 39 16 40 27C41 36.5 33.5 42.5 24.5 42.5C14.5 42.5 8 36.5 8.5 27C9 18.5 13 12.2 20 11Z";
    const tail = "M31 23.5L36.2 6.2Q37.4 3.4 40.2 3.8L44 4.9Q46.8 6 46 9L38.4 29Z";
    const wing = "M22.5 27.5C27 23.5 35.5 25 38.5 30.5C40.5 34.5 38 37.5 34 37.3C29 37 24.5 33.5 22.5 27.5Z";
    const beak = "M10.6 19.4L4.6 21.6Q4 22 4.6 22.4L10.6 23.6Z";
    return {
      sil: `<path d="${tail}"/><path d="${body}"/><path d="${beak}"/>`,
      art: (p) => `<defs>
        <linearGradient id="${p}b" x1=".2" x2=".75" y1="0" y2="1"><stop offset="0" stop-color="#93b6ff"/><stop offset=".28" stop-color="#c7b6ff"/><stop offset=".5" stop-color="#ffb1d8"/><stop offset=".74" stop-color="#ffd2a4"/><stop offset="1" stop-color="#a9e9ff"/></linearGradient>
        <linearGradient id="${p}w" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#bfe9ff"/><stop offset=".5" stop-color="#ffc8e6"/><stop offset="1" stop-color="#d4c2ff"/></linearGradient>
        <linearGradient id="${p}t" x1="0" x2="1" y1="1" y2="0"><stop offset="0" stop-color="#ffd27a"/><stop offset=".35" stop-color="#a6e4ff"/><stop offset="1" stop-color="#dccbff"/></linearGradient>
        <linearGradient id="${p}k" x1="1" x2="0"><stop offset="0" stop-color="#6f95f2"/><stop offset="1" stop-color="#c9dbff"/></linearGradient></defs>
        <path d="${tail}" fill="url(#${p}t)"/>
        <path d="M35 22L39.4 6.2M37.2 24.4L42.8 6.8M39.2 26.2L45 8.6" stroke="#fff" stroke-opacity=".7" stroke-width=".7" stroke-linecap="round"/><path d="M33.4 25.2L38.2 28.4" stroke="#f2c14e" stroke-width="1.3" stroke-linecap="round"/>
        <path d="${body}" fill="url(#${p}b)"/>
        <ellipse cx="17" cy="26" rx="6.5" ry="4.2" fill="#fff4fa" opacity=".6"/>
        <path d="${wing}" fill="url(#${p}w)" stroke="#fff" stroke-opacity=".8" stroke-width=".7"/>
        <path d="M26 29.5Q31.5 28 37 32M27.5 32.3Q32 31.5 36.5 34.8" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width=".7" stroke-linecap="round"/>
        <path d="M36.2 36.8Q39.4 36.6 40 33.4" fill="none" stroke="#f2c14e" stroke-width="1.2" stroke-linecap="round"/>
        <path d="${beak}" fill="url(#${p}k)"/>
        <circle cx="16.6" cy="20.2" r="2.5" fill="#f2c14e" opacity=".85"/>
        <circle cx="16.6" cy="20.2" r="1.85" fill="#1a1530"/>
        <circle cx="16" cy="19.5" r=".7" fill="#fff"/>
        <path d="M14 13.4Q18.5 10.6 25 11.8" fill="none" stroke="#fff" stroke-opacity=".9" stroke-width="1.6" stroke-linecap="round"/>
        <circle cx="13" cy="33.5" r=".8" fill="#fff" opacity=".8"/><circle cx="21" cy="38.5" r=".6" fill="#fff" opacity=".8"/><circle cx="30" cy="17" r=".6" fill="#fff" opacity=".8"/>
        ${SPARK(9, 11, 0.7)}`,
    };
  })(),
};

const LOCK = `<g transform="translate(37.5 37.5)"><circle r="7.6" fill="#fff" stroke="#c3cbd1" stroke-width="1"/>`
  + `<path d="M-2.4 -0.6V-2.4A2.4 2.4 0 0 1 2.4 -2.4V-0.6" fill="none" stroke="#7f8b94" stroke-width="1.5"/>`
  + `<rect x="-3.8" y="-0.9" width="7.6" height="5.6" rx="1.3" fill="#7f8b94"/><circle cy="1.7" r=".95" fill="#fff"/></g>`;

/**
 * @param {"flower"|"pudding"|"cake"|"bear"|"cat"|"bird"} id
 * @param {{ locked?: boolean }} [options]
 * @returns {string} 48×48 viewBox SVG markup (an unknown id falls back to the
 *   flower icon, with a one-time console warning)
 */
export function shapeIconSVG(id, { locked = false } = {}) {
  const key = `${id}|${locked ? 1 : 0}`;
  const cached = cache.get(key);
  if (cached) return cached;
  if (!ICONS[id] && !warned.has(id)) { warned.add(id); console.warn(`shapeIconSVG: unknown shape "${id}", using flower`); }
  const icon = ICONS[id] ?? ICONS.flower;
  const prefix = `si-${ICONS[id] ? id : "flower"}-`;
  const body = locked
    ? `<g fill="#cdd3d8" stroke="#cdd3d8" stroke-width="1" stroke-linejoin="round">${icon.sil.replace(/stroke="#000"/g, 'stroke="#cdd3d8"')}</g>`
      + LOCK
    : icon.art(prefix);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48" aria-hidden="true">${body}</svg>`;
  cache.set(key, svg);
  return svg;
}
