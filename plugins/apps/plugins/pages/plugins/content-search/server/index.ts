import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { eventField, Trigger } from "@plugins/infra/plugins/events/server";
import { blocksChanged, BlockLifecycle } from "@plugins/page/plugins/editor/server";
import { reindexPageSearchJob } from "./internal/reindex-job";
import { pagesSearchBackfillWarmup } from "./internal/backfill";
import {
  deletePagesSearchHook,
  trashPagesSearchHook,
  restorePagesSearchHook,
} from "./internal/delete-hook";

export default {
  description:
    "Pages full-text search consumer: indexes pages into the search engine, reindexing on blocksChanged, with the boot backfill that re-derives every page's doc once per change of the derivation code (a warm-up declaring derivedFrom: pages that predate the index, or docs an older derivation wrote, become current).",
  // The steady-state reindex job, and the backfill warm-up (deferred past
  // serving-ready; runs only when the doc derivation's code changed — see
  // internal/backfill.ts).
  register: [reindexPageSearchJob, pagesSearchBackfillWarmup],
  contributions: [
    // Reindex a page's search doc whenever its blocks change. Declared (not
    // imperatively bound) so the events plugin makes it idempotent across
    // reboots. Match-any on pageId — the per-emit pageId reaches the job via
    // the event payload.
    Trigger({
      on: blocksChanged,
      do: reindexPageSearchJob,
      with: { pageId: eventField("pageId") },
      oneShot: false,
    }),
    // A page HARD delete / purge FK-cascades its blocks without firing the
    // reindexer for the page itself; drop its stale search doc.
    BlockLifecycle.OnDelete(deletePagesSearchHook),
    // A page TRASH deindexes it (soft delete emits no per-page blocksChanged on
    // the single-delete path); restore re-derives its doc.
    BlockLifecycle.OnTrash(trashPagesSearchHook),
    BlockLifecycle.OnRestore(restorePagesSearchHook),
  ],
} satisfies ServerPluginDefinition;
