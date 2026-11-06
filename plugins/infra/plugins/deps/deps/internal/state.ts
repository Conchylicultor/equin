import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { open } from "node:fs/promises";
import { exists, readFile } from "@plugins/packages/plugins/timed-fs/core";
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

export async function readJson<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T> {
  return schema.parse(JSON.parse(await readFile(path, "utf8")));
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
export async function logTail(
  path: string,
  lines = DEP_LOG_TAIL_LINES,
): Promise<string[]> {
  if (!(await exists(path))) return [];
  const handle = await open(path, "r");
  try {
    const size = (await handle.stat()).size;
    const length = Math.min(size, 16 * 1024);
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, size - length);
    const all = buf.toString("utf8").split("\n").map(screenLine);
    // A cut at the front may split a line; drop that partial one.
    if (length < size) all.shift();
    return all.filter((l) => l.trim() !== "").slice(-lines);
  } finally {
    await handle.close();
  }
}

/**
 * The state of one `(id, identity)` on disk. Cheap: a few `exists` probes, small
 * JSON reads and one lock probe — safe on a backend's event loop.
 *
 * Precedence, by what each file proves:
 * 1. `ready.json` (and the payload intact, by the kind's test) — installed.
 * 2. the lock held — an install is running (`installing.json` says since when).
 * 3. `failed.json` — the last install threw.
 * 4. otherwise absent, including an `installing.json` whose writer died
 *    without releasing — the kernel released the lock, so nothing is running.
 */
export async function readInstallState(
  paths: InstallPaths,
  isIntact: (dir: AppPath) => boolean | Promise<boolean>,
): Promise<DepState> {
  if ((await exists(paths.ready)) && (await isIntact(paths.env))) {
    const ready = await readJson(paths.ready, ReadyFileSchema);
    const lastUsed = (await exists(paths.lastUsed))
      ? (await readFile(paths.lastUsed, "utf8")).trim()
      : null;
    return {
      kind: "ready",
      identity: ready.identity,
      bytes: ready.bytes,
      lastUsed: lastUsed === "" ? null : lastUsed,
    };
  }
  if (await isLockHeld(paths.lock)) {
    // The installer writes installing.json right after taking the lock; in
    // the instant between, the lock alone says an install is running.
    const since = (await exists(paths.installing))
      ? (await readJson(paths.installing, InstallingFileSchema)).since
      : new Date().toISOString();
    return { kind: "installing", since, logTail: await logTail(paths.log) };
  }
  if (await exists(paths.failed)) {
    const failed = await readJson(paths.failed, FailedFileSchema);
    return { kind: "failed", message: failed.message, at: failed.at };
  }
  return { kind: "absent" };
}
