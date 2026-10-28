import { reportServerError } from "@plugins/framework/plugins/server-core/core";
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
// The connection is a dedicated one on the DIRECT socket: pgbouncer's
// transaction pooling breaks a session-held lock.
// See research/2026-10-28-database-deferred-contract-phase.md.

// The advisory-lock class of the generation locks (the two-int4 form, so no
// key is shared with the jobs plugin's bigint job locks). Distinct from the
// runner's transaction-scoped schema-layer lock class.
const GENERATION_CLASS = 1835103860;

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
}

export interface SchemaGenerationLocksOptions {
  /**
   * The DIRECT socket (pgbouncer's transaction pooling breaks a session-held
   * lock). A function: the desktop's names this process's database, which
   * must not be asked at module load.
   */
  connectionString: () => string;
  /** Told each time a wait finds older generations still connected. */
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
        stack: err.stack ?? null,
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
