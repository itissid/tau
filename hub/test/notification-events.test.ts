import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createTauHubServer } from "../hub.ts";
import { NotificationEventLog } from "../notification-events.ts";

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

const clickedEvent = {
  schemaVersion: 1,
  source: "service-worker",
  event: "notification-clicked",
  occurredAt: "2026-08-29T03:00:00.000Z",
  requestId: "safety-gate-00000000-0000-4000-8000-000000000001",
  pid: 4101,
  targetUrl: "/i/4101/",
  clientCount: 2,
};

test("Hub stores bounded notification lifecycle events without exposing a read route", async () => {
  const stateDirectory = mkdtempSync(path.join(tmpdir(), "tau-notification-events-"));
  const notificationEventLog = new NotificationEventLog(stateDirectory);
  const hub = createTauHubServer({
    registry: { listLive: () => [] },
    notificationEventLog,
  });
  const port = await listen(hub);
  const origin = `http://127.0.0.1:${port}`;

  try {
    const accepted = await fetch(`${origin}/api/push/notification-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(clickedEvent),
    });
    assert.equal(accepted.status, 202);
    assert.deepEqual(await accepted.json(), { ok: true });

    const lines = readFileSync(notificationEventLog.filePath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const stored = JSON.parse(lines[0]!);
    assert.deepEqual(stored, {
      receivedAt: stored.receivedAt,
      ...clickedEvent,
    });
    assert.match(stored.receivedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(statSync(notificationEventLog.filePath).mode & 0o777, 0o600);

    const listing = await fetch(`${origin}/api/push/notification-events`);
    assert.equal(listing.status, 405);
    assert.doesNotMatch(await listing.text(), /safety-gate|4101/);
  } finally {
    await close(hub);
  }
});

test("Hub rejects notification diagnostics containing unbounded or protected fields", async () => {
  const stateDirectory = mkdtempSync(path.join(tmpdir(), "tau-notification-events-invalid-"));
  const notificationEventLog = new NotificationEventLog(stateDirectory);
  const hub = createTauHubServer({
    registry: { listLive: () => [] },
    notificationEventLog,
  });
  const port = await listen(hub);
  const origin = `http://127.0.0.1:${port}`;

  try {
    for (const invalid of [
      { ...clickedEvent, prompt: "private command" },
      { ...clickedEvent, targetUrl: "/i/9999/" },
      { ...clickedEvent, requestId: "not-a-safety-request" },
      { ...clickedEvent, clientCount: 10_000 },
      { ...clickedEvent, event: "arbitrary-debug-message" },
    ]) {
      const response = await fetch(`${origin}/api/push/notification-events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(invalid),
      });
      assert.equal(response.status, 400);
    }
    assert.throws(() => readFileSync(notificationEventLog.filePath, "utf8"), /ENOENT/);
  } finally {
    await close(hub);
  }
});
