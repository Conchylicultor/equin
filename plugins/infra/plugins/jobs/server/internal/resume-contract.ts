import { z } from "zod";

// Single source of truth for the `ctx.waitFor` / `ctx.sleep` durable-hook
// binding contract. Both sides of the events↔jobs IoC seam reference this one
// module:
//   - PRODUCER: the worker's durable ctx (step-ctx.ts) constructs the trigger
//     row's `with` payload (and the timeout/sleep scheduled enqueue payload),
//     typed by {@link ResumeInput}.
//   - CONSUMER: the private `jobs.resume` builtin (resume-job.ts) parses that
//     payload with {@link ResumeInputSchema}.
// Pinning the producer's type to the same schema the consumer parses makes the
// construction compile-checked, so the two can never drift (the mismatch was
// previously only caught at runtime when the dispatcher parsed `with`).
//
// This file deliberately depends on neither step-ctx nor resume-job, so it can
// be imported by both without forming a cycle.

// Reserved keys inserted into the `jobs.resume` payload via a trigger's
// `with` clause (or a scheduled enqueue for timeouts). Kept together so the
// resume handler can discriminate them from the event payload's own keys
// (which arrive via the events dispatcher's merge).
export const RESUME_KEYS = {
  workflowRunId: "__resume_workflowRunId",
  waitName: "__resume_waitName",
  jobName: "__resume_jobName",
  input: "__resume_input",
  // The event the suspended run was triggered with (absent for a direct
  // enqueue): a resumed run is handed the same `event` as the run that
  // suspended, or an event-triggered job would wake to nothing.
  event: "__resume_event",
  timeout: "__resume_timeout",
} as const;

// Resume control-fields. The events plugin's bridge bakes these into the
// trigger row's `with` (see install-jobs-hooks.ts). Direct timeout/sleep
// enqueues (scheduleResume in the worker) also go through this same shape.
export const ResumeInputSchema = z.object({
  [RESUME_KEYS.workflowRunId]: z.string(),
  [RESUME_KEYS.waitName]: z.string(),
  [RESUME_KEYS.jobName]: z.string(),
  [RESUME_KEYS.input]: z.unknown(),
  [RESUME_KEYS.event]: z.unknown().optional(),
  [RESUME_KEYS.timeout]: z.boolean().optional(),
});

// Compile-time shape the worker constructs `with` against. Identical to the
// parsed output (the schema has no transforms), so producer and consumer are
// guaranteed to agree.
export type ResumeInput = z.input<typeof ResumeInputSchema>;
