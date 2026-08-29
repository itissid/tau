import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { MessageChannel } from "node:worker_threads";

const directory = path.dirname(fileURLToPath(import.meta.url));
const workerSource = readFileSync(path.resolve(directory, "../public/sw.js"), "utf8");

type Listener = (event: any) => void;

function workerHarness(initialClients: any[] = [], behavior: {
  showNotification?: (title: string, options: any) => Promise<void>;
  openWindow?: (url: string) => Promise<any>;
} = {}) {
  const listeners = new Map<string, Listener>();
  const notifications: Array<{ title: string; options: any }> = [];
  const openWindowCalls: string[] = [];
  const opened: string[] = [];
  const diagnosticEvents: any[] = [];
  let windowClients = initialClients;
  const self = {
    registration: {
      scope: "https://tau.example.test/",
      showNotification: async (title: string, options: any) => {
        if (behavior.showNotification) return behavior.showNotification(title, options);
        notifications.push({ title, options });
      },
    },
    clients: {
      claim: async () => undefined,
      matchAll: async () => windowClients,
      openWindow: async (url: string) => {
        openWindowCalls.push(url);
        const client = behavior.openWindow
          ? await behavior.openWindow(url)
          : { id: "opened-client", url };
        if (client) opened.push(url);
        return client;
      },
    },
    addEventListener(type: string, listener: Listener) {
      listeners.set(type, listener);
    },
    skipWaiting() {},
  };
  const cache = { addAll: async () => undefined, put: async () => undefined };
  vm.runInNewContext(workerSource, {
    self,
    caches: {
      open: async () => cache,
      keys: async () => [],
      delete: async () => true,
      match: async () => undefined,
    },
    fetch: async (url: string, options: any) => {
      if (url === "/api/push/notification-events") {
        diagnosticEvents.push(JSON.parse(options.body));
      }
      return new Response("ok");
    },
    URL,
    Response,
    Map,
    MessageChannel,
    Promise,
    clearTimeout,
    setTimeout,
  });

  const dispatch = async (type: string, values: Record<string, unknown>) => {
    const pending: Promise<unknown>[] = [];
    const event = {
      ...values,
      waitUntil(value: Promise<unknown>) { pending.push(value); },
    };
    listeners.get(type)?.(event);
    await Promise.all(pending);
  };

  return {
    notifications,
    openWindowCalls,
    opened,
    diagnosticEvents,
    setClients(value: any[]) { windowClients = value; },
    dispatch,
  };
}

const payload = {
  schemaVersion: 1,
  type: "safety-gate-pending",
  requestId: "safety-gate-12345678-1234-4123-8123-123456789abc",
  pid: 4101,
  title: "Permission needed",
  body: "A Pi action is waiting for safety approval.",
  url: "/i/4101/",
};

test("root service worker displays a bounded pending-permission push when no foreground live client exists", async () => {
  const harness = workerHarness();
  await harness.dispatch("push", { data: { json: () => payload } });

  assert.deepEqual(JSON.parse(JSON.stringify(harness.notifications)), [{
    title: "Permission needed",
    options: {
      body: "A Pi action is waiting for safety approval.",
      tag: payload.requestId,
      renotify: false,
      requireInteraction: true,
      data: {
        requestId: payload.requestId,
        pid: 4101,
        url: "/i/4101/",
      },
    },
  }]);
  assert.deepEqual(harness.diagnosticEvents.map((event) => event.event), [
    "push-received",
    "notification-shown",
  ]);
});

test("service worker records notification display failures after receiving a valid push", async () => {
  const harness = workerHarness([], {
    showNotification: async () => { throw new Error("browser rejected notification"); },
  });
  const failingPayload = {
    ...payload,
    requestId: "safety-gate-00000000-0000-4000-8000-000000000009",
    pid: 4109,
    url: "/i/4109/",
  };

  await assert.rejects(
    harness.dispatch("push", { data: { json: () => failingPayload } }),
    /browser rejected notification/,
  );
  assert.deepEqual(harness.diagnosticEvents.map((event) => event.event), [
    "push-received",
    "notification-show-failed",
  ]);
  assert.deepEqual(harness.diagnosticEvents.at(-1), {
    schemaVersion: 1,
    source: "service-worker",
    event: "notification-show-failed",
    occurredAt: harness.diagnosticEvents.at(-1).occurredAt,
    requestId: failingPayload.requestId,
    pid: failingPayload.pid,
    targetUrl: failingPayload.url,
    clientCount: 0,
    result: "error",
  });
});

test("root service worker suppresses a duplicate system alert only for a foreground live Tau client", async () => {
  const liveClient = {
    id: "client-1",
    url: "https://tau.example.test/i/4101/",
    visibilityState: "visible",
    focused: true,
    postMessage() {},
  };
  const harness = workerHarness([liveClient]);

  await harness.dispatch("message", {
    source: liveClient,
    data: { type: "tau-client-state", pid: 4101, webSocketConnected: true },
  });
  await harness.dispatch("push", { data: { json: () => payload } });
  assert.deepEqual(harness.notifications, []);
  assert.deepEqual(harness.diagnosticEvents.map((event) => event.event), [
    "push-received",
    "push-suppressed",
  ]);

  await harness.dispatch("message", {
    source: liveClient,
    data: { type: "tau-client-state", pid: 4101, webSocketConnected: false },
  });
  await harness.dispatch("push", { data: { json: () => payload } });
  assert.equal(harness.notifications.length, 1);
});

test("foreground suppression queries a visible page after the service worker restarts", async () => {
  const liveClient = {
    id: "client-after-worker-restart",
    url: "https://tau.example.test/i/4101/",
    visibilityState: "visible",
    focused: true,
    postMessage(message: any, ports: any[]) {
      if (message.type === "tau-query-client-state") {
        ports[0].postMessage({ webSocketConnected: true });
      }
    },
  };
  const harness = workerHarness([liveClient]);
  await harness.dispatch("push", { data: { json: () => payload } });
  assert.deepEqual(harness.notifications, []);
});

test("notification click opens the exact route when Firefox reports no clients and a falsy WindowClient", async () => {
  let attempt = 0;
  const harness = workerHarness([], {
    openWindow: async (url) => {
      attempt += 1;
      return attempt === 1 ? null : { id: "opened-client", url };
    },
  });

  await harness.dispatch("notificationclick", {
    notification: { data: payload, close() {} },
  });

  assert.deepEqual(harness.openWindowCalls, [
    "https://tau.example.test/i/4101/",
    "https://tau.example.test/i/4101/",
  ]);
  assert.deepEqual(harness.opened, ["https://tau.example.test/i/4101/"]);
  assert.deepEqual(harness.diagnosticEvents.slice(-3).map((event) => event.event), [
    "notification-clicked",
    "client-routing",
    "window-opened",
  ]);
});

test("notification click focuses an exact client that appears after a falsy openWindow result", async () => {
  const clients: any[] = [];
  const actions: string[] = [];
  const lateClient = {
    id: "late-client",
    url: "https://tau.example.test/i/4101/",
    async focus() { actions.push("focus"); return this; },
  };
  const harness = workerHarness(clients, {
    openWindow: async () => {
      clients.push(lateClient);
      return null;
    },
  });

  await harness.dispatch("notificationclick", {
    notification: { data: payload, close() {} },
  });

  assert.deepEqual(harness.openWindowCalls, ["https://tau.example.test/i/4101/"]);
  assert.deepEqual(actions, ["focus"]);
  assert.deepEqual(harness.diagnosticEvents.slice(-3).map((event) => event.event), [
    "notification-clicked",
    "client-routing",
    "window-opened",
  ]);
});

test("notification click navigates or opens the exact terminal-owned Pi instance", async () => {
  const actions: string[] = [];
  const existingClient = {
    id: "client-2",
    url: "https://tau.example.test/i/9999/",
    visibilityState: "hidden",
    focused: false,
    async navigate(url: string) { actions.push(`navigate:${url}`); return this; },
    async focus() { actions.push("focus"); return this; },
  };
  const harness = workerHarness([existingClient]);
  let closed = 0;

  await harness.dispatch("notificationclick", {
    notification: {
      data: payload,
      close() { closed += 1; },
    },
  });
  assert.deepEqual(actions, ["navigate:https://tau.example.test/i/4101/", "focus"]);
  assert.equal(closed, 1);
  assert.deepEqual(harness.diagnosticEvents.map((event) => event.event), [
    "notification-clicked",
    "client-routing",
    "client-navigated",
    "client-focused",
  ]);
  assert.deepEqual(harness.diagnosticEvents.at(-1), {
    schemaVersion: 1,
    source: "service-worker",
    event: "client-focused",
    occurredAt: harness.diagnosticEvents.at(-1).occurredAt,
    requestId: payload.requestId,
    pid: payload.pid,
    targetUrl: payload.url,
    clientCount: 1,
    result: "existing-client",
  });

  harness.setClients([]);
  await harness.dispatch("notificationclick", {
    notification: { data: payload, close() {} },
  });
  assert.deepEqual(harness.opened, ["https://tau.example.test/i/4101/"]);
  assert.deepEqual(harness.diagnosticEvents.slice(-3).map((event) => event.event), [
    "notification-clicked",
    "client-routing",
    "window-opened",
  ]);
});
