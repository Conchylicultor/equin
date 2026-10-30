import { db } from "@plugins/database/server";
import type { Emoji } from "@plugins/ui/plugins/icons/plugins/emoji/core";
import { PageDataSchema, PAGE_BLOCK_TYPE, type Block } from "../../core";
import type { ForestExecutor } from "./page-forest";
import { rewritePageRow } from "./page-row-write";
import { rewriteBlockData } from "./parse-block-data";

/**
 * Set (or clear, with `null`) a page's emoji icon, server-side — for a caller
 * with no live page row to spread (the header writes through its own `PATCH`).
 * Built on {@link rewritePageRow}, so the read that decides the write is taken
 * under the page forest's lock, the stored data rides through verbatim (title,
 * cover, kind), and the change is announced (`blocksChanged`) after commit.
 *
 * `onlyIfUnset`: write only when the page has no icon under the lock — the
 * guard for an automatic writer that must never overwrite an icon the user
 * picked while it was working. Judged under the lock, so a concurrent pick
 * cannot slip between the check and the write.
 *
 * Setting the icon the page already has (or skipping under `onlyIfUnset`)
 * writes nothing and announces nothing; either way the current row is returned.
 *
 * `executor` must be able to OPEN a transaction (see {@link ForestExecutor}): the
 * forest lock is this call's own transaction, never a caller's.
 */
export async function setPageIcon(
  pageId: string,
  icon: Emoji | null,
  opts: { onlyIfUnset?: boolean } = {},
  executor: ForestExecutor = db,
): Promise<Block> {
  return rewritePageRow(
    pageId,
    (row) => {
      const current = PageDataSchema.parse(row.data).icon;
      if (current === icon) return null;
      if (opts.onlyIfUnset === true && current !== null) return null;
      return rewriteBlockData({
        type: PAGE_BLOCK_TYPE,
        before: row,
        next: { ...row.data, icon },
      });
    },
    executor,
  );
}
