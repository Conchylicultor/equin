import { z } from "zod";

/** The report kind every failed job attempt is filed as. */
export const JOB_ATTEMPT_FAILED_KIND = "job-attempt-failed";

/**
 * What became of the run a failed attempt belonged to — known later than the
 * failure, so the report is filed with `retrying` / `last-attempt` and
 * restated once the run settles.
 */
export const AttemptFateSchema = z.discriminatedUnion("state", [
  /** Another attempt of the row follows; the run has not settled yet. */
  z.object({ state: z.literal("retrying") }),
  /** It was the row's last attempt; how the run ends is being settled. */
  z.object({ state: z.literal("last-attempt") }),
  /** A later attempt completed (or suspended: it got past the failure and the
   * workflow waits on). The failure still needs a cause — a retry that works
   * hides a bug, it does not explain it. */
  z.object({
    state: z.literal("recovered"),
    attempt: z.number().int(),
    suspended: z.boolean(),
    at: z.number(),
  }),
  /** No attempt of the run will ever come (the queue's `RunDeathCause`). */
  z.object({
    state: z.literal("gave-up"),
    cause: z.enum(["failed", "worker-died", "wake-failed", "cancelled"]),
    error: z.string(),
    at: z.number(),
  }),
  /** A re-queue of the job's key retired the row while it ran; the newer row
   * owns the run. */
  z.object({ state: z.literal("superseded"), at: z.number() }),
]);
export type AttemptFate = z.infer<typeof AttemptFateSchema>;

/** The payload of a `job-attempt-failed` report — one failed attempt. */
export const JobAttemptFailedPayloadSchema = z.object({
  jobName: z.string(),
  /** The queue row the attempt ran on. */
  jobId: z.string(),
  workflowRunId: z.string(),
  /** 1-indexed. */
  attempt: z.number().int(),
  maxAttempts: z.number().int(),
  /** The attempt's own error, as thrown — the report's message adds the fate. */
  error: z.string(),
  errorType: z.string().nullable(),
  stack: z.string().nullable(),
  fate: AttemptFateSchema,
});
export type JobAttemptFailedPayload = z.infer<
  typeof JobAttemptFailedPayloadSchema
>;

const CAUSE_WORDS: Record<
  Extract<AttemptFate, { state: "gave-up" }>["cause"],
  string
> = {
  failed: "its last attempt failed",
  "worker-died": "its worker died on its last attempt",
  "wake-failed": "its wake-up failed",
  cancelled: "cancelled in Debug → Queue",
};

/** The fate in a few words, leading the report's message so the bell's
 * one-line cut never drops it. */
export function describeFate(fate: AttemptFate): string {
  switch (fate.state) {
    case "retrying":
      return "Retrying";
    case "last-attempt":
      return "No attempt left";
    case "recovered":
      return fate.suspended
        ? `Recovered — attempt ${fate.attempt} got past it`
        : `Recovered on attempt ${fate.attempt}`;
    case "gave-up":
      return `Gave up — ${CAUSE_WORDS[fate.cause]}`;
    case "superseded":
      return "Superseded by a newer run";
  }
}

/** The report's message: the fate, then the attempt and its error. */
export function attemptReportMessage(p: JobAttemptFailedPayload): string {
  return (
    `${describeFate(p.fate)} · ${p.jobName} failed on attempt ` +
    `${p.attempt}/${p.maxAttempts}: ${p.error}`
  );
}
