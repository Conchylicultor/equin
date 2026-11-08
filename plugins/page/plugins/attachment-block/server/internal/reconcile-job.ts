import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { BLOCKS_CHANGED_SETTLE } from "@plugins/page/plugins/editor/server";
import { reconcilePageAttachments } from "./reconcile";

// Event-driven reconcile. Bound to the editor's `page.blocksChanged` with
// `with: { pageId: eventField("pageId") }`, so the page arrives as the input and
// the job keys on it: an edit burst settles into one reconcile of the page
// (`BLOCKS_CHANGED_SETTLE`) instead of one per edit. `reconcilePageAttachments`
// is idempotent (set()-based) and reads the page's current blocks.
export const reconcileBlockAttachmentsJob = defineJob({
  name: "page.attachment-block.reconcile",
  description:
    "Keeps a page's attachment links in step with the attachment blocks it contains once its edits settle.",
  // instant, and the measurements disagree ON PURPOSE. `slow_ops` showed a
  // max_ms near 1050s for this job, but that number is wall-clock INCLUDING
  // gate wait: the handler is one indexed SELECT over a page's blocks plus one
  // batched setMany() for the whole page — no network, no spawn, no model call.
  // The tail was background-tx-acquire wait plus an un-batched per-block
  // round-trip, i.e. two defects, neither of which a bigger hold class would
  // fix. The second is now gone (see `reconcile.ts`): the page is reconciled in
  // ONE transaction, and a settle that changed no attachment link writes
  // nothing at all. The tx-acquire wait remains, which is why conformance is
  // still read off WORK time (durationMs - waitMs) rather than wall-clock; if
  // the work itself ever exceeds 10s, queue-slot-hog says so.
  // See research/2026-08-19-global-job-hold-class-reserved-slots.md §6.
  hold: "instant",
  input: z.object({ pageId: z.string() }),
  event: z.never(),
  dedup: { key: ({ pageId }) => pageId, settle: BLOCKS_CHANGED_SETTLE },
  run: async ({ input }) => {
    await reconcilePageAttachments(input.pageId);
  },
});
