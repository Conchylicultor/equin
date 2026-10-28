import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { z } from "zod";
import { DEP_LOG_TAIL_LINES, type DepState } from "../../core";
import { isLockHeld } from "./lock";
import type { InstallPaths } from "./store";

/** `ready.json`: written last, after the payload is complete. */
export const ReadyFileSchema = z.object({
  identity: z.string(),
  installedAt: z.string(),
  bytes: z.number().int().nonnegative(),
  inputs: z.record(z.string(), z.string()),
});
export type ReadyFile = z.infer<typeof ReadyFileSchema>;

/** `installing.json`: written while the install holds the lock. */
export const InstallingFileSchema = z.object({
  since: z.string(),
  pid: z.number().int(),
});

/** `failed.json`: written when an install throws. */
export const FailedFileSchema = z.object({
  message: z.string(),
  at: z.string(),
});

export function readJson<T>(path: string, schema: z.ZodType<T>): T {
  return schema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * One line as a terminal shows it: a progress meter (curl, uv) rewrites its
 * line with `\r`, so only the text after the last one is what is on screen.
 */
export function screenLine(line: string): string {
  return (
    line
      .split("\r")
      .filter((part) => part !== "")
      .at(-1) ?? ""
  );
}

/** The last `lines` lines of a (possibly large) log, reading only its end. */
export function logTail(path: string, lines = DEP_LOG_TAIL_LINES): string[] {
  if (!existsSync(path)) return [];
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, 16 * 1024);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    const all = buf.toString("utf8").split("\n").map(screenLine);
    // A cut at the front may split a line; drop that partial one.
    if (length < size) all.shift();
    return all.filter((l) => l.trim() !== "").slice(-lines);
  } finally {
    closeSync(fd);
  }
}

/**
 * The state of one `(id, identity)` on disk. Cheap: a few `existsSync`s, small
 * JSON reads and one lock probe — safe on a backend's event loop.
 *
 * Precedence, by what each file proves:
 * 1. `ready.json` (and the payload intact, by the kind's test) — installed.
 * 2. the lock held — an install is running (`installing.json` says since when).
 * 3. `failed.json` — the last install threw.
 * 4. otherwise absent, including an `installing.json` whose writer died
 *    without releasing — the kernel released the lock, so nothing is running.
 */
export function readInstallState(
  paths: InstallPaths,
  isIntact: (dir: string) => boolean,
): DepState {
  if (existsSync(paths.ready) && isIntact(paths.env)) {
    const ready = readJson(paths.ready, ReadyFileSchema);
    const lastUsed = existsSync(paths.lastUsed)
      ? readFileSync(paths.lastUsed, "utf8").trim()
      : null;
    return {
      kind: "ready",
      identity: ready.identity,
      bytes: ready.bytes,
      lastUsed: lastUsed === "" ? null : lastUsed,
    };
  }
  if (isLockHeld(paths.lock)) {
    // The installer writes installing.json right after taking the lock; in
    // the instant between, the lock alone says an install is running.
    const since = existsSync(paths.installing)
      ? readJson(paths.installing, InstallingFileSchema).since
      : new Date().toISOString();
    return { kind: "installing", since, logTail: logTail(paths.log) };
  }
  if (existsSync(paths.failed)) {
    const failed = readJson(paths.failed, FailedFileSchema);
    return { kind: "failed", message: failed.message, at: failed.at };
  }
  return { kind: "absent" };
}
