import { db } from "@plugins/database/server";
import { implement } from "@plugins/infra/plugins/endpoints/server";
import { setPageKind } from "../../core";
import {
  pageData,
  pageKindOf,
  samePageKind,
  type Block,
  type PageKind,
} from "../../core";
import type { ForestExecutor } from "./page-forest";
import { rewritePageRow } from "./page-row-write";
import { rekindPageData } from "./parse-block-data";

/**
 * Change what a page IS to the agents working on it — an ordinary page, an
 * agent-authored page, or an instructions page (global or not). The page
 * header's kind control, and the ONLY write that changes a page's kind after it
 * is born (`research/2026-09-15-page-agent-page-follow-ups.md` §1,
 * `research/2026-09-17-page-agent-instructions.md`).
 *
 * Any page may be changed, a top-level one included: it is the human's choice,
 * and no MCP tool exposes this op, so only the human makes it. The write is
 * {@link rekindPageData}'s — the stored data with the kind keys set and every
 * other key copied — so a change cannot carry a title or an icon along with it.
 *
 * Setting the kind the page already has is a no-op: no write, no event, the row
 * returned as it is. So a double click, or two tabs clicking at once, lands one
 * change, not a change and a change back.
 *
 * What a change leaves alone: the page's content, its authorship rows (which
 * conversations wrote into it — they stop showing while the page is not an
 * agent page, and show again if it becomes one), and every version in its
 * history (a restore keeps the page's CURRENT kind; see `restorePageContent`).
 *
 * Exported beside the endpoint so a DB-backed suite drives it on a throwaway
 * database, as `applyPageBlockPatch` is.
 */
export async function setPageKindOf(
  pageId: string,
  kind: PageKind,
  executor: ForestExecutor = db,
): Promise<Block> {
  return rewritePageRow(
    pageId,
    (row) =>
      samePageKind(pageKindOf(pageData(row)), kind)
        ? null
        : rekindPageData({ before: row, kind }),
    executor,
  );
}

/** The HTTP face of {@link setPageKindOf} — validation and nothing else. */
export const handleSetPageKind = implement(setPageKind, ({ params, body }) =>
  setPageKindOf(params.id, body.kind),
);
