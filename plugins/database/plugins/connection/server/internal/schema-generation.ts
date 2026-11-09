import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import { crashFieldsOf } from "@plugins/packages/plugins/error-subject/core";
import { queryRows } from "@plugins/database/plugins/sql-rows/core";
import { z } from "zod";
import { createDbClient, type DbClient } from "./client";
import { BOOT_DDL_QUERY_DEADLINE_MS, withQueryDeadline } from "./deadline";

// ── Schema-generation locks ─────────────────────────────────────────────────
//
// Which code is still talking to this database. Every process that boots the
// database plugin — the serving backend and every exec child — holds, for its
// whole life, a SHARED session advisory lock `(GENERATION_CLASS, generation)`,
// its generation being its latest migration file's (`schemaGeneration`). The
// session dies with the process, so the lock needs no cleanup, and advisory
// locks are per database, so each worktree's database is its own.
//
// A deferred contract (`database/migrations`' `completeDeferredContract`) must not run while code
// that predates its group still holds a session: that code is what the
// contract breaks. `awaitGenerationsGone(knowing)` takes the EXCLUSIVE lock on
// every held generation outside `knowing`, which Postgres grants only once
// every holder of it is gone — a wait on the server, not a poll. New processes
// only ever share generations inside `knowing`, so the wait never stalls a
// newer deploy's boot; an old-code process starting meanwhile queues behind it.
//
// The same session also holds an EXCLUSIVE lock `(PROCESS_CLASS, its backend
// pid)` that no one else ever asks for exclusively: this process's own presence.
// `awaitOlderProcessesGone()` waits on it (a shared request on each older
// process's key, granted once that process is gone) — for a removal that
// breaks any code that booted before this process, whatever its generation:
// the change feed's trigger on a table the new code no longer feeds, which the
// previous backend still reads (it may keep serving for good if this deploy
// is abandoned after it booted).
//
// The connection is a dedicated one on the DIRECT socket: pgbouncer's
// transaction pooling breaks a session-held lock.
// See research/2026-10-28-database-deferred-contract-phase.md.

// The advisory-lock class of the generation locks (the two-int4 form, so no
// key is shared with the jobs plugin's bigint job locks). Distinct from the
// runner's transaction-scoped schema-layer lock class.
const GENERATION_CLASS = 1835103860;
// The advisory-lock class of each process's presence lock, keyed by its
// session's backend pid (unique among live sessions).
const PROCESS_CLASS = 1835103861;

// The Postgres-side bound on one exclusive wait. Each statement on this
// connection also carries the client deadline (60 s), so a wait must end on
// the server first: on `lock_not_available` the scan below runs again and the
// wait resumes. The renewal is what lets a dead socket still be noticed.
const LOCK_WAIT = "45s";
const LOCK_NOT_AVAILABLE = "55P03";

// int4 key ↔ the unsigned generation (`pg_locks.objid` is an oid, unsigned).
const asInt4 = (generation: number): number => generation | 0;

export interface SchemaGenerationLocks {
  hold(generation: number): Promise<void>;
  awaitGenerationsGone(
    knowing: readonly number[],
  ): Promise<() => Promise<void>>;
  awaitOlderProcessesGone(): Promise<void>;
}

export interface SchemaGenerationLocksOptions {
  /**
   * The DIRECT socket (pgbouncer's transaction pooling breaks a session-held
   * lock). A function: the desktop's names this process's database, which
   * must not be asked at module load.
   */
  connectionString: () => string;
  /** Told each time a wait finds older generations or processes still connected. */
  log: (line: string) => void;
}

/**
 * The schema-generation locks of one process (the desktop's
 * `DatabaseDriver.holdSchemaGeneration` / `awaitGenerationsGone`), on one
 * dedicated session opened on first use.
 */
export function createSchemaGenerationLocks({
  connectionString,
  log,
}: SchemaGenerationLocksOptions): SchemaGenerationLocks {
  let session: Promise<DbClient> | null = null;
  let held: number | null = null;

  const open = async (): Promise<DbClient> => {
    const client = createDbClient({
      name: "schema-generation",
      connectionString: connectionString(),
    });
    client.on("error", (err: Error) => {
      // The session is gone, and its lock with it: from here on a newer
      // deploy no longer sees this process as running its code. What drops a
      // direct session is in practice a cluster restart, which dropped every
      // other session of this process too — so it is reported, not re-taken
      // behind the caller's back. A later wait opens a fresh session.
      session = null;
      reportServerError({
        message: `[database] schema-generation session lost (generation ${held ?? "none"} no longer held): ${err.message}`,
        ...crashFieldsOf(err),
        errorType: "DbConnectionError",
      });
    });
    await client.connect();
    return client;
  };

  const client = (): Promise<DbClient> => (session ??= open());

  return {
    async hold(generation) {
      if (held !== null) {
        throw new Error(
          `[database] holdSchemaGeneration called twice (holding ${held}, asked ${generation})`,
        );
      }
      held = generation;
      const c = await client();
      // Shared, so it waits only while a newer process holds this generation
      // exclusively — i.e. this is old code starting while a contract that
      // breaks it is about to run. The boot DDL bound covers that wait.
      await withQueryDeadline(
        { ms: BOOT_DDL_QUERY_DEADLINE_MS, reason: "schema generation lock" },
        () =>
          c.query("SELECT pg_advisory_lock_shared($1, $2)", [
            GENERATION_CLASS,
            asInt4(generation),
          ]),
      );
      // This process's presence, on the same session (so it lives exactly as
      // long as the generation it holds). Nobody else takes this key
      // exclusively, so it is granted at once.
      await c.query("SELECT pg_advisory_lock($1, pg_backend_pid())", [
        PROCESS_CLASS,
      ]);
    },

    async awaitOlderProcessesGone() {
      const c = await client();
      await c.query(`SET lock_timeout = '${LOCK_WAIT}'`);
      let unwaitable = new Set<number>();
      for (;;) {
        // Every other session holding a generation on this database that
        // started before this one — a process that booted earlier — and
        // whether it holds a presence lock (code from before it existed
        // holds none).
        const rows = await queryRows(c, {
          sql: `SELECT g.pid, EXISTS (
              SELECT 1 FROM pg_locks p
              WHERE p.locktype = 'advisory' AND p.objsubid = 2 AND p.classid = $2
                AND p.granted AND p.pid = g.pid AND p.objid::int = g.pid
                AND p.database = g.database
            ) AS present
            FROM pg_locks g
            JOIN pg_stat_activity a ON a.pid = g.pid
            WHERE g.locktype = 'advisory' AND g.objsubid = 2 AND g.classid = $1
              AND g.granted AND g.pid <> pg_backend_pid()
              AND g.database = (SELECT oid FROM pg_database WHERE datname = current_database())
              AND a.backend_start < (SELECT backend_start FROM pg_stat_activity WHERE pid = pg_backend_pid())
            GROUP BY g.pid, g.database`,
          params: [GENERATION_CLASS, PROCESS_CLASS],
          row: z.object({ pid: z.number(), present: z.boolean() }),
        });
        const legacy = new Set(
          rows.filter((r) => !r.present).map((r) => r.pid),
        );
        const fresh = [...legacy].filter((pid) => !unwaitable.has(pid));
        if (fresh.length > 0) {
          // A process from before presence locks: nothing to wait on. Loud,
          // since what waits here then runs while it is still connected.
          reportServerError({
            message: `[database] ${fresh.length} older process(es) predate presence locks (pids ${fresh.join(", ")}): awaitOlderProcessesGone cannot wait for them`,
            stack: null,
            errorType: "OlderProcessUnwaitable",
          });
        }
        unwaitable = legacy;
        const older = rows.filter((r) => r.present).map((r) => r.pid);
        if (older.length === 0) return;
        log(
          `[database] waiting on ${older.length} older process(es) still connected`,
        );
        for (const pid of older) {
          try {
            await c.query("SELECT pg_advisory_lock_shared($1, $2)", [
              PROCESS_CLASS,
              pid,
            ]);
            await c.query("SELECT pg_advisory_unlock_shared($1, $2)", [
              PROCESS_CLASS,
              pid,
            ]);
          } catch (err) {
            if ((err as { code?: string }).code !== LOCK_NOT_AVAILABLE) {
              throw err;
            }
            // Still connected after LOCK_WAIT: scan again and keep waiting.
          }
        }
      }
    },

    async awaitGenerationsGone(knowing) {
      const c = await client();
      await c.query(`SET lock_timeout = '${LOCK_WAIT}'`);
      const known = new Set(knowing.map(asInt4));
      const taken = new Set<number>();
      for (;;) {
        // Every generation another session holds (granted, on this database).
        const rows = await queryRows(c, {
          sql: `SELECT DISTINCT objid::text AS g FROM pg_locks
            WHERE locktype = 'advisory' AND objsubid = 2 AND classid = $1
              AND granted AND pid <> pg_backend_pid()
              AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
          params: [GENERATION_CLASS],
          row: z.object({ g: z.string() }),
        });
        const old = rows
          .map((r) => asInt4(Number(r.g)))
          .filter((g) => !known.has(g) && !taken.has(g));
        if (old.length === 0) break;
        log(
          `[database] deferred contract waits on ${old.length} older schema generation(s) still connected`,
        );
        for (const g of old) {
          try {
            await c.query("SELECT pg_advisory_lock($1, $2)", [
              GENERATION_CLASS,
              g,
            ]);
            taken.add(g);
          } catch (err) {
            if ((err as { code?: string }).code !== LOCK_NOT_AVAILABLE) {
              throw err;
            }
            // Still held after LOCK_WAIT: scan again and keep waiting.
          }
        }
      }
      return async () => {
        for (const g of taken) {
          await c.query("SELECT pg_advisory_unlock($1, $2)", [
            GENERATION_CLASS,
            g,
          ]);
        }
      };
    },
  };
}
