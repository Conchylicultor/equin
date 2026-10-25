import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { databaseForkJob } from "./internal/fork-job";
import { forkTempSweepJob } from "./internal/fork-temp-sweep";
import { handleGetForkExclusions } from "./internal/handle-exclusions";
import { getForkExclusions } from "../core/endpoints";
import {
  dbForkFailedKind,
  forkUndeclaredSchemaKind,
} from "./internal/report-kinds";

export { databaseForkJob } from "./internal/fork-job";

export default {
  description:
    "Durable, self-healing worktree DB fork: a graphile job that forks the base DB per worktree (idempotent, atomic), plus a scheduled sweep of orphaned temp forks.",
  httpRoutes: {
    [getForkExclusions.route]: handleGetForkExclusions,
  },
  contributions: [dbForkFailedKind, forkUndeclaredSchemaKind],
  register: [databaseForkJob, forkTempSweepJob],
} satisfies ServerPluginDefinition;
