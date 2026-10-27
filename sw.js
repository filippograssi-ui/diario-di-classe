const C = "diario-5a-v3";
const SHELL = ["./", "./index.html", "./backend.js", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(C).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  const sameOrigin = u.origin === location.origin;
  const lib = u.hostname === "cdn.jsdelivr.net" || u.hostname.endsWith("gstatic.com") || u.hostname === "fonts.googleapis.com";
  if (!sameOrigin && !lib) return;
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok || r.type === "opaque") { const cp = r.clone(); caches.open(C).then(c => c.put(e.request, cp)); }
    return r;
  }).catch(() => caches.match(e.request).then(r => r || (sameOrigin ? caches.match("./index.html") : undefined))));
});
