import { and, eq, or } from "drizzle-orm";
import { db } from "@plugins/database/server";
import {
  existingPageIds,
  liveBlocks,
} from "@plugins/page/plugins/editor/server";
import { PageLinks } from "./extractor";
import { _pageLinks } from "./tables";

// Rebuild the outgoing link edges for a single source page.
//
// 1. Load the page's content blocks (`pageId = pageId`).
// 2. Dispatch each block generically by `block.type` over the collected
//    extractors (collection-consumer separation — never names a block type),
//    recording WHICH block each link came from: an edge is (target, block).
// 3. Drop self-references and ids that name no `type="page"` row. A TRASHED
//    target is kept: an edge is the source's content, whatever its target's
//    state — readers filter liveness (`pageLive`, `liveBlocks`), so a
//    restore brings the edge back with no reindex of this page.
// 4. Diff against the existing page_links rows for this source; insert added
//    edges, delete removed ones. Each affected target's backlinks panel
//    refreshes automatically — the page_links insert/delete is invalidated by
//    the L4 DB change-feed, which recomputes every subscribed `pageBacklinks`
//    tuple.
//
// A TRASHED source page is left as it is: its content is trashed with it and
// frozen until restored, so its edges already say what it links to — reading
// its (now non-live) blocks would wipe them, and the restore would need a
// reindex to bring them back. Readers hide a trashed source's edges.
export async function reindexPage(pageId: string): Promise<void> {
  const [source] = await db
    .select({ id: liveBlocks.id })
    .from(liveBlocks)
    .where(eq(liveBlocks.id, pageId))
    .limit(1);
  if (!source) return;

  // Built fresh each call so newly-registered extractors are always honored.
  // `getContributions()` reads the populated server registry. Typed extractors
  // run on their matching block type; global (type-less) ones run on every block.
  const extractors = new Map<string, (data: unknown) => string[]>();
  const globalExtractors: ((data: unknown) => string[])[] = [];
  for (const c of PageLinks.Extractor.getContributions()) {
    if (c.type === undefined) globalExtractors.push(c.extract);
    else extractors.set(c.type, c.extract);
  }

  const blocks = await db
    .select({ id: liveBlocks.id, type: liveBlocks.type, data: liveBlocks.data })
    .from(liveBlocks)
    .where(eq(liveBlocks.pageId, pageId));

  // `edgeKey(target, block)` → the edge, deduped (two extractors, or one
  // extractor naming a target twice, still make one edge per block).
  const found = new Map<string, Edge>();
  const collect = (
    extract: (data: unknown) => string[],
    block: { id: string; data: unknown },
  ) => {
    for (const targetPageId of extract(block.data)) {
      if (!targetPageId || targetPageId === pageId) continue;
      const edge = { targetPageId, sourceBlockId: block.id };
      found.set(edgeKey(edge), edge);
    }
  };
  for (const block of blocks) {
    const extract = extractors.get(block.type);
    if (extract) collect(extract, block);
    for (const g of globalExtractors) collect(g, block);
  }

  // Validate targets: a page row, live or trashed (a non-page id, or one
  // naming nothing, is dropped — the FK would refuse it).
  const validTargets = await existingPageIds([
    ...new Set([...found.values()].map((e) => e.targetPageId)),
  ]);
  const next = new Map(
    [...found].filter(([, e]) => validTargets.has(e.targetPageId)),
  );

  const existingEdges = await db
    .select({
      targetPageId: _pageLinks.targetPageId,
      sourceBlockId: _pageLinks.sourceBlockId,
    })
    .from(_pageLinks)
    .where(eq(_pageLinks.sourcePageId, pageId));
  const old = new Map(existingEdges.map((e) => [edgeKey(e), e]));

  const toInsert = [...next].filter(([k]) => !old.has(k)).map(([, e]) => e);
  const toDelete = [...old].filter(([k]) => !next.has(k)).map(([, e]) => e);

  if (toInsert.length > 0) {
    await db
      .insert(_pageLinks)
      .values(toInsert.map((e) => ({ sourcePageId: pageId, ...e })));
  }
  if (toDelete.length > 0) {
    await db
      .delete(_pageLinks)
      .where(
        and(
          eq(_pageLinks.sourcePageId, pageId),
          or(
            ...toDelete.map((e) =>
              and(
                eq(_pageLinks.targetPageId, e.targetPageId),
                eq(_pageLinks.sourceBlockId, e.sourceBlockId),
              ),
            ),
          ),
        ),
      );
  }
}

interface Edge {
  targetPageId: string;
  sourceBlockId: string;
}

/** One spelling of an edge's identity within its source page. */
const edgeKey = (e: Edge): string =>
  `${e.targetPageId}\u0000${e.sourceBlockId}`;
