import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { SlowOpSchema } from "./schema";

/**
 * The Slow Ops pane's read: every `slow_ops` aggregate of this worktree,
 * ranked by total time (descending). A snapshot, re-read when a reader mounts
 * and on the pane's Refresh (`refresh()`): `slow_ops` is ExcludeFromChangeFeed
 * (a live-ticked high-churn counter amplifies the slowness it records), so no
 * change ever reaches a reader. UNBOUNDED: a full-table read (about 19 MB /
 * 5k rows measured — see `database/sql-column`'s CLAUDE.md), held back only by
 * the 30-day retention sweep (`slowOpsRetention`, one row per distinct
 * (operationKind, operation, worktree)). Bounding it (a `limit`, or a
 * `liveCollection` window) is still open.
 */
export const slowOpsValue = liveValue("slow-ops.list", {
  schema: z.array(SlowOpSchema),
  load: "snapshot",
});
