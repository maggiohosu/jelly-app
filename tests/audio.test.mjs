// Audio engine tests: `node tests/audio.test.mjs [testName,…]` (optional subset,
// e.g. `node tests/audio.test.mjs testMotionSounds,testMotionLimits`).
// Serves the repo on :8125 (in-process; reuses a server already on that port),
// renders tests/audio.test.html in headless Chromium via Playwright, prints the
// PASS/FAIL lines and saves the main render to /tmp/claude-0/audio/render.wav and
// each motion / jingle sound to $AUDIO_SOUNDS_DIR (default /tmp/claude-0/audio/sounds/<name>.wav).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("/opt/node22/lib/node_modules/playwright");
const root = path.resolve(new URL("..", import.meta.url).pathname);
const PORT = 8125;
const WAV = "/tmp/claude-0/audio/render.wav";
const SOUNDS_DIR = process.env.AUDIO_SOUNDS_DIR || "/tmp/claude-0/audio/sounds";
const ONLY = process.argv[2] || "";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
};

// 1) syntax
try {
  execFileSync(process.execPath, ["--check", path.join(root, "src/app/audio.js")], { stdio: "pipe" });
  check("node --check src/app/audio.js", true);
} catch (e) {
  check("node --check src/app/audio.js", false, String(e.stderr || e.message));
}

// 2) static server
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json" };
const server = http.createServer((req, res) => {
  let file = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (file.endsWith("/")) file += "index.html";
  const full = path.join(root, file);
  if (!full.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, (error, data) => {
    if (error) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "content-type": types[path.extname(full)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(data);
  });
});
const ownServer = await new Promise((resolve, reject) => {
  server.once("error", (e) => (e.code === "EADDRINUSE" ? resolve(false) : reject(e)));
  server.listen(PORT, "127.0.0.1", () => resolve(true));
});
if (!ownServer) console.log(`(port ${PORT} busy: using the server already running there)`);

// 3) browser
const browser = await chromium.launch({ channel: "chromium", args: ["--autoplay-policy=no-user-gesture-required"] });
let exitCode = 1, page = null;
try {
  page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") pageErrors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/tests/audio.test.html${ONLY ? `?only=${encodeURIComponent(ONLY)}` : ""}`);
  await page.waitForFunction(() => window.__audioTest && window.__audioTest.done, null, { timeout: 300000, polling: 500 });
  const result = await page.evaluate(() => window.__audioTest);
  for (const line of result.lines) console.log(line);
  failures += result.failures;
  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
  if (result.wav) {
    fs.mkdirSync(path.dirname(WAV), { recursive: true });
    fs.writeFileSync(WAV, Buffer.from(result.wav, "base64"));
    console.log(`INFO  wrote ${WAV} (${(fs.statSync(WAV).size / 1e6).toFixed(2)} MB)`);
  }
  const sounds = Object.entries(result.soundWavs || {});
  if (sounds.length) {
    fs.mkdirSync(SOUNDS_DIR, { recursive: true });
    for (const [name, b64] of sounds) fs.writeFileSync(path.join(SOUNDS_DIR, `${name}.wav`), Buffer.from(b64, "base64"));
    console.log(`INFO  wrote ${sounds.length} sounds to ${SOUNDS_DIR}/ (${sounds.map(([n]) => n).join(", ")})`);
  }
  exitCode = failures ? 1 : 0;
} catch (e) {
  failures++;
  console.log(`FAIL  test page did not complete  ${e.message}`);
  try { console.log(await page.evaluate(() => document.getElementById("log")?.textContent || "")); } catch { /* page gone */ }
} finally {
  await browser.close();
  if (ownServer) server.close();
}
console.log(failures ? `\n${failures} FAILED (runner total)` : "\nAUDIO TESTS OK");
process.exit(exitCode);
