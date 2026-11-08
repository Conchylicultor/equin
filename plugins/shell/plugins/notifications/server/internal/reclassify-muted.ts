import { and, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db } from "@plugins/database/server";
import type { NotificationState } from "../../core";
import { _notifications } from "./tables";

/**
 * Set `muted` for every notification whose metadata field `key` equals one of
 * `values`. `muted` is a snapshot of some classification taken at record time
 * (e.g. crash noise) — when the rules behind it change, the producer reconciles
 * the stored flag through here. Updates only rows that actually flip (the live
 * notifications resource refreshes via the L4 DB change-feed), and is a no-op for
 * an empty `values` list. Returns the number of rows updated.
 */
export async function setMutedByMetadata(
  key: string,
  values: string[],
  muted: boolean,
): Promise<number> {
  if (values.length === 0) return 0;
  const rows = await db
    .update(_notifications)
    .set({ muted })
    .where(
      and(
        inArray(sql`${_notifications.metadata} ->> ${key}`, values),
        eq(_notifications.muted, !muted),
      ),
    )
    .returning({ id: _notifications.id });
  return rows.length;
}

/**
 * Set `state` on every notification whose metadata field `key` equals
 * `value` — every row about one subject, the earlier episodes' rows included
 * (they released their dedup key, not their metadata). The row keeps its
 * place, its read and dismissed state: only what it says of its problem
 * changes. Writes only rows whose state differs. Returns how many changed.
 */
export async function restateByMetadata(
  key: string,
  value: string,
  state: NotificationState | null,
  conn: NodePgDatabase = db,
): Promise<number> {
  const rows = await conn
    .update(_notifications)
    .set({ state })
    .where(
      and(
        sql`${_notifications.metadata} ->> ${key} = ${value}`,
        sql`${_notifications.state} is distinct from ${state === null ? null : JSON.stringify(state)}::jsonb`,
      ),
    )
    .returning({ id: _notifications.id });
  return rows.length;
}
