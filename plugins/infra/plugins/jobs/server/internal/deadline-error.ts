// The error a run's deadline aborts its `ctx.signal` with — portable, because a
// handler (on any host) names and checks it; the deadline itself is the
// desktop queue's (`machine/internal/deadline.ts`).

// Globally-shared brand. `Symbol.for` returns the same Symbol across module
// reloads (HMR), worker pools, and separate copies of @plugins/jobs reachable
// through different paths — so `isJobDeadlineExceededError()` is robust where
// `instanceof` would silently fail when the class identity differs between throw
// and catch. Same rationale as `NonRetryableError`'s brand in non-retryable.ts.
const JOB_DEADLINE_BRAND: unique symbol = Symbol.for(
  "@plugins/jobs:JobDeadlineExceededError",
) as never;

/**
 * The `AbortSignal.reason` a run's deadline aborts with, so a handler that
 * unwinds because of it fails with a named cause rather than an anonymous
 * `AbortError` that reads like a shutdown.
 *
 * A handler generally does not construct this — it surfaces as the rejection of
 * whatever the handler was awaiting when the signal was threaded into it
 * (`fetch`, `spawnCaptured`, a pool acquire).
 */
export class JobDeadlineExceededError extends Error {
  // Brand shows up on the instance for `isJobDeadlineExceededError()`.
  // Symbol-keyed so it doesn't leak into JSON / log serialisation.
  readonly [JOB_DEADLINE_BRAND] = true;
  constructor(message: string) {
    super(message);
    this.name = "JobDeadlineExceededError";
  }
}

/** Brand check that survives module-identity differences. Use this, never
 * `instanceof`. */
export function isJobDeadlineExceededError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as Record<symbol, unknown>)[JOB_DEADLINE_BRAND] === true
  );
}
