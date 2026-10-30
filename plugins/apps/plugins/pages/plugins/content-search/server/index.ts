import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { blocksChanged, BlockLifecycle } from "@plugins/page/plugins/editor/server";
import { reindexPageSearchJob } from "./internal/reindex-job";
import { backfillPagesSearchJob } from "./internal/backfill-job";
import { pagesSearchBackfillWarmup } from "./internal/backfill-warmup";
import {
  deletePagesSearchHook,
  trashPagesSearchHook,
  restorePagesSearchHook,
} from "./internal/delete-hook";

export { backfillPagesSearchJob } from "./internal/backfill-job";

export default {
  portable: true,
  description:
    "Pages full-text search consumer: indexes pages into the search engine, reindexing on blocksChanged, with the backfill job that seeds existing pages (enqueued at boot by a warm-up, so pages that predate the index — or drifted — become searchable).",
  // The warm-up enqueues the seed scan off the serving-critical boot path (see
  // backfill-warmup.ts); the jobs back it and the steady-state reindex trigger.
  register: [
    reindexPageSearchJob,
    backfillPagesSearchJob,
    pagesSearchBackfillWarmup,
  ],
  contributions: [
    // Reindex a page's search doc whenever its blocks change. Declared (not
    // imperatively bound) so the events plugin makes it idempotent across
    // reboots. Match-any on pageId — the per-emit pageId reaches the job via
    // the event payload.
    Trigger({ on: blocksChanged, do: reindexPageSearchJob, with: {}, oneShot: false }),
    // A page HARD delete / purge FK-cascades its blocks without firing the
    // reindexer for the page itself; drop its stale search doc.
    BlockLifecycle.OnDelete(deletePagesSearchHook),
    // A page TRASH deindexes it (soft delete emits no per-page blocksChanged on
    // the single-delete path); restore re-derives its doc.
    BlockLifecycle.OnTrash(trashPagesSearchHook),
    BlockLifecycle.OnRestore(restorePagesSearchHook),
  ],
} satisfies ServerPluginDefinition;
