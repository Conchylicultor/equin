import { z } from "zod";
import { parseSqlOrigin } from "@plugins/database/plugins/connection/core";

/**
 * How long a session may hold others back, or sit idle inside a transaction,
 * before the lock watch names it. Equal to the query deadline's default bound
 * (60 s): a waiter that has waited this long has already been failed by its
 * own deadline, so past it the chain is costing callers, not just time.
 */
export const LOCK_WATCH_THRESHOLD_MS = 60_000;

/** The most holders one observation carries — the schema refuses more. */
export const LOCK_WATCH_HOLDERS_MAX = 20;

/** The longest stretch of a holder's statement an observation carries. */
export const LOCK_WATCH_SQL_MAX = 500;

/** A statement cut to {@link LOCK_WATCH_SQL_MAX}, as every payload carries one. */
export function cutLockWatchSql(sql: string): string {
  return sql.length > LOCK_WATCH_SQL_MAX
    ? sql.slice(0, LOCK_WATCH_SQL_MAX)
    : sql;
}

/** One `pg_stat_activity` row, as the watch reads it (its own database's client backends). */
export interface SessionRow {
  pid: number;
  /** `active`, `idle`, `idle in transaction`, `idle in transaction (aborted)`, … */
  state: string | null;
  applicationName: string;
  /** The session's current statement, or its last one when idle. */
  query: string;
  /** Since its transaction began; null outside a transaction. */
  xactMs: number | null;
  /** Since its state last changed: how long it has been waiting, or idle. */
  stateMs: number | null;
  /** `pg_blocking_pids(pid)`: the sessions this one waits on, directly. */
  blockedBy: readonly number[];
  /** Epoch ms its backend started — with the pid, the session's identity across looks. */
  backendStartMs: number | null;
}

/** A session holding its transaction where the watch names it. */
export const LockHolderSchema = z.object({
  pid: z.number().int(),
  /** The origin its statement names (`/* origin=… *\/`); null for an untagged one (another pool, a psql session). */
  origin: z.string().nullable(),
  /** Its current (or last) statement, without the origin comment, cut to {@link LOCK_WATCH_SQL_MAX}. */
  sql: z.string(),
  state: z.string().nullable(),
  applicationName: z.string(),
  /** How long its transaction has been open. */
  xactMs: z.number().nullable(),
  /** How long it has sat idle inside its transaction; null when it is not idle in one. */
  idleMs: z.number().nullable(),
  /** Every session waiting on it, directly or down a chain. */
  waiting: z.number().int(),
  /** The longest any of them has waited; 0 when none does. */
  longestWaitMs: z.number(),
});
export type LockHolder = z.infer<typeof LockHolderSchema>;

export const LockWatchObservationSchema = z.object({
  /** Epoch ms of the read. */
  observedAt: z.number(),
  /** The bound in force, carried so a reader never restates it. */
  thresholdMs: z.number(),
  /** Most waiters first; at most {@link LOCK_WATCH_HOLDERS_MAX}. */
  holders: z.array(LockHolderSchema).max(LOCK_WATCH_HOLDERS_MAX),
});
export type LockWatchObservation = z.infer<typeof LockWatchObservationSchema>;

function isIdleInTransaction(state: string | null): boolean {
  return state !== null && state.startsWith("idle in transaction");
}

/**
 * The sessions the watch names, from one read of `pg_stat_activity`: the HEAD
 * of every lock chain whose waiters have waited past `thresholdMs` (a holder
 * that is not itself waiting — the one whose commit or rollback would free the
 * chain), and every session idle inside a transaction past `thresholdMs`.
 *
 * A waiter that also blocks others is not a head: naming it would send whoever
 * reads the report to a session that is a victim too. Waiters are counted
 * transitively, so the head of the 2026-11-03 chain reads "holds 15".
 *
 * Pure: the read is the caller's.
 */
export function lockHolders(
  rows: readonly SessionRow[],
  thresholdMs: number,
): LockHolder[] {
  const byPid = new Map<number, SessionRow>();
  for (const r of rows) byPid.set(r.pid, r);

  // Direct waiters per blocker.
  const waitersOf = new Map<number, number[]>();
  for (const r of rows) {
    for (const b of r.blockedBy) {
      const list = waitersOf.get(b);
      if (list) list.push(r.pid);
      else waitersOf.set(b, [r.pid]);
    }
  }

  const holders: LockHolder[] = [];
  const seen = new Set<number>();
  const consider = (pid: number): void => {
    if (seen.has(pid)) return;
    seen.add(pid);
    const row = byPid.get(pid);
    // A blocker outside this database's client backends (an autovacuum, a
    // session on another database holding a shared lock) is not in the read:
    // it cannot be described, and its waiters still show as waiting.
    if (!row) return;

    let waiting = 0;
    let longestWaitMs = 0;
    const stack = [...(waitersOf.get(pid) ?? [])];
    const counted = new Set<number>([pid]);
    while (stack.length > 0) {
      const w = stack.pop()!;
      if (counted.has(w)) continue;
      counted.add(w);
      waiting++;
      longestWaitMs = Math.max(longestWaitMs, byPid.get(w)?.stateMs ?? 0);
      stack.push(...(waitersOf.get(w) ?? []));
    }

    const idleMs = isIdleInTransaction(row.state) ? row.stateMs : null;
    const blocking = row.blockedBy.length === 0 && waiting > 0;
    const blockingLong = blocking && longestWaitMs >= thresholdMs;
    const idleLong = idleMs !== null && idleMs >= thresholdMs;
    if (!blockingLong && !idleLong) return;

    const { origin, sql } = parseSqlOrigin(row.query);
    holders.push({
      pid,
      origin,
      sql: cutLockWatchSql(sql),
      state: row.state,
      applicationName: row.applicationName,
      xactMs: row.xactMs,
      idleMs,
      waiting: blocking ? waiting : 0,
      longestWaitMs: blocking ? longestWaitMs : 0,
    });
  };
  for (const pid of waitersOf.keys()) consider(pid);
  for (const r of rows) if (isIdleInTransaction(r.state)) consider(r.pid);

  holders.sort(
    (a, b) => b.waiting - a.waiting || (b.idleMs ?? 0) - (a.idleMs ?? 0),
  );
  return holders.slice(0, LOCK_WATCH_HOLDERS_MAX);
}
