import * as fs from "node:fs";
import * as path from "node:path";

const REQUEST_ID_PATTERN = /^safety-gate-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVENT_NAMES = new Set([
  "push-received",
  "push-suppressed",
  "notification-shown",
  "notification-show-failed",
  "notification-clicked",
  "client-routing",
  "client-navigated",
  "client-focused",
  "window-opened",
  "routing-failed",
  "session-connected",
  "pending-dialog-shown",
  "pending-dialog-response",
]);
const PAGE_EVENTS = new Set([
  "session-connected",
  "pending-dialog-shown",
  "pending-dialog-response",
]);
const RESULTS = new Set([
  "foreground-client",
  "existing-client",
  "new-window",
  "approve",
  "deny",
  "cancel",
  "error",
]);
const OPERATIONS = new Set(["navigate", "focus", "open-window"]);
const VISIBILITY_STATES = new Set(["visible", "hidden", "prerender", "unloaded"]);
const ALLOWED_KEYS = new Set([
  "schemaVersion",
  "source",
  "event",
  "occurredAt",
  "requestId",
  "pid",
  "targetUrl",
  "clientCount",
  "result",
  "operation",
  "visibilityState",
  "webSocketConnected",
]);

export interface NotificationLifecycleEvent {
  schemaVersion: 1;
  source: "service-worker" | "page";
  event: string;
  occurredAt: string;
  requestId?: string;
  pid: number;
  targetUrl?: string;
  clientCount?: number;
  result?: string;
  operation?: string;
  visibilityState?: string;
  webSocketConnected?: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

export function parseNotificationLifecycleEvent(value: unknown): NotificationLifecycleEvent {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !ALLOWED_KEYS.has(key))) {
    throw new Error("Invalid notification event fields");
  }
  const source = value.source;
  const event = value.event;
  const pid = value.pid;
  if (value.schemaVersion !== 1 ||
      (source !== "service-worker" && source !== "page") ||
      typeof event !== "string" || !EVENT_NAMES.has(event) ||
      !Number.isSafeInteger(pid) || (pid as number) <= 0 ||
      !isIsoTimestamp(value.occurredAt)) {
    throw new Error("Invalid notification event identity");
  }
  if (PAGE_EVENTS.has(event) !== (source === "page")) {
    throw new Error("Invalid notification event source");
  }
  if (event !== "session-connected") {
    if (typeof value.requestId !== "string" || !REQUEST_ID_PATTERN.test(value.requestId)) {
      throw new Error("Invalid notification request ID");
    }
  } else if (value.requestId !== undefined) {
    throw new Error("Session connection events cannot include a request ID");
  }
  if (value.targetUrl !== undefined && value.targetUrl !== `/i/${pid}/`) {
    throw new Error("Invalid notification target URL");
  }
  if (value.clientCount !== undefined &&
      (!Number.isSafeInteger(value.clientCount) || (value.clientCount as number) < 0 || (value.clientCount as number) > 100)) {
    throw new Error("Invalid notification client count");
  }
  if (value.result !== undefined && (typeof value.result !== "string" || !RESULTS.has(value.result))) {
    throw new Error("Invalid notification result");
  }
  if (value.operation !== undefined && (typeof value.operation !== "string" || !OPERATIONS.has(value.operation))) {
    throw new Error("Invalid notification operation");
  }
  if (value.visibilityState !== undefined &&
      (typeof value.visibilityState !== "string" || !VISIBILITY_STATES.has(value.visibilityState))) {
    throw new Error("Invalid notification visibility state");
  }
  if (value.webSocketConnected !== undefined && typeof value.webSocketConnected !== "boolean") {
    throw new Error("Invalid notification WebSocket state");
  }
  return value as unknown as NotificationLifecycleEvent;
}

export class NotificationEventLog {
  readonly filePath: string;

  constructor(stateDirectory: string) {
    this.filePath = path.join(path.resolve(stateDirectory), "notification-events.jsonl");
  }

  append(event: NotificationLifecycleEvent): void {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.appendFileSync(this.filePath, `${JSON.stringify({ receivedAt: new Date().toISOString(), ...event })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.chmodSync(this.filePath, 0o600);
  }
}
