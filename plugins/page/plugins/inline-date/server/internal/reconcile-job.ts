import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { BLOCKS_CHANGED_SETTLE } from "@plugins/page/plugins/editor/server";
import { reconcileReminders } from "./reconcile";

// Event-driven reminder reconcile. Bound to the editor's `page.blocksChanged`
// with `with: { pageId: eventField("pageId") }`, so the page arrives as the
// input and the job keys on it: an edit burst settles into one reconcile of the
// page (`BLOCKS_CHANGED_SETTLE`) instead of one per edit. `reconcileReminders`
// is idempotent (diff-based) and reads the page's current text.
export const reminderReconcileJob = defineJob({
  name: "page.reminders.reconcile",
  description:
    "Keeps scheduled reminders in step with the inline dates on a page once its edits settle.",
  hold: "instant",
  input: z.object({ pageId: z.string() }),
  event: z.never(),
  dedup: { key: ({ pageId }) => pageId, settle: BLOCKS_CHANGED_SETTLE },
  run: async ({ input }) => {
    await reconcileReminders(input.pageId);
  },
});
