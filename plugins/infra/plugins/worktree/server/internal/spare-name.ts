import { randomBytes } from "node:crypto";
import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";

// A spare checkout's directory (and so its `.git/worktrees/<name>` admin dir,
// which `git worktree move` keeps) is `spare-<ms>-<rand>`. It deliberately FAILS
// `isCanonicalWorktreeName`: the reaper, the namespace passes and the registry filters
// all ignore non-canonical names, so a spare is never mistaken for an attempt.
// Unique per spare, so an admin dir name can never collide.
const SPARE_PREFIX = "spare-";

/**
 * The `git worktree lock --reason` that marks a spare READY. Set as the last
 * step of creating one, so a half-written spare (a refill killed mid-add) is
 * never claimable; removed by the claim's `unlock`, which is also how two
 * claimers of one spare are told apart.
 */
export const SPARE_LOCK_REASON = LEGACY_IDS.spareLockReason;

export function newSpareName(now = Date.now()): string {
  return `${SPARE_PREFIX}${now}-${randomBytes(3).toString("hex")}`;
}

export function isSpareName(name: string): boolean {
  return name.startsWith(SPARE_PREFIX);
}
