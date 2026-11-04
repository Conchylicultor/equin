import { z } from "zod";
import { parseSqlOrigin } from "@plugins/database/plugins/connection/core";
import { cutLockWatchSql, type SessionRow } from "./observation";

// A session the cluster's idle_in_transaction_session_timeout ended — the bound
// around app code that stalls between two statements of a transaction
// (`database/embedded`'s cluster settings). Ending it is the bound acting; the
// stall is the defect, so every end is reported, naming the code.
//
// Two observers, because each misses what the other sees:
//
// - the session's own CLIENT (`database/connection`'s DbClient): the server's
//   25P03 reaches it the instant the session ends, with the origin and
//   statement of the transaction's last statement as the client sent them.
//   Exact, but only for a connection built by `createDbPool` /
//   `createDbClient` in a process whose event loop still runs.
// - the LOCK WATCH: any session on its database, app or not (a psql shell, a
//   tool's raw client). It saw the session idle in its transaction on one look,
//   gone on the next, and `pg_stat_database.sessions_fatal` went up in between
//   — an inference, a minute coarse, and blind while the watch is not running.
//
// One reap is reported once: the watch leaves a session whose
// `application_name` says an app client owns it (`isDbApplicationName`) to that
// client, and names it in `db.jsonl` only.

/** The report kind string, spelled once. */
export const DB_IDLE_TRANSACTION_ENDED_KIND = "db-idle-transaction-ended";

/** Who saw the session end. */
const IDLE_ENDED_OBSERVERS = ["client", "lock-watch"] as const;

export const DbIdleTransactionEndedPayloadSchema = z.object({
  observedBy: z.enum(IDLE_ENDED_OBSERVERS),
  /** The origin of the transaction's last statement; null when untagged (context-less, or not this app's). */
  origin: z.string().nullable(),
  /** The transaction's last statement, without the origin comment, cut by `cutLockWatchSql`; null when the client did not see it. */
  sql: z.string().nullable(),
  /** The origin of its first statement — the client knows it; the watch does not. */
  openedBy: z.string().nullable(),
  /** The connection's pool name (client) — null when the watch saw it. */
  pool: z.string().nullable(),
  /** `application_name` as the watch read it; null when the client saw it. */
  applicationName: z.string().nullable(),
  /** The server pid (watch); null when the client saw it (through PgBouncer it cannot know it). */
  pid: z.number().int().nullable(),
  /** How long its transaction had been open when it ended (watch: at least, as of its last look). */
  transactionMs: z.number().nullable(),
  /** How long it had sat idle in it (watch: at its last look). */
  idleMs: z.number().nullable(),
  /** The bound in force, when known: the watch reads it; the client is not told. */
  boundMs: z.number().nullable(),
});
export type DbIdleTransactionEndedPayload = z.infer<
  typeof DbIdleTransactionEndedPayloadSchema
>;

/** A session the watch saw idle inside a transaction, kept until its next look. */
export interface IdleSessionSeen {
  pid: number;
  /** Epoch ms the session's backend started: with the pid, its identity. */
  backendStartMs: number;
  query: string;
  applicationName: string;
  xactMs: number | null;
  idleMs: number;
  observedAt: number;
}

/** Every session idle inside a transaction on one look, as the next look compares it. */
export function idleSessionsSeen(
  rows: readonly SessionRow[],
  observedAt: number,
): IdleSessionSeen[] {
  return rows.flatMap((r) =>
    r.state !== null &&
    r.state.startsWith("idle in transaction") &&
    r.stateMs !== null &&
    r.backendStartMs !== null
      ? [
          {
            pid: r.pid,
            backendStartMs: r.backendStartMs,
            query: r.query,
            applicationName: r.applicationName,
            xactMs: r.xactMs,
            idleMs: r.stateMs,
            observedAt,
          },
        ]
      : [],
  );
}

/**
 * Which of the sessions the previous look saw idle in a transaction the
 * timeout ended by this look: gone (no session with the same pid and backend
 * start), idle long enough by now to have reached `boundMs`, and no more of
 * them than `fatalEnds` — how many sessions on the database ended on a FATAL
 * since the previous look (`pg_stat_database.sessions_fatal`; a reap counts
 * there, a client closing its connection or `pg_terminate_backend` does not).
 * Longest idle first: when fewer FATAL ends than candidates, the likeliest.
 *
 * Pure: both reads are the caller's.
 */
export function idleSessionsEnded(input: {
  previous: readonly IdleSessionSeen[];
  current: readonly SessionRow[];
  now: number;
  fatalEnds: number;
  boundMs: number;
}): IdleSessionSeen[] {
  const { previous, current, now, fatalEnds, boundMs } = input;
  if (fatalEnds <= 0 || boundMs <= 0) return [];
  const alive = new Set(
    current.map((r) => `${r.pid}@${r.backendStartMs ?? "?"}`),
  );
  return previous
    .filter(
      (s) =>
        !alive.has(`${s.pid}@${s.backendStartMs}`) &&
        s.idleMs + (now - s.observedAt) >= boundMs,
    )
    .sort((a, b) => b.idleMs - a.idleMs)
    .slice(0, fatalEnds);
}

/** The report payload for a session the watch saw ended. */
export function idleEndedPayloadFromWatch(
  s: IdleSessionSeen,
  boundMs: number,
): DbIdleTransactionEndedPayload {
  const { origin, sql } = parseSqlOrigin(s.query);
  return {
    observedBy: "lock-watch",
    origin,
    sql: cutLockWatchSql(sql),
    openedBy: null,
    pool: null,
    applicationName: s.applicationName,
    pid: s.pid,
    transactionMs: s.xactMs,
    idleMs: s.idleMs,
    boundMs,
  };
}
