import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import { rawEndpointHandler } from "@plugins/infra/plugins/endpoints/server";
import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { handleList } from "./internal/handle-list";
import { handleDelete } from "./internal/handle-delete";
import { handleBulkDelete } from "./internal/handle-bulk-delete";
import { worktreeReapJob } from "./internal/reap-job";
import { worktreeReapFailedKind } from "./internal/reap-failed-kind";
import {
  listWorktrees,
  bulkDeleteWorktrees,
  deleteWorktree,
} from "../shared/endpoints";

export default {
  description:
    "Audit and remove stale git worktrees and their Postgres DB forks.",
  httpRoutes: {
    [listWorktrees.route]: handleList,
    [bulkDeleteWorktrees.route]: rawEndpointHandler(
      bulkDeleteWorktrees,
      handleBulkDelete,
    ),
    [deleteWorktree.route]: rawEndpointHandler(deleteWorktree, handleDelete),
  },
  register: [worktreeReapJob],
  contributions: [worktreeReapFailedKind],
  // Drain the stale-registry backlog promptly after boot rather than waiting up
  // to an hour for the next scheduled tick. The reap job is main-only (DBs +
  // the registry are global cluster resources). A sweep that survived the
  // restart is still running detached, so this enqueue's claim loses and it
  // returns; steady-state runs find nothing to do.
  onReady: () => {
    if (!isMain()) return;
    void worktreeReapJob.enqueue({});
  },
} satisfies ServerPluginDefinition;
