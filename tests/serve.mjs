// Minimal static server for local testing: `node tests/serve.mjs [port]`.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(new URL("..", import.meta.url).pathname);
const port = Number(process.argv[2] || 8123);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json", ".json": "application/json", ".svg": "image/svg+xml" };
http.createServer((req, res) => {
  let file = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (file.endsWith("/")) file += "index.html";
  const full = path.join(root, file);
  if (!full.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, (error, data) => {
    if (error) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "content-type": types[path.extname(full)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(data);
  });
}).listen(port, () => console.log(`serving ${root} on http://localhost:${port}`));
