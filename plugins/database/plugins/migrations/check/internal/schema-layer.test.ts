/**
 * Real-DB suite for the boot schema layer (`applySchemaLayerFrom`): a synthetic
 * phased push applied over a live view, and the layer's atomicity when a step
 * after the migrations fails. The from-scratch replay of the real `data/`
 * directory with the real derived layer is `schema-layer-replay.test.ts`.
 *
 * It sits in `check/`, not beside the runner in `server/`, because it needs the
 * throwaway-DB fixture: a `server/` test importing it would close the plugin
 * import cycle database → migrations → db-test-fixture → admin → database.
 * `check/` is outside that graph (imperative-create-table-allowlisted.ts uses
 * the fixture the same way).
 *
 * Requires the running embedded cluster (`./equin build` first).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { integer, pgView, text } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { renderPhasedMigration } from "@plugins/database/plugins/migrations/plugins/phases/core";
import type { DeclaredView } from "@plugins/database/plugins/derived-views/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import {
  applySchemaLayerFrom,
  type Migration,
  type SchemaLayerInputs,
} from "../../server/internal/runner";
import { MIGRATIONS_TABLE_NAME } from "@plugins/database/plugins/derived-views/core";

function mig(
  stamp: string,
  hash: string,
  slug: string,
  sqlText: string,
): Migration {
  return {
    file: `${stamp}_${hash}__${slug}.sql`,
    hash,
    sortKey: stamp.replace("_", ""),
    sqlText,
  };
}

function withViews(...views: DeclaredView[]): SchemaLayerInputs {
  return { views, derivedTables: [], updatedAtSpecs: [] };
}

// The pre-push history: a table with the column the push will retire.
const base = mig(
  "20260101_000000",
  "0b0b0b0b",
  "base",
  `CREATE TABLE "sl_widgets" ("id" integer PRIMARY KEY, "old_name" text);
   INSERT INTO "sl_widgets" VALUES (1, 'one'), (2, 'two');`,
);

// The live view reads the column the push drops.
const oldView: DeclaredView = {
  view: pgView("sl_widgets_v", { id: integer("id"), name: text("name") }).as(
    sql`SELECT "id", "old_name" AS "name" FROM "sl_widgets"`,
  ),
};

// One push: a new required column, a backfill that reads the old one, and the
// old one's drop — expand → data → contract.
const backfill = mig(
  "20260102_000000",
  "dddddddd",
  "backfill_name",
  `UPDATE "sl_widgets" SET "name" = upper("old_name");`,
);
const push = mig(
  "20260103_000000",
  "5a5a5a5a",
  "merged_20260103_0000",
  renderPhasedMigration({
    expand: `ALTER TABLE "sl_widgets" ADD COLUMN "name" text;`,
    contract: `ALTER TABLE "sl_widgets" ALTER COLUMN "name" SET NOT NULL;\nALTER TABLE "sl_widgets" DROP COLUMN "old_name";`,
    claims: ["20260102_000000__backfill_name"],
    supersedes: null,
  }),
);
const newView: DeclaredView = {
  view: pgView("sl_widgets_v", { id: integer("id"), name: text("name") }).as(
    sql`SELECT "id", "name" FROM "sl_widgets"`,
  ),
};

async function columns(t: TestDb): Promise<string[]> {
  const rows = await executeRows(t.db, {
    query: sql`SELECT column_name::text AS c FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'sl_widgets' ORDER BY c`,
    row: z.object({ c: z.string() }),
    label: "test: sl_widgets columns",
  });
  return rows.map((r) => r.c);
}

async function ledger(t: TestDb): Promise<string[]> {
  const rows = await executeRows(t.db, {
    query: sql`SELECT hash FROM ${sql.raw(MIGRATIONS_TABLE_NAME)} ORDER BY hash`,
    row: z.object({ hash: z.string() }),
    label: "test: ledger",
  });
  return rows.map((r) => r.hash);
}

async function viewRows(t: TestDb): Promise<{ id: number; name: string }[]> {
  return executeRows(t.db, {
    query: sql`SELECT id, name FROM sl_widgets_v ORDER BY id`,
    row: z.object({ id: z.number(), name: z.string() }),
    label: "test: view rows",
  });
}

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb({ prefix: "schema_layer_test" });
  await applySchemaLayerFrom(t.db, [base], withViews(oldView), {
    commit: true,
    deferContract: false,
  });
});

afterEach(async () => {
  await t.drop();
});

describe("applySchemaLayer", () => {
  test("a phased push applies over a live view reading the column it drops", async () => {
    expect(await viewRows(t)).toEqual([
      { id: 1, name: "one" },
      { id: 2, name: "two" },
    ]);

    const result = await applySchemaLayerFrom(
      t.db,
      [base, backfill, push],
      withViews(newView),
      { commit: true, deferContract: false },
    );

    expect(result.pending).toBe(2);
    expect(await columns(t)).toEqual(["id", "name"]);
    expect(await viewRows(t)).toEqual([
      { id: 1, name: "ONE" },
      { id: 2, name: "TWO" },
    ]);
    expect(await ledger(t)).toEqual(["0b0b0b0b", "5a5a5a5a", "dddddddd"]);

    // Steady state: nothing pending, nothing dropped, nothing re-run.
    expect(
      await applySchemaLayerFrom(
        t.db,
        [base, backfill, push],
        withViews(newView),
        {
          commit: true,
          deferContract: false,
        },
      ),
    ).toEqual({ pending: 0, rollups: [], deferredContract: null });
    expect(await viewRows(t)).toHaveLength(2);
  });

  test("a failure in the view rebuild leaves the ledger, the columns and the old views intact", async () => {
    const brokenView: DeclaredView = {
      view: pgView("sl_widgets_v", {
        id: integer("id"),
        name: text("name"),
      }).as(sql`SELECT "id", "no_such_column" AS "name" FROM "sl_widgets"`),
    };

    let error: unknown;
    try {
      await applySchemaLayerFrom(
        t.db,
        [base, backfill, push],
        withViews(brokenView),
        { commit: true, deferContract: false },
      );
    } catch (e) {
      error = e;
    }
    expect(String(error)).toContain("no_such_column");

    expect(await ledger(t)).toEqual(["0b0b0b0b"]);
    expect(await columns(t)).toEqual(["id", "old_name"]);
    // The old view is still there, still reading the old column.
    expect(await viewRows(t)).toEqual([
      { id: 1, name: "one" },
      { id: 2, name: "two" },
    ]);
  });

  test("the dry run applies the same layer and leaves the database untouched", async () => {
    // As `dryRunPendingMigrations` calls it: boot's deferring plan, then the
    // deferred run, in the one rolled-back transaction.
    const result = await applySchemaLayerFrom(
      t.db,
      [base, backfill, push],
      withViews(newView),
      { commit: false, deferContract: true },
    );
    expect(result.pending).toBe(2);
    expect(await ledger(t)).toEqual(["0b0b0b0b"]);
    expect(await columns(t)).toEqual(["id", "old_name"]);
  });

  test("the dry run fails a contract whose claimed data is not idempotent", async () => {
    // The backfill runs at boot and again before the deferred contract.
    const once = mig(
      "20260102_000000",
      "dddddddd",
      "backfill_name",
      `INSERT INTO "sl_widgets" ("id", "old_name", "name") VALUES (3, 'three', 'THREE');`,
    );
    let error: unknown;
    try {
      await applySchemaLayerFrom(t.db, [base, once, push], withViews(newView), {
        commit: false,
        deferContract: true,
      });
    } catch (e) {
      error = e;
    }
    expect(String(error)).toContain("duplicate key");
  });
});

async function pendingContracts(t: TestDb): Promise<string[]> {
  const rows = await executeRows(t.db, {
    query: sql`SELECT hash FROM ${sql.raw(MIGRATIONS_TABLE_NAME)} WHERE contract_pending ORDER BY hash`,
    row: z.object({ hash: z.string() }),
    label: "test: pending contracts",
  });
  return rows.map((r) => r.hash);
}

describe("the deferred contract", () => {
  test("boot leaves the last group's contract pending; the deferred run backfills what the old code wrote, then contracts", async () => {
    const boot = await applySchemaLayerFrom(
      t.db,
      [base, backfill, push],
      withViews(newView),
      { commit: true, deferContract: true },
    );
    expect(boot.deferredContract).toBe(push.file);
    // Expanded and backfilled; nothing tightened or dropped.
    expect(await columns(t)).toEqual(["id", "name", "old_name"]);
    expect(await ledger(t)).toEqual(["0b0b0b0b", "5a5a5a5a", "dddddddd"]);
    expect(await pendingContracts(t)).toEqual(["5a5a5a5a"]);

    // The previous backend's code, still serving: it knows only old_name.
    await t.db.execute(
      sql`INSERT INTO "sl_widgets" ("id", "old_name") VALUES (3, 'three')`,
    );

    // A second boot of the same code keeps deferring it.
    expect(
      (
        await applySchemaLayerFrom(
          t.db,
          [base, backfill, push],
          withViews(newView),
          { commit: true, deferContract: true },
        )
      ).deferredContract,
    ).toBe(push.file);

    const done = await applySchemaLayerFrom(
      t.db,
      [base, backfill, push],
      withViews(newView),
      { commit: true, deferContract: false },
    );
    expect(done).toEqual({ pending: 1, rollups: [], deferredContract: null });
    expect(await columns(t)).toEqual(["id", "name"]);
    expect(await pendingContracts(t)).toEqual([]);
    expect(await viewRows(t)).toEqual([
      { id: 1, name: "ONE" },
      { id: 2, name: "TWO" },
      { id: 3, name: "THREE" },
    ]);
  });

  test("a later push's boot completes an earlier pending contract before its own expand", async () => {
    await applySchemaLayerFrom(
      t.db,
      [base, backfill, push],
      withViews(newView),
      {
        commit: true,
        deferContract: true,
      },
    );
    const next = mig(
      "20260104_000000",
      "6b6b6b6b",
      "merged_20260104_0000",
      renderPhasedMigration({
        expand: `ALTER TABLE "sl_widgets" ADD COLUMN "old_name" integer;`,
        contract: `ALTER TABLE "sl_widgets" ALTER COLUMN "old_name" SET NOT NULL;`,
        claims: [],
        supersedes: null,
      }),
    );
    const result = await applySchemaLayerFrom(
      t.db,
      [base, backfill, push, next],
      withViews(newView),
      { commit: true, deferContract: true },
    );
    // `push`'s contract dropped the text old_name, so `next` re-adds it.
    expect(result.deferredContract).toBe(next.file);
    expect(await pendingContracts(t)).toEqual(["6b6b6b6b"]);
    expect(await columns(t)).toEqual(["id", "name", "old_name"]);
  });
});
