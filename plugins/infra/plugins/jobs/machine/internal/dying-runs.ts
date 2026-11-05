import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import type { EnqueueTx } from "../../server/internal/registry";

/**
 * Rows whose run `dispatch()` in THIS process has declared dead (its last
 * attempt threw) while graphile still holds them locked.
 *
 * The gap it closes: a row counts as in flight while it is locked
 * (`keysInFlight`), and graphile unlocks it only with its fail write — issued
 * after the handler returns and never awaited (`job:complete` fires before it
 * lands). The run's `onDead` hook runs in between, so whatever it sets off
 * (a status reconcile asking "is this launch still coming?") would read the
 * dying row as still coming, and the answer would wait for the next unrelated
 * read. Marked here before the hook runs, the row stops counting at once.
 *
 * A fact about this process's own dispatches, held in this process, and
 * consulted only while that id's row is still locked. A dead row never runs
 * again under its id by a re-queue of its key — graphile retires an
 * unavailable row and inserts a fresh one (`keys-in-flight.test.ts`) — and a
 * retry (attempts reset) unmarks it before it can be locked again, so a stale
 * entry is never a wrong answer — only memory, which {@link pruneDyingRuns}
 * returns once the row is unlocked or gone.
 */
const dying = new Set<string>();

/** `dispatch()` decided job `jobId`'s run is dead; its row is still locked. */
export function markRunDying(jobId: string): void {
  dying.add(jobId);
}

/** Job `jobId` runs again (Debug → Queue's retry): it is no longer dying. */
export function unmarkRunDying(jobId: string): void {
  dying.delete(jobId);
}

/** The job ids of the rows marked dying — `keysInFlight` counts none of them. */
export function dyingRunIds(): readonly string[] {
  return [...dying];
}

/** Forget the marks whose rows are no longer locked (graphile's fail write landed). */
export async function pruneDyingRuns(database: EnqueueTx): Promise<void> {
  if (dying.size === 0) return;
  const ids = [...dying];
  const stillLocked = await executeRows(database, {
    label: "jobs.dying-runs: prune",
    row: z.object({ id: z.string() }),
    query: sql`
      SELECT j.id::text AS id
        FROM graphile_worker._private_jobs j
       WHERE j.id::text IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))
         AND j.locked_at IS NOT NULL
    `,
  });
  const locked = new Set(stillLocked.map((r) => r.id));
  for (const id of ids) if (!locked.has(id)) dying.delete(id);
}
