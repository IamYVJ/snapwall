// Keeps the app shell so SnapWall opens quickly from the home screen. Only same-origin GETs are handled:
// API calls, photos and videos come from the API's origin and always go straight to the network, never a cache.
const CACHE = 'snapwall-shell-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;

  if (req.mode === 'navigate') {
    // Network first, so a new deploy shows up on the next open; the cached page is only for when offline.
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Only the app itself is the shell; privacy.html is a separate page.
          if (res.ok && url.pathname.endsWith('/')) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('./', copy));
          }
          return res;
        })
        .catch(() => caches.match('./').then((hit) => hit ?? Response.error())),
    );
  } else if (url.pathname.includes('/assets/')) {
    // Built assets have content hashes in their names, so a cached copy is never stale.
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ??
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});
