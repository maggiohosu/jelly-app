// Every module the app can load (static imports reachable from main.js and
// the workers) must be in the service worker's precache list, or the
// home-screen app breaks offline.
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(new URL("..", import.meta.url).pathname);
const sw = fs.readFileSync(path.join(root, "sw.js"), "utf8");
const listed = new Set([...sw.matchAll(/"\.\/([^"]+)"/g)].map((m) => m[1]));
const seen = new Set();
function walk(file) {
  const rel = path.relative(root, file);
  if (seen.has(rel)) return;
  seen.add(rel);
  const src = fs.readFileSync(file, "utf8");
  const specs = [...src.matchAll(/(?:import|export)\s[^;]*?from\s+"([^"]+)"/g), ...src.matchAll(/new URL\("([^"]+)", import\.meta\.url\)/g)].map((m) => m[1]);
  for (const s of specs) {
    if (s.startsWith(".")) walk(path.resolve(path.dirname(file), s));
    else if (s.startsWith("three/addons/")) walk(path.join(root, "vendor/three/addons", s.slice("three/addons/".length)));
  }
}
walk(path.join(root, "src/app/main.js"));
const missing = [...seen].filter((f) => !listed.has(f));
console.log(`${missing.length ? "FAIL" : "PASS"}  every reachable module is precached (${seen.size} modules)${missing.length ? "  missing: " + missing.join(", ") : ""}`);
process.exit(missing.length ? 1 : 0);
