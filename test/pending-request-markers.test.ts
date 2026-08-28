import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { PendingRequestMarkerStore } from "../extensions/pending-request-markers.ts";
import type { SafetyGatePendingRequest } from "../extensions/safety-gate-protocol.ts";
import type { TauInstanceInfo } from "../extensions/registry.ts";

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

const instance: TauInstanceInfo = {
  pid: process.pid,
  port: 3101,
  host: "127.0.0.1",
  cwd: "/tmp/project",
  sessionFile: "/tmp/session.jsonl",
  startedAt: "2026-08-28T13:59:00.000Z",
  processStartTicks: "12345",
};

test("pending request markers persist bounded routing metadata atomically and survive restart", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "tau-pending-markers-"));
  const store = new PendingRequestMarkerStore(directory);

  store.publish(instance, request);
  store.publish(instance, request);

  const markerPath = path.join(directory, `${process.pid}-${request.id}.json`);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(markerPath).mode & 0o777, 0o600);
  assert.deepEqual(new PendingRequestMarkerStore(directory).list(), [{
    schemaVersion: 1,
    requestKind: "safety-gate",
    pid: process.pid,
    processStartTicks: "12345",
    id: request.id,
    title: request.title,
    message: request.message,
    operation: request.operation,
    createdAt: request.createdAt,
  }]);
  assert.doesNotMatch(readFileSync(markerPath, "utf8"), /SECRET_TOOL_INPUT_MUST_STAY_LOCAL/);

  store.remove(process.pid, request.id);
  assert.deepEqual(store.list(), []);
});

test("pending marker discovery removes malformed and non-canonical records", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "tau-pending-markers-invalid-"));
  const store = new PendingRequestMarkerStore(directory);
  store.publish(instance, request);

  writeFileSync(path.join(directory, "malformed.json"), "not-json", { mode: 0o600 });
  writeFileSync(
    path.join(directory, `999-${request.id}.json`),
    JSON.stringify({ ...store.list()[0], pid: process.pid }),
    { mode: 0o600 },
  );

  assert.deepEqual(store.list().map((marker) => marker.id), [request.id]);
  assert.throws(() => readFileSync(path.join(directory, "malformed.json"), "utf8"), /ENOENT/);
  assert.throws(() => readFileSync(path.join(directory, `999-${request.id}.json`), "utf8"), /ENOENT/);
});
