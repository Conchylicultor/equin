import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { implement } from "@plugins/infra/plugins/endpoints/server";
import { getBlockPage } from "../../core";
import { PAGE_BLOCK_TYPE } from "../../core";
import { liveBlocks } from "./live-blocks";

// The one "no page to open" answer, shared by all three ways of reaching it.
const MISS = { found: false } as const;

/**
 * Resolve any block id to the page that displays it. A page row answers with
 * itself; a content block answers with its denormalized `pageId`.
 *
 * A miss is a value (`found: false`), not a 404: callers are id-bearing
 * surfaces OUTSIDE the document (a block id written into a conversation, a
 * stale link) where naming a trashed or vanished block is expected, and a
 * thrown error would make them render a failure for an ordinary outcome.
 */
export const handleGetBlockPage = implement(
  getBlockPage,
  async ({ params }) => {
    const [row] = await db
      .select({
        id: liveBlocks.id,
        type: liveBlocks.type,
        pageId: liveBlocks.pageId,
      })
      // Trashed rows are `deletedAt`-flagged, not deleted — `liveBlocks` excludes
      // them so a link to a trashed page degrades to plain text rather than
      // opening a pane the pages set cannot resolve.
      .from(liveBlocks)
      .where(eq(liveBlocks.id, params.id))
      .limit(1);

    if (!row) return MISS;
    if (row.type === PAGE_BLOCK_TYPE)
      return {
        found: true,
        pageId: row.id,
        isPage: true,
        type: row.type,
      } as const;
    // A non-page block with no page ancestor sits at the forest root and is
    // displayed by no page — the same "nothing to open" answer as a miss.
    if (row.pageId === null) return MISS;
    return {
      found: true,
      pageId: row.pageId,
      isPage: false,
      type: row.type,
    } as const;
  },
);
