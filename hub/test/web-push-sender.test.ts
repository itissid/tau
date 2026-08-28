import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import test from "node:test";
import webpush from "web-push";

import {
  createWebPushSender,
  generatePushRequest,
} from "../web-push-sender.ts";

const payload = {
  schemaVersion: 1 as const,
  type: "safety-gate-pending" as const,
  requestId: "safety-gate-12345678-1234-4123-8123-123456789abc",
  pid: 4101,
  title: "Tau permission needed",
  body: "A Pi action is waiting for safety approval.",
  url: "/i/4101/",
};

function receiverSubscription() {
  const receiver = createECDH("prime256v1");
  receiver.generateKeys();
  return {
    endpoint: "https://push.example.invalid/send/disposable-request-test",
    expirationTime: null,
    keys: {
      p256dh: receiver.getPublicKey().toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
    },
  };
}

test("Web Push request generation encrypts the bounded payload and adds VAPID authentication", () => {
  const vapidKeys = webpush.generateVAPIDKeys();
  const request = generatePushRequest(receiverSubscription(), payload, vapidKeys);

  assert.equal(request.endpoint, "https://push.example.invalid/send/disposable-request-test");
  assert.ok(Buffer.isBuffer(request.body));
  assert.ok(request.body.length > 0);
  assert.equal(request.headers["Content-Encoding"], "aes128gcm");
  assert.match(String(request.headers.Authorization), /^vapid t=/);
  assert.equal(request.headers.TTL, 300);
  assert.doesNotMatch(request.body.toString("utf8"), /safety-gate|4101|approval/);
});

test("sender seam passes one serialized payload without exposing subscription or VAPID secrets", async () => {
  const calls: any[] = [];
  const sender = createWebPushSender({
    async sendNotification(target: any, body: string, options: any) {
      calls.push({ target, body, options });
      return { statusCode: 201 };
    },
  } as any);
  const target = receiverSubscription();
  const vapidKeys = webpush.generateVAPIDKeys();

  assert.deepEqual(await sender.send(target, payload, vapidKeys), { statusCode: 201 });
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].body), payload);
  assert.equal(calls[0].options.TTL, 300);
  assert.equal(calls[0].options.urgency, "high");
  assert.equal(calls[0].options.vapidDetails.publicKey, vapidKeys.publicKey);
  assert.equal(calls[0].options.vapidDetails.privateKey, vapidKeys.privateKey);
  assert.doesNotMatch(calls[0].body, new RegExp(target.keys.auth));
  assert.doesNotMatch(calls[0].body, new RegExp(vapidKeys.privateKey));
});
