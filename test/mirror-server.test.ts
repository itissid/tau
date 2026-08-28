import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import test from "node:test";
import { WebSocket } from "ws";

import {
  SAFETY_GATE_PENDING_EVENT,
  SAFETY_GATE_SETTLED_EVENT,
} from "../extensions/safety-gate-protocol.ts";

async function freePort(): Promise<number> {
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return port;
}

class FakePi {
  handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  commands = new Map<string, any>();
  eventListeners = new Map<string, Array<(value: unknown) => void>>();
  events = {
    on: (name: string, listener: (value: unknown) => void) => {
      const listeners = this.eventListeners.get(name) ?? [];
      listeners.push(listener);
      this.eventListeners.set(name, listeners);
    },
    emit: (name: string, value: unknown) => {
      for (const listener of this.eventListeners.get(name) ?? []) listener(value);
    },
  };
  sentUserMessages: Array<{ content: unknown; options: unknown }> = [];
  sessionName: string | undefined;
  thinkingLevel = "medium";

  on(event: string, handler: (event: any, ctx: any) => unknown) {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  registerCommand(name: string, command: any) {
    this.commands.set(name, command);
  }

  async emit(event: string, value: any, ctx: any) {
    for (const handler of this.handlers.get(event) ?? []) {
      await handler(value, ctx);
    }
  }

  sendUserMessage(content: unknown, options?: unknown) {
    this.sentUserMessages.push({ content, options });
  }

  getThinkingLevel() {
    return this.thinkingLevel;
  }

  setThinkingLevel(level: string) {
    this.thinkingLevel = level;
  }

  getSessionName() {
    return this.sessionName;
  }

  setSessionName(name: string) {
    this.sessionName = name;
  }

  async setModel() {
    return true;
  }
}

async function waitFor<T>(read: () => T | undefined, description: string): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

test("mirror serves Tau, streams Pi state/events, accepts prompt/abort, and stays terminal-safe", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "tau-mirror-test-"));
  const home = path.join(root, "home");
  const agentDir = path.join(home, ".pi", "agent");
  const instancesDir = path.join(home, ".pi", "tau-instances");
  const pendingDir = path.join(home, ".pi", "tau-pending");
  const logFile = path.join(agentDir, "logs", "tau-test.log");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(path.join(agentDir, "settings.json"), "{}\n");
  const port = await freePort();

  const previousEnvironment = {
    HOME: process.env.HOME,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    TAU_HOST: process.env.TAU_HOST,
    TAU_MIRROR_PORT: process.env.TAU_MIRROR_PORT,
    TAU_INSTANCES_DIR: process.env.TAU_INSTANCES_DIR,
    TAU_PENDING_DIR: process.env.TAU_PENDING_DIR,
    TAU_LOG_FILE: process.env.TAU_LOG_FILE,
  };
  Object.assign(process.env, {
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    TAU_HOST: "0.0.0.0",
    TAU_MIRROR_PORT: String(port),
    TAU_INSTANCES_DIR: instancesDir,
    TAU_PENDING_DIR: pendingDir,
    TAU_LOG_FILE: logFile,
  });

  const terminalWrites: unknown[][] = [];
  const originalConsole = {
    log: console.log,
    error: console.error,
    warn: console.warn,
  };
  console.log = (...args: unknown[]) => { terminalWrites.push(["log", ...args]); };
  console.error = (...args: unknown[]) => { terminalWrites.push(["error", ...args]); };
  console.warn = (...args: unknown[]) => { terminalWrites.push(["warn", ...args]); };

  const fakePi = new FakePi();
  const notifications: Array<{ message: string; type: string }> = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  let abortCount = 0;
  const transcript = [{
    type: "message",
    id: "entry-1",
    parentId: null,
    timestamp: "2026-08-28T00:00:00.000Z",
    message: { role: "user", content: "existing transcript" },
  }];
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: "/tmp/tau-browser-project",
    ui: {
      notify(message: string, type: string) { notifications.push({ message, type }); },
      setStatus(key: string, text: string | undefined) { statuses.push({ key, text }); },
    },
    sessionManager: {
      getSessionFile: () => "/tmp/session.jsonl",
      getEntries: () => transcript,
    },
    model: { provider: "test", id: "model" },
    modelRegistry: { getAvailable: async () => [] },
    getContextUsage: () => ({ tokens: 12, contextWindow: 100, percent: 12 }),
    isIdle: () => true,
    abort: () => { abortCount++; },
    compact: () => undefined,
  };

  let ws: WebSocket | undefined;
  let started = false;
  try {
    const extensionModule = await import(`../extensions/mirror-server.ts?test=${Date.now()}`);
    extensionModule.default(fakePi as any);
    await fakePi.emit("session_start", { reason: "startup" }, ctx);
    started = true;

    // A duplicate startup signal in one Pi process remains idempotent.
    const autoStartHandler = fakePi.handlers.get("session_start")?.at(-1);
    assert.ok(autoStartHandler);
    await autoStartHandler!({ reason: "reload" }, ctx);

    const records = readdirSync(instancesDir).filter((file) => file.endsWith(".json"));
    assert.deepEqual(records, [`${process.pid}.json`]);
    const record = JSON.parse(readFileSync(path.join(instancesDir, records[0]!), "utf8"));
    assert.equal(record.port, port);
    assert.equal(record.host, "127.0.0.1");
    assert.equal(record.sessionFile, "/tmp/session.jsonl");

    const pendingRequest = {
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
    fakePi.events.emit(SAFETY_GATE_PENDING_EVENT, pendingRequest);
    const pendingFiles = readdirSync(pendingDir).filter((file) => file.endsWith(".json"));
    assert.deepEqual(pendingFiles, [`${process.pid}-${pendingRequest.id}.json`]);
    assert.doesNotMatch(readFileSync(path.join(pendingDir, pendingFiles[0]!), "utf8"), /SECRET_TOOL_INPUT_MUST_STAY_LOCAL/);
    fakePi.events.emit(SAFETY_GATE_SETTLED_EVENT, {
      schemaVersion: 1,
      id: pendingRequest.id,
      answer: "deny",
      source: "terminal",
    });
    assert.deepEqual(readdirSync(pendingDir).filter((file) => file.endsWith(".json")), []);

    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Tau<\/title>/);
    const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((response) => response.json());
    assert.equal(health.mirrorUrl, `http://127.0.0.1:${port}`);
    assert.equal(health.tailscaleUrl, undefined);

    const messages: any[] = [];
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => {
      ws!.once("open", resolve);
      ws!.once("error", reject);
    });

    const snapshot = await waitFor(
      () => messages.find((message) => message.type === "mirror_sync"),
      "current transcript snapshot",
    );
    assert.deepEqual(snapshot.entries, transcript);

    await fakePi.emit("message_start", { message: { role: "assistant", content: [] } }, ctx);
    await fakePi.emit("tool_execution_start", {
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "README.md" },
    }, ctx);
    assert.ok(await waitFor(
      () => messages.find((message) => message.event?.type === "message_start"),
      "live message event",
    ));
    assert.ok(await waitFor(
      () => messages.find((message) => message.event?.type === "tool_execution_start"),
      "live tool event",
    ));

    ws.send(JSON.stringify({ id: "prompt-1", type: "prompt", message: "browser prompt" }));
    assert.ok(await waitFor(
      () => messages.find((message) => message.type === "response" && message.id === "prompt-1"),
      "prompt response",
    ));
    assert.deepEqual(fakePi.sentUserMessages, [{ content: "browser prompt", options: undefined }]);

    ws.send(JSON.stringify({ id: "abort-1", type: "abort" }));
    assert.ok(await waitFor(
      () => messages.find((message) => message.type === "response" && message.id === "abort-1"),
      "abort response",
    ));
    assert.equal(abortCount, 1);

    ws.send("not-json");
    ws.close();
    await new Promise<void>((resolve) => ws!.once("close", () => resolve()));
    ws = undefined;

    await fakePi.emit("session_shutdown", { reason: "quit" }, ctx);
    started = false;

    assert.deepEqual(readdirSync(instancesDir).filter((file) => file.endsWith(".json")), []);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`));
    assert.ok(notifications.some(({ message, type }) =>
      type === "warning" && message.includes("binding to 127.0.0.1")));
    assert.ok(notifications.some(({ message, type }) =>
      type === "info" && message.includes(`http://127.0.0.1:${port}`)));
    assert.ok(statuses.some(({ text }) => text === `Mirror: 127.0.0.1:${port}`));
    assert.equal(statuses.at(-1)?.text, undefined);

    const diagnostics = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    for (const event of [
      "host_restricted_to_loopback",
      "server_started",
      "browser_connected",
      "browser_message_parse_failed",
      "browser_disconnected",
      "server_stopped",
    ]) {
      assert.ok(diagnostics.some((record) => record.event === event), `missing diagnostic ${event}`);
    }
    assert.deepEqual(terminalWrites, []);
  } finally {
    if (ws) ws.terminate();
    if (started) await fakePi.emit("session_shutdown", { reason: "quit" }, ctx);
    console.log = originalConsole.log;
    console.error = originalConsole.error;
    console.warn = originalConsole.warn;
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
