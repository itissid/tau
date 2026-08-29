import assert from "node:assert/strict";
import test from "node:test";

import { reportNotificationLifecycleEvent } from "../public/notification-events.js";

const requestId = "safety-gate-12345678-1234-4123-8123-123456789abc";

test("browser reports only bounded page-side notification lifecycle fields", async () => {
  const requests: Array<{ url: string; options: any }> = [];
  const fetchFn = async (url: string, options: any) => {
    requests.push({ url, options });
    return { ok: true };
  };

  assert.equal(await reportNotificationLifecycleEvent({
    event: "pending-dialog-shown",
    requestId,
    pid: 4101,
  }, {
    fetchFn,
    now: () => new Date("2026-08-29T03:01:00.000Z"),
  }), true);

  assert.deepEqual(requests, [{
    url: "/api/push/notification-events",
    options: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        source: "page",
        event: "pending-dialog-shown",
        occurredAt: "2026-08-29T03:01:00.000Z",
        requestId,
        pid: 4101,
        targetUrl: "/i/4101/",
      }),
    },
  }]);

  assert.equal(await reportNotificationLifecycleEvent({
    event: "pending-dialog-shown",
    requestId: "not-a-safety-request",
    pid: 4101,
  }, { fetchFn }), false);
  assert.equal(requests.length, 1);
});

test("browser notification diagnostics are best effort", async () => {
  const result = await reportNotificationLifecycleEvent({
    event: "pending-dialog-response",
    requestId,
    pid: 4101,
    result: "approve",
  }, {
    fetchFn: async () => { throw new Error("offline"); },
  });
  assert.equal(result, false);
});
