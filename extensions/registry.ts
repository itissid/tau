import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface TauInstanceInfo {
  port: number;
  pid: number;
  sessionFile: string;
  cwd: string;
  startedAt: string;
  host: string;
  /** Linux /proc start ticks distinguish the owning process from a reused PID. */
  processStartTicks?: string;
}

export function defaultTauInstancesDir(): string {
  if (process.env.TAU_INSTANCES_DIR) return path.resolve(process.env.TAU_INSTANCES_DIR);
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, ".pi", "tau-instances");
}

function isRecord(value: unknown): value is TauInstanceInfo {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<TauInstanceInfo>;
  return (
    Number.isInteger(record.port) &&
    (record.port ?? 0) > 0 &&
    Number.isInteger(record.pid) &&
    (record.pid ?? 0) > 0 &&
    typeof record.sessionFile === "string" &&
    typeof record.cwd === "string" &&
    typeof record.startedAt === "string" &&
    typeof record.host === "string" &&
    (record.processStartTicks === undefined || /^\d+$/.test(record.processStartTicks))
  );
}

function readProcessStartTicks(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return undefined;
    // Fields after the command begin at field 3; process start time is field 22.
    return stat.slice(commandEnd + 2).trim().split(/\s+/)[19];
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isSameProcess(info: TauInstanceInfo): boolean {
  if (!isProcessAlive(info.pid)) return false;
  if (process.platform !== "linux") return true;
  const currentStartTicks = readProcessStartTicks(info.pid);
  return currentStartTicks !== undefined && currentStartTicks === info.processStartTicks;
}

export class TauInstanceRegistry {
  readonly directory: string;

  constructor(directory = defaultTauInstancesDir()) {
    this.directory = directory;
  }

  private recordPath(pid: number): string {
    return path.join(this.directory, `${pid}.json`);
  }

  private removeFile(filePath: string): void {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  register(info: TauInstanceInfo): void {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const processStartTicks = readProcessStartTicks(info.pid);
    const storedInfo = processStartTicks === undefined ? info : { ...info, processStartTicks };
    const target = this.recordPath(info.pid);
    const temporary = path.join(
      this.directory,
      `.${info.pid}.${process.pid}.${Date.now()}.tmp`,
    );
    fs.writeFileSync(temporary, JSON.stringify(storedInfo), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, target);
  }

  updateSession(pid: number, sessionFile: string): void {
    const target = this.recordPath(pid);
    try {
      const value = JSON.parse(fs.readFileSync(target, "utf8")) as unknown;
      if (!isRecord(value)) {
        this.removeFile(target);
        return;
      }
      this.register({ ...value, sessionFile });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        try {
          this.removeFile(target);
        } catch {
          // A malformed record is stale; a later registry read can retry cleanup.
        }
      }
    }
  }

  unregister(pid: number): void {
    this.removeFile(this.recordPath(pid));
  }

  /** Return only canonical records whose original owning process is still alive. */
  listLive(): TauInstanceInfo[] {
    if (!fs.existsSync(this.directory)) return [];
    const instances: TauInstanceInfo[] = [];

    for (const file of fs.readdirSync(this.directory)) {
      if (!file.endsWith(".json")) continue;
      const filePath = path.join(this.directory, file);
      try {
        const fileMatch = /^([1-9]\d*)\.json$/.exec(file);
        const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
        const filePid = fileMatch ? Number(fileMatch[1]) : undefined;
        if (!isRecord(value) || value.pid !== filePid || !isSameProcess(value)) {
          this.removeFile(filePath);
          continue;
        }
        instances.push(value);
      } catch {
        try {
          this.removeFile(filePath);
        } catch {
          // Keep registry reads available even if one stale file cannot be removed.
        }
      }
    }

    return instances.sort((left, right) => left.port - right.port || left.pid - right.pid);
  }
}
