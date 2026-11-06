import { mkdirSync, writeFileSync } from "node:fs";
import { bootUnsettledDir } from "../../data-dirs";

/**
 * Mark `worktree` as holding a boot not yet seen to settle. Synchronous, and
 * written by the serving entry point beside the boot's `start` line, before
 * any plugin import (server-core `bin/serve.ts`): a boot killed while
 * importing still leaves its mark. SERVE ONLY, by construction — an `exec`
 * child never reaches ready, and never runs that entry point. It runs before
 * the backend listens, so no thread waits on it.
 */
export function markOwnBootUnsettled(worktree: string): void {
  mkdirSync(bootUnsettledDir.path, { recursive: true });
  writeFileSync(bootUnsettledDir.file(worktree), "");
}
