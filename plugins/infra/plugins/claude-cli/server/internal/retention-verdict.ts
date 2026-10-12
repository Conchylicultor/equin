/**
 * The one piece of real logic behind `claudeCliCallsFor` (`claude-cli.calls-for`): when a correlation
 * id matches NO rows, was a call never made (`none`) or made and since trimmed
 * (`not-retained`)?
 *
 * Pure and IO-free on purpose — the predicate is easy to get subtly wrong and
 * expensive to exercise through a real table, so it is separated from the queries
 * that feed it (`list-calls.ts`) and covered directly by `retention-verdict.test.ts`.
 *
 * `recordClaudeCliCall` trims the log to the `limit` most recent rows GLOBALLY,
 * so `not-retained` requires BOTH:
 *
 *  1. `total >= limit` — the log is at capacity, i.e. trimming has actually been
 *     possible. Without this a fresh install, which has never trimmed anything,
 *     would libel every record older than its first call as trimmed.
 *  2. `occurredAt < oldest` — the record predates every surviving call. A call
 *     made FOR a record happens at or after the record's own instant, so nothing
 *     it produced could still be here.
 *
 * Without `occurredAt` there is no way to test (2), so the honest answer is `none`
 * — claiming trimming we cannot demonstrate would be worse than admitting nothing.
 */
export function statusForNoCalls(input: {
  /** When the asking record itself happened. Absent ⇒ (2) is untestable. */
  occurredAt: Date | undefined;
  /** Current row count of the whole call log. */
  total: number;
  /** `min(created_at)` over the surviving rows; null when the log is empty. */
  oldest: Date | null;
  /** The trim ceiling the recorder enforces (`RECENT_CALLS_LIMIT`). */
  limit: number;
}): "none" | "not-retained" {
  const { occurredAt, total, oldest, limit } = input;
  if (!occurredAt) return "none";
  if (total < limit) return "none";
  if (!oldest) return "none";
  return occurredAt.getTime() < oldest.getTime() ? "not-retained" : "none";
}
