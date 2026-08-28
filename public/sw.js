// Tau root service worker. The Hub serves this file at /sw.js with scope /.
// It keeps the existing Tau UI installable and handles bounded safety-gate pushes.

const CACHE_NAME = 'tau-root-v3';
const REQUEST_ID_PATTERN = /^safety-gate-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const liveClientState = new Map();

function isBoundedString(value, maximumLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength;
}

function isPendingPush(value) {
  return !!value && typeof value === 'object' &&
    value.schemaVersion === 1 &&
    value.type === 'safety-gate-pending' &&
    REQUEST_ID_PATTERN.test(value.requestId) &&
    Number.isSafeInteger(value.pid) && value.pid > 0 &&
    isBoundedString(value.title, 160) &&
    isBoundedString(value.body, 240) &&
    value.url === `/i/${value.pid}/`;
}

function queryLiveClient(client, pid) {
  const known = liveClientState.get(client.id);
  if (known?.pid === pid) return Promise.resolve(known.webSocketConnected);
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => {
      channel.port1.close();
      resolve(false);
    }, 150);
    channel.port1.onmessage = (event) => {
      clearTimeout(timeout);
      channel.port1.close();
      const connected = event.data?.webSocketConnected === true;
      liveClientState.set(client.id, { pid, webSocketConnected: connected });
      resolve(connected);
    };
    try {
      client.postMessage({ type: 'tau-query-client-state', pid }, [channel.port2]);
    } catch {
      clearTimeout(timeout);
      channel.port1.close();
      resolve(false);
    }
  });
}

function navigationData(value) {
  if (!value || typeof value !== 'object') return null;
  if (!REQUEST_ID_PATTERN.test(value.requestId)) return null;
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) return null;
  if (value.url !== `/i/${value.pid}/`) return null;
  return { requestId: value.requestId, pid: value.pid, url: value.url };
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith('tau-') && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (!event.source?.id || !event.data || event.data.type !== 'tau-client-state') return;
  const { pid, webSocketConnected } = event.data;
  if (!Number.isSafeInteger(pid) || pid <= 0 || typeof webSocketConnected !== 'boolean') return;
  liveClientState.set(event.source.id, { pid, webSocketConnected });
});

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let payload;
    try {
      payload = event.data?.json();
    } catch {
      return;
    }
    if (!isPendingPush(payload)) return;

    const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const foregroundCandidates = windowClients.filter((client) => {
      try {
        return client.visibilityState === 'visible' && new URL(client.url).pathname.startsWith(payload.url);
      } catch {
        return false;
      }
    });
    for (const client of foregroundCandidates) {
      if (await queryLiveClient(client, payload.pid)) return;
    }

    await self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.requestId,
      renotify: false,
      requireInteraction: true,
      data: {
        requestId: payload.requestId,
        pid: payload.pid,
        url: payload.url,
      },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const data = navigationData(event.notification.data);
    if (!data) return;
    const target = new URL(data.url, self.registration.scope);
    const scope = new URL(self.registration.scope);
    if (target.origin !== scope.origin || target.pathname !== data.url) return;

    const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const exactClient = windowClients.find((client) => client.url === target.href);
    if (exactClient) {
      await exactClient.focus();
      return;
    }

    const sameOriginClient = windowClients.find((client) => {
      try {
        return new URL(client.url).origin === target.origin;
      } catch {
        return false;
      }
    });
    if (sameOriginClient?.navigate) {
      const navigated = await sameOriginClient.navigate(target.href);
      await (navigated ?? sameOriginClient).focus();
      return;
    }
    await self.clients.openWindow(target.href);
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== new URL(self.registration.scope).origin) return;
  const tauPath = url.pathname.replace(/^\/i\/[1-9]\d+\//, '');
  if (tauPath.startsWith('/api/') || tauPath.startsWith('api/') || tauPath === 'ws') return;

  event.respondWith(fetch(event.request)
    .then((response) => {
      if (response.ok) {
        const clone = response.clone();
        void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
      }
      return response;
    })
    .catch(async () => {
      const cached = await caches.match(event.request);
      return cached ?? new Response('Tau is offline — start your Pi session to connect.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain' },
      });
    }));
});
