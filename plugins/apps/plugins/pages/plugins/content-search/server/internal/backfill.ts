import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { defineWarmup } from "@plugins/infra/plugins/warmup/server";
import {
  liveBlocks,
  PAGE_BLOCK_TYPE,
} from "@plugins/page/plugins/editor/server";
import {
  upsertSearchDocs,
  deleteSearchDocs,
  getSourceDocMetadata,
} from "@plugins/search/plugins/engine/server";
import { buildPageSearchDoc } from "./reindex-page";
import { pageSearchDocCode, SOURCE } from "./search-doc";

// The catch-up pass over every page's search doc, run once per change of the
// code that derives a doc — never on a boot whose code derived the docs.
//
// Every page write keeps its doc fresh by itself: `blocksChanged` enqueues
// `pages.search.reindex` durably, in the writing transaction (and trash /
// restore / delete have their hooks). So a stored doc can only disagree with
// its page when the DERIVATION changed — a new field, another text extraction
// — or when the corpus predates the index. Both are what `derivedFrom` covers:
// the warm-up runs when `search-doc.ts`'s code (and what it loads) digests
// differently from the last run against this database, and on a database
// that never ran it. Until 2026-11-12 it reindexed every page on every boot
// (about 0.15 s of CPU on main, inside the window tabs resubscribe in), to
// catch a change that lands a few times a month.
//
// SKIP-IF-UNCHANGED within a run: each stored doc carries a fingerprint of
// what it encodes (`metadata.contentHash`), loaded for the whole source in
// ONE query; only pages whose freshly-derived fingerprint differs are
// upserted, so a code change that alters no doc writes nothing.
async function backfillPagesSearch(): Promise<void> {
  const pages = await db
    .select({ id: liveBlocks.id })
    .from(liveBlocks)
    .where(eq(liveBlocks.type, PAGE_BLOCK_TYPE));

  // Fingerprints of the docs already indexed for this source, keyed by pageId.
  // A page absent from this map (never indexed) has `undefined`, which can
  // never equal a computed hash — so it is always (re)indexed.
  const indexed = new Map(
    (await getSourceDocMetadata(SOURCE)).map((d) => [
      d.entityId,
      typeof d.metadata.contentHash === "string"
        ? d.metadata.contentHash
        : undefined,
    ]),
  );

  for (const page of pages) {
    const built = await buildPageSearchDoc(page.id);
    if (!built) {
      // Page block vanished between enumeration and read — wipe any stale doc.
      await deleteSearchDocs(SOURCE, [page.id]);
      continue;
    }
    if (indexed.get(page.id) === built.contentHash) continue; // unchanged — skip the write
    await upsertSearchDocs([built.doc]);
  }
}

// `worktree` scope — pages live in each worktree's own DB, so every backend
// owns its corpus (and its stamp; a fork inherits main's with main's docs).
export const pagesSearchBackfillWarmup = defineWarmup({
  name: "pages.search.backfill",
  description:
    "Re-derives every page's search document after the way documents are derived changes, so the whole page corpus stays searchable.",
  scope: "worktree",
  derivedFrom: () => [pageSearchDocCode],
  run: backfillPagesSearch,
});
