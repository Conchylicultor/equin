import { defineReportSink } from "@plugins/primitives/plugins/report-sink/core";
import type { DbPoolName } from "../../core";

// The server's half of a transaction's bound. The client-side deadline
// (`deadline.ts`) bounds a call in flight; nothing on the client bounds the
// time BETWEEN two statements of a transaction — app code that is alive but
// stalls with the transaction open, holding its row locks and its pool slot.
// The cluster's `idle_in_transaction_session_timeout` (`database/embedded`'s
// cluster settings) is that bound: Postgres ends such a session, rolling the
// transaction back. Ending it is a bound, not a fix — the stall is a defect in
// the code that opened the transaction — so every session it ends is
// announced here, naming that code, and `database/lock-watch` files the report.

/** The SQLSTATE Postgres ends a session with on `idle_in_transaction_session_timeout`. */
export const IDLE_IN_TRANSACTION_TIMEOUT_SQLSTATE = "25P03";

/**
 * Postgres ended this connection's session because it sat idle inside a
 * transaction past the cluster's `idle_in_transaction_session_timeout`.
 *
 * - `pool` names the connection; `origin` / `sql` are the runtime-profiler
 *   entry and the label of the transaction's LAST statement before the stall —
 *   the code that went quiet with the transaction open (`origin` null when
 *   context-less); `openedBy` is the origin of its first statement.
 * - `transactionMs` is since its first statement was sent, `idleMs` since its
 *   last reply: both by this process's awake clock, so a sleep shortens them
 *   against the server's wall-clock bound. `sql` and both are null when the
 *   transaction's statements passed through unbounded (a Submittable): not
 *   known, never a made-up zero.
 * - `serverMessage` is Postgres's own words.
 *
 * `at` is epoch ms (`Date.now()`).
 */
export interface IdleTransactionEndedEvent {
  at: number;
  pool: DbPoolName;
  origin: string | null;
  /** Null (with the two durations) when the client did not see the transaction's statements. */
  sql: string | null;
  openedBy: string | null;
  transactionMs: number | null;
  idleMs: number | null;
  serverMessage: string;
}

/**
 * Where a `DbClient` announces a session the server ended for idling in its
 * transaction. The connection plugin cannot file a report (`reports` depends
 * on `database`): `database/lock-watch` registers the handler. Held until it
 * does, like `queryDeadlineSink`.
 */
export const idleTransactionEndedSink =
  defineReportSink<IdleTransactionEndedEvent>();

/** The one spelling of the event's log line: `db.jsonl` in a backend, stderr in a CLI process. */
export function formatIdleTransactionEndedLogLine(
  event: IdleTransactionEndedEvent,
): string {
  const idle =
    event.idleMs !== null ? `${Math.round(event.idleMs / 1000)}s` : "?";
  const open =
    event.transactionMs !== null
      ? `${Math.round(event.transactionMs / 1000)}s`
      : "?";
  return (
    `[idle-tx] pool=${event.pool} session ended by the server after ` +
    `${idle} idle in its transaction (open ${open}) ` +
    `origin=${event.origin ?? "-"} sql=${(event.sql ?? "?").slice(0, 160)}`
  );
}

/**
 * What a call on a connection whose session the server ended for idling in its
 * transaction gets — the stalled transaction's own next statement, typically:
 * its work was rolled back. Carries no `code`, so the app pool's deadlock retry
 * never re-runs the statement on another connection as if nothing happened.
 */
export class IdleTransactionEndedError extends Error {
  override readonly name = "IdleTransactionEndedError";
  readonly pool: DbPoolName;
  readonly origin: string | null;

  constructor(event: IdleTransactionEndedEvent) {
    const idle =
      event.idleMs !== null ? ` for ${Math.round(event.idleMs / 1000)}s` : "";
    super(
      `The database ended this connection's session (pool ${event.pool}): its ` +
        `transaction sat idle${idle} after ` +
        `${event.origin ? `${event.origin}'s` : "its last"} statement, past the ` +
        "cluster's idle_in_transaction_session_timeout, and was rolled back. " +
        "Whatever the code awaited between two statements of a transaction took " +
        `too long. Last statement: ${(event.sql ?? "?").slice(0, 200)}`,
    );
    this.pool = event.pool;
    this.origin = event.origin;
  }
}
