import webpush from "web-push";

import type {
  PushSender,
  SafetyGatePushPayload,
} from "./push-delivery.ts";
import type {
  StoredPushSubscription,
  VapidKeys,
} from "./push-state.ts";

const VAPID_SUBJECT = "https://github.com/itissid/tau";

interface WebPushAdapter {
  sendNotification(
    subscription: StoredPushSubscription,
    payload: string,
    options: {
      TTL: number;
      urgency: "high";
      vapidDetails: VapidKeys & { subject: string };
    },
  ): Promise<{ statusCode: number }>;
}

function options(vapidKeys: VapidKeys) {
  return {
    TTL: 300,
    urgency: "high" as const,
    vapidDetails: {
      subject: VAPID_SUBJECT,
      publicKey: vapidKeys.publicKey,
      privateKey: vapidKeys.privateKey,
    },
  };
}

export function generatePushRequest(
  subscription: StoredPushSubscription,
  payload: SafetyGatePushPayload,
  vapidKeys: VapidKeys,
) {
  return webpush.generateRequestDetails(
    subscription,
    JSON.stringify(payload),
    options(vapidKeys),
  );
}

export function createWebPushSender(adapter: WebPushAdapter = webpush): PushSender {
  return {
    async send(subscription, payload, vapidKeys) {
      const response = await adapter.sendNotification(
        subscription,
        JSON.stringify(payload),
        options(vapidKeys),
      );
      return { statusCode: response.statusCode };
    },
  };
}
