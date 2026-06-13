const APP_VERSION = "1.1.1";
const CACHE_PREFIX = "catatkas-cache-";
const CACHE_NAME = `${CACHE_PREFIX}v${APP_VERSION}`;

// Absolute paths for GitHub Pages deployment at /CatatKas/
const APP_SHELL = [
  "/CatatKas/",
  "/CatatKas/index.html",
  "/CatatKas/styles.css",
  "/CatatKas/app.js",
  "/CatatKas/manifest.json",
  "/CatatKas/icons/icon.svg",
  "/CatatKas/icons/icon-192.png",
  "/CatatKas/icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(APP_SHELL.map((url) => new Request(url, { cache: "reload" })))
    )
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "CHECK_UPDATE") {
    event.ports?.[0]?.postMessage({
      type: "UPDATE_READY",
      version: APP_VERSION,
      cacheName: CACHE_NAME
    });
  }

  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  // Navigation requests: network-first with cache fallback
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) =>
            cache.put("/CatatKas/index.html", copy)
          );
          return response;
        })
        .catch(() => caches.match("/CatatKas/index.html"))
    );
    return;
  }

  // All other assets: cache-first with network fallback
  event.respondWith(
    caches.match(event.request).then((cached) =>
      cached || fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => offlineAssetFallback(event.request))
    )
  );
});

function offlineAssetFallback(request) {
  if (request.destination === "image") {
    return new Response(
      '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#0f766e"/></svg>',
      { headers: { "Content-Type": "image/svg+xml" } }
    );
  }

  return new Response("", { status: 503, statusText: "Offline" });
}
