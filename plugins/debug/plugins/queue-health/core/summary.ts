import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { HoldClassSchema } from "@plugins/infra/plugins/jobs/core";

// A response schema is required for useEndpoint/fetchEndpoint (and the MCP tool)
// to return parsed data. These three item schemas mirror the jobs plugin's
// introspection return shapes (BacklogJobStat / RunningJobStat / DeadJobStat) —
// the server ignores the schema, so it is client- and MCP-safe.

// Every `hold` below is `.optional()` for one reason: the MCP tool parses this
// schema against a response fetched from ANOTHER worktree's backend through the
// gateway, and that backend may still be running a build from before hold
// classes existed. An absent `hold` means "that backend predates the ladder",
// which is a different statement from any default we could invent.

// Mirrors jobs' BacklogJobStat: ready-queue depth per jobName, per class.
const backlogJobStatSchema = z.object({
  jobName: z.string(),
  hold: HoldClassSchema.optional(),
  readyCount: z.number().int(),
  oldestOverdueMs: z.number().int(),
});

// One tier of the runner ladder. `reachableSlots` is how many of the pool's
// slots a row of this class can EVER be picked up by (instant 8, seconds 6,
// minutes 4) — the reservation, stated per class.
//
// `lockedCount` counts locked ROWS of this class. It is deliberately not called
// "slots held by this tier": three runners share one graphile job table and no
// runner id is recorded per row, so the DB cannot attribute a locked row to the
// runner that holds it.
const classStatSchema = z.object({
  hold: HoldClassSchema,
  reachableSlots: z.number().int(),
  readyCount: z.number().int(),
  lockedCount: z.number().int(),
  oldestOverdueMs: z.number().int(),
});

// Mirrors jobs' RunningJobStat: a currently-locked job holding a shared slot.
// `alive` is exact worker liveness (a granted advisory lock on the job id), not
// an inference from `lockedForMs` — a long `lockedForMs` with `alive: true` is a
// healthy slow job, the same duration with `alive: false` is an abandoned row.
const runningJobStatSchema = z.object({
  jobName: z.string(),
  hold: HoldClassSchema.optional(),
  jobId: z.string(),
  lockedForMs: z.number().int(),
  lockedBy: z.string().nullable(),
  alive: z.boolean(),
});

// Mirrors jobs' DeadJobStat: terminally-dead rows per jobName.
const deadJobStatSchema = z.object({
  jobName: z.string(),
  deadCount: z.number().int(),
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  lastError: z.string().nullable(),
  sampleJobId: z.string().nullable(),
});

// A single attributed snapshot of the queue's health: the total slot count, the
// aggregate backlog, the same backlog broken out per hold class, and the
// per-jobName breakdowns that attribute backlog (byJobName), slot-holding
// (running), and terminal failures (dead).
//
// `concurrency` and `backlog` are the ALL-CLASSES rollup and keep their original
// meaning and names — every existing consumer keeps parsing unchanged. `classes`
// is pure addition: the same three numbers per tier of the runner ladder, which
// is where a saturation question actually has an answer now that a class's ready
// work can only be drained by the runners that serve it.
export const QueueHealthSummarySchema = z.object({
  concurrency: z.number().int(),
  backlog: z.object({
    readyCount: z.number().int(),
    lockedCount: z.number().int(),
    oldestOverdueMs: z.number().int(),
  }),
  // Optional for the same cross-worktree reason as `hold` above: a backend
  // predating the ladder answers this route without a `classes` array.
  classes: z.array(classStatSchema).optional(),
  byJobName: z.array(backlogJobStatSchema),
  running: z.array(runningJobStatSchema),
  dead: z.array(deadJobStatSchema),
});
export type QueueHealthSummary = z.infer<typeof QueueHealthSummarySchema>;

export const queueHealthSummaryEndpoint = defineEndpoint({
  route: "GET /api/debug/queue-health/summary",
  response: QueueHealthSummarySchema,
  // It reads the desktop's graphile queue (infra/jobs#machine).
  needsMachine: { feature: "Queue health" },
});
