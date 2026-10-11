import { inArray } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { tasksSidequestTriage } from "./tables";

const t = tasksSidequestTriage.table;

/** The triage rows of `taskIds`, keyed by task (absent ⇒ not triaged). */
export async function triageReadsOf(
  taskIds: readonly string[],
): Promise<Map<string, (typeof t)["$inferSelect"]>> {
  if (taskIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(t)
    .where(inArray(t.taskId, [...taskIds]));
  return new Map(rows.map((r) => [r.taskId, r]));
}
