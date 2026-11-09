import type { Pool, PoolClient } from "pg";
import { crashFieldsOf } from "@plugins/packages/plugins/error-subject/core";
import { createKeyedMutex } from "@plugins/packages/plugins/keyed-mutex/core";
import { z } from "zod";
import { connectionString } from "@plugins/database/plugins/admin/server";
import {
  createDbPool,
  onClientLost,
} from "@plugins/database/plugins/connection/server";
import { queryOne } from "@plugins/database/plugins/sql-rows/core";
import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import { TOTAL_JOB_SLOTS } from "../../core/hold";
import { JOBS_POOL_IDLE_TIMEOUT_MS } from "./pool-idle";

// Exact liveness for a running job, maintained by Postgres itself.
//
// A session-scoped advisory lock is released the instant the owning backend goes
// away — SIGKILL, OOM-killer, kernel panic, `process.exit()` from a buggy handler
// alike — because releasing its locks is part of backend teardown when the client
// socket closes. So "is a worker still running this job?" stops being ESTIMATED
// from a clock and becomes a FACT the database maintains.
//
// That distinction is the whole design. Every previous mechanism here keyed off
// the age of `graphile_worker._private_jobs.locked_at`, and an age cannot tell
// "worker dead" from "worker busy" — so a 15-minute backup looked identical to a
// crashed worker and was re-dispatched WHILE STILL RUNNING (two complete archives
// per night for three months; 25 distinct jobs stolen across an 8-day window).
// The lease-renewal heartbeat that was supposed to prevent that could not: a lease
// is still a timeout, and machine sleep freezes every timer we own while `now()`
// keeps advancing, so on wake `locked_at` is hours stale on a perfectly live job.
// Nothing built on a clock we control can survive that; shared fate with the
// Postgres backend can. See
// `research/2026-07-30-jobs-exact-liveness-advisory-locks.md`.
//
// If you are here because a long job looks "stuck": do NOT reintroduce a timeout.
// The lock's absence is the only liveness signal, and it is exact.

// --- Why a dedicated direct connection and not the shared `db` handle --------
//
// TWO independent reasons, either one fatal:
//
// 1. `db` routes through PgBouncer in TRANSACTION pooling mode, which does not
//    preserve session state between statements — the server connection is handed
//    to someone else the moment our transaction ends. A session-scoped advisory
//    lock taken on one statement would silently be invisible (or released) on the
//    next. `connectionString()` is the DIRECT 5433 socket, the same routing
//    graphile-worker and the change-feed LISTEN already require, and the routing
//    rule `plugins/database/plugins/pgbouncer/CLAUDE.md` already documents for
//    advisory locks.
// 2. Holding a `pool.connect()` lease for the WHOLE job body would pin one of only
//    `BACKGROUND_TX_MAX = 3` background transaction slots for minutes or hours.
//    The lane-capacity deadlock proof in `plugins/database/server/internal/client.ts`
//    assumes those leases are transaction-scoped; a handful of long jobs would
//    exhaust the lane and wedge every background transaction in the backend.
//
// --- ONE session holds every running job's lock -------------------------------
//
// An advisory lock belongs to its session, and a session holds any number of
// them. So a backend holds all its running jobs' locks on ONE connection: taken
// when the first job starts, handed back to the pool when the last one ends
// (`JOBS_POOL_IDLE_TIMEOUT_MS` keeps it warm for the next cron tick). Until
// 2026-11-09 each running job held its own connection, so a backend kept as many
// idle `job-lock` sessions as its busiest minute ran jobs at once: 54 across 10
// databases on 2026-11-08 (32 across 5 the next day, none of them holding a
// lock), ~8–11 MB of footprint each, only `app-background` and `jobs-runner`
// holding more on the cluster.
//
// What one connection per job bought, and why it is not needed:
//
// - **Releasing a lock by destroying its session.** Every uncertain path (the
//   handler threw, the unlock failed or said "not held") destroyed the job's
//   connection rather than trusting a statement. With one session that would
//   drop every OTHER job's lock, so: a throwing handler is unlocked like any
//   other (its body ran on other connections, this session is healthy), and a
//   session we stop trusting is RETIRED — no new lock is taken on it, and it is
//   destroyed once the last job on it ends, which releases whatever it still
//   holds. "A lock is never leaked into a reused session" still holds by
//   construction: a retired session is never handed out again.
// - **A blast radius of one job.** A session that dies takes every lock on it,
//   so every job holding one is told (`onLost`, reported, "may double-run").
//   What kills a direct session is in practice the cluster ending it — a restart,
//   or an administrator's terminate — which ends every other session of this
//   process at once anyway (the one `job-lock` connection error on record,
//   2026-11-04, was "terminating connection due to administrator command", on 5
//   connections in the same 100 ms). The one loss that used to stay per-job is a
//   lock / unlock statement getting no reply in 60 s of awake time: its
//   connection is closed (`database/connection`), and on the shared session that
//   is every running job's lock. That needs a Postgres that does not answer a
//   trivial statement for a minute, which no deadline report has ever recorded
//   for this pool; it is reported per job, never re-taken behind the caller's
//   back (the schema-generation session's rule too).
//
// Session-held locks are re-entrant within their session: a second
// `pg_try_advisory_lock` of a key the session already holds is GRANTED. So the
// one-holder-per-key check a separate session per job made Postgres do is done
// here, in process (`heldHere`), before the statement — the same `LOCK_HELD`.
//
// The pool keeps `max: TOTAL_JOB_SLOTS`. Steady state is one connection; more
// exist only while a retired session drains. Every session in use has at least
// one dispatch in it, and dispatches are bounded by the worker's slot count, so
// a checkout can never park a handler that already holds a graphile slot. It must
// be the TOTAL across every runner in the ladder: reading the sum from
// `core/hold` keeps the two undriftable.
//
// Built by `createDbPool` (`job-lock`): opening a connection and each lock /
// unlock statement carry the connection plugin's deadline. The handler body runs
// on OTHER connections while this one sits idle holding the lock, and an idle
// connection has no call pending — so no deadline ever bounds how long a job
// holds its lock. Only the short statements around it are bounded.

// Returned instead of the handler's result when another live worker provably holds
// this job's lock. A unique symbol, not `null`/`undefined`/a falsy default: the
// caller CANNOT read it as a legitimate handler result, and TypeScript forces the
// branch (`Promise<T | typeof LOCK_HELD>` narrows only on an explicit `=== LOCK_HELD`).
// Under this design a contended dispatch should be near-impossible, so it is a real
// signal — see the caller in `worker.ts`, which reports it and re-queues the tick.
export const LOCK_HELD: unique symbol = Symbol("jobs.lock-held");

export type WithJobLock = <T>(
  jobId: string,
  onLost: (err: unknown) => void,
  fn: () => Promise<T>,
) => Promise<T | typeof LOCK_HELD>;

export interface JobLocks {
  withJobLock: WithJobLock;
  /** Close the pool. Only once no `withJobLock` is running. */
  end(): Promise<void>;
}

// One lock session: a checked-out `job-lock` connection and the jobs whose lock
// it holds.
//
// - `open` — the session new dispatches join.
// - `retired` — no longer trusted: no new dispatch joins it (one that joined
//   before may still take its lock on it), and it is destroyed when its last
//   user leaves, which releases anything it still holds.
// - `lost` — the connection died (socket error, or a call missed its deadline
//   and the connection plugin closed it): every lock on it is gone.
// - `closed` — handed back to the pool, its last user gone, holding nothing.
type SessionState = "open" | "retired" | "lost" | "closed";

interface SessionCore {
  // Keys this session's statements in `statements`.
  id: string;
  state: SessionState;
  // Dispatches between joining and leaving: counted synchronously at join, so
  // the session cannot be handed back while a joiner still awaits `ready`.
  users: number;
  // Jobs whose lock this session holds, and whom to tell if it dies.
  holders: Map<string, (err: unknown) => void>;
  // Jobs that left whose lock this session may STILL hold (the lock statement
  // threw, or the unlock failed): kept in `heldHere` until the session is
  // destroyed or lost, so a retry of the job id in this process reads as held
  // here rather than racing a lock only the destruction releases.
  uncertain: Set<string>;
  // Set once connected: what to do with the connection when the last user leaves.
  client: PoolClient | null;
  detach: () => void;
}

interface LockSession extends SessionCore {
  ready: Promise<PoolClient>;
}

/**
 * The advisory job locks of one process, on one shared session at a time.
 * `connectionString` must name the DIRECT socket (see above); a function, so the
 * desktop's is not asked for at module load.
 */
export function createJobLocks({
  connectionString,
}: {
  connectionString: () => Promise<string>;
}): JobLocks {
  let pool: Pool | null = null;
  let poolPending: Promise<Pool> | null = null;
  let current: LockSession | null = null;
  let sessionSeq = 0;
  const heldHere = new Set<string>();
  // One statement at a time per session. Jobs start and end concurrently, and
  // pg only queues concurrent `query()` calls on one client under a
  // deprecation warning (pg@9 removes it), so the lock and unlock statements
  // of one session are ordered here.
  //
  // The cost: one statement that gets no reply delays every other job's lock or
  // unlock on the session until its deadline (60 s) closes the connection —
  // which then loses the session anyway (see above).
  const statements = createKeyedMutex();

  const onSession = <T>(
    session: LockSession,
    client: PoolClient,
    sql: string,
    jobId: string,
    row: z.ZodType<T>,
  ): Promise<T> =>
    statements.run(session.id, () =>
      queryOne(client, { sql, params: [jobId], row }),
    );

  const lockPool = (): Promise<Pool> =>
    (poolPending ??= (async () => {
      let connString: string;
      try {
        connString = await connectionString();
      } catch (err) {
        // Not cached: the next dispatch asks again instead of every dispatch
        // failing until restart.
        poolPending = null;
        throw err;
      }
      pool = createDbPool({
        name: "job-lock",
        connectionString: connString,
        max: TOTAL_JOB_SLOTS,
        // Only ever reaps connections sitting IDLE in the pool; the session in
        // use is checked out and never touched by this. Long enough that the
        // next cron tick's jobs reuse this one's (pool-idle.ts).
        idleTimeoutMillis: JOBS_POOL_IDLE_TIMEOUT_MS,
        // A pool whose entire purpose is job-scoped leases must never be the
        // reason the process refuses to exit: unref idle clients so shutdown is
        // not held open by a connection nobody is using.
        allowExitOnIdle: true,
      });
      return pool;
    })());

  const lose = (session: SessionCore, err: unknown): void => {
    if (session.state === "lost" || session.state === "closed") return;
    session.state = "lost";
    if (current === session) current = null;
    // Every lock on it is gone. Never swallowed: for each job still running,
    // this is the exact moment the double-run window opens, and the whole
    // point of this design is that it is loud.
    const holders = [...session.holders.values()];
    session.holders.clear();
    settleUncertain(session);
    for (const onLost of holders) onLost(err);
  };

  // The session's end released every lock it still held.
  const settleUncertain = (session: SessionCore): void => {
    for (const jobId of session.uncertain) heldHere.delete(jobId);
    session.uncertain.clear();
  };

  // This job's lock may outlive its dispatch on this session (see `uncertain`).
  const markUncertain = (session: SessionCore, jobId: string): void => {
    if (session.state === "lost" || session.state === "closed") return;
    session.uncertain.add(jobId);
  };

  const retire = (session: SessionCore): void => {
    if (session.state !== "open") return;
    session.state = "retired";
    if (current === session) current = null;
  };

  const connect = async (session: SessionCore): Promise<PoolClient> => {
    try {
      const client = await (await lockPool()).connect();
      const onError = (err: unknown) => lose(session, err);
      client.on("error", onError);
      const unsubscribe = onClientLost(client, onError);
      session.detach = () => {
        client.off("error", onError);
        unsubscribe();
      };
      session.client = client;
      return client;
    } catch (err) {
      // Nothing was held on a session that never connected: just make sure no
      // later dispatch joins it.
      session.state = "lost";
      if (current === session) current = null;
      throw err;
    }
  };

  const open = (): LockSession => {
    const core: SessionCore = {
      id: String(++sessionSeq),
      state: "open",
      users: 0,
      holders: new Map(),
      uncertain: new Set(),
      client: null,
      detach: () => {},
    };
    return Object.assign(core, { ready: connect(core) });
  };

  const join = (): LockSession => {
    if (current?.state !== "open") current = open();
    current.users++;
    return current;
  };

  const leave = (session: LockSession): void => {
    session.users--;
    if (session.users > 0) return;
    if (session.state === "open") {
      // Its last job ended, and every lock it took was released: back to the
      // pool, warm for the next tick. The next dispatch joins a new session.
      session.state = "closed";
      if (current === session) current = null;
    }
    const { client } = session;
    if (!client) return;
    // Detach first: a connection back in the pool must not tell this session's
    // (now empty) holder set about a later error.
    session.detach();
    // Destroyed unless it ended clean: a retired session may still hold a lock
    // it could not release, and destroying it is what releases that. (A
    // connection lost to a missed deadline was already closed and handed back
    // by the connection plugin; its release is a no-op.)
    client.release(session.state !== "closed");
    if (session.state === "retired") session.state = "closed";
    settleUncertain(session);
  };

  const unlock = async (session: LockSession, jobId: string): Promise<void> => {
    // Out of the holder set BEFORE the statement: if the statement is what
    // loses the session, this job is over and must not be told it may
    // double-run — only the jobs still running are.
    session.holders.delete(jobId);
    // A lost session's locks went with it.
    if (session.state === "lost" || !session.client) return;
    try {
      const { unlocked } = await onSession(
        session,
        session.client,
        "SELECT pg_advisory_unlock($1::bigint) AS unlocked",
        jobId,
        z.object({ unlocked: z.boolean() }),
      );
      if (!unlocked) {
        // We held it a statement ago and Postgres says we do not. Something
        // about this session is not what we think: stop taking locks on it,
        // and let its destruction (once its other jobs end) settle whatever it
        // still holds.
        retire(session);
        markUncertain(session, jobId);
        const message = `[jobs] pg_advisory_unlock reported no lock held for job ${jobId} — retiring the lock session (destroyed once its other jobs end)`;
        console.warn(message);
        reportServerError({ message, stack: null });
      }
      // the unlock is best-effort BECAUSE a session we stop trusting is destroyed, which releases the lock unconditionally; rethrowing here would replace the handler's own outcome with a cleanup failure
    } catch (err) {
      retire(session);
      markUncertain(session, jobId);
      const errObj = err instanceof Error ? err : new Error(String(err));
      const message = `[jobs] advisory unlock failed for job ${jobId}: ${errObj.message} — retiring the lock session (destroyed once its other jobs end)`;
      console.warn(message, errObj);
      reportServerError({
        message,
        ...crashFieldsOf(errObj),
      });
    }
  };

  const withJobLock: WithJobLock = async (jobId, onLost, fn) => {
    // A session grants a key it already holds again, so a second dispatch of
    // the same job id in this process must be refused here, not by Postgres.
    if (heldHere.has(jobId)) return LOCK_HELD;
    heldHere.add(jobId);
    // Read by the outer `finally`, after the session may have ended.
    let joined: LockSession | null = null;
    try {
      const session = join();
      joined = session;
      try {
        const client = await session.ready;
        let locked: boolean;
        try {
          // `pg_try_advisory_lock` always returns exactly one row, so
          // `queryOne` is the accurate door: no row means we do not understand
          // what we are talking to, and it throws rather than letting the
          // caller guess.
          ({ locked } = await onSession(
            session,
            client,
            "SELECT pg_try_advisory_lock($1::bigint) AS locked",
            jobId,
            z.object({ locked: z.boolean() }),
          ));
        } catch (err) {
          // Whether Postgres granted it is unknown: never take another lock on
          // this session, so its destruction releases this one if it was.
          // (A missed deadline already lost it; `retire` is then a no-op.)
          retire(session);
          markUncertain(session, jobId);
          throw err;
        }
        if (!locked) return LOCK_HELD;
        // Granted on a session that died while the statement was in flight:
        // the lock went with it, before the handler even started.
        if (session.state === "lost") {
          throw new Error(
            `[jobs] the lock session was lost while taking job ${jobId}'s lock`,
          );
        }
        session.holders.set(jobId, onLost);
        try {
          return await fn();
        } finally {
          await unlock(session, jobId);
        }
      } finally {
        leave(session);
      }
    } finally {
      // Still held here while a session that may hold its lock lives on.
      // (`settleUncertain` drops it once that session ends.)
      if (!joined?.uncertain.has(jobId)) heldHere.delete(jobId);
    }
  };

  return {
    withJobLock,
    async end() {
      const p = pool;
      pool = null;
      poolPending = null;
      current = null;
      await p?.end();
    },
  };
}

const jobLocks = createJobLocks({ connectionString });

/**
 * Run `fn` while holding the exclusive session advisory lock for `jobId`.
 *
 * Returns {@link LOCK_HELD} — without running `fn` — if another live session, or
 * another dispatch in this process, already holds it. `onLost` fires if the lock
 * session dies mid-handler, which means the lock is gone and the job is exposed
 * to a double-run; it is a notification, not a recovery hook (nothing can un-run
 * a handler mid-flight).
 *
 * The key is the graphile job id, never a workflow run id: a suspended workflow
 * resumes as a DIFFERENT `_private_jobs` row, and locking the run id would make a
 * resumed step contend with its own suspended predecessor.
 */
export const withJobLock: WithJobLock = (jobId, onLost, fn) =>
  jobLocks.withJobLock(jobId, onLost, fn);
