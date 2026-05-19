const CACHE = "mc-v1";

self.addEventListener("install", (e) => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(clients.claim());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;

  // Only intercept GET — let POST/PATCH/DELETE bypass the SW
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Bypass API routes entirely (no caching, no interception)
  if (url.pathname.startsWith("/api/")) return;

  // Bypass Next.js dev-server internals (HMR, source-maps, stack frames)
  if (
    url.pathname.startsWith("/_next/") ||
    url.pathname.startsWith("/_nextjs")
  ) return;

  // Static assets: cache first, network fallback
  e.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          // Only cache successful same-origin responses
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
