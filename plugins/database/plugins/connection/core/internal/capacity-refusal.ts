/**
 * Was this connection refused because the server side is FULL — not because the
 * database is broken, unreachable or misconfigured?
 *
 * Two refusals, and only these two:
 *
 * - **pgbouncer's `max_client_conn`.** Every backend, exec child and CLI on the
 *   box connects through the one pgbouncer, whose client-connection cap is
 *   host-wide. Past it pgbouncer answers the login with
 *   `FATAL 08P01 no more connections allowed (max_client_conn)` and closes. The
 *   SQLSTATE alone is NOT the classification: 08P01 is `protocol_violation`,
 *   which pgbouncer also uses for genuinely broken protocol. The message is
 *   pgbouncer's own fixed text, so the pair is exact.
 * - **Postgres's `too_many_connections` (53300).** The direct-socket twin
 *   (`max_connections`), reached by the sessions that bypass pgbouncer (the job
 *   queue, LISTEN, admin).
 *
 * Both are back-pressure: the same connect succeeds once enough holders let go.
 * They are therefore transient — and, unlike every other connect failure,
 * worth waiting out rather than failing on. What is NOT one: a refused socket,
 * an auth failure, a missing database — those say something is wrong.
 *
 * Walks `cause` and `AggregateError.errors`, because the refusal rarely reaches
 * the caller bare: `awaitDbReady`'s deadline wraps the last one in a `cause`,
 * and a boot aggregates failures.
 */
export function isConnectionCapacityRefusal(err: unknown): boolean {
  return someInChain(err, isCapacityRefusalItself, new Set());
}

/** pgbouncer's fixed refusal text, as it prefixes the reason in parentheses. */
const PGBOUNCER_FULL = "no more connections allowed";

function isCapacityRefusalItself(err: object): boolean {
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (code === "53300") return true;
  return (
    code === "08P01" &&
    typeof message === "string" &&
    message.startsWith(PGBOUNCER_FULL)
  );
}

function someInChain(
  err: unknown,
  test: (e: object) => boolean,
  seen: Set<object>,
): boolean {
  if (err === null || typeof err !== "object" || seen.has(err)) return false;
  seen.add(err);
  if (test(err)) return true;
  if (err instanceof AggregateError) {
    for (const inner of err.errors) {
      if (someInChain(inner, test, seen)) return true;
    }
  }
  return someInChain((err as { cause?: unknown }).cause, test, seen);
}
