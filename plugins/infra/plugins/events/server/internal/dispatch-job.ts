import { eq } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import { inspect } from "@plugins/packages/plugins/zod-introspect/core";
import {
  defineJob,
  NonRetryableError,
  UNSAFE_getRegisteredJob,
} from "@plugins/infra/plugins/jobs/server";
import { db } from "@plugins/database/server";
import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import { triggerTableRegistry } from "./registry";

// The events plugin's dispatcher is itself a registered job. `emit()` enqueues
// one of these per matching trigger row; the handler resolves the trigger's
// target job, validates the event payload against the target's event schema,
// and enqueues the target via `target.enqueue()`. This gives the target its
// own graphile queue row, its own `workflowRunId`, and its own dedup key —
// the same path as a direct `.enqueue()` call.
//
// For oneShot triggers, the trigger row is deleted after the target is
// durably enqueued — the trigger has served its purpose. If the target
// later fails, graphile retries it independently.
//
// Unknown targets (stale triggers referencing deleted jobs) are self-healed:
// the orphaned trigger row is removed and dispatch returns without throwing.
//
// Event-payload schema drift (the target exists but the stored payload no
// longer parses against its `event:` schema) is its sibling but NOT self-healed
// — the binding is still valid. It is deterministic, though, so it throws a
// NonRetryableError to dead-letter after one attempt instead of churning
// maxAttempts retries on every emission.
export const eventsDispatchJob = defineJob({
  name: "events.dispatch",
  description:
    "Delivers an emitted event to the job subscribed to it by validating the payload and queueing that job.",
  internal: true,
  // instant: routing only — resolve the target, validate the payload, enqueue.
  // Measured at 26ms of work over 1405 runs. The target's EXECUTION lands in
  // whatever class the target itself declares, so a heavy target never makes the
  // hop that reaches it heavy. This is what keeps event delivery out of the queue
  // behind long work; see the plan's Context on the two unprioritised hops.
  hold: "instant",
  input: z.object({
    eventName: z.string(),
    triggerId: z.string().uuid(),
    jobName: z.string(),
    jobWith: z.record(z.string(), z.unknown()),
    eventPayload: z.record(z.string(), z.unknown()),
    oneShot: z.boolean(),
  }),
  event: z.never(),
  dedup: "none",
  run: async ({ input: p }) => {
    const target = UNSAFE_getRegisteredJob(p.jobName);
    if (!target) {
      const msg = `[events] removing stale trigger ${p.triggerId}: job "${p.jobName}" no longer exists (event "${p.eventName}")`;
      console.warn(msg);
      reportServerError({ message: msg });
      const table = triggerTableRegistry.get(p.eventName);
      if (table) {
        await db
          .delete(table)
          // biome-ignore lint/suspicious/noExplicitAny: dynamic id column access on untyped PgTable
          .where(eq((table as any).id as AnyPgColumn, p.triggerId));
      }
      return;
    }

    // Validate the event payload before enqueuing. `z.never()` means the
    // target ignores events — pass undefined. The target's input schema is
    // validated inside `enqueue()` itself (via `spec.input.parse()`).
    const isNeverEvent = inspect(target.eventSchema).kind === "never";
    let eventArg: unknown = undefined;
    if (!isNeverEvent) {
      const parsedEvent = target.eventSchema.safeParse(p.eventPayload);
      if (!parsedEvent.success) {
        // Event-payload contract drift: the target job exists, but the stored
        // payload no longer parses against its `event:` schema. This is a
        // deterministic failure — the same stored payload will never parse on
        // retry — so we throw a NonRetryableError to dead-letter it after one
        // attempt instead of churning maxAttempts retries on every emission.
        // We do NOT self-heal (delete the trigger) like the unknown-job path:
        // the binding is still valid, the contract just needs fixing. The
        // worker reports + dead-letters it, keeping the drift loud and visible.
        throw new NonRetryableError(
          `[events] event drift for job "${p.jobName}" (event "${p.eventName}", trigger ${p.triggerId}): ${parsedEvent.error.message}`,
        );
      }
      eventArg = parsedEvent.data;
    }

    await target.enqueue(p.jobWith, { _event: eventArg });

    if (p.oneShot) {
      const table = triggerTableRegistry.get(p.eventName);
      if (!table) {
        const msg = `[events] unknown event "${p.eventName}" at dispatch (trigger ${p.triggerId}); skipping oneShot cleanup`;
        console.error(msg);
        reportServerError({ message: msg });
        return;
      }
      await db
        .delete(table)
        // biome-ignore lint/suspicious/noExplicitAny: dynamic id column access on untyped PgTable.
        .where(eq((table as any).id as AnyPgColumn, p.triggerId));
    }
  },
});
