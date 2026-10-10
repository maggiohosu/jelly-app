// Offline cache for 말랑젤리. Bump VERSION on every deploy so phones pick up
// the new files (the new worker installs in the background and takes over on
// the next launch).
const VERSION = "v9.4";
const CACHE = `mallang-jelly-${VERSION}`;
const PRECACHE = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "./vendor/three/three.core.min.js",
  "./vendor/three/three.webgpu.min.js",
  "./vendor/three/three.tsl.min.js",
  "./vendor/three/addons/tsl/display/BloomNode.js",
  "./vendor/three/addons/math/ConvexHull.js",
  "./src/app/main.js",
  "./src/app/audio.js",
  "./src/app/quality.js",
  "./src/app/ui.js",
  "./src/app/progress.js",
  "./src/app/fun.js",
  "./src/app/orders.js",
  "./src/app/game-ui.js",
  "./src/render/stage.js",
  "./src/render/jelly-view.js",
  "./src/render/gems.js",
  "./src/render/beads.js",
  "./src/render/additives.js",
  "./src/render/coins.js",
  "./src/render/rabbit.js",
  "./src/render/rabbit-fur.js",
  "./src/render/toilet.js",
  "./src/render/rare-gems.js",
  "./src/render/rare-shapes.js",
  "./src/render/thumbnail.js",
  "./src/render/decor.js",
  "./src/render/shape-icons.js",
  "./src/render/input.js",
  "./src/render/gpu-caustic-field.js",
  "./src/workers/sim-worker.js",
  "./src/workers/optics-worker.js",
  "./src/core/cage.js",
  "./src/core/softbody.js",
  "./src/core/world.js",
  "./src/core/shapes.js",
  "./src/core/shape-mesher.js",
  "./src/core/optics.js",
];

self.addEventListener("install", (event) => {
  // cache: "reload" bypasses the HTTP cache (GitHub Pages sends max-age=600),
  // so a new VERSION never precaches a stale file.
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("mallang-jelly-") && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// Cache first (instant offline start); anything new is cached on first fetch.
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== location.origin) return;
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
      }
      return response;
    })),
  );
});
