import { realpath } from "@plugins/packages/plugins/timed-fs/core";
import { defineWarmup } from "@plugins/infra/plugins/warmup/server";
import { closureChangedSince } from "@plugins/packages/plugins/source-digest/server";

/**
 * Walks this backend's entry closure once after boot, so the first deploy's
 * adoption question (`handle-adopt.ts`) re-reads only the files changed since:
 * the walk remembers each file's imports under its inode stamp
 * (source-digest's `closureChangedSince`). The answer itself is not kept — a
 * deploy always asks afresh; only the per-file facts are reused.
 */
export const adoptionClosureWarmup = defineWarmup({
  name: "restart-skip.closure",
  description:
    "Reads the backend's code once after it starts, so a later build can tell quickly whether it may keep this backend running.",
  scope: "worktree",
  run: async () => {
    // Same entry and instant as the judgement (`shared/process-view.ts`).
    await closureChangedSince(
      [await realpath(Bun.main)],
      performance.timeOrigin,
    );
  },
});
