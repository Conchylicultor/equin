import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { readdir, stat } from "@plugins/packages/plugins/timed-fs/core";
import { bootUnsettledDir } from "../../data-dirs";

// The unsettled-boot marks (see `data-dirs/index.ts`): an index of the
// worktrees whose boot channel can hold an open boot, so the boot watchdog
// reads those and not every worktree's. A mark is added by the backend that
// boots (server-core's `bin/index.ts`, beside its `start` line) and by the watchdog
// for any open boot it reads; it is cleared only by the watchdog, after
// reading the channel as settled (`clearBootUnsettled`).

const INDEXED = ".indexed";

/**
 * Mark `worktree` as holding a boot not yet seen to settle. Synchronous, and
 * written by the serving entry point beside the boot's `start` line, before
 * any plugin import (server-core `bin/index.ts`): a boot killed while
 * importing still leaves its mark. SERVE ONLY, by construction — an `exec`
 * child never reaches ready, and never runs that entry point.
 */
export function markBootUnsettled(worktree: string): void {
  mkdirSync(bootUnsettledDir.path, { recursive: true });
  writeFileSync(bootUnsettledDir.file(worktree), "");
}

/**
 * The marked worktrees, and whether the marks are complete — `indexed: false`
 * until the watchdog's first full sweep stamped them (or after the directory
 * was deleted): boots from before the marks existed carry none.
 */
export async function readBootUnsettled(): Promise<{
  worktrees: string[];
  indexed: boolean;
}> {
  let names: string[];
  try {
    names = await readdir(bootUnsettledDir.path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { worktrees: [], indexed: false };
    throw err;
  }
  return {
    worktrees: names.filter((n) => !n.startsWith(".")),
    indexed: names.includes(INDEXED),
  };
}

/** The marks are complete: every worktree was swept once. */
export function stampBootUnsettledIndexed(): void {
  mkdirSync(bootUnsettledDir.path, { recursive: true });
  writeFileSync(bootUnsettledDir.file(INDEXED), "");
}

/**
 * `worktree`'s latest boot settled (became ready, or exited) at `settledAtMs` —
 * clear its mark, unless the mark is newer than that (it belongs to a boot
 * started since, whose `start` line a read may not have shown yet: the mark
 * and the line are written by two registrations in no fixed order).
 */
export async function clearBootUnsettled(
  worktree: string,
  settledAtMs: number,
): Promise<void> {
  const path = bootUnsettledDir.file(worktree);
  let mtimeMs: number;
  try {
    ({ mtimeMs } = await stat(path));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (mtimeMs >= settledAtMs) return;
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
