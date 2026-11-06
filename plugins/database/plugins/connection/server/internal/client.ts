import { AsyncLocalStorage } from "node:async_hooks";
import { Client, Pool, type ClientBase, type ClientConfig } from "pg";
import {
  currentEntryLabel,
  noteLoopObserved,
  recordSpan,
} from "@plugins/infra/plugins/runtime-profiler/core";
import { hasRuntimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import {
  IN_FLIGHT_REPORT_MAX,
  dbApplicationName,
  parseSqlOrigin,
  type DbCallPhase,
  type DbPoolName,
  type DbTxState,
} from "../../core";
import {
  CONNECT_CALL_LABEL,
  QUERY_DEADLINE_MS,
  QueryDeadlineExceededError,
  currentQueryDeadline,
  formatDeadlineLogLine,
  queryDeadlineSink,
  txStateOf,
  type InFlightDbCall,
  type QueryDeadlineEvent,
} from "./deadline";
import { armAwakeDeadline } from "./awake-timer";
import {
  IDLE_IN_TRANSACTION_TIMEOUT_SQLSTATE,
  IdleTransactionEndedError,
  formatIdleTransactionEndedLogLine,
  idleTransactionEndedSink,
  type IdleTransactionEndedEvent,
} from "./idle-transaction";

// ---------------------------------------------------------------------------
// The deadline lives on the CONNECTION: one `pg.Client` subclass bounds the two
// methods every database call ends in — `connect()` and `query()` — whoever
// calls them: the app pool's wrapper, drizzle, graphile-worker's `withPgClient`
// and its LISTEN connection, pg-pool's own `pool.query`, a standalone client.
// Every backend pool and client is built with it, through `createDbPool` /
// `createDbClient`.
//
// Why not pg's `connectionTimeoutMillis`: it bounds only the connect, counts
// sleep as elapsed, and reports nothing. The deadline here bounds both phases
// in awake time, names its caller, and closes the lost connection itself.
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

/**
 * The SQL text of `client.query`'s first argument (a string or a config
 * object), without the origin comment the app pool puts in front of it
 * (`tagSqlWithOrigin`, core): the caller is already named in its own field
 * (`origin`), so a label — a span's, a deadline's — stays the statement alone.
 */
export function queryText(first: unknown): string {
  if (typeof first === "string") return parseSqlOrigin(first).sql;
  if (first && typeof first === "object" && "text" in first) {
    const text = (first as { text?: unknown }).text;
    if (typeof text === "string") return parseSqlOrigin(text).sql;
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

// Every call waiting for its reply, on every connection this process built: what
// a missed deadline reports as "in flight" next to the call it lost. A Set of
// small records, added and deleted once per call — no walk on the hot path; the
// walk is the expiry's.
interface PendingCall {
  client: DbClient;
  call: DeadlineCall;
}
const pendingCalls = new Set<PendingCall>();

/**
 * Every call pending at `now` on the process's OTHER connections, oldest first
 * and capped, with the total. Calls queued on the lost connection itself are
 * left out: pg sends one statement at a time, so they never reached the server
 * — they are not waiters on anything there, and they fail with the lost call.
 */
function inFlightAt(
  lostClient: DbClient,
  now: number,
): { inFlight: InFlightDbCall[]; inFlightCount: number } {
  const others: InFlightDbCall[] = [];
  for (const { client, call } of pendingCalls) {
    if (client === lostClient) continue;
    others.push({
      pool: client.poolName,
      phase: call.phase,
      sql: call.sql,
      origin: call.origin,
      ageMs: Math.round(now - call.startedAt),
      transaction: txStateOf(client, call.phase),
    });
  }
  others.sort((a, b) => b.ageMs - a.ageMs);
  return {
    inFlight: others.slice(0, IN_FLIGHT_REPORT_MAX),
    inFlightCount: others.length,
  };
}

/**
 * The transaction a connection is in, as of its last reply: who sent its first
 * statement, and its latest one — what the server's idle-in-transaction
 * timeout names when it ends the session.
 */
interface OpenTransaction {
  openedBy: string | null;
  startedAt: number;
  last: { origin: string | null; sql: string; repliedAt: number };
}

/** What a missed deadline knows beyond the call itself, read at expiry. */
interface ExpiryContext {
  transaction: DbTxState | null;
  inFlight: InFlightDbCall[];
  inFlightCount: number;
}

type PgRelease = (err?: Error | boolean) => void;
type LostListener = (err: QueryDeadlineExceededError) => void;
// biome-ignore lint/suspicious/noExplicitAny: pg's overloaded methods, invoked with the caller's own arguments.
type AnyMethod = (...args: any[]) => any;

const pgQuery = Client.prototype.query as AnyMethod;
const pgConnect = Client.prototype.connect as AnyMethod;
const pgEnd = Client.prototype.end as AnyMethod;

/** How a `DbClient` is bound: its name and its default bound. */
export interface DbClientBinding {
  name: DbPoolName;
  /** Built by a pool (`createDbPool`), or standalone (`createDbClient`). */
  pooled: boolean;
  /** The default bound in place of `QUERY_DEADLINE_MS`. Tests only. */
  deadlineMs?: number;
}

/** pg-pool's own `release` for one checkout, and whether it has run. */
interface Checkout {
  release: PgRelease;
  returned: boolean;
}

// pg's `end(cb)` settles without an error (it waits for the socket's `end`):
// closing a lost client needs no follow-up once that happens.
function lostClientClosed(): void {}

/**
 * A `pg.Client` whose `connect()` and `query()` each carry a deadline.
 *
 * On expiry of either, the call fails with `QueryDeadlineExceededError` and the
 * client is LOST, for good:
 *   - it is CLOSED: a checked-out client is first handed back to its pool as
 *     broken (`release(err)`, pg-pool's public way to drop a client, which
 *     pulses its queue so a waiting checkout gets a replacement), and its
 *     socket is destroyed. Postgres sees the session end and rolls back any
 *     transaction it was in, releasing its locks; PgBouncer frees its slot;
 *   - a `<sql>[deadline]` `db` span is recorded and the event is emitted on
 *     `queryDeadlineSink` (`database/query-deadline` logs and reports it);
 *   - every other call already in flight on it, and every later call, fails at
 *     once with the same error (pg queues statements per connection, so they
 *     would only wait out another bound behind the lost one);
 *   - the holder's own later `release()` does nothing (the client was already
 *     handed back; a second release would be pg-pool's double-release throw);
 *   - `onClientLost` subscribers are told.
 *
 * A late real reply is dropped: its call was already settled, and its socket
 * is gone.
 */
export class DbClient extends Client {
  readonly poolName: DbPoolName;
  readonly #pooled: boolean;
  readonly #defaultDeadlineMs: number;
  #lost: QueryDeadlineExceededError | null = null;
  readonly #lostListeners = new Set<LostListener>();
  readonly #inFlight = new Set<LostListener>();
  #checkout: Checkout | null = null;
  #holderRelease: PgRelease | undefined;
  #poolAssigning = false;
  #tx: OpenTransaction | null = null;
  #endedIdle: IdleTransactionEndedError | null = null;

  constructor(
    config: string | ClientConfig | undefined,
    binding: DbClientBinding,
  ) {
    super(config);
    this.poolName = binding.name;
    this.#pooled = binding.pooled;
    this.#defaultDeadlineMs = binding.deadlineMs ?? QUERY_DEADLINE_MS;
    // Every chunk the server sends reaches JS here first — registered before
    // pg's own parser (attached at connect) — so a reply read late, behind a
    // block of the event loop, registers that block before its statement's
    // span is recorded: the statement is charged it as an `event-loop` wait,
    // whichever phase of the loop the block ran in (runtime-profiler, "Event-
    // loop stalls"). One clock read and a compare per chunk.
    this.connection.stream.on("data", noteLoopObserved);
  }

  /** Set once the server ended this session for idling inside its transaction. */
  get endedIdleError(): IdleTransactionEndedError | null {
    return this.#endedIdle;
  }

  /** The error that lost this client, or null while it is healthy. */
  get lostError(): QueryDeadlineExceededError | null {
    return this.#lost;
  }

  // pg-pool assigns `client.release` on every checkout (`_acquireClient`), for
  // every checkout path — `pool.connect()` in both forms, its own `pool.query`,
  // graphile-worker's LISTEN connection — right after emitting `acquire`. An
  // accessor sees each assignment, so the deadline can hand a lost client back
  // to its pool itself (`#close`) with pg-pool's own release for that checkout,
  // and the holder's later release is a no-op by construction rather than per
  // call site (a second release is pg-pool's double-release throw).
  //
  // `createDbPool`'s `acquire` listener calls `beginCheckout()`, so the next
  // assignment is known to be pg-pool's; any other is a holder wrapping it (the
  // app pool's background lease, `armLease`). The getter captures the function
  // in force at read time: a holder that reads `client.release`, then assigns
  // its own wrapper calling what it read, gets that wrapper back on the next
  // read without recursing into itself.
  get release(): PgRelease | undefined {
    const holder = this.#holderRelease;
    const checkout = this.#checkout;
    if (!holder && !checkout) return undefined;
    return (err?: Error | boolean) => {
      if (this.#lost) {
        this.#returnBroken();
        return;
      }
      if (holder) return holder(err);
      checkout!.returned = true;
      return checkout!.release(err);
    };
  }

  set release(fn: PgRelease | undefined) {
    if (!this.#poolAssigning) {
      this.#holderRelease = fn;
      return;
    }
    this.#poolAssigning = false;
    this.#holderRelease = undefined;
    this.#checkout = fn ? { release: fn, returned: false } : null;
  }

  /** @internal — `createDbPool`'s `acquire` listener: pg-pool's next `release` assignment is its own. */
  beginCheckout(): void {
    this.#poolAssigning = true;
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

  // The server ending this session for idling inside its transaction arrives
  // as an `error` event (pg delivers an ErrorResponse that answers no query
  // that way), with SQLSTATE 25P03 — directly, and through PgBouncer, which
  // forwards it before its own `server conn crashed?`. Seen here rather than
  // by a listener, so whether the holder listens (and whether an unheard
  // `error` crashes the process) is exactly as before.
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    if (event === "error") this.#noticeIdleTimeout(args[0]);
    return super.emit(event, ...args);
  }

  #noticeIdleTimeout(err: unknown): void {
    if (this.#endedIdle || this.#lost) return;
    if (
      (err as { code?: unknown } | null)?.code !==
      IDLE_IN_TRANSACTION_TIMEOUT_SQLSTATE
    ) {
      return;
    }
    const now = performance.now();
    // Null when the transaction's statements bypassed the bounded path (a
    // Submittable, a config with its own callback): not known, never zero.
    const tx = this.#tx;
    const event: IdleTransactionEndedEvent = {
      at: Date.now(),
      pool: this.poolName,
      origin: tx?.last.origin ?? null,
      sql: tx?.last.sql ?? null,
      openedBy: tx?.openedBy ?? null,
      transactionMs: tx ? Math.round(now - tx.startedAt) : null,
      idleMs: tx ? Math.round(now - tx.last.repliedAt) : null,
      serverMessage: err instanceof Error ? err.message : String(err),
    };
    this.#tx = null;
    this.#endedIdle = new IdleTransactionEndedError(event);
    // Like a missed deadline: no runtime namespace (a CLI process) means no
    // handler and no logs dir, so its own stderr is where it is read.
    if (!hasRuntimeNamespace()) {
      process.stderr.write(`${formatIdleTransactionEndedLogLine(event)}\n`);
    }
    idleTransactionEndedSink.emit(event);
  }

  // After every reply (or error reply): where the connection stands in a
  // transaction. Two field writes per statement; read only if the server
  // ends the session.
  #noteReply(call: DeadlineCall): void {
    const status = this.getTransactionStatus();
    if (status !== "T" && status !== "E") {
      this.#tx = null;
      return;
    }
    const last = {
      origin: call.origin,
      sql: call.sql,
      repliedAt: performance.now(),
    };
    if (this.#tx) this.#tx.last = last;
    else this.#tx = { openedBy: call.origin, startedAt: call.startedAt, last };
  }

  // biome-ignore lint/suspicious/noExplicitAny: pg's overloaded query signature.
  override query(...args: any[]): any {
    if (this.#poolAssigning) {
      // `beginCheckout()` ran (pg-pool's `acquire`) but pg-pool handed the
      // client out without assigning that checkout's `release` first. Then the
      // deadline cannot hand a lost client back to its pool, and every loss
      // would leak a pool slot for good — fail here, at the first statement.
      throw new Error(
        "pg-pool handed out a client without assigning release() right after " +
          "emitting `acquire` (pg-pool 3.14 does). Re-check DbClient#release in " +
          "plugins/database/plugins/connection/server/internal/client.ts against this pg-pool.",
      );
    }
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
    const pending: PendingCall = { client: this, call };
    let settled = false;
    const cancel = armAwakeDeadline(call.startedAt, call.deadlineMs, () => {
      if (settled) return;
      settled = true;
      const expiry = this.#expiry(call);
      pendingCalls.delete(pending);
      // Hand the error over BEFORE closing. Inside a pool the callback is
      // pg-pool's `newClient` handler: it drops the client from its pool,
      // pulses the queue and fails the waiting checkout.
      const err = this.#lose(call, callback);
      this.#report(call, err, expiry);
    });
    pendingCalls.add(pending);
    try {
      pgConnect.call(this, (...result: unknown[]) => {
        if (settled) return; // late completion of a connect already failed
        settled = true;
        cancel();
        pendingCalls.delete(pending);
        callback(...result);
      });
    } catch (err) {
      settled = true;
      cancel();
      pendingCalls.delete(pending);
      throw err;
    }
    return undefined;
  }

  // biome-ignore lint/suspicious/noExplicitAny: pg's overloaded end signature.
  override end(callback?: AnyMethod): any {
    const result = callback ? pgEnd.call(this, callback) : pgEnd.call(this);
    // pg's own end() closes gracefully when no statement is active (Terminate,
    // then wait for the server to close): a lost connection may never answer,
    // so its socket is destroyed outright. pg then emits `end`, which settles
    // `result` (pg-pool's `_remove` waits on it).
    if (this.#lost) this.#destroySocket();
    return result;
  }

  #destroySocket(): void {
    (
      this as unknown as { connection: { stream: { destroy(): void } } }
    ).connection.stream.destroy();
  }

  // Hand a lost client still checked out back to its pool as broken, with
  // pg-pool's own release for this checkout: pg-pool drops it, `end()`s it
  // (above) and pulses its queue. False when it is not checked out.
  #returnBroken(): boolean {
    const checkout = this.#checkout;
    if (!checkout || checkout.returned) return false;
    checkout.returned = true;
    checkout.release(this.#lost ?? true);
    return true;
  }

  // Close a lost client: through its pool when checked out of one; otherwise
  // directly. A pooled client that is not checked out is either one whose
  // connect timed out (pg-pool's connect callback dropped it) or one its holder
  // released with a call still pending, now idle in the pool: either way
  // pg-pool's idle `error` listener is on it, and the loss emitted to it drops
  // the client from the pool (pg-pool `_remove`s a client whose idle socket
  // errors) — so a closed client is never handed out again.
  #close(): void {
    if (this.#returnBroken()) return;
    if (this.#pooled) this.emit("error", this.#lost);
    this.end(lostClientClosed);
  }

  // After the close, the socket is gone: pg reports nothing for the close
  // itself (it ends on purpose; ECONNRESET / EPIPE while ending are dropped by
  // pg). Any other error is unexpected — reported, once, never swallowed, and
  // never an unhandled `'error'` that kills the process.
  #reportedLateError = false;
  #onLostClientError = (err: Error): void => {
    if (err === this.#lost) return; // the loss handed to pg-pool by `#close`
    if (this.#reportedLateError) return;
    this.#reportedLateError = true;
    const message = `[db] pool=${this.poolName}: error on a connection closed after a missed deadline: ${err.message}`;
    if (!hasRuntimeNamespace()) process.stderr.write(`${message}\n`);
    reportServerError({
      message,
      stack: err.stack ?? null,
      errorType: "DbConnectionError",
    });
  };

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
    // The server ended this session for idling in its transaction: pg would
    // say only "not queryable"; the caller — usually the stalled transaction's
    // own next statement — learns why, and that its work was rolled back.
    const endedIdle = this.#endedIdle;
    if (endedIdle) return Promise.reject(endedIdle);
    // Started synchronously, so pg's own synchronous throws (a null config)
    // still reach the caller as throws.
    const result = work();
    const pending: PendingCall = { client: this, call };
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const fail = (err: unknown): void => {
        if (settled) return;
        settled = true;
        cancel();
        this.#inFlight.delete(fail);
        pendingCalls.delete(pending);
        reject(err);
      };
      const cancel = armAwakeDeadline(call.startedAt, call.deadlineMs, () => {
        if (settled) return;
        settled = true;
        const expiry = this.#expiry(call);
        this.#inFlight.delete(fail);
        pendingCalls.delete(pending);
        const err = this.#lose(call);
        reject(err);
        this.#report(call, err, expiry);
      });
      this.#inFlight.add(fail);
      pendingCalls.add(pending);
      // A late outcome (after the deadline, or after another call lost the
      // client) is dropped here — handled, never an unhandled rejection.
      result.then(
        (value) => {
          if (settled) return;
          settled = true;
          cancel();
          this.#inFlight.delete(fail);
          pendingCalls.delete(pending);
          this.#noteReply(call);
          resolve(value);
        },
        (err: unknown) => {
          if (settled) return;
          // The server's 25P03 can also arrive as the ANSWER to a call: code
          // wedged past the bound sends its next statement before reading
          // the FATAL already in its socket, and pg settles that call (and
          // every queued one, before emitting `error`) with it. Same end,
          // same report, same error.
          this.#noticeIdleTimeout(err);
          const endedIdle = this.#endedIdle;
          if (endedIdle) {
            fail(endedIdle);
            return;
          }
          this.#noteReply(call);
          fail(err);
        },
      );
    });
  }

  // Expiry, part 0, before anything changes: what the call was part of — its
  // connection's transaction state and every other call still waiting.
  #expiry(call: DeadlineCall): ExpiryContext {
    return {
      transaction: txStateOf(this, call.phase),
      ...inFlightAt(this, performance.now()),
    };
  }

  // Expiry, part 1: the connection is lost. Everything that must hold before
  // the caller hears about it — nothing can hand it out or release it again;
  // it is out of its pool and closed; lease owners and queued calls are told.
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
    // Before the close: a lost client always has an `error` listener.
    this.on("error", this.#onLostClientError);
    try {
      handOff?.(err);
    } finally {
      this.#close();
      const listeners = [...this.#lostListeners];
      this.#lostListeners.clear();
      for (const listener of listeners) listener(err);
      const inFlight = [...this.#inFlight];
      for (const fail of inFlight) fail(err);
    }
    return err;
  }

  // Expiry, part 2, after the caller has its error: tell the outside world.
  #report(
    call: DeadlineCall,
    err: QueryDeadlineExceededError,
    expiry: ExpiryContext,
  ): void {
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
      ...expiry,
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
  /**
   * How long a connection may sit idle before the pool closes it (`0`: never).
   * Required, and chosen from the pool's work pattern: a direct pool's closed
   * connection is a Postgres process the next use forks again (fork, auth,
   * catalog warm-up, two log lines). pg-pool's own default (10 s) was what the
   * jobs pools got by leaving this out, while their work comes once a minute —
   * so every cron tick reopened every connection the last one used, ~140 new
   * Postgres processes a minute host-wide (2026-11-06,
   * `plugins/infra/plugins/jobs/machine/internal/pool-idle.ts`).
   */
  idleTimeoutMillis: number;
  allowExitOnIdle?: boolean;
  /** The default per-call bound in place of `QUERY_DEADLINE_MS`. Tests only. */
  deadlineMs?: number;
}

/**
 * Build a `pg.Pool` whose every client is a `DbClient` bound to `name`: every
 * connect and every query on it carries the deadline, and a lost client is
 * dropped from this pool and closed. Opens no connection (pg pools connect lazily).
 *
 * Queue wait (every connection busy) stays unbounded: that is back-pressure,
 * not a silent connection, and every held connection has its own bound.
 */
export function createDbPool(options: CreateDbPoolOptions): Pool {
  const binding: DbClientBinding = {
    name: options.name,
    pooled: true,
    deadlineMs: options.deadlineMs,
  };
  class PooledDbClient extends DbClient {
    constructor(config?: string | ClientConfig) {
      super(config, binding);
    }
  }
  const pool = new Pool({
    connectionString: options.connectionString,
    application_name: dbApplicationName(options.name, hasRuntimeNamespace()),
    max: options.max,
    idleTimeoutMillis: options.idleTimeoutMillis,
    ...(options.allowExitOnIdle !== undefined
      ? { allowExitOnIdle: options.allowExitOnIdle }
      : {}),
    Client: PooledDbClient as unknown as new () => ClientBase,
  });
  // pg-pool emits `acquire` right before it assigns this checkout's `release`
  // (see `DbClient#release`). Registered first, ahead of any consumer's.
  pool.on("acquire", (client) => {
    if (client instanceof DbClient) client.beginCheckout();
  });
  installConnectionErrorHandlers(pool, options.name);

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

  return pool;
}

// A connection error with nobody listening is an unhandled `'error'` event, which
// kills the process: pg-pool re-emits an IDLE client's socket error on the pool
// (after ending and dropping the client), and a CHECKED-OUT client whose socket
// breaks between statements emits it on the client. So every pool carries both
// listeners by construction, rather than each consumer remembering to — or a
// library (graphile-worker, handed the jobs pools as `pgPool`) installing its
// own, which would log through its own logger, outside our reports.
//
// Neither listener recovers anything; nothing has to be: pg-pool has already
// dropped an idle client, and a checked-out client is no longer queryable — its
// holder's next statement rejects, and pg-pool drops it on release. What they do
// is make the event loud in the one place errors go: `reportServerError` in a
// backend, stderr in a CLI process (no runtime namespace, no reporter).
//
// A LOST client's errors are not reported here: the loss itself (which `#close`
// hands to pg-pool's idle listener) was reported by the deadline, and anything
// later is its own listener's (`DbClient#onLostClientError`).
function installConnectionErrorHandlers(pool: Pool, name: DbPoolName): void {
  const reported = new WeakSet<ClientBase>();
  const onClientError = (client: ClientBase, err: Error): void => {
    if (client instanceof DbClient && client.lostError) return;
    // The server ended the session for idling in its transaction: `DbClient`
    // announced it on `idleTransactionEndedSink`, naming the stalled code, and
    // it is reported there. The errors that follow it on the same connection
    // (PgBouncer's `server conn crashed?`, pg's `Connection terminated
    // unexpectedly`) are that same end.
    if (client instanceof DbClient && client.endedIdleError) return;
    // pg-pool's idle listener answers any later error on a dropped client
    // itself; one report per connection is the event.
    if (reported.has(client)) return;
    reported.add(client);
    const message = `[db] pool=${name}: connection error: ${err.message}`;
    if (!hasRuntimeNamespace()) process.stderr.write(`${message}\n`);
    reportServerError({
      message,
      stack: err.stack ?? null,
      errorType: "DbConnectionError",
    });
  };
  // Registered on connect, so it is ahead of pg-pool's idle listener on every
  // client: an idle client's error is reported here before the pool re-emits
  // it, and the pool listener below has nothing left to do but exist.
  pool.on("connect", (client) => {
    client.on("error", (err) => onClientError(client, err));
  });
  pool.on("error", () => {
    /* reported by the client's own listener above */
  });
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
    {
      connectionString: options.connectionString,
      application_name: dbApplicationName(options.name, hasRuntimeNamespace()),
    },
    { name: options.name, pooled: false, deadlineMs: options.deadlineMs },
  );
}
