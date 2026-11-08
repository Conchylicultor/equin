import { text } from "drizzle-orm/pg-core";
import { defineTriggerEvent } from "@plugins/infra/plugins/events/server";
import type { SettleSpec } from "@plugins/infra/plugins/jobs/core";

// Payload announced whenever a page's block set changes (create / update /
// delete / move / split / merge / indent / outdent). Subscribers (e.g. the
// links plugin's backlinks reindexer) bind a job via `trigger()`. Filtered by
// `pageId` so a subscriber can scope to one page, though the reindex job binds
// match-any and dispatches per affected page.
export interface BlocksChangedPayload {
  pageId: string;
  [key: string]: unknown;
}

export const { event: blocksChanged, table: _blocksChangedTriggers } =
  defineTriggerEvent<BlocksChangedPayload>({
    name: "page.blocksChanged",
    filters: {
      pageId: text("page_id"),
    },
  });

/**
 * The settle window of a subscriber that recomputes a page's derived state
 * (its search entry, links, reminders, attachment links) from its current
 * blocks — bound with `with: { pageId: eventField("pageId") }` and
 * `dedup: { key: pageId, settle: BLOCKS_CHANGED_SETTLE }`. Edits arrive seconds
 * apart while someone types or an agent edits, each one emitting; a recompute
 * of the current state only needs the last of them. So one run per page once
 * its edits pause for 2 s — and at least every 30 s while they never do.
 */
export const BLOCKS_CHANGED_SETTLE: SettleSpec = {
  quietMs: 2_000,
  maxWaitMs: 30_000,
};
