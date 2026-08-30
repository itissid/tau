const REQUEST_ID_PATTERN = /^safety-gate-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PAGE_EVENTS = new Set([
  'session-connected',
  'pending-dialog-shown',
  'pending-dialog-response',
]);
const RESPONSE_RESULTS = new Set(['approve', 'deny', 'cancel']);

export async function reportNotificationLifecycleEvent(event, options = {}) {
  const fetchFn = options.fetchFn ?? globalThis.fetch?.bind(globalThis);
  const now = options.now ?? (() => new Date());
  if (!fetchFn || !event || typeof event !== 'object') return false;
  if (!PAGE_EVENTS.has(event.event)) return false;
  if (!Number.isSafeInteger(event.pid) || event.pid <= 0) return false;
  if (event.event === 'session-connected') {
    if (event.requestId !== undefined || event.result !== undefined) return false;
  } else if (!REQUEST_ID_PATTERN.test(event.requestId)) {
    return false;
  }
  if (event.event === 'pending-dialog-response') {
    if (!RESPONSE_RESULTS.has(event.result)) return false;
  } else if (event.result !== undefined) {
    return false;
  }

  const body = {
    schemaVersion: 1,
    source: 'page',
    event: event.event,
    occurredAt: now().toISOString(),
    ...(event.requestId ? { requestId: event.requestId } : {}),
    pid: event.pid,
    targetUrl: `/i/${event.pid}/`,
    ...(event.result ? { result: event.result } : {}),
  };
  try {
    const response = await fetchFn('/api/push/notification-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response.ok === true;
  } catch {
    return false;
  }
}
