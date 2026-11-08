import { eq } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import { inspect } from "@plugins/packages/plugins/zod-introspect/core";
import {
  type EnqueueTx,
  getAllRegisteredJobNames,
  type RegisteredJob,
  UNSAFE_getRegisteredJob,
} from "@plugins/infra/plugins/jobs/server";
import { db } from "@plugins/database/server";
import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import { resolveEventFields } from "./event-field";
import { triggerTableRegistry } from "./registry";

/** One matched trigger row, and the event payload it matched. */
export const TriggerDeliverySchema = z.object({
  eventName: z.string(),
  triggerId: z.string().uuid(),
  jobName: z.string(),
  jobWith: z.record(z.string(), z.unknown()),
  eventPayload: z.record(z.string(), z.unknown()),
  oneShot: z.boolean(),
});
export type TriggerDelivery = z.infer<typeof TriggerDeliverySchema>;

/** A delivery whose target resolved and whose payloads parse — ready to enqueue. */
export interface ResolvedDelivery {
  delivery: TriggerDelivery;
  target: RegisteredJob;
  /** The trigger's `with`, its event fields resolved against the payload. */
  input: Record<string, unknown>;
  event: unknown;
}

/**
 * Resolve one matched trigger to the job it delivers to, or to nothing.
 *
 * A subscriber's problem never fails the emitter (a drifted subscriber must not
 * roll back a task status change):
 * - Unknown target (a stale binding whose job was removed): the trigger row is
 *   removed (self-heal) and reported.
 * - Contract drift (the stored `with` — its event fields resolved — or the
 *   event payload no longer parses against the target's schemas, or the
 *   payload lacks a field an `eventField` names): reported and skipped. Deterministic — the same
 *   payload never parses — so there is nothing to retry; the binding stays, the
 *   contract needs fixing.
 */
export async function resolveDelivery(
  d: TriggerDelivery,
  tx?: EnqueueTx,
): Promise<ResolvedDelivery | null> {
  const target = UNSAFE_getRegisteredJob(d.jobName);
  if (!target) {
    // An empty registry is not a stale binding — it is an emit before the
    // register phase, and deleting the row then would wipe a valid trigger.
    if (getAllRegisteredJobNames().size === 0) {
      throw new Error(
        `[events] "${d.eventName}" emitted before any job was registered (trigger ${d.triggerId} → "${d.jobName}")`,
      );
    }
    const msg = `[events] removing stale trigger ${d.triggerId}: job "${d.jobName}" no longer exists (event "${d.eventName}")`;
    console.warn(msg);
    reportServerError({ message: msg });
    await deleteTriggerRow(tx ?? db, d);
    return null;
  }

  // `z.never()` means the target ignores events — deliver undefined. The
  // target's input schema is parsed by `enqueue()` itself; checked here first
  // so drift is reported instead of thrown into the emitter.
  let event: unknown = undefined;
  if (inspect(target.eventSchema).kind !== "never") {
    const parsedEvent = target.eventSchema.safeParse(d.eventPayload);
    if (!parsedEvent.success) {
      reportDrift(d, "event", parsedEvent.error.message);
      return null;
    }
    event = parsedEvent.data;
  }
  const resolvedWith = resolveEventFields(d.jobWith, d.eventPayload);
  if (!resolvedWith.ok) {
    reportDrift(
      d,
      "input",
      `the payload has no ${resolvedWith.missing.map((f) => JSON.stringify(f)).join(", ")} for the trigger's eventField`,
    );
    return null;
  }
  const parsedInput = target.inputSchema.safeParse(resolvedWith.input);
  if (!parsedInput.success) {
    reportDrift(d, "input", parsedInput.error.message);
    return null;
  }
  return { delivery: d, target, input: resolvedWith.input, event };
}

/**
 * Enqueue a resolved delivery's target — its own queue row, run id and dedup
 * key, the same path as a direct `.enqueue()` — on `tx` when given. A oneShot
 * trigger has served its purpose once its target is durably enqueued (if the
 * target later fails, its own row retries), so its row is deleted with it.
 */
export async function enqueueDelivery(
  r: ResolvedDelivery,
  tx?: EnqueueTx,
): Promise<void> {
  await r.target.enqueue(r.input, { _event: r.event, tx });
  if (r.delivery.oneShot) await deleteTriggerRow(tx ?? db, r.delivery);
}

/** Resolve and enqueue one delivery, outside any caller transaction. */
export async function deliverToTrigger(d: TriggerDelivery): Promise<void> {
  const resolved = await resolveDelivery(d);
  if (resolved) await enqueueDelivery(resolved);
}

/**
 * Whether a target's row may be inserted on the emitter's own transaction.
 * A keyed or singleton enqueue upserts graphile's `job_key`, which holds that
 * key's row lock until the transaction ends — so two emitters touching the same
 * key would serialize behind each other, and two touching two keys in opposite
 * orders would deadlock, aborting a write that has nothing to do with the
 * subscriber. A `none` row is a plain insert, and locks nothing anyone shares.
 */
export function enqueuesOnCallerTx(target: RegisteredJob): boolean {
  return target.dedup === "none";
}

function reportDrift(
  d: TriggerDelivery,
  side: "event" | "input",
  detail: string,
): void {
  const msg = `[events] ${side} drift for job "${d.jobName}" (event "${d.eventName}", trigger ${d.triggerId}): ${detail}`;
  console.error(msg);
  reportServerError({ message: msg, scope: d.jobName });
}

async function deleteTriggerRow(
  exec: EnqueueTx,
  d: TriggerDelivery,
): Promise<void> {
  const table = triggerTableRegistry.get(d.eventName);
  if (!table) {
    throw new Error(
      `[events] unknown event "${d.eventName}" at delivery (trigger ${d.triggerId})`,
    );
  }
  await exec
    .delete(table)
    // biome-ignore lint/suspicious/noExplicitAny: dynamic id column access on untyped PgTable.
    .where(eq((table as any).id as AnyPgColumn, d.triggerId));
}
