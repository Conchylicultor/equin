import { useMemo } from "react";
import { mapRow, useLive } from "@plugins/network/plugins/live/web";
import {
  mapResource,
  useCombinedResources,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import {
  inDocumentOrder,
  pageBlocks,
  pageData,
  pagesTree,
  toNodes,
  type Block,
} from "@plugins/page/plugins/editor/core";
import type { Emoji } from "@plugins/ui/plugins/icons/plugins/emoji/core";
import { locatedPlaces } from "@plugins/page/plugins/place/core";
import { usePlaces } from "@plugins/apps/plugins/places/plugins/places-core/web";
import { joinPageOverlay, type PageOverlayItem } from "../../core";

/** The page the overlay comes from, as its panel names it. */
export interface PageOverlayPage {
  id: string;
  title: string;
  icon: Emoji | null;
}

/**
 * What the overlay shows once every read has landed: the page is gone
 * (`missing` — a stale link), or its places joined with yours.
 */
export type PageOverlay =
  | { kind: "missing"; pageId: string }
  | {
      kind: "page";
      page: PageOverlayPage;
      /** The page's Google places, numbered in page order. */
      items: readonly PageOverlayItem[];
      /** The page's places not on the overlay (not located yet, or not Google's). */
      unplaced: number;
    };

/** The page's own blocks in document order (the forest holds sub-pages' rows too). */
function ownBlocksInOrder(blocks: readonly Block[], pageId: string): Block[] {
  const own = blocks.filter((b) => b.pageId === pageId);
  const byId = new Map(own.map((b) => [b.id, b]));
  return inDocumentOrder(
    toNodes([...blocks]),
    own.map((b) => b.id),
  ).flatMap((id) => {
    const b = byId.get(id);
    return b === undefined ? [] : [b];
  });
}

/**
 * One page's places laid over yours, read live: the page row (its title and
 * icon), its blocks (`pageBlocks`, scoped to the page — an edit to the page
 * re-joins at once) and your saved places, joined by `joinPageOverlay`. A
 * state, never a stand-in: loading until all three have landed, the failed
 * read's error, then `missing` or the page's items.
 */
export function usePageOverlay(pageId: string): ResourceResult<PageOverlay> {
  const pageRow = useLive(pagesTree, { id: pageId });
  const page = useMemo(
    () =>
      mapRow(pageRow, (row): PageOverlayPage | null => {
        if (row === null) return null;
        const data = pageData(row);
        return { id: row.id, title: data.title || "Untitled", icon: data.icon };
      }),
    [pageRow],
  );
  const blocks = useLive(pageBlocks, { where: { pageId } });
  const places = usePlaces();
  const combined = useCombinedResources({ page, blocks, places });
  return useMemo(
    () =>
      mapResource(combined, (d): PageOverlay => {
        if (d.page === null) return { kind: "missing", pageId };
        const { items, unplaced } = joinPageOverlay(
          locatedPlaces(ownBlocksInOrder(d.blocks, pageId)),
          d.places,
        );
        return { kind: "page", page: d.page, items, unplaced };
      }),
    [combined, pageId],
  );
}
