import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { defineHostService } from "@plugins/framework/plugins/server-core/core";

/**
 * The drizzle database every query in the app is written against.
 *
 * Still spelled as node-postgres's database type: it is the API the codebase
 * was written to, and a type-only import that erases. The PGlite driver hands
 * its own drizzle instance through this type (`database/plugins/pglite`), which
 * is sound for the query builder both share; what differs between the two
 * result shapes (`rowCount` vs `affectedRows`) is the type widening still to do
 * (research/2026-10-18-global-portable-server-machine-split.md §2).
 */
export type Db = NodePgDatabase<Record<string, never>>;

/**
 * How this host reaches its database — the one capability the portable
 * database layer needs from the host it runs on. The desktop's provider is
 * `database#machine` (the per-worktree `pg.Pool` behind the lane gates and the
 * query deadline); a host without the computer provides PGlite
 * (`database/plugins/pglite`).
 */
export interface DatabaseDriverImpl {
  /**
   * The drizzle instance. A function so a driver may build it on first use:
   * the desktop's pool asks for this process's runtime namespace, which must
   * not happen at module import.
   */
  db(): Db;
  /**
   * Resolves once the database answers queries — the boot barrier's first
   * step, before the schema layer runs. The desktop waits out a starting
   * cluster and pre-opens its pool here.
   */
  ready(): Promise<void>;
  /**
   * Run boot DDL (the schema layer): on the desktop under the widened boot
   * query deadline, since it can wait minutes on the previous backend's locks
   * during a hot-swap.
   */
  bootDdl<T>(fn: () => Promise<T>): Promise<T>;
}

export const DatabaseDriver =
  defineHostService<DatabaseDriverImpl>("database.driver");

// The real drizzle instance's methods, bound once per instance. Keyed by the
// instance rather than by property alone: one process can boot more than one
// graph (a test booting a PGlite graph after the preload's desktop driver), and
// a method bound to the previous host's database must never answer for this one.
const boundMethods = new WeakMap<object, Map<PropertyKey, unknown>>();

// Every OPEN top-level transaction's after-commit queue, keyed by the `tx`
// handle the transaction's callback receives. See `afterCommit`.
const afterCommitQueues = new WeakMap<object, (() => void)[]>();

/**
 * `db.transaction`, tracking each transaction it opens so `afterCommit` can
 * attach work to its commit. The callback, the config and the result pass
 * through untouched; a rollback (the callback throws) drops the queue.
 */
function trackedTransaction(transaction: Db["transaction"]): Db["transaction"] {
  return async function <T>(
    callback: (tx: DbTx) => Promise<T>,
    config?: Parameters<Db["transaction"]>[1],
  ): Promise<T> {
    let queue: (() => void)[] = [];
    const result = await transaction(async (tx) => {
      queue = [];
      afterCommitQueues.set(tx, queue);
      try {
        return await callback(tx);
      } finally {
        afterCommitQueues.delete(tx);
      }
    }, config);
    for (const fn of queue) queueMicrotask(fn);
    return result;
  };
}

/**
 * The app's database — a forwarding Proxy over the booted host's driver
 * (`DatabaseDriver`), so importing it builds nothing and reads no host
 * service: the driver is asked on the first `db.<method>()`, which only ever
 * runs inside the booted graph. Non-function properties (the RQB `db.query`
 * namespace, `db.$client`) forward straight through.
 */
export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    const real = DatabaseDriver.get().db() as unknown as Record<
      PropertyKey,
      unknown
    >;
    const value = real[prop];
    if (typeof value !== "function") return value;
    let methods = boundMethods.get(real);
    if (methods === undefined) {
      methods = new Map();
      boundMethods.set(real, methods);
    }
    let bound = methods.get(prop);
    if (bound === undefined) {
      const fn = (value as (...args: unknown[]) => unknown).bind(real);
      bound =
        prop === "transaction"
          ? trackedTransaction(fn as unknown as Db["transaction"])
          : fn;
      methods.set(prop, bound);
    }
    return bound;
  },
});

/**
 * Run `fn` once the transaction `exec` belongs to has COMMITTED — or now, when
 * `exec` is `db` itself (an autocommit write is committed when it returns). A
 * rolled-back transaction never runs it. For work that must not observe a
 * write before it is durable and visible — an in-process job queue running a
 * job its caller enqueued inside a transaction.
 *
 * Only a top-level `db.transaction(…)`'s handle is tracked: a nested
 * (savepoint) handle, or a transaction opened on another drizzle instance,
 * throws rather than guessing when its outer transaction commits.
 */
export function afterCommit(exec: Db | DbTx, fn: () => void): void {
  if (exec === db) {
    queueMicrotask(fn);
    return;
  }
  const queue = afterCommitQueues.get(exec);
  if (queue === undefined) {
    throw new Error(
      "[database] afterCommit: not an open top-level transaction of `db` — a nested (savepoint) transaction or another drizzle instance's has no commit to wait for.",
    );
  }
  queue.push(fn);
}

/** The handle a `db.transaction(…)` callback receives. */
export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function isTransientDbError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; errno?: string };
  const code = e.code ?? e.errno;
  return code === "57P03" || code === "ENOENT" || code === "ECONNREFUSED";
}
