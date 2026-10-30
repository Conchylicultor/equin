/**
 * Thrown by shared check plumbing (a git scan, a spawned tool) when it could
 * not answer for an ENVIRONMENTAL reason — a host-load timeout, not a wrong
 * input. A check body that lets it escape settles as `inconclusive` (non-fatal,
 * never cached, re-run next time) instead of the fatal "threw instead of
 * returning a result" every other throw is. It is the typed spelling of
 * `{ ok: false, inconclusive: true }` for code that has no result to return.
 */
export class InconclusiveCheckError extends Error {
  constructor(
    message: string,
    /** What to do about it, shown as the result's hint. */
    readonly hint?: string,
  ) {
    super(message);
    this.name = "InconclusiveCheckError";
  }
}
