import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { createDbPool } from "@plugins/database/plugins/connection/server";
import { DATABASE_CONFIG_PATH } from "@plugins/database/core";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";

// The worktree name is ONLY needed for the worktree (non-admin) connection
// string. `getAdminPool()` talks exclusively to the `postgres` system DB, so it
// must import and run in a process that declared no namespace at all (the
// self-contained launcher creates the app DB before any namespace exists). The
// ask is therefore deferred to first use of the worktree path via
// `runtimeNamespace()`, not run at module load — but it is still loud and never
// silently defaulted.

interface ConnConfig {
  host: string;
  port: number;
  user: string;
}

function readConn(): ConnConfig {
  const configPath = DATABASE_CONFIG_PATH;
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    return {
      host: process.env.PGHOST ?? raw.connection?.host ?? "localhost",
      port: Number(process.env.PGPORT ?? raw.connection?.port ?? 5432),
      user:
        process.env.PGUSER ??
        raw.connection?.user ??
        process.env.USER ??
        "postgres",
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && !(err instanceof SyntaxError)) throw err;
    return {
      host: process.env.PGHOST ?? "localhost",
      port: Number(process.env.PGPORT ?? 5432),
      user: process.env.PGUSER ?? process.env.USER ?? "postgres",
    };
  }
}

function buildConnString(conn: ConnConfig, database: string): string {
  if (conn.host.startsWith("/")) {
    return `postgres://${conn.user}@/${database}?host=${encodeURIComponent(conn.host)}&port=${conn.port}`;
  }
  return `postgres://${conn.user}@${conn.host}:${conn.port}/${database}`;
}

// Connection config is read lazily (on first use), not at module load. A pool
// must bind its config when it first connects, not when it is imported: the
// self-contained launcher writes database.json *during* boot, after this module
// is already imported, so an eager read would freeze to the no-config fallback
// and connect to the wrong Postgres. In a normal backend the gateway writes
// database.json before spawning us, so first use is always after the file
// exists — identical behavior, just deferred.
let cachedConn: ConnConfig | null = null;
function getConn(): ConnConfig {
  if (!cachedConn) cachedConn = readConn();
  return cachedConn;
}

// Worktree connection string for graphile-worker (the jobs worker, which only
// runs inside a real worktree backend, where a runtime namespace is always
// declared). It is the one export that genuinely needs the worktree name, so it
// is a lazy function — never evaluated at module load. Admin-only importers (such
// as the self-contained launcher, which never starts the jobs worker) leave it
// uncalled, so the module stays import-safe and `getAdminPool()` is reachable in
// a process with no namespace at all; calling this one there fails loud via
// `runtimeNamespace()` rather than returning a silent undefined.
export function connectionString(): string {
  return buildConnString(getConn(), runtimeNamespace());
}

// Both pools below are built by `createDbPool`, so opening a connection and
// every statement on them carry the connection plugin's deadline (60 s by
// default). Whole-database DDL — `CREATE DATABASE`, `DROP DATABASE … WITH
// (FORCE)`, `ALTER DATABASE … RENAME` — can legitimately run longer, and runs
// through `runDatabaseDdl` (./database-ddl) under its own bound and reason.
let adminPool: Pool | null = null;

export function getAdminPool(): Pool {
  if (!adminPool) {
    adminPool = createDbPool({
      name: "admin",
      connectionString: buildConnString(getConn(), "postgres"),
      max: 1,
      idleTimeoutMillis: 20_000,
    });
  }
  return adminPool;
}

/**
 * Release the admin pool's idle client, if one was ever opened.
 *
 * A NO-OP when nothing called `getAdminPool()` — which is the whole reason this
 * exists rather than callers writing `getAdminPool().end()`. That spelling
 * CREATES the pool in order to close it, so a process that never touched the
 * admin database would open a connection to `postgres` on its way out (and,
 * on a host with no database config, throw while doing it).
 *
 * The caller is a long-lived process ending: `./equin build` calls it from
 * its terminal funnel so the CLI exits immediately instead of waiting out the
 * pool's 20s idle timeout.
 */
export async function closeAdminPool(): Promise<void> {
  if (adminPool === null) return;
  const pool = adminPool;
  adminPool = null;
  await pool.end();
}

// An idle client's connection error (the socket dropping between one query and
// `end()`) is handled by `createDbPool` itself, as on every pool.
export function openShortLivedClient(dbName: string): Pool {
  return createDbPool({
    name: "admin-short-lived",
    connectionString: buildConnString(getConn(), dbName),
    max: 1,
    idleTimeoutMillis: 1_000,
  });
}

export function libpqSubprocessEnv(): Record<string, string> {
  const conn = getConn();
  return {
    PGHOST: conn.host,
    PGPORT: String(conn.port),
    PGUSER: conn.user,
  };
}
