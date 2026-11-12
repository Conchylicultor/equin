import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { defineWarmup } from "@plugins/infra/plugins/warmup/server";
import {
  liveBlocks,
  PAGE_BLOCK_TYPE,
} from "@plugins/page/plugins/editor/server";
import { PageLinks } from "./extractor";
import { pageLinksCode } from "./derive-edges";
import { reindexPage } from "./reindex";

// The catch-up pass over every page's outgoing links, run once per change of
// the code that derives them — never on a boot whose code derived the rows.
//
// Every page write keeps its edges fresh by itself: `blocksChanged` enqueues
// `page.links.reindex` durably, in the writing transaction. So the stored
// edges can only disagree with the pages when the DERIVATION changed — the
// edge's shape, an extractor added or edited (the rows a data migration
// dropped for naming no linking block were rebuilt this way) — or when the
// corpus predates the index. Both are what `derivedFrom` covers: the warm-up
// runs when the derivation's code (`derive-edges.ts` plus every contributed
// extractor's module) digests differently from the last run against this
// database, and on a database that never ran it. Until 2026-11-12 it
// reindexed every page on every boot (about 0.15 s of CPU on main, inside the
// window tabs resubscribe in).
//
// A run writes only what changed: `reindexPage` diffs against the rows
// already indexed, so a code change that moves no edge writes nothing.
async function backfillPageLinks(): Promise<void> {
  const pages = await db
    .select({ id: liveBlocks.id })
    .from(liveBlocks)
    .where(eq(liveBlocks.type, PAGE_BLOCK_TYPE));
  for (const page of pages) await reindexPage(page.id);
}

// Deferred past serving-ready, throttled, and `worktree`-scoped — pages live in
// each worktree's own DB, so every backend owns its index (and its stamp; a
// fork inherits main's with main's rows).
export const pageLinksBackfillWarmup = defineWarmup({
  name: "page.links.backfill",
  description:
    "Re-derives every page's outgoing links after the way links are derived changes, so each page's backlinks list stays complete.",
  scope: "worktree",
  derivedFrom: () => {
    for (const extractor of PageLinks.Extractor.getContributions())
      pageLinksCode.include(extractor.code);
    return [pageLinksCode];
  },
  run: backfillPageLinks,
});
