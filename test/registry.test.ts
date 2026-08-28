import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { TauInstanceRegistry, type TauInstanceInfo } from "../extensions/registry.ts";

function record(pid: number, port: number): TauInstanceInfo {
  return {
    pid,
    port,
    host: "127.0.0.1",
    cwd: "/tmp/project",
    sessionFile: "/tmp/session.jsonl",
    startedAt: "2026-08-28T00:00:00.000Z",
  };
}

test("registry atomically publishes live records and removes stale records", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "tau-registry-test-"));
  const registry = new TauInstanceRegistry(directory);

  registry.register(record(process.pid, 3101));
  const recordPath = path.join(directory, `${process.pid}.json`);
  const published = JSON.parse(readFileSync(recordPath, "utf8"));
  assert.deepEqual(
    { ...published, processStartTicks: undefined },
    { ...record(process.pid, 3101), processStartTicks: undefined },
  );
  if (process.platform === "linux") assert.match(published.processStartTicks, /^\d+$/);
  assert.equal(statSync(recordPath).mode & 0o777, 0o600);
  assert.deepEqual(registry.listLive(), [published]);

  registry.updateSession(process.pid, "/tmp/replacement.jsonl");
  const updated = registry.listLive()[0]!;
  assert.equal(updated.sessionFile, "/tmp/replacement.jsonl");

  const nonCanonicalPath = path.join(directory, `${process.pid}-extra.json`);
  writeFileSync(nonCanonicalPath, JSON.stringify(updated));
  assert.deepEqual(registry.listLive().map((instance) => instance.pid), [process.pid]);
  assert.throws(() => readFileSync(nonCanonicalPath, "utf8"), /ENOENT/);

  if (process.platform === "linux") {
    writeFileSync(recordPath, JSON.stringify({ ...updated, processStartTicks: "0" }));
    assert.deepEqual(registry.listLive(), []);
    assert.throws(() => readFileSync(recordPath, "utf8"), /ENOENT/);
    registry.register(record(process.pid, 3101));
  }

  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.equal(child.status, 0);
  assert.ok(child.pid);
  writeFileSync(path.join(directory, `${child.pid}.json`), JSON.stringify(record(child.pid!, 3102)));
  writeFileSync(path.join(directory, "malformed.json"), "not-json");

  assert.deepEqual(registry.listLive().map((instance) => instance.pid), [process.pid]);
  assert.throws(() => readFileSync(path.join(directory, `${child.pid}.json`), "utf8"), /ENOENT/);
  assert.throws(() => readFileSync(path.join(directory, "malformed.json"), "utf8"), /ENOENT/);

  registry.unregister(process.pid);
  assert.deepEqual(registry.listLive(), []);
});
