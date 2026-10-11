const CACHE = "spritehunter-shell-v3";
const SHELL = [
  "/",
  "/offline.html",
  "/manifest.webmanifest",
  "/spritehunter-icon-192.png",
  "/spritehunter-icon-512.png",
  "/apple-touch-icon.png",
  "/spritehunter-logo.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
          return response;
        })
        .catch(async () => (
          await caches.match(request, { ignoreSearch: true })
          || await caches.match("/")
          || await caches.match("/offline.html")
        )),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((response) => {
        if (response.ok) caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
        return response;
      }).catch(() => cached || Response.error());
      return cached || network;
    }),
  );
});
