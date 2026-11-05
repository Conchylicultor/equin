import { and, eq, inArray } from "drizzle-orm";
import { db, type DbExecutor } from "@plugins/database/server";
import { PAGE_BLOCK_TYPE } from "../../core";
import { _blocks } from "./tables";

/**
 * The ids among `ids` that name a page row — LIVE OR TRASHED. For an index
 * derived from a page's CONTENT that must outlive its referent's trash: a link
 * edge (`page/links`) is kept whatever its target's state, since the source
 * still names it and a restore must bring it back with no reindex; liveness
 * is the readers' filter (`pageLive`, `liveBlocks`). An id naming no row (a
 * purged page, a typo) or a non-page block is dropped. Every other reader
 * takes `liveBlocks`.
 */
export async function existingPageIds(
  ids: readonly string[],
  executor: DbExecutor = db,
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await executor
    .select({ id: _blocks.id })
    .from(_blocks)
    .where(
      and(inArray(_blocks.id, [...ids]), eq(_blocks.type, PAGE_BLOCK_TYPE)),
    );
  return new Set(rows.map((r) => r.id));
}
