import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import webpush from "web-push";

import { PendingRequestMarkerStore } from "../extensions/pending-request-markers.ts";
import { TauInstanceRegistry } from "../extensions/registry.ts";
import { createTauHubServer } from "./hub.ts";
import { PushDeliveryCoordinator } from "./push-delivery.ts";
import { HubPushState } from "./push-state.ts";
import { createWebPushSender } from "./web-push-sender.ts";

function readPort(value: string | undefined): number {
  const port = Number(value ?? "3000");
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid TAU_HUB_PORT: ${value}`);
  }
  return port;
}

const host = process.env.TAU_HUB_HOST || "127.0.0.1";
if (!new Set(["127.0.0.1", "::1", "localhost"]).has(host)) {
  throw new Error(`TAU_HUB_HOST must be loopback, received: ${host}`);
}

const port = readPort(process.env.TAU_HUB_PORT);
const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
const stateDirectory = path.resolve(process.env.TAU_HUB_STATE_DIR || path.join(home, ".pi", "tau-hub"));
const rootAssetsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../public",
);
const registry = new TauInstanceRegistry();
const markerStore = new PendingRequestMarkerStore();
const pushState = new HubPushState(stateDirectory, {
  generateVapidKeys: () => webpush.generateVAPIDKeys(),
});
const pushDelivery = new PushDeliveryCoordinator({
  registry,
  markerStore,
  pushState,
  sender: createWebPushSender(),
});
const server = createTauHubServer({
  registry,
  pushState,
  rootAssetsDirectory,
});

server.on("error", (error) => {
  console.error("Tau Hub server error", error);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  pushDelivery.start();
  const displayHost = host === "::1" ? "[::1]" : host;
  console.log(`Tau Hub listening at http://${displayHost}:${port}`);
});

let stopping = false;
function stop(signal: string): void {
  if (stopping) return;
  stopping = true;
  pushDelivery.stop();
  server.close((error) => {
    if (error) {
      console.error(`Tau Hub failed to stop after ${signal}`, error);
      process.exitCode = 1;
    }
  });
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
