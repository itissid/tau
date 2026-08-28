import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type TauLogLevel = "debug" | "info" | "warning" | "error";

export interface TauDiagnosticRecord {
  timestamp: string;
  level: TauLogLevel;
  event: string;
  pid: number;
  details?: unknown;
}

function normalizeDetails(details: unknown): unknown {
  if (details instanceof Error) {
    return {
      name: details.name,
      message: details.message,
      stack: details.stack,
    };
  }
  return details;
}

export function defaultTauLogFile(): string {
  if (process.env.TAU_LOG_FILE) return path.resolve(process.env.TAU_LOG_FILE);
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent");
  return path.join(agentDir, "logs", "tau-mirror.log");
}

/**
 * A deliberately terminal-blind diagnostic sink.
 *
 * Tau runs inside the same process as Pi's fullscreen renderer, so stdout and
 * stderr are not safe logging destinations. Failures in this sink are swallowed
 * rather than falling back to either terminal stream.
 */
export class TauDiagnostics {
  readonly filePath: string;

  constructor(filePath = defaultTauLogFile()) {
    this.filePath = filePath;
  }

  write(level: TauLogLevel, event: string, details?: unknown): void {
    const record: TauDiagnosticRecord = {
      timestamp: new Date().toISOString(),
      level,
      event,
      pid: process.pid,
      ...(details === undefined ? {} : { details: normalizeDetails(details) }),
    };

    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch {
      // Never fall back to stdout/stderr: those streams belong to Pi's TUI.
    }
  }
}
