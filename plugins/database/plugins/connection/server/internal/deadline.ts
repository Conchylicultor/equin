import { AsyncLocalStorage } from "node:async_hooks";
import { defineReportSink } from "@plugins/primitives/plugins/report-sink/core";
import type { DbCallPhase, DbPoolName } from "../../core";

// A client-side deadline on every database call — opening a connection and
// every statement on one — on every backend connection, and what the outside
// world is told when one is missed. See
// research/2026-09-16-global-db-call-deadline-every-connection.md, and before it
// research/2026-09-11-global-query-deadline-and-stall-health.md (Part 1) and the
// incident it answers, research/2026-09-11-global-live-updates-frozen-by-stray-fd-close.md:
// a pooled socket was closed underneath a running query, `pg` got no event, and
// with no deadline anywhere the query — and the live-state flush awaiting it —
// waited forever.

/**
 * How long a call (connect or query) may wait for its reply before its caller
 * gets a `QueryDeadlineExceededError`. For `connect` it equals Postgres's own
 * `authentication_timeout` — the value `migrations/check` settled on.
 */
export const QUERY_DEADLINE_MS = 60_000;

/**
 * The bound boot DDL opts into via `withQueryDeadline` — migrations and the
 * derived-table / derived-view / change-feed-trigger rebuilds can legitimately
 * wait minutes on the previous backend's locks during a hot-swap.
 */
export const BOOT_DDL_QUERY_DEADLINE_MS = 15 * 60_000;

/**
 * The server-side twin of the deadline: how long Postgres lets a session sit
 * idle inside an open transaction before it terminates it (rolling back and
 * releasing its locks). An abandoned connection (./abandon.ts) is never closed
 * and never sent a ROLLBACK, so a transaction it was in stays open with its
 * row locks for as long as the process lives — on 2026-11-03 one such
 * transaction blocked every usage-sync writer, then the whole app pool, for
 * five hours. Every database a backend serves carries this as its
 * `idle_in_transaction_session_timeout` (set at boot by the desktop driver),
 * so an abandoned transaction lets go within this bound. Generous: no live
 * code sits idle in a transaction for minutes (long holders use session-level
 * advisory locks, which this does not touch).
 *
 * Interim: a bound around the abandon rule's flaw, removed once a lost
 * connection is closed instead of abandoned
 * (research/2026-11-04-global-db-connection-failure-vision.md, task 2).
 */
export const IDLE_IN_TRANSACTION_TIMEOUT_MS = 5 * 60_000;

/** The label a `connect` call carries where a query carries its SQL. */
export const CONNECT_CALL_LABEL = "[connect]";

/**
 * What the deadline tells the outside world, through `queryDeadlineSink`.
 *
 * - `deadline` — one call missed its deadline and its connection was abandoned.
 *   `pool` names the connection (`createDbPool` / `createDbClient` name);
 *   `phase` is `connect` (opening it) or `query` (a statement on it).
 *   `sql` is the query's label exactly as its `<sql>` profiler span records it,
 *   or `[connect]` for the connect phase; `origin` is the innermost
 *   runtime-profiler entry that issued the call (a resource, route or job
 *   label), `null` when context-less (boot, migrations); `reason` is the
 *   enclosing `withQueryDeadline` scope's reason, `null` under the default bound.
 * - `abandon-cap` — an abandon (on `pool`) landed after `cap` connections were
 *   already being held; this one is detached but no longer retained (see
 *   `abandonClient`). `abandoned` counts every abandon since boot.
 *
 * `at` is epoch ms (`Date.now()`).
 */
export type QueryDeadlineEvent =
  | {
      kind: "deadline";
      at: number;
      pool: DbPoolName;
      phase: DbCallPhase;
      sql: string;
      elapsedMs: number;
      deadlineMs: number;
      origin: string | null;
      reason: string | null;
    }
  | {
      kind: "abandon-cap";
      at: number;
      pool: DbPoolName;
      abandoned: number;
      cap: number;
    };

/**
 * The one spelling of a missed deadline's log line: `db.jsonl` in a backend
 * (written by the sink handler), stderr in a CLI process.
 */
export function formatDeadlineLogLine(
  event: Extract<QueryDeadlineEvent, { kind: "deadline" }>,
): string {
  return (
    `[deadline] pool=${event.pool} phase=${event.phase} no reply in ${event.elapsedMs}ms ` +
    `(bound ${event.deadlineMs}ms${event.reason ? `, ${event.reason}` : ""}) ` +
    `origin=${event.origin ?? "-"} sql=${event.sql.slice(0, 160)} — connection abandoned`
  );
}

// The database plugins cannot file a report themselves — `reports` depends on
// `database` — so the deadline emits here and a sub-plugin that may import both
// registers the handler (same shape as jobs → jobs/deadline-audit).
// Fire-and-forget, and emissions before the handler registers are held, not
// dropped.
export const queryDeadlineSink = defineReportSink<QueryDeadlineEvent>();

/**
 * A database call got no reply within its deadline. The caller's promise (or
 * callback) gets this; the connection it ran on has been abandoned (never
 * reused, never closed), and every later call on that connection gets this same
 * error at once.
 *
 * Deliberately carries no `code`: the app pool's 40P01/40001 retry keys on
 * `err.code`, and a lost query must never be re-run on another connection behind
 * the caller's back.
 */
export class QueryDeadlineExceededError extends Error {
  override readonly name = "QueryDeadlineExceededError";
  readonly pool: DbPoolName;
  readonly phase: DbCallPhase;
  readonly sql: string;
  readonly elapsedMs: number;
  readonly deadlineMs: number;
  readonly origin: string | null;
  readonly reason: string | null;

  constructor(fields: {
    pool: DbPoolName;
    phase: DbCallPhase;
    sql: string;
    elapsedMs: number;
    deadlineMs: number;
    origin: string | null;
    reason: string | null;
  }) {
    const what =
      fields.phase === "connect"
        ? "Opening a database connection"
        : "Database query";
    super(
      `${what} (pool ${fields.pool}) got no reply within ${fields.deadlineMs}ms ` +
        `(${fields.elapsedMs}ms elapsed${fields.origin ? `, issued by ${fields.origin}` : ""}` +
        `${fields.reason ? `, bound: ${fields.reason}` : ""}); ` +
        `its connection was abandoned.` +
        (fields.phase === "query" ? ` sql: ${fields.sql.slice(0, 200)}` : ""),
    );
    this.pool = fields.pool;
    this.phase = fields.phase;
    this.sql = fields.sql;
    this.elapsedMs = fields.elapsedMs;
    this.deadlineMs = fields.deadlineMs;
    this.origin = fields.origin;
    this.reason = fields.reason;
  }
}

interface QueryDeadlineScope {
  ms: number;
  reason: string;
}

// Local to this plugin and independent of the runtime-profiler's stores: the
// bound is a property of the work, not of how it is attributed.
const deadlineScope = new AsyncLocalStorage<QueryDeadlineScope>();

/**
 * Run `fn` with every database call it issues (awaited, at any depth, on any
 * connection built by this plugin) bounded by `ms` instead of the default
 * `QUERY_DEADLINE_MS`. `reason` names the scope on the error and the report. An
 * inner scope replaces an outer one.
 */
export function withQueryDeadline<T>(
  scope: { ms: number; reason: string },
  fn: () => Promise<T>,
): Promise<T> {
  if (!Number.isFinite(scope.ms) || scope.ms <= 0) {
    throw new RangeError(
      `withQueryDeadline: ms must be a positive finite number, got ${scope.ms}`,
    );
  }
  return deadlineScope.run({ ms: scope.ms, reason: scope.reason }, fn);
}

/** The bound in force at the call site. Read synchronously, before any await. */
export function currentQueryDeadline(defaultMs: number): {
  deadlineMs: number;
  reason: string | null;
} {
  const scope = deadlineScope.getStore();
  return scope
    ? { deadlineMs: scope.ms, reason: scope.reason }
    : { deadlineMs: defaultMs, reason: null };
}
