import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ExcludeFromFork } from "@plugins/database/plugins/admin/server";
import { siteMirrorSyncEndpoint } from "../core";
import { siteMirrorPullAllJob, siteMirrorPullJob } from "./internal/jobs";
import { siteMirrorStatusServed } from "./internal/served";
import { handleSiteMirrorSync } from "./internal/sync";
import { siteMirrorReplicas } from "./internal/tables";
import { startDoorbell, stopDoorbell } from "./internal/doorbell";

export {
  SiteMirrorSink,
  type SiteMirrorPace,
  type SiteMirrorSinkSpec,
  type SiteMirrorSite,
} from "./internal/sink";
export { onSiteMirrorApplied, readSiteMirror } from "./internal/read";

export default {
  description:
    "Keeps one table-mirror replica per (deployment, mirror set) of each deployed site's box, pulled over SSH through host-query (each page one host-only GET, a key list cut to what one question carries): the site-mirror.pull job (one bounded chunk per run, re-enqueued while behind, one pending per replica), its hourly main-only site-mirror.pull-all (drops deleted deployments' replicas and orphan schemas, then pulls every replica), POST /api/site-mirror/sync (on a tab open and on Sync now; creates the set's replica on first ask), the SiteMirrorSink contribution (a set read as a change stream through its owner's sink — only the content-free key index kept — kept for every deployment and pulled at its own pace, one bounded page per hourly run, never on demand), the site-mirror.status live value (phase, progress, last sync, last outcome), and readSiteMirror / onSiteMirrorApplied — a consumer's own SQL on a deployment's copy, and its change signal. Answers the box link's doorbell: a box's table-mirror signal pulls the set it names, spaced at least 5 s after the replica's last attempt (a sink set by its pace's minIntervalMs), and a box's hello pulls every replica of that deployment.",
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
  // The box link's doorbell: a box's mirror signal pulls its set (spaced),
  // a box's hello pulls every replica of it. The hourly pull-all stays the
  // safety net.
  onReady: startDoorbell,
  onShutdown: stopDoorbell,
} satisfies ServerPluginDefinition;
