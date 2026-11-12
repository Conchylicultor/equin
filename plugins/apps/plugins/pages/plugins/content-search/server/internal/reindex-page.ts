import { and, eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import {
  liveBlocks,
  PAGE_BLOCK_TYPE,
} from "@plugins/page/plugins/editor/server";
import {
  upsertSearchDocs,
  deleteSearchDocs,
} from "@plugins/search/plugins/engine/server";
import {
  derivePageSearchDoc,
  SOURCE,
  type BuiltPageSearchDoc,
} from "./search-doc";

// Read a page's blocks and derive its search document (`search-doc.ts`).
//
// 1. Load the page block (the `type="page"` row whose id is the pageId) and all
//    of its content blocks (`pageId = pageId`).
// 2. Return `null` if the page block is gone (deleted between a blocksChanged
//    emit / backfill enumeration and this read) — the caller wipes the doc.
export async function buildPageSearchDoc(
  pageId: string,
): Promise<BuiltPageSearchDoc | null> {
  // Only `data` is read (the page's title + icon), so that is all this projects:
  // a narrower read AND a checked assignment, where `select()` needed a cast.
  const pageRows = await db
    .select({ data: liveBlocks.data })
    .from(liveBlocks)
    .where(
      and(eq(liveBlocks.id, pageId), eq(liveBlocks.type, PAGE_BLOCK_TYPE)),
    );
  const pageBlock = pageRows[0];

  // A trashed page reads as gone here, so the caller wipes its search doc — the
  // trash-time deindex (OnTrash) plus this steady-state path both drop it.
  if (!pageBlock) return null;

  const contentBlocks = await db
    .select({ type: liveBlocks.type, data: liveBlocks.data })
    .from(liveBlocks)
    .where(eq(liveBlocks.pageId, pageId));

  return derivePageSearchDoc(pageId, pageBlock, contentBlocks);
}

// Rebuild the search document for a single page (the steady-state
// `blocksChanged`-triggered path). Diff-free upsert (replace-on-conflict), so
// re-running is idempotent; a delete self-heals a reindex racing a page delete.
// The upserted doc carries the content fingerprint in `metadata`, which the
// boot backfill reads back to decide what it can skip.
export async function reindexPageSearch(pageId: string): Promise<void> {
  const built = await buildPageSearchDoc(pageId);
  if (!built) {
    await deleteSearchDocs(SOURCE, [pageId]);
    return;
  }
  await upsertSearchDocs([built.doc]);
}
