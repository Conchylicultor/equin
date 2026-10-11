import { and, count, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { _automationLaunchBatches, tasksOrigin } from "./tables";

const b = _automationLaunchBatches;
const t = tasksOrigin.table;

/**
 * Keep `automationId`'s batch in step with whether it is on: turned on (or on
 * at boot with no open batch), a new batch opens now; turned off, the open one
 * closes. Idempotent — call it on every config change and at boot.
 */
export async function syncLaunchBatch(
  automationId: string,
  enabled: boolean,
): Promise<void> {
  if (enabled) await openLaunchBatch(automationId);
  else await closeLaunchBatch(automationId);
}

async function closeLaunchBatch(automationId: string): Promise<void> {
  await db
    .update(b)
    .set({ endedAt: new Date() })
    .where(and(eq(b.automationId, automationId), isNull(b.endedAt)));
}

/** The open batch's start — opening one now when there is none. */
export async function openLaunchBatch(automationId: string): Promise<Date> {
  const now = new Date();
  // Only a closed (or missing) batch is replaced: an open one keeps counting.
  await db
    .insert(b)
    .values({ automationId, startedAt: now, endedAt: null })
    .onConflictDoUpdate({
      target: b.automationId,
      set: { startedAt: now, endedAt: null },
      where: isNotNull(b.endedAt),
    });
  const [row] = await db
    .select({ startedAt: b.startedAt })
    .from(b)
    .where(eq(b.automationId, automationId));
  if (row === undefined) {
    throw new Error(
      `automation ${automationId}: its launch batch was not written`,
    );
  }
  return row.startedAt;
}

/** How many tasks `automationId` launched since `since` (its batch's start). */
export async function launchedSince(
  automationId: string,
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(t)
    .where(
      and(
        eq(t.automationId, automationId),
        eq(t.role, "launched"),
        gte(t.filedAt, since),
      ),
    );
  return row?.n ?? 0;
}

/**
 * Every launch-kind automation's launches in its OPEN batch, keyed by
 * automation id (absent ⇒ off, or nothing launched yet).
 */
export async function launchedInOpenBatches(): Promise<Map<string, number>> {
  const rows = await db
    .select({ automationId: b.automationId, n: count(t.taskId) })
    .from(b)
    .innerJoin(
      t,
      and(
        eq(t.automationId, b.automationId),
        eq(t.role, "launched"),
        sql`${t.filedAt} >= ${b.startedAt}`,
      ),
    )
    .where(isNull(b.endedAt))
    .groupBy(b.automationId);
  return new Map(rows.map((r) => [r.automationId, r.n]));
}
