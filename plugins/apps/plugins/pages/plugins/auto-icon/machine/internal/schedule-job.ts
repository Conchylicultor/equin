import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { autoIconJob } from "./auto-icon-job";

/** How long a page's edits must settle before its icon is picked. */
const SETTLE_MS = 10_000;

/**
 * Subscriber of `blocksChanged`. A trigger's job input is its constant `with`,
 * so the subscriber cannot itself be keyed per page: it re-enqueues the keyed
 * {@link autoIconJob} with a fresh `runAt = now + 10s` on every change, and
 * graphile replaces the pending row — so an edit burst collapses to one run
 * ~10s after the last edit, and leaving the page needs no signal of its own.
 * The job returns at once for a page that already had its run.
 */
export const autoIconScheduleJob = defineJob({
  name: "pages.auto-icon.schedule",
  description:
    "Schedules a page's icon pick once its edits have settled for 10 seconds.",
  // instant: one queue insert. The debounce is the future `runAt` on that row.
  hold: "instant",
  input: z.object({}).default({}),
  event: z.object({ pageId: z.string() }),
  dedup: "none",
  run: async ({ event }) => {
    if (!event) return;
    await autoIconJob.enqueue(
      { pageId: event.pageId },
      { runAt: new Date(Date.now() + SETTLE_MS) },
    );
  },
});
