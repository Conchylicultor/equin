import {
  defineServerContribution,
  reportServerError,
} from "@plugins/framework/plugins/server-core/core";
import { notInArray } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { getAllRegisteredJobNames } from "@plugins/infra/plugins/jobs/server";
import { db } from "@plugins/database/server";
import { triggerTableRegistry } from "./registry";
import { deleteTriggersFor, trigger } from "./trigger";
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

export async function syncTriggerContributions(): Promise<void> {
  const declared = Trigger.getContributions();
  const seenJobs = new Set<string>();
  for (const t of declared) {
    if (!seenJobs.has(t.do.name)) {
      await deleteTriggersFor(t.do);
      seenJobs.add(t.do.name);
    }
    await trigger(t);
  }
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
