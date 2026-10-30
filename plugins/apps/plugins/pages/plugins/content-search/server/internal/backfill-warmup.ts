import { defineWarmup } from "@plugins/infra/plugins/warmup/server";
import { backfillPagesSearchJob } from "./backfill-job";

// Seed pages that predate this plugin (and re-sync any doc that drifted while the
// backfill was last skipped). A declared warm-up, not an eager `onReady` enqueue:
// it is deferred past serving-ready, throttled, and scope-gated by the warmup
// executor. `worktree` scope — pages live in each worktree's own DB, so every
// backend must seed its own corpus (this is not host-global work). The warm-up
// body only enqueues; the (now incremental) scan runs in the job.
export const pagesSearchBackfillWarmup = defineWarmup({
  name: "pages.search.backfill",
  description:
    "Starts a catch-up pass at boot so every existing page is searchable.",
  scope: "worktree",
  run: async () => {
    await backfillPagesSearchJob.enqueue({});
  },
});
