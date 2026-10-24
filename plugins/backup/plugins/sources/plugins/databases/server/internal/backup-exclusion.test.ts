/**
 * `ExcludeFromBackup` end to end, against real Postgres: dump a database with
 * `traces` excluded, restore the archive into a second database, and check that
 * `traces` came back with its DDL and no rows while a kept table kept its row.
 *
 * Lives here rather than in `database/admin` because `admin` cannot import
 * `db-test-fixture` (the fixture imports `admin`); this plugin already imports
 * `admin`, so the test edge closes no cycle. The planner's rules are covered
 * without a database in admin's `backup-plan.test.ts`.
 *
 * Run: `./equin test plugins/backup/plugins/sources/plugins/databases`
 * (requires the running embedded cluster — `./equin build` first).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { pgClientBin } from "@plugins/database/plugins/client-tools/server";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import {
  backupDatabase,
  inspectBackup,
} from "@plugins/database/plugins/admin/server";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";

let source: TestDb;
let restored: TestDb;
let dir: string;

async function databaseName(db: NodePgDatabase): Promise<string> {
  const result = await db.execute(sql`SELECT current_database() AS name`);
  return z.object({ name: z.string() }).parse(result.rows[0]).name;
}

async function countRows(db: NodePgDatabase, table: string): Promise<number> {
  const result = await db.execute(
    sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}`,
  );
  return z.object({ n: z.number() }).parse(result.rows[0]).n;
}

beforeAll(async () => {
  source = await createTestDb({ prefix: "bk_excl_src" });
  restored = await createTestDb({ prefix: "bk_excl_dst" });
  dir = await mkdtemp(join(tmpdir(), "backup-exclusion-test-"));
  // The real schema, so `traces` and `tasks` carry their production DDL.
  await runMigrations(source.db);
  await source.db.execute(sql`
    INSERT INTO traces (worktree, trigger_kind, trigger_label, duration_ms, threshold_ms, snapshot)
    VALUES ('test', 'span', 'slow thing', 1200, 1000, '{}'::jsonb)
  `);
  await source.db.execute(
    sql`INSERT INTO tasks (id, title, rank) VALUES ('task-kept', 'kept row', 'a0')`,
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await source.drop();
  await restored.drop();
});

describe("backupDatabase with ExcludeFromBackup", () => {
  test("keeps the excluded table's DDL, drops its rows, keeps other rows", async () => {
    const name = await databaseName(source.db);
    const archive = join(dir, `${name}.dump`);

    const plan = await backupDatabase(
      name,
      archive,
      { tables: ["traces"] },
      { strict: true },
    );
    expect(plan.excludeTableData).toEqual(['"public"."traces"']);
    expect(plan.excludedTables).toEqual(["traces"]);
    expect(plan.unmatched).toEqual([]);

    const restore = await spawnCaptured(
      [pgClientBin("pg_restore"), "-d", restored.connectionString, archive],
      { timeoutMs: 120_000 },
    );
    expect(restore.stderr).toBe("");
    expect(restore.exitCode).toBe(0);

    // `traces` exists (the count would throw otherwise) and is empty.
    expect(await countRows(restored.db, "traces")).toBe(0);
    expect(await countRows(restored.db, "tasks")).toBe(1);

    const info = await inspectBackup(archive, name, plan.excludedTables);
    const byName = new Map(info.tables.map((t) => [t.name, t]));
    expect(byName.get("traces")?.rowsExcluded).toBe(true);
    expect(byName.get("tasks")?.rowsExcluded).toBe(false);
    expect(info.sizeBytes).toBeGreaterThan(0);
  });

  /**
   * `mail_messages` links to `mail_threads`, so leaving out the threads' rows
   * while keeping the messages makes an archive `pg_restore` cannot load. For
   * the running namespace's own database (strict) that is a bad declaration:
   * the planner refuses before `pg_dump` starts, naming the database.
   */
  test("strict: refuses a kept table linking to a left-out one, naming the database", async () => {
    const name = await databaseName(source.db);
    const out = join(dir, "kept-link.dump");

    const err = await backupDatabase(
      name,
      out,
      { tables: ["mail_threads"] },
      { strict: true },
    ).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    // The database, which is the fact that makes this diagnosable.
    expect(message).toContain(`database "${name}"`);
    // And the link itself, so the reader knows what to do about it.
    expect(message).toContain("mail_messages");
    expect(message).toContain("mail_threads");

    // Refused BEFORE pg_dump ran, so there is no half-written archive claiming
    // to be this database.
    expect(await Bun.file(out).exists()).toBe(false);
  });

  /**
   * The case that took the machine's backups down: another database on the
   * cluster, on an older schema that still links into a declared table. The
   * backup cannot migrate it, and leaving rows out only saves space — so the
   * linked table's rows are kept in this database, and the plan says why.
   */
  test("lenient: keeps a linked table's rows instead, and reports it", async () => {
    const name = await databaseName(source.db);
    const out = join(dir, "kept-for-link.dump");

    const plan = await backupDatabase(
      name,
      out,
      { tables: ["mail_threads", "traces"] },
      { strict: false },
    );

    expect(plan.excludedTables).toEqual(["traces"]);
    expect(new Set(plan.keptForLinks.map((k) => k.table))).toEqual(
      new Set(["mail_threads"]),
    );
    expect(plan.keptForLinks.map((k) => k.linkedFrom)).toContain(
      "mail_messages",
    );
    expect(await Bun.file(out).exists()).toBe(true);
  });

  test("a declared table the database lacks is reported, not fatal", async () => {
    const name = await databaseName(source.db);
    const plan = await backupDatabase(
      name,
      join(dir, "unmatched.dump"),
      { tables: ["no_such_table"] },
      { strict: true },
    );
    expect(plan.excludeTableData).toEqual([]);
    expect(plan.unmatched).toEqual([
      'table "public.no_such_table" does not exist in the source database',
    ]);
  });
});
