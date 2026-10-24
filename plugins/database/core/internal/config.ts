import { readFileSync } from "node:fs";

import { dbConfigDir } from "../../data-dirs";

export type DatabaseProvider = "embedded" | "system";

export interface DatabaseConfig {
  provider?: DatabaseProvider;
  connection: {
    host: string;
    port: number;
    user: string;
  };
  pgbouncer?: {
    host: string;
    port: number;
  };
  services: Array<{
    name: string;
    start: string[];
    ready: { unix: string } | { tcp: string };
    watchdog?: { intervalSec?: number };
  }>;
}

const CONFIG_PATH = dbConfigDir.file("database.json");

const SYSTEM_PG_DEFAULTS: DatabaseConfig = {
  connection: {
    host: "localhost",
    port: 5432,
    user: process.env.USER ?? "postgres",
  },
  services: [],
};

let cached: DatabaseConfig | null = null;

/**
 * THE reader for `~/.singularity/state/db-config/database.json`. Memoized for
 * the process lifetime; `CONFIG_PATH` is resolved at module load from the
 * `state/db-config` declaration (and so from `SINGULARITY_DIR`), so a process
 * that wants a different location must set `SINGULARITY_DIR` in its own
 * environment before this module is first imported (see the co-located
 * `config.test.ts`, which spawns a child for exactly that reason).
 *
 * ENOENT / malformed JSON are TOLERATED and fall back to `SYSTEM_PG_DEFAULTS`
 * ("no managed services, talk to a plain local Postgres"). That is deliberate:
 * the file is written by `./equin start`, so its absence means "this host
 * has no embedded cluster", not "this call is broken". Callers that genuinely
 * need a live cluster must fail on the *connection*, where the error names the
 * real problem — not here, where it could only say "file missing".
 *
 * Two hand-rolled copies of this reader used to exist (the CLI's `bin/paths.ts`
 * and the `migrations-in-sync` check) with DIVERGENT semantics: the CLI's threw
 * on ENOENT while the other two fell back, so the same missing file produced a
 * crash or a default depending on which entry point you came through. Keep
 * exactly one reader here.
 */
export function readDatabaseConfig(): DatabaseConfig {
  if (cached) return cached;
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    cached = JSON.parse(raw) as DatabaseConfig;
    return cached;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && !(err instanceof SyntaxError)) throw err;
    cached = SYSTEM_PG_DEFAULTS;
    return cached;
  }
}

/**
 * The libpq environment (`PGHOST` / `PGPORT` / `PGUSER`) for a child process or
 * a raw `pg.Client`, derived from `readDatabaseConfig()` — so it inherits that
 * function's single, tolerant failure semantics. An explicitly-set `PG*` in the
 * ambient environment always wins over the config file.
 */
export function libpqEnv(): Record<string, string> {
  const config = readDatabaseConfig();
  return {
    PGHOST: process.env.PGHOST ?? config.connection.host,
    PGPORT: process.env.PGPORT ?? String(config.connection.port),
    PGUSER: process.env.PGUSER ?? config.connection.user,
  };
}

/**
 * Build a libpq connection string from config connection params.
 * Hosts starting with "/" are treated as Unix-socket directories.
 */
export function buildConnectionString(
  conn: DatabaseConfig["connection"],
  database: string,
): string {
  if (conn.host.startsWith("/")) {
    return `postgres://${conn.user}@/${database}?host=${encodeURIComponent(conn.host)}&port=${conn.port}`;
  }
  return `postgres://${conn.user}@${conn.host}:${conn.port}/${database}`;
}

export { CONFIG_PATH as DATABASE_CONFIG_PATH };
