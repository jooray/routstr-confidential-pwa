/* Service worker, generated per release by vite.config.ts (pwa-release). */
const VERSION = __VERSION__;
const BUILD = __BUILD__;
const CACHE = `routstr-confidential-${VERSION}-${BUILD}`;
const ASSETS = __ASSETS__;
// Cache Storage belongs to the whole origin, which other sites may share:
// answers come only from this release's own cache, never from `caches.match`
// over every cache of the origin.
const fromOwnCache = (req, opts) => caches.open(CACHE).then((c) => c.match(req, opts));

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(ASSETS.map((a) => new Request(a, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("routstr-confidential-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") self.skipWaiting();
  if (event.data === "version") event.source?.postMessage({ type: "version", version: VERSION, build: BUILD });
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Only this app's own files; node API calls and WebSockets go straight out.
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.endsWith("/version.json") || url.pathname.endsWith("/sw.js")) return;
  if (req.mode === "navigate") {
    // Network first so a new release is seen at once; cached shell offline.
    // Only a good answer for the app shell itself (the scope URL or its
    // index.html, any query) replaces the cached shell: an error page or a
    // navigation to another file must not become the offline app.
    const scope = new URL(self.registration.scope);
    const isShell = url.pathname === scope.pathname || url.pathname === `${scope.pathname}index.html`;
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (isShell && res.ok && res.type === "basic" && !res.redirected) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put("./", copy));
          }
          return res;
        })
        .catch(() =>
          (isShell ? Promise.resolve(undefined) : fromOwnCache(url.pathname.endsWith("/") ? `${url.pathname}index.html` : req, { ignoreSearch: true }))
            .then((own) => own || fromOwnCache("./"))
            .then((r) => r || Response.error()),
        ),
    );
    return;
  }
  event.respondWith(fromOwnCache(req).then((hit) => hit || fetch(req)));
});
