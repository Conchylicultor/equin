import { lt } from "drizzle-orm";
import { z } from "zod";
import { db } from "@plugins/database/server";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { _notifications } from "./tables";

const RETENTION_MS = 30 * 24 * 3_600_000;

// The one retention rule: a notification is deleted 30 days after its
// `created_at` — whatever it is (read or unread, dismissed or not, any
// category, audience or state). Keyed on `created_at`, the row's place, so a
// row never moves: it only falls off the bottom of the list. Never on
// `last_seen_at`, which every dedup hit bumps and would keep a firing row alive
// forever. A deleted row's dedup key goes with it, so a later occurrence is a
// new row on top.
export const ttlCleanupJob = defineJob({
  name: "notifications.ttl-cleanup",
  description:
    "Deletes every notification created more than 30 days ago, whatever its state.",
  hold: "instant",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "0 * * * *" }, // hourly
  async run() {
    const cutoff = new Date(Date.now() - RETENTION_MS);
    await db.delete(_notifications).where(lt(_notifications.createdAt, cutoff));
  },
});
