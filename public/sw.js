// Tau Service Worker — minimal, just enables PWA install
// No aggressive caching since Tau connects to a live local server

const CACHE_NAME = 'tau-v2';
const scopeUrl = new URL(self.registration.scope);
const scopePath = scopeUrl.pathname.endsWith('/') ? scopeUrl.pathname : `${scopeUrl.pathname}/`;
const scopedUrl = (path = '') => new URL(path, scopeUrl).href;

// Cache only the app shell on install
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll([
        scopedUrl(),
        scopedUrl('style.css'),
        scopedUrl('app.js'),
        scopedUrl('url-base.js'),
        scopedUrl('state.js'),
        scopedUrl('themes.js'),
        scopedUrl('markdown.js'),
        scopedUrl('message-renderer.js'),
        scopedUrl('tool-card.js'),
        scopedUrl('dialogs.js'),
        scopedUrl('session-sidebar.js'),
        scopedUrl('websocket-client.js'),
        scopedUrl('manifest.json'),
      ]);
    })
  );
  self.skipWaiting();
});

// Clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => {
      return Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

// Network-first strategy — always try live server, fall back to cache
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const relativePath = url.pathname.startsWith(scopePath)
    ? url.pathname.slice(scopePath.length)
    : null;
  const tauPath = relativePath ?? url.pathname.replace(/^\/i\/[1-9]\d+\//, '');

  // Don't cache API/WebSocket requests, including after an in-page PID switch.
  if (tauPath.startsWith('api/') || tauPath === 'ws') {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Update cache with fresh response
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        // Offline — serve from cache
        return caches.match(event.request).then((cached) => {
          return cached || new Response('Tau is offline — start your pi session to connect.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain' },
          });
        });
      })
  );
});
