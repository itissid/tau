import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PushNotificationController } from "../public/push-notifications.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.resolve(directory, "../public");

class FakeButton {
  disabled = false;
  textContent = "";
  dataset: Record<string, string> = {};
}

function subscription(endpoint = "https://push.example.test/subscription-1") {
  return {
    endpoint,
    toJSON: () => ({
      endpoint,
      expirationTime: null,
      keys: { p256dh: "receiver-public-key", auth: "receiver-auth-secret" },
    }),
  };
}

test("notification opt-in requests permission only from the explicit action and migrates to one root worker", async () => {
  const button = new FakeButton();
  const calls: Array<{ url: string; options?: any }> = [];
  const postedStates: unknown[] = [];
  const stale = {
    scope: "https://tau.example.test/i/4101/",
    unregisterCount: 0,
    async unregister() { this.unregisterCount += 1; return true; },
  };
  const rootRegistration = {
    scope: "https://tau.example.test/",
    active: { postMessage: (value: unknown) => postedStates.push(value) },
    pushManager: {
      getSubscription: async () => null,
      subscribe: async (options: any) => {
        assert.equal(options.userVisibleOnly, true);
        assert.ok(options.applicationServerKey instanceof Uint8Array);
        return subscription();
      },
    },
  };
  let permissionRequests = 0;
  const notificationApi = {
    permission: "default",
    async requestPermission() {
      permissionRequests += 1;
      this.permission = "granted";
      return "granted";
    },
  };
  const serviceWorker = {
    async register(script: string, options: any) {
      assert.equal(script, "/sw.js");
      assert.deepEqual(options, { scope: "/" });
      return rootRegistration;
    },
    async getRegistrations() { return [stale, rootRegistration]; },
  };
  const fetchFn = async (url: string, options?: any) => {
    calls.push({ url, options });
    if (url === "/api/push/vapid-public-key") {
      return new Response(JSON.stringify({ publicKey: "BEl6fI0lJ4SQQQ" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  };

  const controller = new PushNotificationController({
    button: button as any,
    navigatorLike: { serviceWorker } as any,
    notificationApi: notificationApi as any,
    fetchFn,
    secureContext: true,
  });
  await controller.initialize();
  assert.equal(permissionRequests, 0);
  assert.equal(button.dataset.state, "available");
  assert.equal(button.textContent, "Enable notifications");
  assert.equal(stale.unregisterCount, 1);

  await controller.enableFromGesture();
  assert.equal(permissionRequests, 1);
  assert.equal(button.dataset.state, "enabled");
  assert.equal(button.textContent, "Notifications enabled");
  assert.deepEqual(calls.map(({ url }) => url), [
    "/api/push/vapid-public-key",
    "/api/push/subscriptions",
  ]);
  const postedSubscription = JSON.parse(calls[1]!.options.body);
  assert.deepEqual(postedSubscription, subscription().toJSON());

  controller.reportWebSocketState(4101, true);
  assert.deepEqual(postedStates, [{ type: "tau-client-state", pid: 4101, webSocketConnected: true }]);
});

test("Tau UI links the root PWA and exposes only an explicit notification opt-in action", () => {
  const html = readFileSync(path.join(publicDirectory, "index.html"), "utf8");
  const app = readFileSync(path.join(publicDirectory, "app.js"), "utf8");
  const manifest = JSON.parse(readFileSync(path.join(publicDirectory, "manifest.webmanifest"), "utf8"));

  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /id="notification-status-btn"/);
  assert.match(app, /notification-status-btn/);
  assert.match(app, /enableFromGesture/);
  assert.match(app, /reportWebSocketState/);
  assert.doesNotMatch(app, /serviceWorker\.register\(instancePath\('sw\.js'\)\)/);
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
});

test("notification status reports unsupported and denied without attempting subscription", async () => {
  const unsupportedButton = new FakeButton();
  const unsupported = new PushNotificationController({
    button: unsupportedButton as any,
    navigatorLike: {} as any,
    notificationApi: undefined,
    fetchFn: async () => { throw new Error("must not fetch"); },
    secureContext: true,
  });
  await unsupported.initialize();
  assert.equal(unsupportedButton.dataset.state, "unsupported");
  assert.equal(unsupportedButton.textContent, "Notifications unsupported");
  assert.equal(unsupportedButton.disabled, true);

  const deniedButton = new FakeButton();
  let permissionRequests = 0;
  const denied = new PushNotificationController({
    button: deniedButton as any,
    navigatorLike: {
      serviceWorker: {
        register: async () => ({ pushManager: { getSubscription: async () => null } }),
        getRegistrations: async () => [],
      },
    } as any,
    notificationApi: {
      permission: "denied",
      async requestPermission() { permissionRequests += 1; return "denied"; },
    } as any,
    fetchFn: async () => { throw new Error("must not fetch"); },
    secureContext: true,
  });
  await denied.initialize();
  await denied.enableFromGesture();
  assert.equal(permissionRequests, 0);
  assert.equal(deniedButton.dataset.state, "denied");
  assert.equal(deniedButton.textContent, "Notifications denied");
  assert.equal(deniedButton.disabled, true);
});
