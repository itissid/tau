import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTauHubServer } from "../hub.ts";
import { HubPushState } from "../push-state.ts";

const directory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.resolve(directory, "../../public");

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      assert.ok(address && typeof address === "object");
      resolve(address.port);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

const subscription = {
  endpoint: "https://push.example.test/send/http-subscription",
  expirationTime: null,
  keys: { p256dh: "receiver-public-key", auth: "receiver-auth-secret" },
};

test("Hub exposes root PWA assets and a secret-minimizing subscription lifecycle without a notification trigger", async () => {
  const stateDirectory = mkdtempSync(path.join(tmpdir(), "tau-hub-http-push-"));
  const pushState = new HubPushState(stateDirectory, {
    generateVapidKeys: () => ({
      publicKey: Buffer.alloc(65, 3).toString("base64url"),
      privateKey: Buffer.alloc(32, 4).toString("base64url"),
    }),
  });
  const hub = createTauHubServer({
    registry: { listLive: () => [] },
    pushState,
    rootAssetsDirectory: publicDirectory,
  });
  const port = await listen(hub);
  const origin = `http://127.0.0.1:${port}`;

  try {
    const worker = await fetch(`${origin}/sw.js`);
    assert.equal(worker.status, 200);
    assert.equal(worker.headers.get("content-type"), "application/javascript; charset=utf-8");
    assert.equal(worker.headers.get("service-worker-allowed"), "/");
    assert.match(await worker.text(), /notificationclick/);

    const manifest = await fetch(`${origin}/manifest.webmanifest`);
    assert.equal(manifest.status, 200);
    assert.equal(manifest.headers.get("content-type"), "application/manifest+json; charset=utf-8");
    assert.deepEqual((await manifest.json()).scope, "/");
    const icon = await fetch(`${origin}/icons/tau-192.png`);
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get("content-type"), "image/png");

    const publicKeyResponse = await fetch(`${origin}/api/push/vapid-public-key`);
    assert.equal(publicKeyResponse.status, 200);
    const publicKeyBody = await publicKeyResponse.text();
    assert.deepEqual(Object.keys(JSON.parse(publicKeyBody)), ["publicKey"]);
    assert.doesNotMatch(publicKeyBody, /private|subscription|endpoint|auth/i);

    const created = await fetch(`${origin}/api/push/subscriptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscription),
    });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { ok: true, created: true });
    const duplicate = await fetch(`${origin}/api/push/subscriptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscription),
    });
    assert.equal(duplicate.status, 200);
    assert.deepEqual(await duplicate.json(), { ok: true, created: false });
    assert.equal(pushState.listSubscriptions().length, 1);

    const listing = await fetch(`${origin}/api/push/subscriptions`);
    assert.equal(listing.status, 405);
    assert.doesNotMatch(await listing.text(), /push\.example|receiver|auth-secret/);

    const deleted = await fetch(`${origin}/api/push/subscriptions`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { ok: true, removed: true });
    assert.deepEqual(pushState.listSubscriptions(), []);

    const invalid = await fetch(`${origin}/api/push/subscriptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: "http://not-secure.invalid", keys: {} }),
    });
    assert.equal(invalid.status, 400);

    for (const route of ["/api/push/send", "/api/notify", "/api/push/notify"]) {
      assert.equal((await fetch(`${origin}${route}`, { method: "POST" })).status, 404);
    }
  } finally {
    await close(hub);
  }
});
