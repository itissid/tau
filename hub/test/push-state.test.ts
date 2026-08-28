import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { HubPushState } from "../push-state.ts";

const firstSubscription = {
  endpoint: "https://push.example.test/send/subscription-one",
  expirationTime: null,
  keys: { p256dh: "receiver-public-key-one", auth: "receiver-auth-one" },
};
const secondSubscription = {
  endpoint: "https://push.example.test/send/subscription-two",
  expirationTime: 2_000_000_000_000,
  keys: { p256dh: "receiver-public-key-two", auth: "receiver-auth-two" },
};

function keyGenerator() {
  return {
    publicKey: Buffer.alloc(65, 1).toString("base64url"),
    privateKey: Buffer.alloc(32, 2).toString("base64url"),
  };
}

test("Hub push state persists one VAPID identity and deduplicated subscriptions with restrictive atomic files", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "tau-hub-push-state-"));
  let generated = 0;
  const generateVapidKeys = () => {
    generated += 1;
    return keyGenerator();
  };
  const first = new HubPushState(directory, { generateVapidKeys });
  const publicKey = first.getPublicVapidKey();
  assert.equal(generated, 1);

  assert.deepEqual(first.upsertSubscription(firstSubscription), { created: true });
  assert.deepEqual(first.upsertSubscription(firstSubscription), { created: false });
  assert.deepEqual(first.upsertSubscription(secondSubscription), { created: true });
  assert.equal(first.listSubscriptions().length, 2);

  const restarted = new HubPushState(directory, { generateVapidKeys });
  assert.equal(restarted.getPublicVapidKey(), publicKey);
  assert.equal(generated, 1);
  assert.deepEqual(restarted.listSubscriptions(), [firstSubscription, secondSubscription]);

  assert.equal(statSync(directory).mode & 0o777, 0o700);
  const files = readdirSync(directory);
  assert.deepEqual(files.sort(), ["deliveries.json", "subscriptions.json", "vapid.json"]);
  for (const file of files) assert.equal(statSync(path.join(directory, file)).mode & 0o777, 0o600);
  assert.equal(files.some((file) => file.endsWith(".tmp")), false);

  assert.equal(restarted.removeSubscription(firstSubscription.endpoint), true);
  assert.equal(restarted.removeSubscription(firstSubscription.endpoint), false);
  assert.deepEqual(restarted.listSubscriptions(), [secondSubscription]);
});

test("Hub push state rejects subscription overflow before it can make restart state invalid", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "tau-hub-subscription-limit-"));
  const pushState = new HubPushState(directory, { generateVapidKeys: keyGenerator });
  for (let index = 0; index < 128; index += 1) {
    pushState.upsertSubscription({
      endpoint: `https://push.example.test/send/subscription-${index}`,
      expirationTime: null,
      keys: { p256dh: `receiver-public-${index}`, auth: `receiver-auth-${index}` },
    });
  }
  assert.throws(() => pushState.upsertSubscription({
    endpoint: "https://push.example.test/send/subscription-overflow",
    expirationTime: null,
    keys: { p256dh: "receiver-public-overflow", auth: "receiver-auth-overflow" },
  }), /limit/i);
  assert.equal(pushState.listSubscriptions().length, 128);
  assert.equal(new HubPushState(directory, { generateVapidKeys: keyGenerator }).listSubscriptions().length, 128);
});

test("Hub push state survives restart with per-subscription delivery deduplication and bounded cleanup", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "tau-hub-push-deliveries-"));
  const state = new HubPushState(directory, { generateVapidKeys: keyGenerator });
  state.upsertSubscription(firstSubscription);
  state.upsertSubscription(secondSubscription);

  const requestId = "safety-gate-12345678-1234-4123-8123-123456789abc";
  state.recordDelivered(requestId, firstSubscription.endpoint);
  assert.equal(state.wasDelivered(requestId, firstSubscription.endpoint), true);
  assert.equal(state.wasDelivered(requestId, secondSubscription.endpoint), false);

  const restarted = new HubPushState(directory, { generateVapidKeys: keyGenerator });
  assert.equal(restarted.wasDelivered(requestId, firstSubscription.endpoint), true);
  restarted.retainDeliveries(new Set());
  assert.equal(restarted.wasDelivered(requestId, firstSubscription.endpoint), false);
});
