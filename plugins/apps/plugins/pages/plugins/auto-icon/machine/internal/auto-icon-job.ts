import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { generatePageIcon } from "./generate-icon";

/**
 * The edit-triggered (and backfill) run of `generatePageIcon`.
 *
 * Keyed on the page (`dedup: { key }`, graphile's replace), so the scheduler's
 * repeated `runAt: now + 10s` during an edit burst pushes the one pending row
 * back — the debounce. `serial`: one model call at a time, since the backfill
 * enqueues every page at once.
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
  dedup: { key: ({ pageId }) => pageId },
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
