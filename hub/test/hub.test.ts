import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";

import { TauInstanceRegistry, type TauInstanceInfo } from "../../extensions/registry.ts";
import { createTauHubServer } from "../hub.ts";

interface Upstream {
  name: string;
  port: number;
  server: http.Server;
  webSocketServer: WebSocketServer;
  releaseStream: () => void;
}

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
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function startUpstream(name: string): Promise<Upstream> {
  let releaseStream = () => {};
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://upstream.invalid");
    if (url.pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(`<title>Tau</title><p>${name}</p>`);
      return;
    }
    if (url.pathname === "/app.js") {
      response.writeHead(200, { "Content-Type": "text/javascript" });
      response.end(`export const instance = ${JSON.stringify(name)};`);
      return;
    }
    if (url.pathname === "/icons/tau-192.png") {
      response.writeHead(200, { "Content-Type": "image/png" });
      response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, name.charCodeAt(0)]));
      return;
    }
    if (url.pathname === "/api/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok", instance: name }));
      return;
    }
    if (url.pathname === "/api/sessions") {
      await new Promise((resolve) => setTimeout(resolve, 150));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ projects: [], instance: name }));
      return;
    }
    if (url.pathname === "/api/file/preview") {
      response.writeHead(200, { "Content-Type": "image/png" });
      response.end(Buffer.from(`attachment-${name}`));
      return;
    }
    if (url.pathname === "/api/rpc") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ instance: name, body: Buffer.concat(chunks).toString("utf8") }));
      return;
    }
    if (url.pathname === "/stream") {
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      releaseStream = release;
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.write(`first-${name}\n`);
      await released;
      response.end(`second-${name}\n`);
      return;
    }
    if (url.pathname === "/target") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ instance: name, queryPort: url.searchParams.get("port") }));
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });

  const webSocketServer = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/ws") {
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
    });
  });
  webSocketServer.on("connection", (webSocket) => {
    webSocket.send(`connected-${name}`);
    webSocket.on("message", (message) => webSocket.send(`${name}:${message.toString()}`));
  });

  const port = await listen(server);
  return {
    name,
    port,
    server,
    webSocketServer,
    releaseStream: () => releaseStream(),
  };
}

function startOwner(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], {
    stdio: "ignore",
  });
  assert.ok(child.pid);
  return child;
}

function stopOwner(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
  });
}

function record(owner: ChildProcess, upstream: Upstream): TauInstanceInfo {
  assert.ok(owner.pid);
  return {
    pid: owner.pid,
    port: upstream.port,
    host: "127.0.0.1",
    cwd: `/tmp/${upstream.name}`,
    sessionFile: `/tmp/${upstream.name}.jsonl`,
    startedAt: "2026-08-28T00:00:00.000Z",
  };
}

function webSocketMessage(webSocket: WebSocket, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}`)), 2_000);
    webSocket.addEventListener("message", (event) => {
      if (event.data !== expected) return;
      clearTimeout(timeout);
      resolve();
    });
    webSocket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket failed before ${expected}`));
    }, { once: true });
  });
}

test("hub dynamically proxies only live registry PIDs across HTTP, streaming, and WebSocket Upgrade", async () => {
  const registryDirectory = mkdtempSync(path.join(tmpdir(), "tau-hub-registry-"));
  const registry = new TauInstanceRegistry(registryDirectory);
  const firstUpstream = await startUpstream("one");
  const secondUpstream = await startUpstream("two");
  const firstOwner = startOwner();
  const secondOwner = startOwner();
  const hub = createTauHubServer({ registry, upstreamTimeoutMs: 2_000 });
  const hubPort = await listen(hub);
  const hubOrigin = `http://127.0.0.1:${hubPort}`;
  const webSockets: WebSocket[] = [];

  try {
    const emptyRoot = await fetch(`${hubOrigin}/`);
    assert.equal(emptyRoot.status, 503);
    assert.match(await emptyRoot.text(), /No terminal-owned Tau instances are active/);

    const firstRecord = {
      ...record(firstOwner, firstUpstream),
      startedAt: "2026-08-28T00:00:00.000Z",
    };
    const secondRecord = {
      ...record(secondOwner, secondUpstream),
      startedAt: "2026-08-28T00:01:00.000Z",
    };
    registry.register(firstRecord);
    registry.register(secondRecord);

    const root = await fetch(`${hubOrigin}/`, { redirect: "manual" });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get("location"), `/i/${secondRecord.pid}/`);

    const noSlash = await fetch(`${hubOrigin}/i/${firstRecord.pid}?view=active`, { redirect: "manual" });
    assert.equal(noSlash.status, 308);
    assert.equal(noSlash.headers.get("location"), `/i/${firstRecord.pid}/?view=active`);

    const page = await fetch(`${hubOrigin}/i/${firstRecord.pid}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Tau<\/title><p>one<\/p>/);

    const asset = await fetch(`${hubOrigin}/i/${secondRecord.pid}/app.js`);
    assert.equal(asset.status, 200);
    assert.match(await asset.text(), /instance = "two"/);
    const icon = Buffer.from(await fetch(
      `${hubOrigin}/i/${firstRecord.pid}/icons/tau-192.png`,
    ).then((response) => response.arrayBuffer()));
    assert.deepEqual(icon, Buffer.from([0x89, 0x50, 0x4e, 0x47, "o".charCodeAt(0)]));

    const health = await fetch(`${hubOrigin}/i/${secondRecord.pid}/api/health`).then((response) => response.json());
    assert.deepEqual(health, { status: "ok", instance: "two" });
    const attachment = await fetch(
      `${hubOrigin}/i/${firstRecord.pid}/api/file/preview?path=%2Ftmp%2Fimage.png`,
    );
    assert.equal(attachment.headers.get("content-type"), "image/png");
    assert.equal(await attachment.text(), "attachment-one");

    const rpc = await fetch(`${hubOrigin}/i/${secondRecord.pid}/api/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "get_state" }),
    }).then((response) => response.json());
    assert.equal(rpc.instance, "two");
    assert.deepEqual(JSON.parse(rpc.body), { type: "get_state" });

    const arbitraryPort = await fetch(
      `${hubOrigin}/i/${firstRecord.pid}/target?port=${secondRecord.port}`,
    ).then((response) => response.json());
    assert.deepEqual(arbitraryPort, { instance: "one", queryPort: String(secondRecord.port) });

    const streamResponse = await fetch(`${hubOrigin}/i/${firstRecord.pid}/stream`);
    assert.ok(streamResponse.body);
    const reader = streamResponse.body!.getReader();
    const firstChunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Hub buffered stream")), 500)),
    ]);
    assert.equal(new TextDecoder().decode(firstChunk.value), "first-one\n");
    firstUpstream.releaseStream();
    const secondChunk = await reader.read();
    assert.equal(new TextDecoder().decode(secondChunk.value), "second-one\n");

    for (const [instanceRecord, name] of [[firstRecord, "one"], [secondRecord, "two"]] as const) {
      const webSocket = new WebSocket(`ws://127.0.0.1:${hubPort}/i/${instanceRecord.pid}/ws`);
      webSockets.push(webSocket);
      await webSocketMessage(webSocket, `connected-${name}`);
      webSocket.send("stream-event");
      await webSocketMessage(webSocket, `${name}:stream-event`);
      webSocket.close();
    }

    const unknown = await fetch(`${hubOrigin}/i/999999999/api/health`);
    assert.equal(unknown.status, 410);

    registry.register({ ...secondRecord, host: "0.0.0.0" });
    const nonLoopback = await fetch(`${hubOrigin}/i/${secondRecord.pid}/api/health`);
    assert.equal(nonLoopback.status, 410);
    const safeHealth = await fetch(`${hubOrigin}/healthz`).then((response) => response.json());
    assert.deepEqual(safeHealth.pids, [firstRecord.pid]);

    registry.register({ ...secondRecord, port: 70_000 });
    const invalidPort = await fetch(`${hubOrigin}/i/${secondRecord.pid}/api/health`);
    assert.equal(invalidPort.status, 410);
    registry.register(secondRecord);

    await stopOwner(firstOwner);
    const stale = await fetch(`${hubOrigin}/i/${firstRecord.pid}/api/health`);
    assert.equal(stale.status, 410);
    assert.match(await stale.text(), /no longer active/);
    assert.throws(
      () => readFileSync(path.join(registryDirectory, `${firstRecord.pid}.json`), "utf8"),
      /ENOENT/,
    );

    const remainingRoot = await fetch(`${hubOrigin}/`, { redirect: "manual" });
    assert.equal(remainingRoot.headers.get("location"), `/i/${secondRecord.pid}/`);
    const remainingDirect = await fetch(`http://127.0.0.1:${secondRecord.port}/api/health`).then((response) => response.json());
    assert.equal(remainingDirect.instance, "two");
  } finally {
    for (const webSocket of webSockets) webSocket.close();
    firstUpstream.releaseStream();
    secondUpstream.releaseStream();
    await Promise.all([stopOwner(firstOwner), stopOwner(secondOwner)]);
    firstUpstream.webSocketServer.close();
    secondUpstream.webSocketServer.close();
    await Promise.all([close(hub), close(firstUpstream.server), close(secondUpstream.server)]);
  }
});

test("slow session discovery gets a route-specific timeout budget", async () => {
  const registryDirectory = mkdtempSync(path.join(tmpdir(), "tau-hub-slow-sessions-"));
  const registry = new TauInstanceRegistry(registryDirectory);
  const upstream = await startUpstream("slow-sessions");
  const owner = startOwner();
  const hub = createTauHubServer({
    registry,
    upstreamTimeoutMs: 50,
    sessionListTimeoutMs: 500,
  });
  const hubPort = await listen(hub);

  try {
    const instanceRecord = record(owner, upstream);
    registry.register(instanceRecord);
    const response = await fetch(
      `http://127.0.0.1:${hubPort}/i/${instanceRecord.pid}/api/sessions`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { projects: [], instance: "slow-sessions" });
  } finally {
    await stopOwner(owner);
    upstream.webSocketServer.close();
    await Promise.all([close(hub), close(upstream.server)]);
  }
});
