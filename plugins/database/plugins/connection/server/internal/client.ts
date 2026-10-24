import { AsyncLocalStorage } from "node:async_hooks";
import { Client, Pool, type ClientBase, type ClientConfig } from "pg";
import {
  currentEntryLabel,
  recordSpan,
} from "@plugins/infra/plugins/runtime-profiler/core";
import { hasRuntimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import type { DbCallPhase, DbPoolName } from "../../core";
import {
  CONNECT_CALL_LABEL,
  QUERY_DEADLINE_MS,
  QueryDeadlineExceededError,
  currentQueryDeadline,
  formatDeadlineLogLine,
  queryDeadlineSink,
  type QueryDeadlineEvent,
} from "./deadline";
import { abandonClient, assertPgPoolInternals } from "./abandon";

// ---------------------------------------------------------------------------
// The deadline lives on the CONNECTION: one `pg.Client` subclass bounds the two
// methods every database call ends in — `connect()` and `query()` — whoever
// calls them: the app pool's wrapper, drizzle, graphile-worker's `withPgClient`
// and its LISTEN connection, pg-pool's own `pool.query`, a standalone client.
// Every backend pool and client is built with it, through `createDbPool` /
// `createDbClient`.
//
// Why not pg's `connectionTimeoutMillis`: on expiry both pg (`Client#_connect`)
// and pg-pool (`newClient`) call `stream.destroy()` — they close the fd, which is
// exactly what the abandon rule (./abandon.ts) forbids.
// ---------------------------------------------------------------------------

// The runtime-profiler caps span labels at 500 chars (recorder MAX_LABEL_LEN):
// `sql` is cut to the same length, so it equals the label the `<sql>` span
// records, and the `[deadline]` span keeps its suffix instead of losing it to
// the recorder's cut.
const SQL_LABEL_MAX = 500;
const DEADLINE_SPAN_SUFFIX = "[deadline]";

/** A query's text, cut to the label its `<sql>` profiler span records. */
export function sqlLabel(text: string): string {
  return text.length > SQL_LABEL_MAX ? text.slice(0, SQL_LABEL_MAX) : text;
}

/** The SQL text of `client.query`'s first argument (a string or a config object). */
export function queryText(first: unknown): string {
  if (typeof first === "string") return first;
  if (first && typeof first === "object" && "text" in first) {
    const text = (first as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "?";
}

// pg's `client.query` forms the deadline cannot bound: a Submittable (pg-cursor /
// pg-query-stream — the object IS the result, read incrementally by its owner)
// and a config object carrying its own `callback` (pg delivers to it, and
// returns nothing to wrap). Both pass straight through. The positional callback
// form — `query(text, cb)` / `query(text, values, cb)`, which pg-pool's own
// `pool.query` uses — IS bounded: the call runs in promise form and the result
// is delivered to the callback.
function isPassThroughQuery(args: readonly unknown[]): boolean {
  const first = args[0];
  if (!first || typeof first !== "object") return false;
  return (
    typeof (first as { submit?: unknown }).submit === "function" ||
    typeof (first as { callback?: unknown }).callback === "function"
  );
}

/** What a call's deadline knows, captured synchronously at the call site. */
interface DeadlineCall {
  phase: DbCallPhase;
  sql: string;
  deadlineMs: number;
  reason: string | null;
  origin: string | null;
  startedAt: number;
}

type PgRelease = (err?: Error | boolean) => void;
type LostListener = (err: QueryDeadlineExceededError) => void;
// biome-ignore lint/suspicious/noExplicitAny: pg's overloaded methods, invoked with the caller's own arguments.
type AnyMethod = (...args: any[]) => any;

const pgQuery = Client.prototype.query as AnyMethod;
const pgConnect = Client.prototype.connect as AnyMethod;
const pgEnd = Client.prototype.end as AnyMethod;

/** How a `DbClient` is bound: its name, its pool (null when standalone), its default bound. */
export interface DbClientBinding {
  name: DbPoolName;
  /** The pool that owns the client — read when the client is abandoned. */
  pool: (() => Pool) | null;
  /** The default bound in place of `QUERY_DEADLINE_MS`. Tests only. */
  deadlineMs?: number;
}

/**
 * A `pg.Client` whose `connect()` and `query()` each carry a deadline.
 *
 * On expiry of either, the call fails with `QueryDeadlineExceededError` and the
 * client is LOST, for good:
 *   - it is abandoned (./abandon.ts): detached from its pool, held, never closed;
 *   - a `<sql>[deadline]` `db` span and a `[deadline]` line in `db.jsonl` are
 *     recorded, and the event is emitted on `queryDeadlineSink`;
 *   - every other call already in flight on it, and every later call, fails at
 *     once with the same error (pg queues statements per connection, so they
 *     would only wait out another bound behind the lost one);
 *   - `release()` (with or without an error) and `end()` do nothing: both would
 *     close the fd;
 *   - `onClientLost` subscribers are told.
 *
 * A late real reply is dropped: its call was already settled.
 */
export class DbClient extends Client {
  readonly poolName: DbPoolName;
  readonly #pool: (() => Pool) | null;
  readonly #defaultDeadlineMs: number;
  #lost: QueryDeadlineExceededError | null = null;
  readonly #lostListeners = new Set<LostListener>();
  readonly #inFlight = new Set<LostListener>();
  #poolRelease: PgRelease | undefined;

  constructor(
    config: string | ClientConfig | undefined,
    binding: DbClientBinding,
  ) {
    super(config);
    this.poolName = binding.name;
    this.#pool = binding.pool;
    this.#defaultDeadlineMs = binding.deadlineMs ?? QUERY_DEADLINE_MS;
  }

  /** The error that lost this client, or null while it is healthy. */
  get lostError(): QueryDeadlineExceededError | null {
    return this.#lost;
  }

  // pg-pool assigns `client.release` on every checkout (`_acquireClient`), for
  // every checkout path — `pool.connect()` in both forms, its own `pool.query`,
  // graphile-worker's LISTEN connection. An accessor sees each assignment, so a
  // lost client's release is a no-op by construction rather than per call site.
  // That matters for `release(err)` / `release(true)`, which pg-pool turns into
  // `client.end()` — a close of an fd that may no longer be this client's.
  //
  // The getter captures the function assigned at read time: a holder that reads
  // `client.release`, then assigns its own wrapper calling what it read, gets
  // that wrapper back on the next read without recursing into itself.
  get release(): PgRelease | undefined {
    const assigned = this.#poolRelease;
    if (!assigned) return undefined;
    return (err?: Error | boolean) => {
      if (this.#lost) return;
      assigned(err);
    };
  }

  set release(fn: PgRelease | undefined) {
    this.#poolRelease = fn;
  }

  /** @internal — use `onClientLost`. */
  subscribeLost(listener: LostListener): () => void {
    const lost = this.#lost;
    if (lost) {
      listener(lost);
      return () => {};
    }
    this.#lostListeners.add(listener);
    return () => {
      this.#lostListeners.delete(listener);
    };
  }

  // biome-ignore lint/suspicious/noExplicitAny: pg's overloaded query signature.
  override query(...args: any[]): any {
    if (isPassThroughQuery(args)) return pgQuery.apply(this, args);
    const callback: AnyMethod | null =
      typeof args[args.length - 1] === "function" ? args.pop() : null;
    const call = this.#capture("query", sqlLabel(queryText(args[0])));
    const result = this.#bounded(call, () => pgQuery.apply(this, args));
    if (!callback) return result;
    result.then(
      (res) => callback(null, res),
      (err: unknown) => callback(err),
    );
    return undefined;
  }

  // biome-ignore lint/suspicious/noExplicitAny: pg's overloaded connect signature.
  override connect(callback?: AnyMethod): any {
    if (!callback) {
      return new Promise<this>((resolve, reject) => {
        this.connect((err: Error | null) =>
          err ? reject(err) : resolve(this),
        );
      });
    }
    const lost = this.#lost;
    if (lost) {
      process.nextTick(() => callback(lost));
      return undefined;
    }
    const call = this.#capture("connect", CONNECT_CALL_LABEL);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = this.#lose(call, (err) => {
        // Hand the error over BEFORE abandoning. Inside a pool the callback is
        // pg-pool's `newClient` handler: it drops the client from `_clients`,
        // pulses the queue and fails the waiting checkout — without ending the
        // client. But it attaches the pool's idle `error` listener first (whose
        // firing `end()`s the client), so whatever `error` listener the callback
        // attached is taken off again.
        const before = new Set(this.listeners("error"));
        try {
          callback(err);
        } finally {
          for (const listener of this.listeners("error")) {
            if (!before.has(listener)) {
              this.removeListener("error", listener as (e: Error) => void);
            }
          }
        }
      });
      this.#report(call, err);
    }, call.deadlineMs);
    try {
      pgConnect.call(this, (...result: unknown[]) => {
        if (settled) return; // late completion of a connect already failed
        settled = true;
        clearTimeout(timer);
        callback(...result);
      });
    } catch (err) {
      settled = true;
      clearTimeout(timer);
      throw err;
    }
    return undefined;
  }

  // biome-ignore lint/suspicious/noExplicitAny: pg's overloaded end signature.
  override end(callback?: AnyMethod): any {
    if (this.#lost) {
      // Abandoned: never closed (./abandon.ts). pg-pool's `_remove` and a
      // standalone owner's cleanup both land here.
      if (callback) {
        process.nextTick(() => callback());
        return undefined;
      }
      return Promise.resolve();
    }
    return callback ? pgEnd.call(this, callback) : pgEnd.call(this);
  }

  #capture(phase: DbCallPhase, sql: string): DeadlineCall {
    return {
      phase,
      sql,
      ...currentQueryDeadline(this.#defaultDeadlineMs),
      origin: currentEntryLabel() ?? null,
      startedAt: performance.now(),
    };
  }

  #bounded<T>(call: DeadlineCall, work: () => Promise<T>): Promise<T> {
    const lost = this.#lost;
    if (lost) return Promise.reject(lost);
    // Started synchronously, so pg's own synchronous throws (a null config)
    // still reach the caller as throws.
    const pending = work();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const fail: LostListener = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#inFlight.delete(fail);
        reject(err);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.#inFlight.delete(fail);
        const err = this.#lose(call);
        reject(err);
        this.#report(call, err);
      }, call.deadlineMs);
      this.#inFlight.add(fail);
      // A late outcome (after the deadline, or after another call lost the
      // client) is dropped here — handled, never an unhandled rejection.
      pending.then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#inFlight.delete(fail);
        resolve(value);
      }, fail);
    });
  }

  // Expiry, part 1: the connection is lost. Everything that must hold before
  // the caller hears about it — nothing can hand it out, release it or end it;
  // it is out of its pool; lease owners and queued calls are told.
  #lose(
    call: DeadlineCall,
    handOff?: (err: QueryDeadlineExceededError) => void,
  ): QueryDeadlineExceededError {
    const err = new QueryDeadlineExceededError({
      pool: this.poolName,
      phase: call.phase,
      sql: call.sql,
      elapsedMs: Math.round(performance.now() - call.startedAt),
      deadlineMs: call.deadlineMs,
      origin: call.origin,
      reason: call.reason,
    });
    this.#lost = err;
    try {
      handOff?.(err);
    } finally {
      abandonClient(this.#pool?.() ?? null, this, this.poolName);
      const listeners = [...this.#lostListeners];
      this.#lostListeners.clear();
      for (const listener of listeners) listener(err);
      const inFlight = [...this.#inFlight];
      for (const fail of inFlight) fail(err);
    }
    return err;
  }

  // Expiry, part 2, after the caller has its error: tell the outside world.
  #report(call: DeadlineCall, err: QueryDeadlineExceededError): void {
    recordSpan(
      "db",
      `${call.sql.slice(0, SQL_LABEL_MAX - DEADLINE_SPAN_SUFFIX.length)}${DEADLINE_SPAN_SUFFIX}`,
      err.elapsedMs,
    );
    const event: QueryDeadlineEvent = {
      kind: "deadline",
      at: Date.now(),
      pool: this.poolName,
      phase: call.phase,
      sql: call.sql,
      elapsedMs: err.elapsedMs,
      deadlineMs: call.deadlineMs,
      origin: call.origin,
      reason: call.reason,
    };
    // The durable `[deadline]` line in `db.jsonl` is the sink handler's
    // (`database/query-deadline`, in the backend): this plugin stays below
    // log-channels, whose server barrel carries HTTP routes. A CLI process
    // (`./equin build`, `db fork`, `deploy` open admin connections) has
    // no runtime namespace, so no handler and no logs dir: its log is its own
    // stderr, where the person running the command reads it.
    if (!hasRuntimeNamespace()) {
      process.stderr.write(`${formatDeadlineLogLine(event)}\n`);
    }
    queryDeadlineSink.emit(event);
  }
}

/**
 * Subscribe to `client` being lost to a missed deadline. Called synchronously at
 * expiry (at once if it is already lost); returns the unsubscribe. For a lease
 * owner whose bookkeeping must end with the connection — the app pool frees its
 * background-transaction gate slot here, because drizzle calls no `release()`
 * when its `BEGIN` is the statement that hung.
 *
 * Throws for a client not built by `createDbPool` / `createDbClient`: every
 * backend connection must carry the deadline.
 */
export function onClientLost(
  client: ClientBase,
  listener: (err: QueryDeadlineExceededError) => void,
): () => void {
  if (!(client instanceof DbClient)) {
    throw new TypeError(
      "onClientLost: this client was not built by createDbPool / createDbClient " +
        "(@plugins/database/plugins/connection/server), so it carries no deadline.",
    );
  }
  return client.subscribeLost(listener);
}

export interface CreateDbPoolOptions {
  /** Which backend connection this is — named on every deadline report. */
  name: DbPoolName;
  connectionString: string;
  max: number;
  idleTimeoutMillis?: number;
  allowExitOnIdle?: boolean;
  /** The default per-call bound in place of `QUERY_DEADLINE_MS`. Tests only. */
  deadlineMs?: number;
}

/**
 * Build a `pg.Pool` whose every client is a `DbClient` bound to `name`: every
 * connect and every query on it carries the deadline, and a lost client is
 * abandoned out of this pool. Opens no connection (pg pools connect lazily).
 *
 * Queue wait (every connection busy) stays unbounded: that is back-pressure,
 * not a silent connection, and every held connection has its own bound.
 */
export function createDbPool(options: CreateDbPoolOptions): Pool {
  let built: Pool | null = null;
  const binding: DbClientBinding = {
    name: options.name,
    pool: () => {
      if (!built) {
        throw new Error(
          `createDbPool(${options.name}): a client outlived or preceded its pool`,
        );
      }
      return built;
    },
    deadlineMs: options.deadlineMs,
  };
  class PooledDbClient extends DbClient {
    constructor(config?: string | ClientConfig) {
      super(config, binding);
    }
  }
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max,
    ...(options.idleTimeoutMillis !== undefined
      ? { idleTimeoutMillis: options.idleTimeoutMillis }
      : {}),
    ...(options.allowExitOnIdle !== undefined
      ? { allowExitOnIdle: options.allowExitOnIdle }
      : {}),
    Client: PooledDbClient as unknown as new () => ClientBase,
  });
  // Fail at build, not later inside a deadline timer, if a pg-pool upgrade moved
  // the internals a lost connection's abandon relies on.
  assertPgPoolInternals(pool);

  // A deadline reads its bound (`withQueryDeadline`) and its caller (the
  // runtime-profiler entry) from AsyncLocalStorage, synchronously, at the
  // client call. When every connection is busy, pg-pool queues the checkout
  // and hands it a connection later, from inside some OTHER caller's
  // `release()` — so the queued checkout's callback, and a `pool.query`
  // statement issued from it, run in the RELEASER's async context: a queued
  // boot-DDL statement would get the default bound, and the report would name
  // whoever freed the connection. The callback is bound to the context of the
  // `connect` call instead. `pool.query` goes through `this.connect(cb)`, so
  // it is covered too. The promise form needs nothing: an `await` continuation
  // runs in the awaiter's context (pinned by deadline.test.ts).
  //
  // Installed before anything else wraps `pool.connect` (the app pool's
  // `installQueryWrapper` captures this as its `origConnect`).
  const pgPoolConnect = pool.connect.bind(pool);
  pool.connect = ((callback?: AnyMethod) =>
    callback
      ? pgPoolConnect(AsyncLocalStorage.bind(callback))
      : pgPoolConnect()) as typeof pool.connect;

  built = pool;
  return pool;
}

export interface CreateDbClientOptions {
  /** Which backend connection this is — named on every deadline report. */
  name: DbPoolName;
  connectionString: string;
  /** The default per-call bound in place of `QUERY_DEADLINE_MS`. Tests only. */
  deadlineMs?: number;
}

/** Build a standalone `DbClient` (not connected yet): every connect and query on it carries the deadline. */
export function createDbClient(options: CreateDbClientOptions): DbClient {
  return new DbClient(
    { connectionString: options.connectionString },
    { name: options.name, pool: null, deadlineMs: options.deadlineMs },
  );
}
