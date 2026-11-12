import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ExcludeFromFork } from "@plugins/database/plugins/admin/server";
import { siteMirrorSyncEndpoint } from "../core";
import { siteMirrorPullAllJob, siteMirrorPullJob } from "./internal/jobs";
import { siteMirrorStatusServed } from "./internal/served";
import { handleSiteMirrorSync } from "./internal/sync";
import { siteMirrorReplicas } from "./internal/tables";

export default {
  description:
    "Keeps one table-mirror replica per (deployment, mirror set) of each deployed site's box, pulled over SSH through host-query (each page one host-only GET, a key list cut to what one question carries): the site-mirror.pull job (one bounded chunk per run, re-enqueued while behind, one pending per replica), its hourly main-only site-mirror.pull-all (drops deleted deployments' replicas and orphan schemas, then pulls every replica), POST /api/site-mirror/sync (on a tab open and on Sync now; creates the set's replica on first ask), and the site-mirror.status live value (phase, progress, last sync, last outcome).",
  contributions: [
    ...siteMirrorStatusServed.declare,
    // Left out of a fork with the replicas it names (table-mirror/replica
    // excludes them): a worktree pulls its own copy on open.
    ExcludeFromFork({
      table: siteMirrorReplicas,
      reason:
        "Owner rows of the replicas, which forks leave out (table-mirror/replica): a worktree asks for its own on open.",
    }),
  ],
  httpRoutes: {
    [siteMirrorSyncEndpoint.route]: handleSiteMirrorSync,
  },
  register: [siteMirrorPullJob, siteMirrorPullAllJob],
} satisfies ServerPluginDefinition;
