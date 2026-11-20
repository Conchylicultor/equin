import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  defineHostService,
  type SchemaOwner,
} from "@plugins/framework/plugins/server-core/core";
import {
  isConnectionCapacityRefusal,
  type DbPoolName,
} from "@plugins/database/plugins/connection/core";

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
   * cluster here.
   *
   * `serving`: this host will serve (not a short-lived `exec` child), so
   * the desktop also checks its background lane logs in (and, in the host
   * singleton, converges the lane's role and PgBouncer config). Required, so
   * every caller decides.
   */
  ready(opts: { readonly serving: boolean }): Promise<void>;
  /**
   * Pre-open the pool to its full size, so a SERVING host's first wave of
   * requests and loaders finds live connections. Called by the boot barrier
   * after `ready`, alongside the schema layer (which needs one connection,
   * not a full pool) — never by an `exec` child: it serves nobody, and a pool
   * warmed per child is what exhausted pgbouncer's `max_client_conn` when ten
   * launches booted twenty children at once (2026-10-28: 16 connections each,
   * 318 refusals, three tasks' launches lost).
   */
  warmPool(): Promise<void>;
  /**
   * Run boot DDL (the schema layer, the change feed's trigger rebuild): on the
   * desktop under the widened boot query deadline, since it can wait minutes on
   * the previous backend's locks during a hot-swap. `reason` names the scope on
   * a deadline report (default "boot DDL").
   *
   * `owner`: only the schema's owner runs boot DDL — the token a serving
   * host's boot hooks are handed (`BootHookContext.schema`). An `exec` child
   * has none to pass (server-core's `core/schema-role.ts`).
   */
  bootDdl<T>(
    owner: SchemaOwner,
    fn: () => Promise<T>,
    reason?: string,
  ): Promise<T>;
  /**
   * Open a LISTEN session on `channels` — the one part of the change feed
   * (`network/live/change-feed`) that differs per host. Resolves once LISTEN on
   * every channel has taken effect, as ONE statement, so no transaction is
   * heard on one channel and not another. Each NOTIFY on them reaches
   * `handlers.notification` in delivery order (a host's notifications share
   * one queue, so the order holds across channels).
   *
   * `handlers.lost` is told, at most once and only after the session was
   * established, that it can deliver nothing more (its connection errored or
   * ended); the caller reconnects. A host whose session cannot be lost (one
   * in-process connection) never calls it. `close()` ends the session; nothing
   * reaches either handler after it.
   *
   * The desktop opens a dedicated connection on the direct socket
   * (`database/connection`'s `openListenSession`), named `name` — what a
   * connection count or a deadline report attributes it to; PGlite listens on
   * its one in-process connection.
   */
  listen(
    name: ListenSessionName,
    channels: readonly string[],
    handlers: ListenHandlers,
  ): Promise<ListenSession>;
  /**
   * Hold this process's schema generation (its latest migration's,
   * `schemaGeneration`) for the rest of its life — how a later deploy's
   * deferred contract sees that this code is still connected. Called once,
   * in the boot barrier, before the schema layer.
   *
   * The desktop holds a shared advisory lock on a dedicated direct
   * connection; PGlite, one process with nothing else connected, holds
   * nothing.
   */
  holdSchemaGeneration(generation: number): Promise<void>;
  /**
   * Resolves once no other connected process holds a generation outside
   * `knowing` (the generations whose code knows the group a deferred
   * contract belongs to, `generationsKnowing`) — a wait, never a poll. The
   * returned release lets older code connect again; call it once the
   * contract committed or failed.
   */
  awaitGenerationsGone(
    knowing: readonly number[],
  ): Promise<() => Promise<void>>;
  /**
   * Resolves once every process that booted on this database before this
   * one (held its schema generation earlier) is gone — whatever its code. A
   * wait, never a poll. For a removal any earlier-booted code may still rely
   * on, migration or not: the previous backend of a hot swap — or one that
   * keeps serving because the deploy was abandoned after this process booted.
   *
   * The desktop waits on each older process's presence lock (held with its
   * generation); PGlite, one process, resolves at once.
   */
  awaitOlderProcessesGone(): Promise<void>;
  /**
   * Resolves once nothing that could boot a new owner of this database is in
   * flight — at once when nothing is — with what it waited on, in words (empty
   * when it did not wait). A wait, never a poll. What an `exec` child whose
   * database is not set up for its code waits out (`awaitSchemaLayer`): once it
   * resolves, no owner is on its way, so a schema still not set up for the
   * child's code never will be.
   *
   * The desktop waits on its deploy lock (main's convergence run, from
   * before it decides until after its last build), the checkout's build lock
   * (every `./equin build`) and — the direct signal — the namespace's
   * schema-owner boot marker, held by a serving backend from its entry point
   * until its `onReady` recorded the stamp, however the build that restarted
   * it exited. On main's checkout it also does not settle while its HEAD is
   * one main's build has not attempted yet (a push landed, its deploy not
   * started). A main SLOT is the opposite case: its HEAD never moves, so a
   * slot whose commit is not the one main's last build was for is a slot main
   * moved past — no deploy will ever boot an owner of its code, and it answers
   * `superseded` at once instead of waiting on main's next deploys
   * (report-1794960565-yv4ch2: a spare refill spawned by the draining backend
   * held its old slot the whole 10 min bound). PGlite's process is its own
   * owner: nothing to wait for.
   */
  awaitDeploysSettled(signal: AbortSignal): Promise<DeploysSettled>;
  /**
   * This serving process's boot toward its schema stamp is over — `onReady`
   * recorded it, or the write failed: says so where a refused `exec` child
   * reads it (`lastOwnerBoot`), then lets go of what told children the stamp
   * was still coming. Called once, by database's `onReady`. The desktop
   * writes the namespace's boot record and releases the boot marker the
   * serving entry point claimed (a process that claimed none — a test's host
   * — does nothing); PGlite has no other process to tell.
   */
  settleOwnerBoot(outcome: OwnerBootOutcome): Promise<void>;
  /**
   * What the last serving backend to boot on this database said of its
   * schema stamp, or null when none ever said anything — what a refused
   * `exec` child names as the reason. Read only once `awaitDeploysSettled`
   * resolved. PGlite: always null (it is its own owner).
   */
  lastOwnerBoot(): Promise<OwnerBootRecord | null>;
}

/**
 * What `awaitDeploysSettled` found: every build, deploy and owner boot in
 * flight ended (`waitedOn`: what it waited for, in words — empty when it did
 * not wait), or none ever will set up this process's code, because main has
 * moved past the slot it runs from (`detail`, in words).
 */
export type DeploysSettled =
  | { kind: "settled"; waitedOn: readonly string[] }
  | { kind: "superseded"; detail: string };

/** How a serving backend's boot toward its schema stamp ended (`settleOwnerBoot`). */
export type OwnerBootOutcome =
  | { kind: "recorded" }
  /** The stamp write failed (`error`); the failure is filed as database's `onReady` server error. */
  | { kind: "stamp-failed"; error: string };

/**
 * The last serving backend's word on its stamp (`lastOwnerBoot`): `booting`
 * from the moment it claimed the boot marker until `onReady` settled it — so
 * `booting` read with the marker free is a backend that exited before it got
 * there.
 */
export type OwnerBootRecord = { pid: number; startedAt: number } & (
  { kind: "booting" } | OwnerBootOutcome
);

/**
 * What a LISTEN session's connection is named (`DatabaseDriverImpl.listen`):
 * one name per kind of session, from the closed pool-name set.
 */
export type ListenSessionName = Extract<
  DbPoolName,
  | "change-feed"
  | "schema-wait"
  | "replica-notify"
  | "mirror-log-notify"
  | "box-link-targets"
>;

/** What a LISTEN session (`DatabaseDriverImpl.listen`) reports to its opener. */
export interface ListenHandlers {
  notification(channel: string, payload: string): void;
  lost(err: unknown): void;
}

/** An open LISTEN session. */
export interface ListenSession {
  close(): Promise<void>;
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

/**
 * A failure that says the database is not answering YET, rather than that
 * something is wrong: a starting cluster (57P03), a socket not there yet, and
 * a connect refused because the server side is full
 * (`isConnectionCapacityRefusal` — pgbouncer's `max_client_conn`, Postgres's
 * 53300), which clears as holders let go. `awaitDbReady` waits these out.
 */
export function isTransientDbError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (isConnectionCapacityRefusal(err)) return true;
  const e = err as { code?: string; errno?: string };
  const code = e.code ?? e.errno;
  return code === "57P03" || code === "ENOENT" || code === "ECONNREFUSED";
}
