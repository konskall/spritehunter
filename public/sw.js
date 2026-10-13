const CACHE = "spritehunter-shell-v5";
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

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const client = clients.find((item) => new URL(item.url).origin === self.location.origin);
      return client ? client.focus() : self.clients.openWindow("/");
    }),
  );
});

// Clone before handing the response to the page: a body that the browser has
// started reading can no longer be cloned, which made cache updates fail.
function cacheCopy(request, response) {
  if (!response.ok) return;
  const copy = response.clone();
  caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          cacheCopy(request, response);
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
        cacheCopy(request, response);
        return response;
      }).catch(() => cached || Response.error());
      return cached || network;
    }),
  );
});
