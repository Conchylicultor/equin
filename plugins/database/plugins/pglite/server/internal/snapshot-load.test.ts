import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HostStorage } from "@plugins/framework/plugins/browser-server/plugins/host-storage/core";
import {
  applySchemaLayer,
  isMigrationFileName,
  migrationsFrom,
} from "@plugins/database/plugins/migrations/server";
import { MIGRATIONS_DATA_DIR } from "@plugins/database/plugins/migrations/core";
import { MIGRATIONS_TABLE_NAME } from "@plugins/database/plugins/derived-views/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { createPgliteDriver } from "./pglite-driver";

// A database loaded from a snapshot taken earlier: the driver loads the
// snapshot's data directory (`databaseStart: snapshot`) and, before anything
// reads it, moves every timestamp the public tables hold by the snapshot's age
// — with triggers off, so a row's `updated_at` trigger or the change feed sees
// no change (the rows did not change; the clock they are read against did).
// Over the app's real schema (the committed migrations): the ledger's
// `applied_at` is the timestamp it moves, and a trigger refusing any update of
// the ledger proves none fired.
//
// In a FRESH bun process (this file, re-run as a child), as every PGlite suite
// here: PGlite picks its environment from `typeof window`, which an earlier
// suite in the shared process may have stubbed.

setDefaultTimeout(120_000);

const IN_CHILD = process.env.PGLITE_SNAPSHOT_LOAD_CHILD === "1";

if (!IN_CHILD) {
  test("a snapshot's database loads with its clock moved to now (in a fresh process)", async () => {
    const result = await spawnCaptured(
      [process.execPath, "test", import.meta.path],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, PGLITE_SNAPSHOT_LOAD_CHILD: "1" },
        timeoutMs: 110_000,
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `child exited ${result.exitCode}\n${result.stdout}\n${result.stderr}`,
      );
    }
  });
}

/** An in-memory storage that hands the database `start` and keeps what it adopts. */
type Adopted = Parameters<HostStorage["adopt"]>[0];

function memoryStorage(start: HostStorage["databaseStart"]): HostStorage & {
  adopted: Adopted[];
} {
  const adopted: Adopted[] = [];
  return {
    kind: "memory",
    databaseDir: undefined,
    databaseStart: start,
    store: () => {
      throw new Error("no host stores in this test");
    },
    adopt: (r) => adopted.push(r),
    adopted,
  };
}

async function openOn(storage: HostStorage): Promise<NodePgDatabase> {
  const driver = createPgliteDriver({ storage: () => storage });
  await driver.ready({ warm: false });
  return driver.db() as unknown as NodePgDatabase;
}

const NO_DERIVED = {
  views: [],
  derivedTables: [],
  updatedAtSpecs: [],
  triggers: [],
  claimedTriggerSets: [],
};

function committedMigrations() {
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

const Applied = z.object({ at: z.string() });
const HOUR_MS = 3_600_000;
const LEDGER = sql.raw(MIGRATIONS_TABLE_NAME);
/** The ledger's earliest `applied_at`, to the minute, in UTC. */
const firstApplied = sql`SELECT to_char(min(applied_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI') AS at FROM ${LEDGER}`;

describe.if(IN_CHILD)("a snapshot's database", () => {
  test("loads, every timestamp moved by its age, no trigger fired", async () => {
    const source = memoryStorage({ from: "stored-or-empty" });
    const db = await openOn(source);
    await applySchemaLayer(db, committedMigrations(), NO_DERIVED, {
      commit: true,
      deferContract: false,
    });
    // Any trigger firing on the ledger fails the load.
    await db.execute(
      sql.raw(`
        CREATE FUNCTION refuse_ledger_update() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'a trigger fired on the ledger'; END $$;
        CREATE TRIGGER refuse_ledger_update BEFORE UPDATE ON ${MIGRATIONS_TABLE_NAME}
          FOR EACH ROW EXECUTE FUNCTION refuse_ledger_update();
      `),
    );
    const [before] = await executeRows(db, {
      query: firstApplied,
      row: Applied,
    });
    expect(source.adopted).toHaveLength(1);
    const dataDir = await source.adopted[0]!.dump();

    const loaded = await openOn(
      memoryStorage({ from: "snapshot", dataDir, shiftMs: 2 * HOUR_MS }),
    );
    const [after] = await executeRows(loaded, {
      query: firstApplied,
      row: Applied,
    });
    expect(Date.parse(`${after!.at}Z`) - Date.parse(`${before!.at}Z`)).toBe(
      2 * HOUR_MS,
    );
  });
});
