import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { rawEndpointHandler } from "@plugins/infra/plugins/endpoints/server";
import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { worktreeScanServed } from "./internal/scan-served";
import { handleDelete } from "./internal/handle-delete";
import { handleBulkDelete } from "./internal/handle-bulk-delete";
import { enqueueReapIfOverdue, worktreeReapJob } from "./internal/reap-job";
import { worktreeReapFailedKind } from "./internal/reap-failed-kind";
import { bulkDeleteWorktrees, deleteWorktree } from "../shared/endpoints";

export default {
  description:
    "Audit and remove stale git worktrees and their Postgres DB forks.",
  httpRoutes: {
    [bulkDeleteWorktrees.route]: rawEndpointHandler(
      bulkDeleteWorktrees,
      handleBulkDelete,
    ),
    [deleteWorktree.route]: rawEndpointHandler(deleteWorktree, handleDelete),
  },
  register: [worktreeReapJob],
  contributions: [worktreeReapFailedKind, ...worktreeScanServed.declare],
  // Catch up after boot only when main was down across an hourly tick (the
  // cron does not backfill). The reap job is main-only (DBs + the registry are
  // global cluster resources).
  onReady: () => {
    if (!isMain()) return;
    void runTracked("worktree-cleanup:boot-catch-up", () =>
      enqueueReapIfOverdue(Date.now()),
    );
  },
} satisfies ServerPluginDefinition;
