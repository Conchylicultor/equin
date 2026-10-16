import { asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import {
  nullable,
  parsed,
} from "@plugins/database/plugins/sql-projection/server";
import {
  serveCollection,
  serveValue,
} from "@plugins/network/plugins/live/server";
import { EmojiSchema } from "@plugins/ui/plugins/icons/plugins/emoji/core";
import { _blocks, liveBlocks } from "@plugins/page/plugins/editor/server";
import {
  inDocumentOrder,
  pageData,
  textOf,
  type BlockNode,
} from "@plugins/page/plugins/editor/core";
import {
  inlineTokenReferentTables,
  inlineTokensAsText,
} from "@plugins/primitives/plugins/text-editor/plugins/inline-chip/server";
import { pageBacklinks, pageLinkSources } from "../../core/resources";
import type { BacklinkRow } from "../../core/schemas";
import { linkSourceRowsServeOptions } from "./link-source-rows";
import { deriveSnippet } from "./snippet";
import { _pageLinks } from "./tables";

// `data->>'title'` / `data->>'icon'`: the source page's title and icon (an
// emoji) live in the `type="page"` block's `data` JSON.
//
// Both carry the decoder their declared type comes from, so the projection is
// `BacklinkRow` by construction rather than by a cast — `->` hands back whatever
// JSON the block's `data` happens to hold, which is exactly the value worth
// parsing rather than asserting. `orderBy` reuses the same expression object;
// the decoder rides along and is simply never invoked there.
const titleExpr = sql`${liveBlocks.data} ->> 'title'`.mapWith(String);
const iconExpr = sql`${liveBlocks.data} ->> 'icon'`.mapWith(
  nullable(parsed(EmojiSchema, "backlinks.icon")),
);

// The source pages that link TO `pageId`, ordered by title, each with the
// snippet of its first linking block in document order. A db-arm value: the
// declared reads (`page_links`, `page_blocks`, and the tables the snippets'
// chip titles come from) route
// every edge write — the reindexer's insert/delete, the trash
// hook's drop, an FK cascade — and every source page's title / icon / text edit
// — or a rename of a task, song, … a snippet's chip shows —
// recomputes the subscribed tuples; push drops a byte-identical result.
export const pageBacklinksServed = serveValue(pageBacklinks, {
  source: "db",
  // A thunk: chip families contribute their referent tables as the plugin tiers
  // load, after this value is declared.
  reads: () => ({
    tables: [...new Set([_pageLinks, _blocks, ...inlineTokenReferentTables()])],
    reason:
      "the backlinks of one page join every edge and every source page's title, icon and text, and each snippet shows the titles its chips resolve to (tasks, songs, pages, …) — whole-table until it reads through a collection",
  }),
  unbounded: {
    reason:
      "the pages that link to one page — a join over page_links and the live page blocks, not the rows of one table",
  },
  loader: async ({ pageId }) => {
    const edges = await db
      .select({
        id: liveBlocks.id,
        title: titleExpr,
        icon: iconExpr,
        sourceBlockId: _pageLinks.sourceBlockId,
      })
      .from(_pageLinks)
      // A trashed source page's edges are dropped by the trash hook; the LIVE
      // join is what makes that a fact rather than a race.
      .innerJoin(liveBlocks, eq(_pageLinks.sourcePageId, liveBlocks.id))
      .where(eq(_pageLinks.targetPageId, pageId))
      // The id breaks a title tie (every "Untitled" source): push compares
      // bytes, so two recomputes over the same rows must not come back in two
      // orders.
      .orderBy(asc(titleExpr), asc(liveBlocks.id));
    if (edges.length === 0) return [];

    const [target] = await db
      .select({ data: liveBlocks.data })
      .from(liveBlocks)
      .where(eq(liveBlocks.id, pageId))
      .limit(1);
    const targetTitle = target ? pageData(target).title || UNTITLED : null;

    const firstBlock = await firstLinkingBlocks(edges);
    const paths = await ancestorTitles(edges.map((e) => e.id));

    const rows: BacklinkRow[] = [];
    const seen = new Set<string>();
    for (const edge of edges) {
      if (seen.has(edge.id)) continue;
      seen.add(edge.id);
      const block = firstBlock.get(edge.id);
      rows.push({
        id: edge.id,
        title: edge.title,
        icon: edge.icon,
        path: paths.get(edge.id) ?? [],
        snippet:
          block === undefined || targetTitle === null
            ? null
            : deriveSnippet(
                await inlineTokensAsText(textOf(block)),
                targetTitle,
              ),
      });
    }
    return rows;
  },
});

/** A page with no title of its own still has to be called something — the
 *  same fallback the page-link referent resolves a token to. */
const UNTITLED = "Untitled";

/**
 * Per source page, its FIRST live linking block in document order. A page
 * that links from one block (the usual case) needs no ordering; only a page
 * linking from several has its block forest read, so `inDocumentOrder` can
 * rank them — a block's `rank` is comparable only among its siblings.
 */
async function firstLinkingBlocks(
  edges: readonly { id: string; sourceBlockId: string }[],
): Promise<Map<string, BlockNode>> {
  const blocks = await db
    .select(nodeColumns)
    .from(liveBlocks)
    .where(
      inArray(liveBlocks.id, [...new Set(edges.map((e) => e.sourceBlockId))]),
    );
  const byPage = new Map<string, BlockNode[]>();
  for (const b of blocks.map(toNode)) {
    if (b.pageId === null) continue;
    const list = byPage.get(b.pageId);
    if (list) list.push(b);
    else byPage.set(b.pageId, [b]);
  }

  const first = new Map<string, BlockNode>();
  const ambiguous: string[] = [];
  for (const [page, linking] of byPage) {
    if (linking.length === 1) first.set(page, linking[0]!);
    else ambiguous.push(page);
  }
  if (ambiguous.length > 0) {
    const forest = (
      await db
        .select(nodeColumns)
        .from(liveBlocks)
        .where(inArray(liveBlocks.pageId, ambiguous))
    ).map(toNode);
    for (const page of ambiguous) {
      const linking = byPage.get(page)!;
      const [id] = inDocumentOrder(
        forest.filter((b) => b.pageId === page),
        linking.map((b) => b.id),
      );
      const block = linking.find((b) => b.id === id);
      if (block) first.set(page, block);
    }
  }
  return first;
}

/**
 * Per page id, its ancestor pages' titles, root first — walked up the
 * denormalized `pageId` (nearest PAGE ancestor) relation one level per query,
 * batched across every page asked about, so the cost is the tree's depth, not
 * the number of rows. `pageId`, not `parentId`: a sub-page's direct parent may
 * be a content block. A chain stops at a missing (trashed) ancestor and guards
 * against cycles.
 */
async function ancestorTitles(
  pageIds: readonly string[],
): Promise<Map<string, string[]>> {
  const parentOf = new Map<string, string | null>();
  const titleOf = new Map<string, string>();
  let frontier = [...new Set(pageIds)];
  while (frontier.length > 0) {
    const rows = await db
      .select({
        id: liveBlocks.id,
        pageId: liveBlocks.pageId,
        title: titleExpr,
      })
      .from(liveBlocks)
      .where(inArray(liveBlocks.id, frontier));
    const next: string[] = [];
    for (const row of rows) {
      parentOf.set(row.id, row.pageId);
      titleOf.set(row.id, row.title || UNTITLED);
      if (row.pageId !== null && !parentOf.has(row.pageId)) {
        next.push(row.pageId);
      }
    }
    // Ids asked for but not found are settled as chain ends.
    for (const id of frontier) if (!parentOf.has(id)) parentOf.set(id, null);
    frontier = [...new Set(next)];
  }

  const paths = new Map<string, string[]>();
  for (const id of new Set(pageIds)) {
    const path: string[] = [];
    const seen = new Set([id]);
    let cur = parentOf.get(id) ?? null;
    while (cur !== null && !seen.has(cur) && titleOf.has(cur)) {
      seen.add(cur);
      path.unshift(titleOf.get(cur)!);
      cur = parentOf.get(cur) ?? null;
    }
    paths.set(id, path);
  }
  return paths;
}

const nodeColumns = {
  id: liveBlocks.id,
  pageId: liveBlocks.pageId,
  parentId: liveBlocks.parentId,
  type: liveBlocks.type,
  data: liveBlocks.data,
  rank: liveBlocks.rank,
  expanded: liveBlocks.expanded,
};

function toNode(row: {
  id: string;
  pageId: string | null;
  parentId: string | null;
  type: string;
  data: unknown;
  rank: unknown;
  expanded: boolean;
}): BlockNode {
  return { ...row, rank: String(row.rank) };
}

// Every live page with the pages linking to it — a routed `all` collection
// over `page_blocks` and its `page_links` children (`./link-source-rows.ts`):
// an edge write — reindex insert/delete, the trash hook's edge drop, an FK
// cascade from a hard delete — refills its target page's row alone.
export const pageLinkSourcesServed = serveCollection(
  pageLinkSources,
  linkSourceRowsServeOptions,
);
