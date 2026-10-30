import { db } from "@plugins/database/server";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import { blockAuthorOf, type BlockAuthor } from "../../core";
import {
  pageBlockHandle,
  PageDataSchema,
  PAGE_BLOCK_TYPE,
  type Block,
} from "../../core";
import type { ForestExecutor } from "./page-forest";
import { rewritePageRow } from "./page-row-write";
import { rewriteBlockData } from "./parse-block-data";

/**
 * Give a page a new title, server-side — the write behind an agent renaming its
 * page by editing the `# Title` line in `edit_page`
 * (`research/2026-09-15-page-agent-page-follow-ups.md` §3). A human renames
 * through the header's own `PATCH`; this is for a caller with no live page row
 * to spread.
 *
 * It writes the page ROW's data — `{ ...stored, title }`, through
 * {@link rewriteBlockData} like every other data edit — and never the page's
 * content, so the `# Title` banner stays a line the reader adds on top rather
 * than a block. Carrying the stored data through is what keeps the author (and
 * the icon and the cover) as they are: the title is the one key it names.
 *
 * `requireAuthor` is a precondition judged UNDER the page's lock: the page must
 * still be authored by that party when the title is written, or the call is a
 * 409 and writes nothing. `edit_page` passes `"agent"` — it decided the edit
 * was a rename because the page was an agent's, and a human may flip the page to
 * their own between that decision and this write. Checking only in the tool
 * would leave that race open. A page with no author marker is the human's.
 *
 * An unchanged title writes nothing and announces nothing, and returns the row.
 */
export async function renamePage(
  pageId: string,
  title: string,
  opts: { requireAuthor?: BlockAuthor } = {},
  executor: ForestExecutor = db,
): Promise<Block> {
  return rewritePageRow(
    pageId,
    (row) => {
      if (opts.requireAuthor !== undefined) {
        const author = blockAuthorOf(pageBlockHandle, row.data) ?? "human";
        if (author !== opts.requireAuthor) {
          throw new HttpError(
            409,
            `Cannot rename page ${pageId} as the ${opts.requireAuthor}'s: it is ` +
              `now the ${author}'s page.`,
          );
        }
      }
      if (PageDataSchema.parse(row.data).title === title) return null;
      // The STORED blob spread, not a parse of it: every key it holds rides
      // through verbatim, and `rewriteBlockData` re-validates the result.
      return rewriteBlockData({
        type: PAGE_BLOCK_TYPE,
        before: row,
        next: { ...row.data, title },
      });
    },
    executor,
  );
}
