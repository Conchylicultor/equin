import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { LogEntrySchema } from "./log";

export const SubscribeBodySchema = z.object({
  userId: z.string().optional(),
  label: z.string(),
  oneShot: z.boolean().optional(),
});
export type SubscribeBody = z.infer<typeof SubscribeBodySchema>;

export const EmitBodySchema = z.object({
  userId: z.string(),
  message: z.string().optional(),
});
export type EmitBody = z.infer<typeof EmitBodySchema>;

export const DirectEnqueueBodySchema = z.object({
  label: z.string(),
});
export type DirectEnqueueBody = z.infer<typeof DirectEnqueueBodySchema>;

export const DeleteTargetingBodySchema = z.object({
  label: z.string(),
});
export type DeleteTargetingBody = z.infer<typeof DeleteTargetingBodySchema>;

export const subscribeEventsTest = defineEndpoint({
  route: "POST /api/events-test/subscribe",
  body: SubscribeBodySchema,
  response: z.object({ id: z.string() }),
});

export const emitEventsTest = defineEndpoint({
  route: "POST /api/events-test/emit",
  body: EmitBodySchema,
});

export const directEnqueueEventsTest = defineEndpoint({
  route: "POST /api/events-test/direct-enqueue",
  body: DirectEnqueueBodySchema,
  response: z.object({ jobId: z.string() }),
});

// The whole log, kept for the e2e flow (`e2e/events-test-flow.ts`), which
// asserts on it over HTTP; the pane reads the live `events-test.log` value.
export const getEventsTestLog = defineEndpoint({
  route: "GET /api/events-test/log",
  response: z.object({ entries: z.array(LogEntrySchema) }),
});

export const resetEventsTest = defineEndpoint({
  route: "POST /api/events-test/reset",
});

export const deleteEventsTestTrigger = defineEndpoint({
  route: "DELETE /api/events-test/trigger/:id",
});

export const deleteEventsTestTargeting = defineEndpoint({
  route: "POST /api/events-test/delete-targeting",
  body: DeleteTargetingBodySchema,
});

// Kept for the e2e flow (`e2e/events-test-flow.ts`), which clears and asserts
// on the triggers over HTTP; the pane reads events' live `event-triggers` value.
export const listEventsTestTriggers = defineEndpoint({
  route: "GET /api/events-test/triggers",
  response: z.object({ rows: z.array(z.record(z.string(), z.unknown())) }),
});

export const waitEventsTestIdle = defineEndpoint({
  route: "GET /api/events-test/wait-idle",
});

export const crashRecoveryEventsTest = defineEndpoint({
  route: "POST /api/events-test/crash-recovery",
  internal: { why: "test fixture: driven by e2e, no browser client" },
});

// The three queue-level regression harnesses. Like crash-recovery they declare
// no response schema: each returns a structured verdict (`{ok:true, …}` or
// `{ok:false, step, error, …}`) as a raw Response, so a failure names the
// assertion that failed rather than throwing.
export const serialQueueEventsTest = defineEndpoint({
  route: "POST /api/events-test/serial-queue",
  internal: { why: "test fixture: driven by e2e, no browser client" },
});

export const queueLockNoStealEventsTest = defineEndpoint({
  route: "POST /api/events-test/queue-lock-no-steal",
  internal: { why: "test fixture: driven by e2e, no browser client" },
});

export const cronDedupEventsTest = defineEndpoint({
  route: "POST /api/events-test/cron-dedup",
  internal: { why: "test fixture: driven by e2e, no browser client" },
});

// A row graphile retired mid-run (a newer copy of its key was queued) is
// dropped by the stuck-lock sweeper once its worker dies — never released into
// the dead-job set. Same verdict shape as the three above.
export const supersededEventsTest = defineEndpoint({
  route: "POST /api/events-test/superseded",
  internal: { why: "test fixture: driven by e2e, no browser client" },
});

// Drives the job queue into a saturated, dead-lettered state on a dev deploy,
// so queue observability (the health report's Job queue row, Debug → Queue)
// can be looked at in its amber/red states. Not a regression harness: it
// asserts nothing and returns as soon as the rows are durable.
//
// Every field is `.optional()` rather than `.default()`: `defineEndpoint` types
// the client-side body from the schema's OUTPUT type, so a default would make
// each field required for every caller. The server resolves the defaults — and
// `count`'s default is derived from the jobs plugin's slot table, which this
// runtime-neutral file does not import.
export const QueueSaturateBodySchema = z.object({
  /** How many `minutes`-class sleepers to enqueue. Default: the class's
   * reachable slots + 1, so exactly one waits when nothing else is running. */
  count: z.number().int().min(1).max(20).optional(),
  /** How long each sleeper holds its slot. Default 90 s. Capped at 20 min —
   * under the `minutes` work ceiling (30 min), so the harness never files a
   * slow-op or slot-hog report of its own. */
  sleepMs: z
    .number()
    .int()
    .min(0)
    .max(20 * 60_000)
    .optional(),
  /** Back-date every sleeper's `run_at` by this much, so the one left waiting
   * already looks old enough to cross a waiting threshold. Default 0 (due
   * now). Capped at 24 h. */
  backdateMs: z
    .number()
    .int()
    .min(0)
    .max(24 * 60 * 60_000)
    .optional(),
  /** Also enqueue one job that throws `NonRetryableError`, so it dead-letters
   * after a single attempt. Default true. */
  dead: z.boolean().optional(),
});
export type QueueSaturateBody = z.infer<typeof QueueSaturateBodySchema>;

export const queueSaturateEventsTest = defineEndpoint({
  route: "POST /api/events-test/queue-saturate",
  internal: { why: "test fixture: driven by e2e, no browser client" },
  body: QueueSaturateBodySchema,
  response: z.object({
    /** Graphile job ids of the sleepers, in enqueue order. */
    sleeperJobIds: z.array(z.string()),
    /** The dead-letter job's id, or null when `dead: false`. */
    deadJobId: z.string().nullable(),
    /** Slots a `minutes` row can reach; sleepers beyond it wait (more, if
     * other long jobs already hold some). */
    minutesSlots: z.number(),
    sleepMs: z.number(),
    /** The back-dated `run_at` every sleeper carries, or null when due now. */
    runAt: z.string().nullable(),
  }),
});

// Enqueues the `events-test.detached-sleep` supervised job (a `run` body in a
// detached child). Fields optional for the same reason as queue-saturate's.
export const DetachedSleepBodySchema = z.object({
  seconds: z.number().int().min(0).max(3600).optional(),
  fail: z.enum(["none", "retryable", "non-retryable"]).optional(),
});
export type DetachedSleepBody = z.infer<typeof DetachedSleepBodySchema>;

export const detachedSleepEventsTest = defineEndpoint({
  route: "POST /api/events-test/detached-sleep",
  internal: { why: "test fixture: driven by e2e, no browser client" },
  body: DetachedSleepBodySchema,
  response: z.object({ ok: z.literal(true) }),
});
