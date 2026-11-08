import { and, eq, lt } from "drizzle-orm";
import { z } from "zod";
import { db } from "@plugins/database/server";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { _notifications } from "./tables";

const DISMISSED_TTL_MS = 7 * 24 * 3_600_000;

// Deletes only what the USER dismissed, a week later. Nothing here (or
// anywhere) dismisses a notification on its own: an undismissed row stays
// until the user dismisses it, however old or quiet. The bell and the pane
// read the undismissed set as bounded windows (`shared/resources.ts`) and the
// badge as one indexed count, so its size costs no read.
export const ttlCleanupJob = defineJob({
  name: "notifications.ttl-cleanup",
  description:
    "Deletes notifications the user dismissed more than a week ago; never dismisses one itself.",
  hold: "instant",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "0 * * * *" }, // hourly
  async run() {
    const dismissedCutoff = new Date(Date.now() - DISMISSED_TTL_MS);
    await db
      .delete(_notifications)
      .where(
        and(
          eq(_notifications.dismissed, true),
          lt(_notifications.createdAt, dismissedCutoff),
        ),
      );
  },
});
