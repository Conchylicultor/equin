import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ExcludeFromFork } from "@plugins/database/plugins/admin/server";
import { _notifications } from "@plugins/shell/plugins/notifications/server";
import { createNotification } from "../shared/endpoints";
import { handleCreate } from "./internal/handle-create";

export default {
  description:
    "Persisting a browser toast to the bell (POST /api/notifications), declared needsMachine: inside a scope without the computer (the demo) a toast stays ephemeral. And the notifications table's exclusion from a worktree's DB fork.",
  contributions: [
    // The sharpest case in the whole exclusion set. A notification has NO
    // worktree column, the resource is boot-critical and read unscoped, and
    // `ttlCleanupJob` declares no `perWorktree` so it runs on main only. A
    // forked worktree therefore shows main's undismissed notifications — build
    // failures, fork-failed notices, crash reports pointing at main's tasks — in
    // its own bell from first boot, and nothing in that fork ever sweeps them.
    ExcludeFromFork({
      table: _notifications,
      reason:
        "No worktree column, read unscoped, and the TTL sweep is main-only — inherited rows show main's bell in a fresh worktree forever.",
    }),
  ],
  httpRoutes: {
    [createNotification.route]: handleCreate,
  },
} satisfies MachinePluginDefinition;
