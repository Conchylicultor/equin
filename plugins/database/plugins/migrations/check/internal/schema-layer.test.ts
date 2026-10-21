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
 * Requires the running embedded cluster (`./singularity build` first).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { integer, pgView, text } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { renderPhasedMigration } from "@plugins/database/plugins/migrations/core";
import type { DeclaredView } from "@plugins/database/plugins/derived-views/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import {
  applySchemaLayerFrom,
  type Migration,
  type SchemaLayerInputs,
} from "../../server/internal/runner";

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
    query: sql`SELECT hash FROM __singularity_migrations ORDER BY hash`,
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
      { commit: true },
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
        },
      ),
    ).toEqual({ pending: 0, rollups: [] });
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
        { commit: true },
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
    const result = await applySchemaLayerFrom(
      t.db,
      [base, backfill, push],
      withViews(newView),
      { commit: false },
    );
    expect(result.pending).toBe(2);
    expect(await ledger(t)).toEqual(["0b0b0b0b"]);
    expect(await columns(t)).toEqual(["id", "old_name"]);
  });
});
