import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { readFileSync } from "@plugins/packages/plugins/timed-fs/core";
import { parsePidFile, type PidFileRead } from "./registry";

/**
 * `readPidFile`, synchronously — for the pid-file arms' `observe()` alone,
 * which the sync `instance.pid` / `instance.state` getters and `listDaemons`
 * call: it re-reads the file on every get. Debt (blocking-fs/no-sync-fs): the
 * pid file should be watched and its read pushed, so a get reads memory.
 */
export function readPidFileSync(path: AppPath): PidFileRead {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "absent" };
    }
    throw err;
  }
  return parsePidFile(raw);
}
