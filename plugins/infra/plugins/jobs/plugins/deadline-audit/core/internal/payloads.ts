import { z } from "zod";
import { HoldClassSchema } from "@plugins/infra/plugins/jobs/core";

/**
 * The jsonb payload behind BOTH deadline report kinds.
 *
 * One schema rather than two, because the two kinds describe the same run at two
 * instants — the abort, and the grace elapsing with the handler still live. The
 * facts are identical; what differs is `elapsedMs` and what it means that the
 * run is still going. A second schema would have to be kept identical by hand.
 *
 * `deadlineMs` is CARRIED, not looked up at render time. A report records what
 * was claimed when it was filed, and the class table is editable — re-deriving
 * the number later would let an edit silently rewrite the past. This is also
 * what lets the renderers obey the rule that no renderer restates a number from
 * the class table: every duration they print arrived here from `deadlineMsFor`.
 */
export const JobDeadlinePayloadSchema = z.object({
  jobName: z.string(),
  jobId: z.string(),
  /** 1-indexed graphile attempt number. */
  attempt: z.number().int(),
  hold: HoldClassSchema,
  /** The class's wall-clock deadline at the moment of the trip. */
  deadlineMs: z.number().int(),
  /** Wall-clock slot hold when this arm fired. Always ≥ `deadlineMs`. */
  elapsedMs: z.number().int(),
  /** Which runner in the ladder dispatched the run (`floor` / `mid` / `wide`). */
  runnerId: z.string(),
});
export type JobDeadlinePayload = z.infer<typeof JobDeadlinePayloadSchema>;

/**
 * The jsonb payload behind the `job-slot-floor` kind — the pool-level report,
 * as opposed to the two run-level ones above.
 *
 * Its arms are discriminated by `action`, not split into two kinds, because
 * they are one condition seen at two severities: a runner lost slots it cannot
 * get back. What differs is whether the process could still do its job
 * afterwards.
 *
 * Every number the class table owns — the runner's concurrency, the classes it
 * serves, the floor it was measured against, the latch's window — is CARRIED,
 * exactly like `deadlineMs` above. A report records what was true when it was
 * filed, and re-deriving these at render time would let a later edit to
 * `RUNNERS` silently rewrite what a past report said.
 */
export const JobSlotFloorPayloadSchema = z.object({
  /**
   * - `crashed` — the runner serving the longest hold class fell below the
   *   floor, and the backend exited deliberately so Postgres would drop its
   *   advisory locks.
   * - `degraded` — capacity was lost but the process stayed up: either a
   *   narrower runner went fully forfeited (its work still reaches the wider
   *   runners), or the floor tripped and the anti-loop latch suppressed the
   *   exit. `restartSuppressed` is what tells those apart.
   */
  action: z.enum(["crashed", "degraded"]),
  restartSuppressed: z.boolean(),
  runnerId: z.string(),
  /** The hold classes this runner's task list serves. */
  serves: z.array(HoldClassSchema),
  usable: z.number().int(),
  concurrency: z.number().int(),
  minUsableSlots: z.number().int(),
  /** The runs sitting in the written-off slots on this runner. */
  holders: z.array(
    z.object({
      jobId: z.string(),
      jobName: z.string(),
      hold: HoldClassSchema,
      heldMs: z.number().int(),
    }),
  ),
  tripsThisWindow: z.number().int(),
  maxTripsPerWindow: z.number().int(),
  windowMs: z.number().int(),
});
export type JobSlotFloorPayload = z.infer<typeof JobSlotFloorPayloadSchema>;

/**
 * The jsonb payload behind the `job-runner-died` kind: graphile stopped a runner
 * on its own. Numbers the class table owns are carried, as above.
 */
export const JobRunnerDiedPayloadSchema = z.object({
  /** `crashed` — the backend exited. `degraded` — the latch suppressed that. */
  action: z.enum(["crashed", "degraded"]),
  runnerId: z.string(),
  serves: z.array(HoldClassSchema),
  concurrency: z.number().int(),
  carriesCron: z.boolean(),
  reason: z.string(),
  tripsThisWindow: z.number().int(),
  maxTripsPerWindow: z.number().int(),
  windowMs: z.number().int(),
});
export type JobRunnerDiedPayload = z.infer<typeof JobRunnerDiedPayloadSchema>;
