import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  isSafetyGatePendingRequest,
  type SafetyGatePendingRequest,
} from "./safety-gate-protocol.ts";
import type { TauInstanceInfo } from "./registry.ts";

export interface PendingRequestMarker {
  schemaVersion: 1;
  requestKind: "safety-gate";
  pid: number;
  processStartTicks?: string;
  id: string;
  title: string;
  message: string;
  operation: string;
  createdAt: string;
}

export function defaultTauPendingDir(): string {
  if (process.env.TAU_PENDING_DIR) return path.resolve(process.env.TAU_PENDING_DIR);
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, ".pi", "tau-pending");
}

function hasExactKeys(value: object, required: string[], optional: string[] = []): boolean {
  const actual = Object.keys(value).sort();
  const requiredSet = new Set(required);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && actual.every((key) => allowed.has(key)) &&
    actual.length >= requiredSet.size;
}

function isPendingRequestMarker(value: unknown): value is PendingRequestMarker {
  if (!value || typeof value !== "object") return false;
  const marker = value as Partial<PendingRequestMarker>;
  const request = {
    type: "extension_ui_request",
    schemaVersion: marker.schemaVersion,
    requestKind: marker.requestKind,
    id: marker.id,
    method: "confirm",
    title: marker.title,
    message: marker.message,
    operation: marker.operation,
    createdAt: marker.createdAt,
  };
  return (
    hasExactKeys(marker, [
      "createdAt",
      "id",
      "message",
      "operation",
      "pid",
      "requestKind",
      "schemaVersion",
      "title",
    ], ["processStartTicks"]) &&
    Number.isSafeInteger(marker.pid) &&
    (marker.pid ?? 0) > 0 &&
    (marker.processStartTicks === undefined || /^\d+$/.test(marker.processStartTicks)) &&
    isSafetyGatePendingRequest(request)
  );
}

export class PendingRequestMarkerStore {
  readonly directory: string;

  constructor(directory = defaultTauPendingDir()) {
    this.directory = directory;
  }

  private markerPath(pid: number, id: string): string {
    return path.join(this.directory, `${pid}-${id}.json`);
  }

  private removeFile(filePath: string): void {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  publish(instance: TauInstanceInfo, request: SafetyGatePendingRequest): void {
    if (!isSafetyGatePendingRequest(request)) throw new Error("Invalid safety-gate pending request");
    const marker: PendingRequestMarker = {
      schemaVersion: 1,
      requestKind: "safety-gate",
      pid: instance.pid,
      ...(instance.processStartTicks === undefined ? {} : { processStartTicks: instance.processStartTicks }),
      id: request.id,
      title: request.title,
      message: request.message,
      operation: request.operation,
      createdAt: request.createdAt,
    };
    if (!isPendingRequestMarker(marker)) throw new Error("Invalid pending request marker");

    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.directory, 0o700);
    const target = this.markerPath(marker.pid, marker.id);
    const temporary = path.join(
      this.directory,
      `.${marker.pid}.${process.pid}.${Date.now()}.tmp`,
    );
    try {
      fs.writeFileSync(temporary, JSON.stringify(marker), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporary, target);
      fs.chmodSync(target, 0o600);
    } catch (error) {
      try {
        this.removeFile(temporary);
      } catch {
        // Preserve the original publish error.
      }
      throw error;
    }
  }

  remove(pid: number, id: string): void {
    this.removeFile(this.markerPath(pid, id));
  }

  list(): PendingRequestMarker[] {
    if (!fs.existsSync(this.directory)) return [];
    const markers: PendingRequestMarker[] = [];
    for (const file of fs.readdirSync(this.directory)) {
      if (!file.endsWith(".json")) continue;
      const filePath = path.join(this.directory, file);
      try {
        const marker = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
        if (!isPendingRequestMarker(marker) || file !== `${marker.pid}-${marker.id}.json`) {
          this.removeFile(filePath);
          continue;
        }
        markers.push(marker);
      } catch {
        try {
          this.removeFile(filePath);
        } catch {
          // Keep discovery available when one stale marker cannot be removed.
        }
      }
    }
    return markers.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }
}
