import { desc, lt, lte, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import { db } from "@plugins/database/server";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { TOMBSTONE_RETENTION_DAYS } from "@plugins/database/plugins/table-mirror/core";
import { tableMirrorLog, tableMirrorMarks, tableMirrorSource } from "./tables";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One prune run as of `now`, in one transaction: record a mark (`now`, this
 * snapshot's xmin), then take M = the newest mark at least `retentionDays` old
 * and delete every log row with `xid < M` — upserts and tombstones alike — and
 * every older mark, and raise the horizon to M. A replica whose floor is at or
 * above M already had what went; one below it is answered
 * `reconcile-required`. So the log holds the last `retentionDays` of changes.
 * Returns the horizon it pruned below (null: no mark old enough yet).
 */
export async function pruneMirrorLog(
  dbx: NodePgDatabase,
  now: Date,
  retentionDays: number = TOMBSTONE_RETENTION_DAYS,
): Promise<{ horizon: string | null }> {
  return dbx.transaction(async (tx) => {
    await tx
      .insert(tableMirrorMarks)
      .values({
        at: now,
        snapshotXmin: sql`pg_snapshot_xmin(pg_current_snapshot())`,
      })
      .onConflictDoNothing();
    const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
    const [mark] = await tx
      .select({
        at: tableMirrorMarks.at,
        xmin: sql`${tableMirrorMarks.snapshotXmin}::text`.mapWith(String),
      })
      .from(tableMirrorMarks)
      .where(lte(tableMirrorMarks.at, cutoff))
      .orderBy(desc(tableMirrorMarks.at))
      .limit(1);
    if (mark === undefined) return { horizon: null };
    await tx
      .delete(tableMirrorLog)
      .where(sql`${tableMirrorLog.xid} < ${mark.xmin}::xid8`);
    await tx.update(tableMirrorSource).set({
      horizon: sql`greatest(${tableMirrorSource.horizon}, ${mark.xmin}::xid8)`,
    });
    await tx.delete(tableMirrorMarks).where(lt(tableMirrorMarks.at, mark.at));
    return { horizon: mark.xmin };
  });
}

/**
 * Daily. `perWorktree: true` is required: a deployed release is never main, and
 * only perWorktree crons install there (the analytics rollup's reason). Each
 * database has its own log, so there is nothing shared to race over.
 */
export const tableMirrorPruneJob = defineJob({
  name: "table-mirror.prune",
  description:
    "Forgets table-mirror changes older than the retention window, so the change log stays bounded; a mirror away longer reconciles instead.",
  hold: "instant",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "40 0 * * *", perWorktree: true },
  async run() {
    await pruneMirrorLog(db, new Date());
  },
});
