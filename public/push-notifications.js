const STALE_INSTANCE_SCOPE = /^\/i\/[1-9]\d+\/$/;

function decodeApplicationServerKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Invalid VAPID public key');
  }
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value.replaceAll('-', '+').replaceAll('_', '/')}${padding}`;
  const raw = globalThis.atob
    ? globalThis.atob(base64)
    : Buffer.from(base64, 'base64').toString('binary');
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

export class PushNotificationController {
  constructor({
    button,
    navigatorLike = globalThis.navigator,
    notificationApi = globalThis.Notification,
    fetchFn = globalThis.fetch?.bind(globalThis),
    secureContext = globalThis.isSecureContext,
  }) {
    this.button = button;
    this.navigatorLike = navigatorLike;
    this.notificationApi = notificationApi;
    this.fetchFn = fetchFn;
    this.secureContext = secureContext;
    this.registration = null;
  }

  setState(state, label, disabled = false) {
    if (!this.button) return;
    this.button.dataset.state = state;
    this.button.textContent = label;
    this.button.disabled = disabled;
  }

  isSupported() {
    return !!(
      this.secureContext &&
      this.notificationApi &&
      this.navigatorLike?.serviceWorker &&
      this.fetchFn
    );
  }

  async installRootWorker() {
    const serviceWorker = this.navigatorLike.serviceWorker;
    const registration = await serviceWorker.register('/sw.js', { scope: '/' });
    for (const candidate of await serviceWorker.getRegistrations()) {
      let scopePath;
      try {
        scopePath = new URL(candidate.scope).pathname;
      } catch {
        continue;
      }
      if (STALE_INSTANCE_SCOPE.test(scopePath)) await candidate.unregister();
    }
    this.registration = registration;
    return registration;
  }

  async synchronizeSubscription(subscription) {
    const response = await this.fetchFn('/api/push/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription.toJSON()),
    });
    if (!response.ok) throw new Error('Tau Hub rejected the push subscription');
  }

  async initialize() {
    if (!this.isSupported()) {
      this.setState('unsupported', 'Notifications unsupported', true);
      return;
    }

    let registration;
    try {
      registration = await this.installRootWorker();
    } catch {
      this.setState('unsupported', 'Notifications unavailable', true);
      return;
    }
    if (!registration.pushManager) {
      this.setState('unsupported', 'Notifications unsupported', true);
      return;
    }
    if (this.notificationApi.permission === 'denied') {
      this.setState('denied', 'Notifications denied', true);
      return;
    }

    const subscription = await registration.pushManager.getSubscription();
    if (this.notificationApi.permission === 'granted' && subscription) {
      try {
        await this.synchronizeSubscription(subscription);
        this.setState('enabled', 'Notifications enabled', true);
      } catch {
        this.setState('error', 'Notifications need retry');
      }
      return;
    }
    this.setState('available', 'Enable notifications');
  }

  async enableFromGesture() {
    if (!this.isSupported()) {
      this.setState('unsupported', 'Notifications unsupported', true);
      return false;
    }
    if (this.notificationApi.permission === 'denied') {
      this.setState('denied', 'Notifications denied', true);
      return false;
    }

    const permission = this.notificationApi.permission === 'granted'
      ? 'granted'
      : await this.notificationApi.requestPermission();
    if (permission !== 'granted') {
      this.setState(
        permission === 'denied' ? 'denied' : 'available',
        permission === 'denied' ? 'Notifications denied' : 'Enable notifications',
        permission === 'denied',
      );
      return false;
    }

    this.setState('enabling', 'Enabling notifications…', true);
    try {
      const registration = this.registration ?? await this.installRootWorker();
      const keyResponse = await this.fetchFn('/api/push/vapid-public-key', {
        headers: { Accept: 'application/json' },
      });
      if (!keyResponse.ok) throw new Error('Tau Hub push configuration is unavailable');
      const { publicKey } = await keyResponse.json();
      const existing = await registration.pushManager.getSubscription();
      const activeSubscription = existing ?? await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeApplicationServerKey(publicKey),
      });
      await this.synchronizeSubscription(activeSubscription);
      this.setState('enabled', 'Notifications enabled', true);
      return true;
    } catch {
      this.setState('error', 'Notifications need retry');
      return false;
    }
  }

  reportWebSocketState(pid, webSocketConnected) {
    if (!Number.isSafeInteger(pid) || pid <= 0 || typeof webSocketConnected !== 'boolean') return;
    const worker = this.registration?.active ??
      this.registration?.waiting ??
      this.registration?.installing ??
      this.navigatorLike.serviceWorker?.controller;
    worker?.postMessage({
      type: 'tau-client-state',
      pid,
      webSocketConnected,
    });
  }
}
