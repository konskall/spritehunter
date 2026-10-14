const CACHE = "spritehunter-shell-v7";
// What the app and the offline page show. The 512 px and Apple icons are only read when the app
// is installed, so they are not downloaded for every visitor (about 360 KB).
const SHELL = [
  "/",
  "/en",
  "/offline.html",
  "/manifest.webmanifest",
  "/spritehunter-icon-128.webp",
  "/spritehunter-icon-192.png",
  "/spritehunter-logo.webp",
];
// Every deploy adds new hashed scripts; keep the newest entries so the cache cannot grow forever.
const MAX_ENTRIES = 80;

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

async function trim(cache) {
  const keys = await cache.keys();
  const shell = new Set(SHELL.map((path) => new URL(path, self.location.origin).href));
  const removable = keys.filter((request) => !shell.has(request.url));
  // Cache keys come back in insertion order, so the oldest entries go first.
  await Promise.all(removable.slice(0, Math.max(0, keys.length - MAX_ENTRIES)).map((request) => cache.delete(request)));
}

// Clone before handing the response to the page: a body that the browser has
// started reading can no longer be cloned, which made cache updates fail.
function cacheCopy(request, response) {
  if (!response.ok) return;
  const copy = response.clone();
  caches.open(CACHE)
    .then(async (cache) => {
      await cache.put(request, copy);
      await trim(cache);
    })
    .catch(() => undefined);
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
          || await caches.match(url.pathname.startsWith("/en") ? "/en" : "/")
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
