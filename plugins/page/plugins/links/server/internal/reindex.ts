import { and, eq, or, sql } from "drizzle-orm";
import {
  inDocumentOrder,
  type BlockNode,
} from "@plugins/page/plugins/editor/core";
import { db, type DbExecutor } from "@plugins/database/server";
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
// 4. Mark, per target, the edge of the FIRST linking block in document order
//    (`first`: the block a backlink's snippet is read from).
// 5. Diff against the existing page_links rows for this source; insert added
//    edges, delete removed ones, flip `first` where the first block moved.
//    Each affected target's backlinks panel refreshes through the change
//    feed: `pageBacklinks` follows the target's first edges.
//
// ONE transaction per page, under a per-page advisory lock taken first: the
// reads and the diff's writes are one atomic step, so a reader never sees a
// half-applied diff (two `first` edges for one pair, or none while the first
// block moves), and two reindexes of one page — the job runs `dedup: "none"`
// — serialize instead of diffing the same old state.
//
// A TRASHED source page is left as it is: its content is trashed with it and
// frozen until restored, so its edges already say what it links to — reading
// its (now non-live) blocks would wipe them, and the restore would need a
// reindex to bring them back. Readers hide a trashed source's edges.
export async function reindexPage(pageId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('page.links.reindex'), hashtext(${pageId}))`,
    );
    await reindexLocked(pageId, tx);
  });
}

async function reindexLocked(pageId: string, tx: DbExecutor): Promise<void> {
  const [source] = await tx
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

  const blocks: BlockNode[] = (
    await tx
      .select({
        id: liveBlocks.id,
        pageId: liveBlocks.pageId,
        parentId: liveBlocks.parentId,
        type: liveBlocks.type,
        data: liveBlocks.data,
        rank: liveBlocks.rank,
        expanded: liveBlocks.expanded,
      })
      .from(liveBlocks)
      .where(eq(liveBlocks.pageId, pageId))
  ).map((b) => ({ ...b, rank: String(b.rank) }));

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
  const validTargets = await existingPageIds(
    [...new Set([...found.values()].map((e) => e.targetPageId))],
    tx,
  );
  const kept = [...found.values()].filter((e) =>
    validTargets.has(e.targetPageId),
  );
  const firstOf = firstLinkingBlocks(blocks, kept);
  const next = new Map(
    kept.map((e) => [
      edgeKey(e),
      { ...e, first: firstOf.get(e.targetPageId) === e.sourceBlockId },
    ]),
  );

  const existingEdges = await tx
    .select({
      targetPageId: _pageLinks.targetPageId,
      sourceBlockId: _pageLinks.sourceBlockId,
      first: _pageLinks.first,
    })
    .from(_pageLinks)
    .where(eq(_pageLinks.sourcePageId, pageId));
  const old = new Map(existingEdges.map((e) => [edgeKey(e), e]));

  const toInsert = [...next].filter(([k]) => !old.has(k)).map(([, e]) => e);
  const toDelete = [...old].filter(([k]) => !next.has(k)).map(([, e]) => e);
  const toFlip = [...next]
    .filter(([k, e]) => old.has(k) && old.get(k)!.first !== e.first)
    .map(([, e]) => e);

  if (toInsert.length > 0) {
    await tx
      .insert(_pageLinks)
      .values(toInsert.map((e) => ({ sourcePageId: pageId, ...e })));
  }
  if (toDelete.length > 0) {
    await tx
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
  for (const e of toFlip) {
    await tx
      .update(_pageLinks)
      .set({ first: e.first })
      .where(
        and(
          eq(_pageLinks.sourcePageId, pageId),
          eq(_pageLinks.targetPageId, e.targetPageId),
          eq(_pageLinks.sourceBlockId, e.sourceBlockId),
        ),
      );
  }
}

/**
 * Per target page, the id of its FIRST linking block in the page's document
 * order. A target linked from one block (the usual case) needs no ordering;
 * `inDocumentOrder` ranks the rest — a block's `rank` is comparable only among
 * its siblings, so the order is the forest's DFS, never a rank sort.
 */
function firstLinkingBlocks(
  forest: BlockNode[],
  edges: readonly Edge[],
): Map<string, string> {
  const linking = new Map<string, string[]>();
  for (const e of edges) {
    const list = linking.get(e.targetPageId);
    if (list) list.push(e.sourceBlockId);
    else linking.set(e.targetPageId, [e.sourceBlockId]);
  }
  const first = new Map<string, string>();
  for (const [target, ids] of linking) {
    const [id] = ids.length === 1 ? ids : inDocumentOrder(forest, ids);
    if (id !== undefined) first.set(target, id);
  }
  return first;
}

interface Edge {
  targetPageId: string;
  sourceBlockId: string;
}

/** One spelling of an edge's identity within its source page. */
const edgeKey = (e: Edge): string =>
  `${e.targetPageId}\u0000${e.sourceBlockId}`;
