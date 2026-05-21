const CACHE = "mc-v2";

self.addEventListener("install", (e) => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;

  if (req.method !== "GET") return;

  const url = new URL(req.url);

  if (url.pathname.startsWith("/api/")) return;
  if (url.pathname.startsWith("/_next/") || url.pathname.startsWith("/_nextjs")) return;

  // Navigation / HTML requests must always hit the network. Cached HTML
  // outlives the chunks it references — after a deploy, the chunk hashes
  // change and the stale HTML loads 404s. Network-first (no cache) is the
  // only correct strategy here.
  if (req.mode === "navigate" || req.destination === "document") return;
  const accept = req.headers.get("accept") || "";
  if (accept.includes("text/html")) return;

  e.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res.ok && res.type === "basic") {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(req, clone)).catch(() => {});
          }
          return res;
        })
        .catch(
          () =>
            new Response("Offline", {
              status: 503,
              headers: { "Content-Type": "text/plain" },
            })
        );
    })
  );
});
