self.addEventListener("install", (e) => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (e) => {
  // Network-only. Previous versions cached static assets and could keep stale
  // HTML/chunk references alive after deploys, causing _next/static 500s.
  return;
});
