import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { HostStorage } from "@plugins/framework/plugins/browser-server/plugins/host-storage/core";
import {
  applySchemaLayer,
  isMigrationFileName,
  migrationsFrom,
  type Migration,
} from "@plugins/database/plugins/migrations/server";
import {
  migrationClaimId,
  parseMigration,
} from "@plugins/database/plugins/migrations/plugins/phases/core";
import { MIGRATIONS_DATA_DIR } from "@plugins/database/plugins/migrations/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { MIGRATIONS_TABLE_NAME } from "@plugins/database/plugins/derived-views/core";
import { createPgliteDriver } from "./pglite-driver";

// A browser host's stored database across a new version: the migrations a
// persistent host runs at boot apply over data an earlier version left — the
// browser keeps it in IndexedDB; here the same engine keeps it on disk
// (PGlite's `nodefs`), which is what persistence changes for the runner: a
// database reopened with its ledger, not a fresh one.
//
// 1. Open a persistent PGlite (through the driver, under a storage whose
//    `databaseDir` is a temp dir), apply the committed history up to just
//    before its LAST phased group that claims data migrations — so the next
//    version's group is expand → claimed data → contract — and write a
//    visitor's row into a real table the next version's files never name.
//    Close it (the storage's close, as on a handoff).
// 2. Reopen it from disk with the whole history: the pending group applies,
//    the ledger holds every file, and the visitor's row is still there.
//    (A table created here would be a scratch table the imperative-table
//    check rightly refuses; a row in the app's own schema is the real case.)
//
// In a FRESH bun process (this file, re-run as a child), as every PGlite suite
// here: PGlite picks its environment from `typeof window`, which an earlier
// suite in the shared process may have stubbed.

setDefaultTimeout(300_000);

const IN_CHILD = process.env.PGLITE_STORED_DATA_CHILD === "1";

if (!IN_CHILD) {
  test("migrations apply over a stored PGlite database (in a fresh process)", async () => {
    const result = await spawnCaptured(
      [process.execPath, "test", import.meta.path],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, PGLITE_STORED_DATA_CHILD: "1" },
        timeoutMs: 280_000,
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `PGlite stored-data child exited ${result.exitCode}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
      );
    }
    expect(result.exitCode).toBe(0);
  });
}

const NO_DERIVED = {
  views: [],
  derivedTables: [],
  updatedAtSpecs: [],
  triggers: [],
  claimedTriggerSets: [],
};

function committedMigrations(): Migration[] {
  const dir = join(REPO_ROOT, MIGRATIONS_DATA_DIR);
  return migrationsFrom(
    readdirSync(dir)
      .filter(isMigrationFileName)
      .map((file) => ({
        file,
        sqlText: readFileSync(join(dir, file), "utf8"),
      })),
  );
}

/**
 * Where to cut the history: the first file of its last phased group that
 * claims data migrations (the earliest of those it claims), and the group.
 */
function lastClaimingGroup(all: Migration[]): {
  cut: number;
  claimer: Migration;
  claimed: Migration[];
} {
  const byClaimId = new Map(all.map((m) => [migrationClaimId(m.file), m]));
  for (let i = all.length - 1; i >= 0; i--) {
    const parsed = parseMigration(all[i]!.sqlText);
    if (parsed.kind !== "phased" || parsed.claims.length === 0) continue;
    const claimed = parsed.claims.map((id) => {
      const m = byClaimId.get(id);
      if (m === undefined) throw new Error(`claim ${id} names no file`);
      return m;
    });
    const cut = Math.min(...claimed.map((m) => all.indexOf(m)));
    return { cut, claimer: all[i]!, claimed };
  }
  throw new Error("the committed history has no phased group with claims");
}

/** A persistent storage over a directory: the driver opens PGlite on it and adopts it. */
function diskStorage(dir: string): HostStorage & { close(): Promise<void> } {
  const adopted: Parameters<HostStorage["adopt"]>[0][] = [];
  return {
    kind: "persistent",
    databaseDir: dir,
    store: () => {
      throw new Error("no host stores in this test");
    },
    adopt: (r) => adopted.push(r),
    async close() {
      for (const r of adopted) await r.close();
    },
  };
}

async function openOn(storage: HostStorage): Promise<NodePgDatabase> {
  const driver = createPgliteDriver({ storage: () => storage });
  await driver.ready({ warm: false });
  return driver.db() as unknown as NodePgDatabase;
}

const LedgerRow = z.object({ hash: z.string() });
const CountRow = z.object({ n: z.number() });
const ColumnRow = z.object({
  table_name: z.string(),
  column_name: z.string(),
  data_type: z.string(),
  required: z.boolean(),
});

/**
 * Write what a visitor would have: one row in a real table of the earlier
 * schema that none of the `pending` migrations names (so the next version
 * must carry it over untouched) and whose required columns are all text (so
 * it can be filled without knowing the table). Returns where to find it.
 */
async function writeVisitorRow(
  db: NodePgDatabase,
  pending: Migration[],
): Promise<{ table: string; column: string; value: string }> {
  const columns = await executeRows(db, {
    query: sql`SELECT c.table_name, c.column_name, c.data_type,
                 (c.is_nullable = 'NO' AND c.column_default IS NULL) AS required
               FROM information_schema.columns c
               JOIN information_schema.tables t
                 ON t.table_schema = c.table_schema AND t.table_name = c.table_name
               WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
               ORDER BY c.table_name, c.ordinal_position`,
    row: ColumnRow,
  });
  const byTable = new Map<string, z.infer<typeof ColumnRow>[]>();
  for (const c of columns) {
    byTable.set(c.table_name, [...(byTable.get(c.table_name) ?? []), c]);
  }
  const pendingText = pending.map((m) => m.sqlText).join("\n");
  for (const [table, cols] of [...byTable].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (pendingText.includes(table)) continue;
    const required = cols.filter((c) => c.required);
    if (required.length === 0) continue;
    if (!required.every((c) => c.data_type === "text")) continue;
    const value = `stored-before-the-update`;
    await db.execute(
      sql`INSERT INTO ${sql.identifier(table)} (${sql.join(
        required.map((c) => sql.identifier(c.column_name)),
        sql`, `,
      )}) VALUES (${sql.join(
        required.map(() => sql`${value}`),
        sql`, `,
      )})`,
    );
    return { table, column: required[0]!.column_name, value };
  }
  throw new Error("no table of the earlier schema fits a visitor's row");
}

describe.if(IN_CHILD)("a stored PGlite database across a new version", () => {
  const dir = mkdtempSync(join(tmpdir(), "pglite-stored-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("the next version's migrations — a phased group with claimed data — apply over it, and its rows survive", async () => {
    const all = committedMigrations();
    const { cut, claimer, claimed } = lastClaimingGroup(all);
    const earlier = all.slice(0, cut);
    expect(earlier.length).toBeGreaterThan(0);

    // The earlier version: its history, then what a visitor wrote.
    const first = diskStorage(dir);
    const before = await openOn(first);
    const r1 = await applySchemaLayer(before, earlier, NO_DERIVED, {
      commit: true,
      deferContract: false,
    });
    expect(r1.pending).toBe(earlier.length);
    const visitor = await writeVisitorRow(before, all.slice(cut));
    await first.close();

    // The next version, on the same stored database.
    const second = diskStorage(dir);
    const after = await openOn(second);
    const r2 = await applySchemaLayer(after, all, NO_DERIVED, {
      commit: true,
      deferContract: false,
    });
    expect(r2.pending).toBe(all.length - earlier.length);
    const ledger = new Set(
      (
        await executeRows(after, {
          query: sql`SELECT hash FROM ${sql.raw(MIGRATIONS_TABLE_NAME)}`,
          row: LedgerRow,
        })
      ).map((r) => r.hash),
    );
    for (const m of [claimer, ...claimed])
      expect(ledger.has(m.hash)).toBe(true);
    expect(all.filter((m) => !ledger.has(m.hash)).map((m) => m.file)).toEqual(
      [],
    );
    const kept = await executeRows(after, {
      query: sql`SELECT count(*)::int AS n FROM ${sql.identifier(visitor.table)} WHERE ${sql.identifier(visitor.column)} = ${visitor.value}`,
      row: CountRow,
    });
    expect(kept).toEqual([{ n: 1 }]);
    await second.close();
  });
});
