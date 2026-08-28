import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface StoredPushSubscription {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

interface VapidState extends VapidKeys {
  schemaVersion: 1;
}

interface SubscriptionState {
  schemaVersion: 1;
  subscriptions: StoredPushSubscription[];
}

interface DeliveryState {
  schemaVersion: 1;
  requests: Record<string, string[]>;
}

interface HubPushStateOptions {
  generateVapidKeys: () => VapidKeys;
}

const REQUEST_ID_PATTERN = /^safety-gate-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_DELIVERY_REQUESTS = 512;
const MAX_SUBSCRIPTIONS = 128;

function cloneSubscription(value: StoredPushSubscription): StoredPushSubscription {
  return {
    endpoint: value.endpoint,
    expirationTime: value.expirationTime,
    keys: { ...value.keys },
  };
}

function hasExactKeys(value: object, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isBoundedBase64Url(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength && BASE64URL_PATTERN.test(value);
}

function isVapidState(value: unknown): value is VapidState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<VapidState>;
  return hasExactKeys(state, ["privateKey", "publicKey", "schemaVersion"]) &&
    state.schemaVersion === 1 &&
    isBoundedBase64Url(state.publicKey, 128) &&
    isBoundedBase64Url(state.privateKey, 128);
}

export function isStoredPushSubscription(value: unknown): value is StoredPushSubscription {
  if (!value || typeof value !== "object") return false;
  const subscription = value as Partial<StoredPushSubscription>;
  if (!hasExactKeys(subscription, ["endpoint", "expirationTime", "keys"])) return false;
  if (typeof subscription.endpoint !== "string" || subscription.endpoint.length > 2_048) return false;
  try {
    if (new URL(subscription.endpoint).protocol !== "https:") return false;
  } catch {
    return false;
  }
  if (subscription.expirationTime !== null &&
      (!Number.isSafeInteger(subscription.expirationTime) || (subscription.expirationTime ?? 0) <= 0)) return false;
  if (!subscription.keys || typeof subscription.keys !== "object" ||
      !hasExactKeys(subscription.keys, ["auth", "p256dh"])) return false;
  return isBoundedBase64Url(subscription.keys.p256dh, 256) &&
    isBoundedBase64Url(subscription.keys.auth, 128);
}

function isSubscriptionState(value: unknown): value is SubscriptionState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<SubscriptionState>;
  return hasExactKeys(state, ["schemaVersion", "subscriptions"]) &&
    state.schemaVersion === 1 &&
    Array.isArray(state.subscriptions) &&
    state.subscriptions.length <= MAX_SUBSCRIPTIONS &&
    state.subscriptions.every(isStoredPushSubscription) &&
    new Set(state.subscriptions.map((subscription) => subscription.endpoint)).size === state.subscriptions.length;
}

function isDeliveryState(value: unknown): value is DeliveryState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<DeliveryState>;
  if (!hasExactKeys(state, ["requests", "schemaVersion"]) || state.schemaVersion !== 1 ||
      !state.requests || typeof state.requests !== "object" || Array.isArray(state.requests)) return false;
  const entries = Object.entries(state.requests);
  return entries.length <= MAX_DELIVERY_REQUESTS && entries.every(([requestId, endpointHashes]) =>
    REQUEST_ID_PATTERN.test(requestId) &&
    Array.isArray(endpointHashes) &&
    endpointHashes.length <= 128 &&
    endpointHashes.every((hash) => typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)) &&
    new Set(endpointHashes).size === endpointHashes.length,
  );
}

function endpointHash(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}

export class HubPushState {
  readonly directory: string;
  private readonly vapidPath: string;
  private readonly subscriptionsPath: string;
  private readonly deliveriesPath: string;
  private vapid: VapidState;
  private subscriptions: SubscriptionState;
  private deliveries: DeliveryState;

  constructor(directory: string, options: HubPushStateOptions) {
    this.directory = path.resolve(directory);
    this.vapidPath = path.join(this.directory, "vapid.json");
    this.subscriptionsPath = path.join(this.directory, "subscriptions.json");
    this.deliveriesPath = path.join(this.directory, "deliveries.json");
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.directory, 0o700);

    this.vapid = this.loadOrCreateVapid(options.generateVapidKeys);
    this.subscriptions = this.loadOrCreate(
      this.subscriptionsPath,
      { schemaVersion: 1, subscriptions: [] },
      isSubscriptionState,
    );
    this.deliveries = this.loadOrCreate(
      this.deliveriesPath,
      { schemaVersion: 1, requests: {} },
      isDeliveryState,
    );
  }

  private atomicWrite(filePath: string, value: unknown): void {
    const temporary = path.join(
      this.directory,
      `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
    );
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, filePath);
      fs.chmodSync(filePath, 0o600);
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try {
        fs.unlinkSync(temporary);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
          // Preserve the original state-write error.
        }
      }
      throw error;
    }
  }

  private loadOrCreate<T>(filePath: string, initial: T, validate: (value: unknown) => value is T): T {
    try {
      const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
      if (!validate(value)) throw new Error(`Invalid Tau Hub push state: ${path.basename(filePath)}`);
      fs.chmodSync(filePath, 0o600);
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.atomicWrite(filePath, initial);
      return initial;
    }
  }

  private loadOrCreateVapid(generateVapidKeys: () => VapidKeys): VapidState {
    try {
      const value = JSON.parse(fs.readFileSync(this.vapidPath, "utf8")) as unknown;
      if (!isVapidState(value)) throw new Error("Invalid Tau Hub push state: vapid.json");
      fs.chmodSync(this.vapidPath, 0o600);
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const generated = generateVapidKeys();
      const state: VapidState = { schemaVersion: 1, ...generated };
      if (!isVapidState(state)) throw new Error("VAPID key generator returned invalid keys");
      this.atomicWrite(this.vapidPath, state);
      return state;
    }
  }

  getPublicVapidKey(): string {
    return this.vapid.publicKey;
  }

  getVapidKeys(): VapidKeys {
    return { publicKey: this.vapid.publicKey, privateKey: this.vapid.privateKey };
  }

  listSubscriptions(): StoredPushSubscription[] {
    return this.subscriptions.subscriptions.map(cloneSubscription);
  }

  upsertSubscription(value: unknown): { created: boolean } {
    if (!isStoredPushSubscription(value)) throw new Error("Invalid push subscription");
    const subscription = cloneSubscription(value);
    const index = this.subscriptions.subscriptions.findIndex((candidate) => candidate.endpoint === subscription.endpoint);
    const created = index < 0;
    if (created && this.subscriptions.subscriptions.length >= MAX_SUBSCRIPTIONS) {
      throw new Error("Push subscription limit reached");
    }
    if (created) this.subscriptions.subscriptions.push(subscription);
    else this.subscriptions.subscriptions[index] = subscription;
    this.subscriptions.subscriptions.sort((left, right) => left.endpoint.localeCompare(right.endpoint));
    this.atomicWrite(this.subscriptionsPath, this.subscriptions);
    return { created };
  }

  removeSubscription(endpoint: string): boolean {
    const next = this.subscriptions.subscriptions.filter((subscription) => subscription.endpoint !== endpoint);
    if (next.length === this.subscriptions.subscriptions.length) return false;
    this.subscriptions.subscriptions = next;
    this.atomicWrite(this.subscriptionsPath, this.subscriptions);
    return true;
  }

  wasDelivered(requestId: string, endpoint: string): boolean {
    return this.deliveries.requests[requestId]?.includes(endpointHash(endpoint)) ?? false;
  }

  recordDelivered(requestId: string, endpoint: string): void {
    if (!REQUEST_ID_PATTERN.test(requestId)) throw new Error("Invalid safety request ID");
    const hash = endpointHash(endpoint);
    const hashes = this.deliveries.requests[requestId] ?? [];
    if (hashes.includes(hash)) return;
    this.deliveries.requests[requestId] = [...hashes, hash].sort();
    const requestIds = Object.keys(this.deliveries.requests);
    while (requestIds.length > MAX_DELIVERY_REQUESTS) {
      const oldest = requestIds.shift();
      if (oldest) delete this.deliveries.requests[oldest];
    }
    this.atomicWrite(this.deliveriesPath, this.deliveries);
  }

  retainDeliveries(activeRequestIds: Set<string>): void {
    let changed = false;
    for (const requestId of Object.keys(this.deliveries.requests)) {
      if (activeRequestIds.has(requestId)) continue;
      delete this.deliveries.requests[requestId];
      changed = true;
    }
    if (changed) this.atomicWrite(this.deliveriesPath, this.deliveries);
  }
}
