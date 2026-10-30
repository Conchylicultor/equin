import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { defineWarmup } from "@plugins/infra/plugins/warmup/server";
import {
  liveBlocks,
  PAGE_BLOCK_TYPE,
} from "@plugins/page/plugins/editor/server";
import { reindexPage } from "./reindex";

// Boot backfill: reindex every live page's outgoing links. The `blocksChanged`
// trigger only reindexes pages as they are edited, so edges that predate the
// current index shape — the rows the `page_links_source_block` data migration
// dropped because they named no linking block — are rebuilt here, from the
// pages' blocks, rather than waiting for each page's next edit.
//
// Steady state writes nothing: `reindexPage` diffs against the rows already
// indexed, so a reboot over an unchanged corpus is reads only (no change-feed
// fan-out). Same shape as the pages search backfill (content-search).
//
// `instant` despite sweeping the corpus: every step is an indexed read or a
// small diff write — no network, no spawn, no model call. `dedup: "singleton"`
// collapses repeated enqueues to one outstanding run.
export const backfillPageLinksJob = defineJob({
  name: "page.links.backfill",
  description:
    "Rebuilds every page's outgoing links, so each page's backlinks list is complete.",
  hold: "instant",
  input: z.object({}).default({}),
  event: z.never(),
  dedup: "singleton",
  run: async () => {
    const pages = await db
      .select({ id: liveBlocks.id })
      .from(liveBlocks)
      .where(eq(liveBlocks.type, PAGE_BLOCK_TYPE));
    for (const page of pages) await reindexPage(page.id);
  },
});

// A declared warm-up, not an eager `onReady` enqueue: deferred past
// serving-ready, throttled, and `worktree`-scoped — pages live in each
// worktree's own DB, so every backend rebuilds its own index. The body only
// enqueues; the scan runs in the job.
export const pageLinksBackfillWarmup = defineWarmup({
  name: "page.links.backfill",
  description:
    "Starts a catch-up pass at boot so every page's backlinks are complete.",
  scope: "worktree",
  run: async () => {
    await backfillPageLinksJob.enqueue({});
  },
});
