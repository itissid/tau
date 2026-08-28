import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { PendingRequestMarkerStore } from "../../extensions/pending-request-markers.ts";
import type { SafetyGatePendingRequest } from "../../extensions/safety-gate-protocol.ts";
import type { TauInstanceInfo } from "../../extensions/registry.ts";
import { PushDeliveryCoordinator } from "../push-delivery.ts";
import { HubPushState } from "../push-state.ts";

const request: SafetyGatePendingRequest = {
  type: "extension_ui_request",
  schemaVersion: 1,
  requestKind: "safety-gate",
  id: "safety-gate-12345678-1234-4123-8123-123456789abc",
  method: "confirm",
  title: "Destructive shell command",
  message: "bash is paused for safety approval. Review the session before approving.",
  operation: "bash",
  createdAt: "2026-08-28T14:00:00.000Z",
};
const secondRequest: SafetyGatePendingRequest = {
  ...request,
  id: "safety-gate-abcdefab-cdef-4abc-8def-abcdefabcdef",
  operation: "write",
  createdAt: "2026-08-28T14:01:00.000Z",
};
const instance: TauInstanceInfo = {
  pid: 4101,
  port: 3101,
  host: "127.0.0.1",
  cwd: "/tmp/project",
  sessionFile: "/tmp/session.jsonl",
  startedAt: "2026-08-28T13:59:00.000Z",
  processStartTicks: "777",
};

function subscription(id: string) {
  return {
    endpoint: `https://push.example.test/send/${id}`,
    expirationTime: null,
    keys: { p256dh: `receiver-public-${id}`, auth: `receiver-auth-${id}` },
  };
}

function state(directory: string) {
  return new HubPushState(directory, {
    generateVapidKeys: () => ({
      publicKey: Buffer.alloc(65, 5).toString("base64url"),
      privateKey: Buffer.alloc(32, 6).toString("base64url"),
    }),
  });
}

test("marker discovery sends one restart-safe push per subscription and cleans settlement and stale subscriptions", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "tau-hub-push-delivery-"));
  const markerStore = new PendingRequestMarkerStore(path.join(root, "pending"));
  const pushState = state(path.join(root, "state"));
  const first = subscription("one");
  const second = subscription("two");
  pushState.upsertSubscription(first);
  pushState.upsertSubscription(second);
  markerStore.publish(instance, request);

  const sent: Array<{ endpoint: string; payload: any }> = [];
  const sender = {
    async send(target: any, payload: any) {
      sent.push({ endpoint: target.endpoint, payload });
      return { statusCode: 201 };
    },
  };
  const registry = { listLive: () => [instance] };
  const coordinator = new PushDeliveryCoordinator({ registry, markerStore, pushState, sender });
  await coordinator.scan();

  assert.deepEqual(sent.map(({ endpoint }) => endpoint).sort(), [first.endpoint, second.endpoint]);
  assert.deepEqual(sent[0]!.payload, {
    schemaVersion: 1,
    type: "safety-gate-pending",
    requestId: request.id,
    pid: 4101,
    title: "Tau permission needed",
    body: request.message,
    url: "/i/4101/",
  });
  assert.doesNotMatch(JSON.stringify(sent[0]!.payload), /privateKey|receiver-auth|receiver-public/);

  const restartedState = state(path.join(root, "state"));
  const restarted = new PushDeliveryCoordinator({ registry, markerStore, pushState: restartedState, sender });
  await restarted.scan();
  assert.equal(sent.length, 2);

  const third = subscription("three");
  restartedState.upsertSubscription(third);
  await restarted.scan();
  assert.equal(sent.length, 3);
  assert.equal(sent.at(-1)!.endpoint, third.endpoint);

  markerStore.remove(instance.pid, request.id);
  await restarted.scan();
  assert.equal(restartedState.wasDelivered(request.id, first.endpoint), false);

  const stale = subscription("gone");
  const missing = subscription("not-found");
  restartedState.upsertSubscription(stale);
  restartedState.upsertSubscription(missing);
  markerStore.publish(instance, secondRequest);
  const staleSender = {
    async send(target: any, payload: any) {
      if (target.endpoint === stale.endpoint) throw Object.assign(new Error("expired"), { statusCode: 410 });
      if (target.endpoint === missing.endpoint) return { statusCode: 404 };
      sent.push({ endpoint: target.endpoint, payload });
      return { statusCode: 201 };
    },
  };
  await new PushDeliveryCoordinator({
    registry,
    markerStore,
    pushState: restartedState,
    sender: staleSender,
  }).scan();
  const remainingEndpoints = restartedState.listSubscriptions().map(({ endpoint }) => endpoint);
  assert.equal(remainingEndpoints.includes(stale.endpoint), false);
  assert.equal(remainingEndpoints.includes(missing.endpoint), false);
  assert.equal(sent.filter(({ payload }) => payload.requestId === secondRequest.id).length, 3);
});

test("settlement during delivery prevents alerts to remaining subscriptions", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "tau-hub-settlement-race-"));
  const markerStore = new PendingRequestMarkerStore(path.join(root, "pending"));
  const pushState = state(path.join(root, "state"));
  pushState.upsertSubscription(subscription("one"));
  pushState.upsertSubscription(subscription("two"));
  markerStore.publish(instance, request);
  let sends = 0;

  await new PushDeliveryCoordinator({
    registry: { listLive: () => [instance] },
    markerStore,
    pushState,
    sender: {
      async send() {
        sends += 1;
        markerStore.remove(instance.pid, request.id);
        return { statusCode: 201 };
      },
    },
  }).scan();

  assert.equal(sends, 1);
  assert.equal(pushState.wasDelivered(request.id, subscription("one").endpoint), false);
});

test("marker discovery rejects a marker that no longer belongs to the live process identity", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "tau-hub-stale-marker-"));
  const markerStore = new PendingRequestMarkerStore(path.join(root, "pending"));
  const pushState = state(path.join(root, "state"));
  pushState.upsertSubscription(subscription("one"));
  markerStore.publish(instance, request);
  let sends = 0;

  await new PushDeliveryCoordinator({
    registry: { listLive: () => [{ ...instance, processStartTicks: "778" }] },
    markerStore,
    pushState,
    sender: { async send() { sends += 1; return { statusCode: 201 }; } },
  }).scan();

  assert.equal(sends, 0);
  assert.deepEqual(markerStore.list(), []);
});
