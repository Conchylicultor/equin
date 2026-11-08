import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { recordVersion } from "@plugins/history/plugins/engine/server";

/**
 * The keyed snapshot job: captures one time-bucketed version of a page. Bound
 * to `blocksChanged` with `with: { pageId: eventField("pageId") }` and settled
 * per page, so a whole edit burst collapses into a single run 4 s after the last
 * edit (and at least once a minute while the edits never pause).
 * `recordVersion`'s 10-minute window then does the Notion-style coalescing.
 */
export const pageSnapshotJob = defineJob({
  name: "pages.history.snapshot",
  description: "Records a version of a page in its history after edits settle.",
  hold: "instant",
  input: z.object({ pageId: z.string() }),
  event: z.never(),
  dedup: {
    key: ({ pageId }) => pageId,
    settle: { quietMs: 4_000, maxWaitMs: 60_000 },
  },
  run: async ({ input }) => {
    await recordVersion("pages", input.pageId);
  },
});
