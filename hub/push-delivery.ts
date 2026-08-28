import type {
  PendingRequestMarker,
  PendingRequestMarkerStore,
} from "../extensions/pending-request-markers.ts";
import type { TauInstanceInfo } from "../extensions/registry.ts";
import type { LiveTauRegistry } from "./hub.ts";
import type {
  HubPushState,
  StoredPushSubscription,
  VapidKeys,
} from "./push-state.ts";

export interface SafetyGatePushPayload {
  schemaVersion: 1;
  type: "safety-gate-pending";
  requestId: string;
  pid: number;
  title: string;
  body: string;
  url: string;
}

export interface PushSendResult {
  statusCode: number;
}

export interface PushSender {
  send(
    subscription: StoredPushSubscription,
    payload: SafetyGatePushPayload,
    vapidKeys: VapidKeys,
  ): Promise<PushSendResult>;
}

interface PushDeliveryCoordinatorOptions {
  registry: LiveTauRegistry;
  markerStore: PendingRequestMarkerStore;
  pushState: HubPushState;
  sender: PushSender;
  pollIntervalMs?: number;
  onError?: (error: unknown) => void;
}

function belongsToInstance(marker: PendingRequestMarker, instance: TauInstanceInfo): boolean {
  if (marker.pid !== instance.pid) return false;
  if (marker.processStartTicks !== undefined || instance.processStartTicks !== undefined) {
    if (marker.processStartTicks !== instance.processStartTicks) return false;
  }
  const markerTime = Date.parse(marker.createdAt);
  const instanceTime = Date.parse(instance.startedAt);
  return Number.isFinite(markerTime) && Number.isFinite(instanceTime) && markerTime >= instanceTime;
}

function sameMarker(left: PendingRequestMarker, right: PendingRequestMarker): boolean {
  return left.pid === right.pid && left.id === right.id &&
    left.processStartTicks === right.processStartTicks;
}

function payloadFor(marker: PendingRequestMarker): SafetyGatePushPayload {
  return {
    schemaVersion: 1,
    type: "safety-gate-pending",
    requestId: marker.id,
    pid: marker.pid,
    title: "Tau permission needed",
    body: marker.message,
    url: `/i/${marker.pid}/`,
  };
}

function responseStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
}

export class PushDeliveryCoordinator {
  private readonly options: PushDeliveryCoordinatorOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private activeScan: Promise<void> | undefined;

  constructor(options: PushDeliveryCoordinatorOptions) {
    this.options = options;
  }

  scan(): Promise<void> {
    if (this.activeScan) return this.activeScan;
    this.activeScan = this.scanOnce().finally(() => {
      this.activeScan = undefined;
    });
    return this.activeScan;
  }

  private async scanOnce(): Promise<void> {
    const instances = this.options.registry.listLive();
    const instanceByPid = new Map(instances.map((instance) => [instance.pid, instance]));
    const activeMarkers: PendingRequestMarker[] = [];

    for (const marker of this.options.markerStore.list()) {
      const instance = instanceByPid.get(marker.pid);
      if (!instance || !belongsToInstance(marker, instance)) {
        this.options.markerStore.remove(marker.pid, marker.id);
        continue;
      }
      activeMarkers.push(marker);
    }

    const vapidKeys = this.options.pushState.getVapidKeys();
    for (const marker of activeMarkers) {
      const payload = payloadFor(marker);
      for (const subscription of this.options.pushState.listSubscriptions()) {
        if (!this.options.markerStore.list().some((candidate) => sameMarker(candidate, marker))) break;
        if (this.options.pushState.wasDelivered(marker.id, subscription.endpoint)) continue;
        try {
          const result = await this.options.sender.send(subscription, payload, vapidKeys);
          if (result.statusCode === 404 || result.statusCode === 410) {
            this.options.pushState.removeSubscription(subscription.endpoint);
          } else if (result.statusCode >= 200 && result.statusCode < 300) {
            this.options.pushState.recordDelivered(marker.id, subscription.endpoint);
          }
        } catch (error) {
          const statusCode = responseStatus(error);
          if (statusCode === 404 || statusCode === 410) {
            this.options.pushState.removeSubscription(subscription.endpoint);
          } else {
            this.options.onError?.(error);
          }
        }
      }
    }

    const stillActiveRequestIds = new Set(
      this.options.markerStore.list()
        .filter((marker) => {
          const instance = instanceByPid.get(marker.pid);
          return instance !== undefined && belongsToInstance(marker, instance);
        })
        .map((marker) => marker.id),
    );
    this.options.pushState.retainDeliveries(stillActiveRequestIds);
  }

  start(): void {
    if (this.timer) return;
    void this.scan().catch((error) => this.options.onError?.(error));
    this.timer = setInterval(() => {
      void this.scan().catch((error) => this.options.onError?.(error));
    }, this.options.pollIntervalMs ?? 1_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
