/**
 * Fresh-install guard: the WHOLE real `data/` directory, replayed from an empty
 * database through the boot schema layer with the real derived layer (every
 * view, rollup table and derived-`updatedAt` trigger main declares), applies.
 * A fresh install and a release both start from an empty base DB, so a phase
 * group, a claim or a derived object that only works on top of an existing
 * database would break them and nothing else.
 *
 * The derived inputs are gathered exactly as `migration-applies-clean` gathers
 * them (this process never boots either), which is why the suite sits here.
 *
 * Requires the running embedded cluster (`./singularity build` first).
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { applySchemaLayer } from "@plugins/database/plugins/migrations/server";
import {
  listMigrationFiles,
  MIGRATIONS_DIR,
} from "@plugins/database/plugins/migrations/machine";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { declaredSchemaInputs } from "./declared-schema-inputs";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "schema_replay_test" });
});

afterAll(async () => {
  await t.drop();
});

test("the whole data/ directory plus the real derived layer applies from scratch", async () => {
  const declared = await declaredSchemaInputs(await getWorktreeRoot());
  if (!declared.ok) throw new Error(declared.message);
  const { inputs } = declared;

  const result = await applySchemaLayer(
    t.db,
    listMigrationFiles(MIGRATIONS_DIR),
    inputs,
    {
      commit: true,
    },
  );
  expect(result.pending).toBeGreaterThan(0);

  const views = await executeRows(t.db, {
    query: sql`SELECT count(*)::int AS n FROM information_schema.views WHERE table_schema = 'public'`,
    row: z.object({ n: z.number() }),
    label: "test: live views",
  });
  expect(views[0]?.n).toBe(inputs.views.length);

  // Every declared rollup was created and reconciled on the way.
  expect(result.rollups.map((r) => r.table).sort()).toEqual(
    inputs.derivedTables.map((r) => r.table).sort(),
  );
  expect(result.rollups.every((r) => r.definitionChanged)).toBe(true);

  // A second boot over the result finds nothing to do: no migration, no
  // rollup definition, and a reconcile that heals nothing.
  expect(
    await applySchemaLayer(t.db, listMigrationFiles(MIGRATIONS_DIR), inputs, {
      commit: true,
    }),
  ).toEqual({
    pending: 0,
    rollups: inputs.derivedTables
      .map((r) => ({
        table: r.table,
        upserted: 0,
        deleted: 0,
        definitionChanged: false,
      }))
      .sort((a, b) => a.table.localeCompare(b.table)),
  });
}, 300_000); // Importing every server barrel, then ~270 migrations.
