import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";

import type { TauInstanceInfo } from "../extensions/registry.ts";
import type { HubPushState } from "./push-state.ts";

export interface LiveTauRegistry {
  listLive(): TauInstanceInfo[];
}

export interface TauHubOptions {
  registry: LiveTauRegistry;
  upstreamTimeoutMs?: number;
  sessionListTimeoutMs?: number;
  pushState?: HubPushState;
  rootAssetsDirectory?: string;
}

interface InstanceRoute {
  pid: number;
  prefix: string;
  upstreamPath: string;
}

const INSTANCE_ROUTE = /^\/i\/([1-9]\d*)(?=\/|$)/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const DEFAULT_UPSTREAM_TIMEOUT_MS = 10_000;
const DEFAULT_SESSION_LIST_TIMEOUT_MS = 60_000;
const MAX_PUSH_REQUEST_BYTES = 16_384;
const ROOT_ASSETS: Record<string, { file: string; contentType: string }> = {
  "/sw.js": { file: "sw.js", contentType: "application/javascript; charset=utf-8" },
  "/manifest.webmanifest": { file: "manifest.webmanifest", contentType: "application/manifest+json; charset=utf-8" },
  "/icons/tau-192.png": { file: "icons/tau-192.png", contentType: "image/png" },
  "/icons/tau-512.png": { file: "icons/tau-512.png", contentType: "image/png" },
  "/icons/tau-maskable-512.png": { file: "icons/tau-maskable-512.png", contentType: "image/png" },
};

function parseInstanceRoute(rawUrl: string): InstanceRoute | undefined {
  const pathname = new URL(rawUrl, "http://tau-hub.invalid").pathname;
  const match = INSTANCE_ROUTE.exec(pathname);
  if (!match) return undefined;

  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;

  const prefix = `/i/${pid}`;
  const remainder = rawUrl.slice(prefix.length);
  const upstreamPath = !remainder || remainder.startsWith("?") ? `/${remainder}` : remainder;
  if (!upstreamPath.startsWith("/")) return undefined;
  return { pid, prefix, upstreamPath };
}

function writeJson(
  response: http.ServerResponse,
  statusCode: number,
  value: unknown,
  extraHeaders: http.OutgoingHttpHeaders = {},
): void {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PUSH_REQUEST_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    request.on("end", () => {
      if (tooLarge) {
        reject(Object.assign(new Error("Request body is too large"), { statusCode: 413 }));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch {
        reject(Object.assign(new Error("Request body must be JSON"), { statusCode: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function serveRootAsset(
  response: http.ServerResponse,
  pathname: string,
  directory: string | undefined,
): boolean {
  const asset = ROOT_ASSETS[pathname];
  if (!asset || !directory) return false;
  const filePath = path.join(directory, asset.file);
  try {
    const body = fs.readFileSync(filePath);
    response.writeHead(200, {
      "Cache-Control": pathname === "/sw.js" ? "no-cache" : "public, max-age=3600",
      "Content-Type": asset.contentType,
      ...(pathname === "/sw.js" ? { "Service-Worker-Allowed": "/" } : {}),
      "X-Content-Type-Options": "nosniff",
    });
    response.end(body);
  } catch {
    writeJson(response, 404, { error: "Tau Hub asset not found" });
  }
  return true;
}

async function handlePushRoute(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  pathname: string,
  pushState: HubPushState | undefined,
): Promise<boolean> {
  if (!pathname.startsWith("/api/push/")) return false;
  if (!pushState) {
    writeJson(response, 404, { error: "Tau Hub push is not configured" });
    return true;
  }

  if (pathname === "/api/push/vapid-public-key") {
    if (request.method !== "GET") {
      writeJson(response, 405, { error: "Method not allowed" }, { Allow: "GET" });
      return true;
    }
    writeJson(response, 200, { publicKey: pushState.getPublicVapidKey() });
    return true;
  }

  if (pathname !== "/api/push/subscriptions") {
    writeJson(response, 404, { error: "Tau Hub push route not found" });
    return true;
  }
  if (request.method !== "POST" && request.method !== "DELETE") {
    writeJson(response, 405, { error: "Method not allowed" }, { Allow: "POST, DELETE" });
    return true;
  }

  try {
    const body = await readJsonBody(request);
    if (request.method === "POST") {
      const result = pushState.upsertSubscription(body);
      writeJson(response, result.created ? 201 : 200, { ok: true, created: result.created });
      return true;
    }
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).length !== 1 || typeof (body as { endpoint?: unknown }).endpoint !== "string") {
      writeJson(response, 400, { error: "Invalid subscription removal" });
      return true;
    }
    const removed = pushState.removeSubscription((body as { endpoint: string }).endpoint);
    writeJson(response, 200, { ok: true, removed });
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode ?? 400;
    if (!response.headersSent) writeJson(response, statusCode, { error: statusCode === 413 ? "Request body is too large" : "Invalid push subscription" });
  }
  return true;
}

function writeNoInstances(response: http.ServerResponse): void {
  response.writeHead(503, {
    "Cache-Control": "no-store",
    "Content-Type": "text/html; charset=utf-8",
    "Retry-After": "2",
  });
  response.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="2"><title>Tau Hub</title></head>
<body><main><h1>Tau Hub</h1><p>No terminal-owned Tau instances are active.</p><p>Start Pi in a terminal, then this page will refresh.</p></main></body></html>\n`);
}

function loadLiveInstances(
  registry: LiveTauRegistry,
): { instances: TauInstanceInfo[] } | { error: unknown } {
  try {
    return { instances: registry.listLive() };
  } catch (error) {
    return { error };
  }
}

function isRoutableInstance(instance: TauInstanceInfo): boolean {
  return (
    LOOPBACK_HOSTS.has(instance.host) &&
    Number.isInteger(instance.port) &&
    instance.port > 0 &&
    instance.port <= 65_535
  );
}

function newestRoutableInstance(instances: TauInstanceInfo[]): TauInstanceInfo | undefined {
  return instances
    .filter(isRoutableInstance)
    .reduce<TauInstanceInfo | undefined>((newest, candidate) => {
      if (!newest) return candidate;
      const timeDifference = Date.parse(candidate.startedAt) - Date.parse(newest.startedAt);
      if (Number.isFinite(timeDifference) && timeDifference !== 0) {
        return timeDifference > 0 ? candidate : newest;
      }
      return candidate.pid > newest.pid ? candidate : newest;
    }, undefined);
}

function httpUpstreamTimeout(
  upstreamPath: string,
  upstreamTimeoutMs: number,
  sessionListTimeoutMs: number,
): number {
  const pathname = new URL(upstreamPath, "http://tau-upstream.invalid").pathname;
  return pathname === "/api/sessions"
    ? Math.max(upstreamTimeoutMs, sessionListTimeoutMs)
    : upstreamTimeoutMs;
}

function resolveInstance(
  registry: LiveTauRegistry,
  pid: number,
): { instance?: TauInstanceInfo; registryError?: unknown } {
  const result = loadLiveInstances(registry);
  if ("error" in result) return { registryError: result.error };
  const instance = result.instances.find((candidate) => candidate.pid === pid);
  if (!instance || !isRoutableInstance(instance)) return {};
  return { instance };
}

function upstreamHostHeader(instance: TauInstanceInfo): string {
  const host = instance.host === "::1" ? "[::1]" : instance.host;
  return `${host}:${instance.port}`;
}

function proxyHttpRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  instance: TauInstanceInfo,
  upstreamPath: string,
  upstreamTimeoutMs: number,
): void {
  const headers = { ...request.headers, host: upstreamHostHeader(instance) };
  delete headers["proxy-connection"];

  const upstream = http.request({
    host: instance.host,
    port: instance.port,
    method: request.method,
    path: upstreamPath,
    headers,
    timeout: upstreamTimeoutMs,
  });

  upstream.on("response", (upstreamResponse) => {
    response.writeHead(
      upstreamResponse.statusCode ?? 502,
      upstreamResponse.statusMessage,
      upstreamResponse.rawHeaders,
    );
    upstreamResponse.pipe(response);
  });

  upstream.on("timeout", () => {
    upstream.destroy(new Error("Tau mirror upstream timed out"));
  });

  upstream.on("error", () => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    writeJson(response, 502, { error: "Tau instance is registered but unreachable" });
  });

  request.on("aborted", () => upstream.destroy());
  request.pipe(upstream);
}

function rawUpgradeRequest(request: http.IncomingMessage, upstreamPath: string, host: string): string {
  const lines = [`${request.method ?? "GET"} ${upstreamPath} HTTP/${request.httpVersion}`];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (!name || value === undefined || name.toLowerCase() === "host") continue;
    lines.push(`${name}: ${value}`);
  }
  lines.push(`Host: ${host}`, "", "");
  return lines.join("\r\n");
}

function writeSocketError(socket: net.Socket, statusCode: number, message: string): void {
  if (!socket.writable) return;
  const body = `${message}\n`;
  socket.end(
    `HTTP/1.1 ${statusCode} ${http.STATUS_CODES[statusCode] ?? "Error"}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

function proxyWebSocketUpgrade(
  request: http.IncomingMessage,
  socket: net.Socket,
  head: Buffer,
  instance: TauInstanceInfo,
  upstreamPath: string,
  upstreamTimeoutMs: number,
): void {
  if (upstreamPath !== "/ws") {
    writeSocketError(socket, 404, "WebSocket route not found");
    return;
  }

  let connected = false;
  const upstreamSocket = net.createConnection({
    host: instance.host,
    port: instance.port,
  });
  upstreamSocket.setTimeout(upstreamTimeoutMs);

  upstreamSocket.once("connect", () => {
    connected = true;
    upstreamSocket.setTimeout(0);
    upstreamSocket.write(rawUpgradeRequest(request, upstreamPath, upstreamHostHeader(instance)));
    if (head.length > 0) upstreamSocket.write(head);
    socket.pipe(upstreamSocket).pipe(socket);
  });

  upstreamSocket.on("timeout", () => {
    upstreamSocket.destroy(new Error("Tau mirror WebSocket upstream timed out"));
  });

  upstreamSocket.on("error", () => {
    if (!connected) writeSocketError(socket, 502, "Tau instance is registered but unreachable");
    else socket.destroy();
  });

  socket.on("error", () => upstreamSocket.destroy());
  socket.on("close", () => upstreamSocket.destroy());
}

export function createTauHubServer(options: TauHubOptions): http.Server {
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  const sessionListTimeoutMs = options.sessionListTimeoutMs ?? DEFAULT_SESSION_LIST_TIMEOUT_MS;
  const server = http.createServer((request, response) => {
    const rawUrl = request.url ?? "/";
    const url = new URL(rawUrl, "http://tau-hub.invalid");

    if (serveRootAsset(response, url.pathname, options.rootAssetsDirectory)) return;
    if (url.pathname.startsWith("/api/push/")) {
      void handlePushRoute(request, response, url.pathname, options.pushState);
      return;
    }

    if (url.pathname === "/healthz") {
      const result = loadLiveInstances(options.registry);
      if ("error" in result) {
        writeJson(response, 503, { status: "error", error: "Tau registry is unavailable" });
        return;
      }
      const routableInstances = result.instances.filter(isRoutableInstance);
      writeJson(response, 200, {
        status: "ok",
        activeInstances: routableInstances.length,
        pids: routableInstances.map((instance) => instance.pid),
      });
      return;
    }

    if (url.pathname === "/") {
      const result = loadLiveInstances(options.registry);
      if ("error" in result) {
        writeJson(response, 503, { error: "Tau registry is unavailable" });
        return;
      }
      const newest = newestRoutableInstance(result.instances);
      if (!newest) {
        writeNoInstances(response);
        return;
      }
      response.writeHead(302, {
        "Cache-Control": "no-store",
        Location: `/i/${newest.pid}/`,
      });
      response.end();
      return;
    }

    const route = parseInstanceRoute(rawUrl);
    if (!route) {
      writeJson(response, 404, { error: "Tau Hub route not found" });
      return;
    }

    const resolved = resolveInstance(options.registry, route.pid);
    if (resolved.registryError) {
      writeJson(response, 503, { error: "Tau registry is unavailable" });
      return;
    }
    if (!resolved.instance) {
      writeJson(response, 410, { error: "Tau instance is no longer active", pid: route.pid });
      return;
    }

    if (url.pathname === route.prefix) {
      response.writeHead(308, {
        "Cache-Control": "no-store",
        Location: `${route.prefix}/${url.search}`,
      });
      response.end();
      return;
    }

    proxyHttpRequest(
      request,
      response,
      resolved.instance,
      route.upstreamPath,
      httpUpstreamTimeout(route.upstreamPath, upstreamTimeoutMs, sessionListTimeoutMs),
    );
  });

  server.on("upgrade", (request, socket, head) => {
    const route = parseInstanceRoute(request.url ?? "/");
    if (!route) {
      writeSocketError(socket, 404, "Tau Hub route not found");
      return;
    }

    const resolved = resolveInstance(options.registry, route.pid);
    if (resolved.registryError) {
      writeSocketError(socket, 503, "Tau registry is unavailable");
      return;
    }
    if (!resolved.instance) {
      writeSocketError(socket, 410, "Tau instance is no longer active");
      return;
    }

    proxyWebSocketUpgrade(
      request,
      socket,
      head,
      resolved.instance,
      route.upstreamPath,
      upstreamTimeoutMs,
    );
  });

  return server;
}
