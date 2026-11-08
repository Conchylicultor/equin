import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { eventField, Trigger } from "@plugins/infra/plugins/events/server";
import { blocksChanged, BlockLifecycle } from "@plugins/page/plugins/editor/server";
import { pageHistorySource } from "./internal/page-source";
import { pageSnapshotJob } from "./internal/snapshot-job";
import { deletePageHistoryHook } from "./internal/delete-hook";

export default {
  description:
    "Pages version-history consumer: registers the page history source (serialize/restore via the editor's page-content API), captures time-bucketed snapshots through a snapshot job bound to blocksChanged and settled per page (4 s after the last edit, at least every minute), and drops a page's history on delete.",
  register: [pageHistorySource, pageSnapshotJob],
  contributions: [
    // The snapshot job is keyed on the page and settled, so a whole edit burst
    // collapses to one snapshot. Declared (not imperatively bound) so the events
    // plugin makes it idempotent across reboots.
    Trigger({
      on: blocksChanged,
      do: pageSnapshotJob,
      with: { pageId: eventField("pageId") },
      oneShot: false,
    }),
    // A page delete FK-cascades its blocks; drop the page's version history too.
    BlockLifecycle.OnDelete(deletePageHistoryHook),
  ],
} satisfies ServerPluginDefinition;
