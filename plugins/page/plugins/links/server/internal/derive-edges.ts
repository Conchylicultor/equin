import {
  inDocumentOrder,
  type BlockNode,
} from "@plugins/page/plugins/editor/core";
import { defineSourceSet } from "@plugins/packages/plugins/source-digest/core";
import type { PageLinkExtractor } from "./extractor";

// Which pages a page links to, from which block, as a pure function of its
// blocks and the contributed extractors — kept in its own small module because
// its code (with every extractor's module, `PageLinkExtractor.code`) is the
// stamp of the stored `page_links` rows: the boot backfill (`backfill.ts`)
// re-derives them only when that code changes. Reading the blocks, validating
// targets and diffing against the stored rows live in `reindex.ts`.

/** The code every stored `page_links` row was derived by: this module plus
 * each contributed extractor's (added at backfill time, once registered). */
export const pageLinksCode = defineSourceSet(
  "how a page's blocks become its outgoing links (the `page_links` rows)",
);
pageLinksCode.include(import.meta);

export interface Edge {
  targetPageId: string;
  sourceBlockId: string;
}

/** One spelling of an edge's identity within its source page. */
export const edgeKey = (e: Edge): string =>
  `${e.targetPageId}\u0000${e.sourceBlockId}`;

/**
 * Every (target, block) edge the page's blocks name, deduped (two extractors,
 * or one extractor naming a target twice, still make one edge per block),
 * self-references dropped. Typed extractors run on their block type, global
 * (type-less) ones on every block — dispatched generically, never naming a
 * block type.
 */
export function extractEdges(
  pageId: string,
  blocks: readonly BlockNode[],
  contributed: readonly PageLinkExtractor[],
): Edge[] {
  const extractors = new Map<string, (data: unknown) => string[]>();
  const globalExtractors: ((data: unknown) => string[])[] = [];
  for (const c of contributed) {
    if (c.type === undefined) globalExtractors.push(c.extract);
    else extractors.set(c.type, c.extract);
  }
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
  return [...found.values()];
}

/**
 * Per target page, the id of its FIRST linking block in the page's document
 * order. A target linked from one block (the usual case) needs no ordering;
 * `inDocumentOrder` ranks the rest — a block's `rank` is comparable only among
 * its siblings, so the order is the forest's DFS, never a rank sort.
 */
export function firstLinkingBlocks(
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
