import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { _notifications } from "./tables";

/**
 * Rewrite what the notification currently holding `dedupeKey` says — its
 * `description` — without it counting as another occurrence: no `count` /
 * `lastSeenAt` bump, no new episode, its read / dismissed state and place
 * untouched (a recurrence is `recordNotification`'s; this is the same event,
 * told better now that more is known). An earlier episode's row released the
 * key and keeps its words. Returns the number of rows updated (0 or 1).
 */
export async function restateNotification(
  dedupeKey: string,
  restated: { description: string },
): Promise<number> {
  const rows = await db
    .update(_notifications)
    .set({ description: restated.description })
    .where(eq(_notifications.dedupKey, dedupeKey))
    .returning({ id: _notifications.id });
  return rows.length;
}
