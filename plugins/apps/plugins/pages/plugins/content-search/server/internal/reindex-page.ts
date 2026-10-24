import { and, eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import {
  liveBlocks,
  PAGE_BLOCK_TYPE,
  pageData,
} from "@plugins/page/plugins/editor/server";
import { textOf } from "@plugins/page/plugins/editor/core";
import {
  upsertSearchDocs,
  deleteSearchDocs,
} from "@plugins/search/plugins/engine/server";
import type { SearchDoc } from "@plugins/search/plugins/engine/core";
import { sha256Hex } from "@plugins/packages/plugins/string-hash/core";

// The search source id this plugin owns. Exported so the backfill reads back the
// exact same source's indexed docs.
export const SOURCE = "pages";

// The freshly-derived search document for a page plus a content fingerprint of
// everything that document encodes. The fingerprint is stamped into the doc's
// `metadata` so a later run can compare it against what is already indexed and
// skip re-upserting an unchanged page.
export interface BuiltPageSearchDoc {
  doc: SearchDoc;
  contentHash: string;
}

// Derive the search document for a single page from its blocks.
//
// 1. Load the page block (the `type="page"` row whose id is the pageId) and all
//    of its content blocks (`pageId = pageId`).
// 2. Return `null` if the page block is gone (deleted between a blocksChanged
//    emit / backfill enumeration and this read) — the caller wipes the doc.
// 3. Derive title (page block's title) + body (content blocks' plain text). The
//    page block itself carries the title but no body text, so it is excluded
//    from `body`; the engine weights `title` above `body` so a title-only match
//    still surfaces the page.
//
// The `contentHash` is a sha256 over exactly what the indexed doc encodes —
// title, body, and the emoji icon carried in metadata — so ANY change that
// would alter the stored doc (content edit, title rename, icon swap) changes the
// hash, and nothing else does. This is the skip-if-unchanged signal.
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

  const data = pageData(pageBlock);
  const title = data.title || "Untitled";
  const body = contentBlocks
    .map((b) => textOf(b))
    .filter((t) => t.length > 0)
    .join("\n");
  const icon = data.icon;

  const contentHash = sha256Hex(JSON.stringify({ title, body, icon }));

  return {
    contentHash,
    doc: {
      source: SOURCE,
      entityId: pageId,
      title,
      body,
      route: "/pages/page/" + pageId,
      metadata: { icon, contentHash },
    },
  };
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
