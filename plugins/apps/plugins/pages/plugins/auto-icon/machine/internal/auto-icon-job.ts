import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { generatePageIcon } from "./generate-icon";

/**
 * The edit-triggered (and backfill) run of `generatePageIcon`.
 *
 * Bound to `blocksChanged` with `with: { pageId: eventField("pageId") }`, keyed
 * on the page and settled: every edit pushes the one pending row back to 10 s
 * from now (at most 2 minutes after the first), so the pick sees the page once
 * its edits pause, and leaving the page needs no signal of its own. The job
 * returns at once for a page that already had its run. `serial`: one model call
 * at a time, since the backfill enqueues every page at once.
 * Always unforced — Regenerate awaits `generatePageIcon` in its request instead.
 */
export const autoIconJob = defineJob({
  name: "pages.auto-icon.generate",
  description:
    "Asks Claude Haiku to pick an emoji icon for a page from its title and content, once per page.",
  // seconds: one Haiku call bounded by its own 30 s timeout.
  hold: "seconds",
  input: z.object({ pageId: z.string() }),
  event: z.never(),
  dedup: {
    key: ({ pageId }) => pageId,
    settle: { quietMs: 10_000, maxWaitMs: 120_000 },
  },
  serial: true,
  maxAttempts: 2,
  run: async ({ input: { pageId } }) => {
    const result = await generatePageIcon(pageId);
    if (result.kind === "rejected") {
      // Nothing written, no provenance row: a later edit retries.
      console.warn(
        `[auto-icon] icon for page ${pageId} rejected: ${result.reason}`,
      );
    }
  },
});
