import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { deliverToTrigger, TriggerDeliverySchema } from "./deliver";

// The outbox of a transactional emit: ONE row per emission, carrying every
// matched trigger whose target cannot be enqueued on the emitter's own
// transaction (a keyed or singleton target — see `defersToOutbox`). The row
// commits or rolls back with the emitter's writes; this job then enqueues each
// target in its own short statement, outside every caller's locks.
//
// Every other target — any target of an emit without a transaction, and a
// `dedup: "none"` target of one with — is enqueued inline by emit() and never
// passes through here. (Until 2026-11 every matched trigger had a row of its
// own here, doubling every event-triggered run.)
//
// The single-delivery input is the old per-trigger shape, kept so a row queued
// before the batch shape (a running backend's, or one copied into a forked
// worktree DB) still drains.
export const eventsDispatchJob = defineJob({
  name: "events.dispatch",
  description:
    "Delivers a transactional event to its keyed subscribers once the emitter's transaction committed, by queueing each subscribed job.",
  internal: true,
  // instant: routing only — resolve each target, validate, enqueue. The
  // targets' EXECUTION lands in whatever class each declares.
  hold: "instant",
  input: z.union([
    z.object({ deliveries: z.array(TriggerDeliverySchema).min(1) }),
    TriggerDeliverySchema,
  ]),
  event: z.never(),
  dedup: "none",
  run: async ({ input }) => {
    // Sequential, each its own statement. A failure throws and the row
    // retries, re-delivering the earlier targets too — every one of them is
    // keyed or singleton, so a re-delivery replaces its still-pending row.
    const deliveries = "deliveries" in input ? input.deliveries : [input];
    for (const d of deliveries) await deliverToTrigger(d);
  },
});
