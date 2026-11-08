import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { BLOCKS_CHANGED_SETTLE } from "@plugins/page/plugins/editor/server";
import { reindexPage } from "./reindex";

// Event-driven reindex. Bound to the editor's `page.blocksChanged` with
// `with: { pageId: eventField("pageId") }`, so the page arrives as the input and
// the job keys on it: an edit burst settles into one reindex of the page
// (`BLOCKS_CHANGED_SETTLE`) instead of one per edit. `reindexPage` is
// idempotent (diff-based) and reads the page's current state.
export const reindexLinksJob = defineJob({
  name: "page.links.reindex",
  description:
    "Refreshes a page's outgoing links once its edits settle so backlinks stay accurate.",
  hold: "instant",
  input: z.object({ pageId: z.string() }),
  event: z.never(),
  dedup: { key: ({ pageId }) => pageId, settle: BLOCKS_CHANGED_SETTLE },
  run: async ({ input }) => {
    await reindexPage(input.pageId);
  },
});
