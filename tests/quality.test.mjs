// QualityGovernor decisions for synthetic frame pacing.
import { QualityGovernor } from "../src/app/quality.js";
let failures = 0;
const check = (label, ok, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`); };
function run(pattern, seconds = 6) {
  const tiers = [];
  const g = new QualityGovernor({ onTier: (t) => tiers.push(t.id), onPhysicsRate: () => {} });
  let now = 0, i = 0;
  while (now < seconds * 1000) { const dt = pattern(i++); now += dt; g.sample(dt, now); }
  return { final: g.tier.id, tiers, baseline: g.baseline };
}
const jitter = (base, spread) => (i) => base + ((i * 7919) % 13) / 13 * spread;
let r = run(jitter(16.67, 0.6)); check("steady 60 fps stays high", r.final === "high", JSON.stringify(r));
r = run(jitter(33.34, 0.6)); check("Low Power Mode 30 fps stays high", r.final === "high", JSON.stringify(r));
r = run(jitter(8.34, 0.3)); check("ProMotion 120 fps stays high", r.final === "high", JSON.stringify(r));
r = run((i) => (i % 3 === 0 ? 16.67 : 33.34)); check("40 fps on a 60 Hz display downgrades", r.final !== "high", JSON.stringify(r));
r = run(jitter(45, 8)); check("~20 fps from the first frame downgrades to low", r.final === "low", JSON.stringify(r));
r = run((i) => (i < 400 ? 16.67 : 30), 14); check("drop from 60 to 33 fps mid-session downgrades", r.final !== "high", JSON.stringify(r));
console.log(failures ? `\n${failures} FAILED` : "\nALL QUALITY CHECKS PASSED");
process.exit(failures ? 1 : 0);
