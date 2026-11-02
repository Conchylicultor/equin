import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { blocksChanged, BlockLifecycle } from "@plugins/page/plugins/editor/server";
import { pageHistorySource } from "./internal/page-source";
import { pageSnapshotJob } from "./internal/snapshot-job";
import { pageHistoryScheduleJob } from "./internal/schedule-job";
import { deletePageHistoryHook } from "./internal/delete-hook";

export default {
  description:
    "Pages version-history consumer: registers the page history source (serialize/restore via the editor's page-content API), captures time-bucketed snapshots through a debounced two-job pipeline bound to blocksChanged, and drops a page's history on delete.",
  register: [pageHistorySource, pageSnapshotJob, pageHistoryScheduleJob],
  contributions: [
    // Each edit burst fans out blocksChanged → the scheduler re-arms the keyed
    // snapshot job with a fresh runAt+4s (graphile replaces the pending row), so
    // the whole burst collapses to one snapshot. Declared (not imperatively
    // bound) so the events plugin makes it idempotent across reboots.
    Trigger({ on: blocksChanged, do: pageHistoryScheduleJob, with: {}, oneShot: false }),
    // A page delete FK-cascades its blocks; drop the page's version history too.
    BlockLifecycle.OnDelete(deletePageHistoryHook),
  ],
} satisfies ServerPluginDefinition;
