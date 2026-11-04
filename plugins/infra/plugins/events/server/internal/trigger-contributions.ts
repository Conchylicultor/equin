import {
  defineServerContribution,
  reportServerError,
} from "@plugins/framework/plugins/server-core/core";
import { notInArray, sql } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { getAllRegisteredJobNames } from "@plugins/infra/plugins/jobs/server";
import { db, writeAtomically } from "@plugins/database/server";
import { triggerTableRegistry } from "./registry";
import { declaredTriggerRow } from "./trigger";
import type { TriggerSpec } from "./trigger";

// biome-ignore lint/suspicious/noExplicitAny: type params erased at the contribution boundary
export const Trigger = defineServerContribution<TriggerSpec<any, any>>(
  "trigger",
  {
    docLabel: (t) => t.do.name,
    absentOnHost: {
      reason:
        "a trigger is its contributor's own reaction to an event (an event → one of its jobs): a host that does not boot the contributor does not react, and nothing a host serves reads the binding to answer",
    },
  },
);

/**
 * Make the trigger tables hold exactly the declared triggers: every declared
 * row (`declared`, whatever job it names — one whose contribution was renamed
 * or removed included) and every row of a job a contribution binds are
 * replaced by the contributions' rows.
 *
 * A declared row of a job no longer declared is the code's own change, not a
 * leak: nothing could have deleted it but this sync. Leaving it for
 * `sweepStaleTriggers` reported every rename of a declared trigger's job as an
 * error, once per database (`tasks.auto-start-cancel-on-drop`, 2026-11-04).
 *
 * Owning EVERY declared row assumes the backend syncing is the only plugin set
 * that database serves: a composition gets a database of its own
 * (`ensureDatabase`, never a fork), and an `exec` child runs no `onReady`.
 *
 * One statement, one DELETE and at most one INSERT per trigger table. It was
 * one DELETE per table per job, then one INSERT per trigger — ~750 serial
 * statements on a main boot (~900 ms of `onReady`), with a window between a
 * job's delete and its re-insert in which its event fired into nothing.
 */
export async function syncTriggerContributions(): Promise<void> {
  const declared = Trigger.getContributions();
  const jobNames = [...new Set(declared.map((t) => t.do.name))];

  const rowsByTable = new Map<PgTable, Record<string, unknown>[]>();
  for (const t of declared) {
    const { table, values } = declaredTriggerRow(t);
    const rows = rowsByTable.get(table);
    if (rows) rows.push(values);
    else rowsByTable.set(table, [values]);
  }

  // ONE statement: every delete and insert are arms of one data-modifying CTE,
  // so the event never fires into a job's missing rows and no trigger table
  // stays locked across an app round trip. Every arm sees the tables as they
  // were before the statement, so an insert arm never meets the rows a delete
  // arm removes (and their ids are fresh, so no key is re-inserted).
  await writeAtomically(db, [
    ...[...triggerTableRegistry.values()].map((table) => {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic column access on base-columns.
      const jobNameCol = (table as any).jobName as AnyPgColumn;
      // biome-ignore lint/suspicious/noExplicitAny: dynamic column access on base-columns.
      const declaredCol = (table as any).declared as AnyPgColumn;
      // One array parameter per table, not one per job name: every arm shares
      // the statement's bind-parameter budget.
      return db
        .delete(table)
        .where(
          sql`${declaredCol} OR ${jobNameCol} = ANY(${sql.param(jobNames)}::text[])`,
        );
    }),
    ...[...rowsByTable].map(([table, rows]) => db.insert(table).values(rows)),
  ]);
}

// A dangling trigger is a row whose `jobName` is not in the live job registry —
// its target job was removed, so the trigger can never deliver and every
// emission of its event would enqueue an `events.dispatch` job that fails. The
// retry storm that motivated this sweep (`improve.apply-queue-top` ×589 dead
// jobs) is exactly that: a deleted job whose trigger row outlived it.
//
// `sweepStaleTriggers` reconciles them at boot in a single atomic pass per
// table — `DELETE … RETURNING jobName`, so what we report is precisely what we
// removed (no find-then-sweep TOCTOU where a row could be reported-but-kept or
// swept-but-unreported). It runs in the events plugin's `onReady`, after the
// register phase has fully populated the job registry, so the "not registered"
// test reflects the complete job set. Deletion is surfaced loudly — a silent
// boot delete would hide the signal that a job was removed without cleaning up
// its triggers.
export async function sweepStaleTriggers(): Promise<void> {
  const registeredNames = getAllRegisteredJobNames();
  // An empty registry means jobs haven't registered yet; sweeping now would
  // delete every (valid) trigger. By `onReady` the register phase has run, so
  // this guard is belt-and-suspenders against an out-of-order call.
  if (registeredNames.size === 0) return;
  const names = [...registeredNames];

  const swept: { eventName: string; jobName: string }[] = [];
  for (const [eventName, table] of triggerTableRegistry.entries()) {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic column access on untyped PgTable
    const jobNameCol = (table as any).jobName as AnyPgColumn;
    const deleted = (await db
      .delete(table)
      .where(notInArray(jobNameCol, names))
      .returning({ jobName: jobNameCol })) as { jobName: string }[];
    for (const r of deleted) swept.push({ eventName, jobName: r.jobName });
  }

  if (swept.length > 0) {
    const byJob = [...new Set(swept.map((d) => d.jobName))].join(", ");
    reportServerError({
      message: `[events] swept ${swept.length} dangling trigger(s) targeting unregistered job(s): ${byJob}`,
      errorType: "DanglingTriggers",
    });
  }
}
