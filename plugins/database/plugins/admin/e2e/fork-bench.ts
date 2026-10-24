/**
 * Fork benchmark — how long does forking the main DB into a worktree take, and
 * how big is the result?
 *
 * Manual only; nothing runs this automatically.
 *
 *   ./equin run plugins/database/plugins/admin/e2e/fork-bench.ts [--runs 3] [--source singularity]
 *
 * It drives `./equin db fork <scratch>` as a subprocess rather than
 * importing `forkDatabase` directly, for two reasons. The `e2e` runtime may
 * reach only other plugins' `core`/`e2e` barrels, so `admin/server` is out of
 * bounds by construction; and the subprocess IS the real path, exclusion
 * plumbing included, so a benchmark that goes green is evidence about the thing
 * users actually wait on.
 *
 * Postgres is reached through `@plugins/database/core`'s config helpers with a
 * plain `pg.Pool` — the same direct-connection shape the migration checks use
 * (`plugins/database/plugins/migrations/check/fork-schema-drift.ts`) for the
 * same barrel reason.
 *
 * The first run can carry the CLI's own startup (dependency bootstrap in
 * `bin/index.ts`), so per-run durations are printed rather than only a summary.
 */

import { CLI_NAME } from "@plugins/framework/plugins/cli/plugins/cli-name/core";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import {
  buildConnectionString,
  readDatabaseConfig,
} from "@plugins/database/core";
import {
  getWorktreeRoot,
  spawnCaptured,
} from "@plugins/infra/plugins/spawn/core";
import {
  arg,
  numArg,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const RUNS = numArg("runs", 3);
const SOURCE = arg("source", "singularity");

/** `assertSafeName` in admin/server accepts [A-Za-z0-9_-]; hex + `_` satisfies it. */
function scratchName(): string {
  return `forkbench_${randomBytes(4).toString("hex")}`;
}

function connString(database: string): string {
  const config = readDatabaseConfig();
  return buildConnectionString(
    {
      host: process.env.PGHOST ?? config.connection.host,
      port: Number(process.env.PGPORT ?? config.connection.port),
      user: process.env.PGUSER ?? config.connection.user,
    },
    database,
  );
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  // Even-length arrays average the two middle samples; `sorted` is non-empty
  // because RUNS is validated below, so both indexes always exist.
  return sorted.length % 2 === 1
    ? sorted[Math.floor(mid)]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

interface Breakdown {
  totalBytes: number;
  schemas: { name: string; bytes: number }[];
  tables: { name: string; bytes: number }[];
}

/** Size of the forked DB, decomposed by schema and by the largest public tables. */
async function measure(database: string, admin: Pool): Promise<Breakdown> {
  const total = await admin.query<{ bytes: string }>(
    "SELECT pg_database_size($1)::bigint AS bytes",
    [database],
  );
  const pool = new Pool({ connectionString: connString(database) });
  try {
    const schemas = await pool.query<{ name: string; bytes: string }>(
      `SELECT n.nspname AS name, sum(pg_total_relation_size(c.oid))::bigint AS bytes
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'm')
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        GROUP BY 1 ORDER BY 2 DESC`,
    );
    const tables = await pool.query<{ name: string; bytes: string }>(
      `SELECT c.relname AS name, pg_total_relation_size(c.oid)::bigint AS bytes
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY 2 DESC LIMIT 10`,
    );
    return {
      totalBytes: Number(total.rows[0]!.bytes),
      schemas: schemas.rows.map((r) => ({
        name: r.name,
        bytes: Number(r.bytes),
      })),
      tables: tables.rows.map((r) => ({
        name: r.name,
        bytes: Number(r.bytes),
      })),
    };
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  if (RUNS < 1) throw new Error(`--runs must be at least 1, got ${RUNS}`);
  const root = await getWorktreeRoot();
  const admin = new Pool({ connectionString: connString("postgres") });

  const durations: number[] = [];
  let last: Breakdown | undefined;

  try {
    for (let i = 1; i <= RUNS; i++) {
      const target = scratchName();
      console.log(`run ${i}/${RUNS}: forking "${SOURCE}" → "${target}"...`);
      try {
        const started = performance.now();
        const result = await spawnCaptured(
          [`./${CLI_NAME}`, "db", "fork", target],
          {
            // This harness exists to MEASURE how long a fork takes, on a box
            // deliberately loaded to make it slow. Any ceiling here would be a
            // cap on the measurement itself, turning the slowest and most
            // interesting run into a killed one.
            cwd: root,
            unbounded:
              "the duration of this child is the quantity being benchmarked; a ceiling would truncate the measurement",
          },
        );
        const elapsed = performance.now() - started;
        if (result.exitCode !== 0) {
          throw new Error(
            `./equin db fork ${target} exited ${result.exitCode}\n${
              result.stderr.trim() || result.stdout.trim()
            }`,
          );
        }
        durations.push(elapsed);
        last = await measure(target, admin);
        console.log(`  ${secs(elapsed)}   ${mb(last.totalBytes)}`);
      } finally {
        // Reclaim the scratch DB even when the fork or the measurement threw,
        // so an aborted run never leaves a ~1 GB orphan behind.
        await admin.query(`DROP DATABASE IF EXISTS "${target}" WITH (FORCE)`);
      }
    }

    console.log(`\nduration over ${RUNS} run(s)`);
    console.log(`  min    ${secs(Math.min(...durations))}`);
    console.log(`  median ${secs(median(durations))}`);
    console.log(`  max    ${secs(Math.max(...durations))}`);

    if (last) {
      console.log(`\nforked size ${mb(last.totalBytes)} (last run)`);
      console.log("  by schema");
      for (const s of last.schemas)
        console.log(`    ${s.name.padEnd(24)} ${mb(s.bytes)}`);
      console.log("  largest public tables");
      for (const t of last.tables)
        console.log(`    ${t.name.padEnd(24)} ${mb(t.bytes)}`);
    }
  } finally {
    await admin.end();
  }
}

await main();
