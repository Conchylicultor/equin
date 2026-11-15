/**
 * Real-DB suite for the schema layer's stamp (`server/internal/layer-stamp.ts`):
 * what an `exec` child reads instead of running the layer itself. In `check/`
 * beside `schema-layer.test.ts`, for the same reason (the throwaway-DB fixture
 * would close an import cycle from `server/`).
 *
 * Requires the running embedded cluster (`./equin build` first).
 */

import { testSchemaOwner } from "@plugins/framework/plugins/server-core/core/testing";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { integer, pgView } from "drizzle-orm/pg-core";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import type { DeclaredView } from "@plugins/database/plugins/derived-views/server";
import {
  applySchemaLayerFrom,
  type Migration,
  type SchemaLayerInputs,
} from "../../server/internal/runner";
import {
  recordSchemaLayerStamp,
  schemaLayerStamp,
} from "../../server/internal/layer-stamp";
import { verifySchemaLayer } from "../../server/internal/layer-verify";

const base: Migration = {
  file: "20260101_000000_0c0c0c0c__base.sql",
  hash: "0c0c0c0c",
  sortKey: "20260101000000",
  sqlText: `CREATE TABLE "st_widgets" ("id" integer PRIMARY KEY);`,
};
const next: Migration = {
  file: "20260102_000000_0d0d0d0d__next.sql",
  hash: "0d0d0d0d",
  sortKey: "20260102000000",
  sqlText: `ALTER TABLE "st_widgets" ADD COLUMN "n" integer;`,
};

function view(body: string): DeclaredView {
  return {
    view: pgView("st_widgets_v", { id: integer("id") }).as(sql.raw(body)),
  };
}

function inputs(...views: DeclaredView[]): SchemaLayerInputs {
  return {
    views,
    derivedTables: [],
    updatedAtSpecs: [],
    triggers: [],
    claimedTriggerSets: [],
  };
}

/** What a serving host's boot does: the layer, then (at `onReady`) its stamp. */
async function ownerBoot(
  t: TestDb,
  migrations: Migration[],
  layerInputs: SchemaLayerInputs,
): Promise<void> {
  const { stamp } = await applySchemaLayerFrom(t.db, migrations, layerInputs, {
    commit: true,
    owner: testSchemaOwner(),
    deferContract: false,
  });
  await recordSchemaLayerStamp(t.db, testSchemaOwner(), stamp);
}

const v1 = view(`SELECT "id" FROM "st_widgets"`);
const v2 = view(`SELECT "id" FROM "st_widgets" WHERE "id" > 0`);

describe("schemaLayerStamp", () => {
  test("is a function of the migrations and of every derived input", () => {
    const a = schemaLayerStamp([base], inputs(v1));
    expect(schemaLayerStamp([base], inputs(v1))).toBe(a);
    expect(schemaLayerStamp([base, next], inputs(v1))).not.toBe(a);
    expect(schemaLayerStamp([base], inputs(v2))).not.toBe(a);
    expect(
      schemaLayerStamp([base], { ...inputs(v1), claimedTriggerSets: ["x"] }),
    ).not.toBe(a);
  });

  test("ignores the framework's own marks on a contribution, and declaration order", () => {
    const set = (id: string, description: string) =>
      ({
        id,
        functions: [],
        triggers: [],
        _pluginDescription: description,
      }) as SchemaLayerInputs["triggers"][number];
    const a = schemaLayerStamp([base], {
      ...inputs(),
      triggers: [set("a", "old words"), set("b", "x")],
    });
    expect(
      schemaLayerStamp([base], {
        ...inputs(),
        triggers: [set("b", "y"), set("a", "new words")],
      }),
    ).toBe(a);
  });

  test("refuses a declaration that is not plain data", () => {
    class NotData {
      readonly id = "set";
    }
    expect(() =>
      schemaLayerStamp([base], {
        ...inputs(),
        triggers: [
          {
            id: "set",
            functions: [],
            triggers: [],
            // A class instance where data belongs: the digest cannot vouch for it.
            ...({ extra: new NotData() } as object),
          },
        ],
      }),
    ).toThrow(/not plain data/);
  });
});

describe("verifySchemaLayer", () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb({ prefix: "schema_stamp_test" });
  });
  afterEach(async () => {
    await t.drop();
  });

  test("a database no owner ever set up is not ready", async () => {
    const check = await verifySchemaLayer(t.db, [base], inputs(v1));
    expect(check.kind).toBe("not-ready");
  });

  test("ready for the code whose layer the owner committed, not for other code", async () => {
    await ownerBoot(t, [base], inputs(v1));
    expect((await verifySchemaLayer(t.db, [base], inputs(v1))).kind).toBe(
      "ready",
    );
    // A push's migration the owner has not applied yet.
    expect((await verifySchemaLayer(t.db, [base, next], inputs(v1))).kind).toBe(
      "not-ready",
    );
    // A view edit the owner has not installed yet.
    expect((await verifySchemaLayer(t.db, [base], inputs(v2))).kind).toBe(
      "not-ready",
    );
  });

  test("a stamp whose migrations the ledger lacks admits nobody (a revert, a copied stamp)", async () => {
    // Newer code booted and stamped, then an older owner rebuilt the database
    // without the newer migration: modelled by stamping [base, next] over a
    // database that applied only [base].
    await ownerBoot(t, [base], inputs(v1));
    await recordSchemaLayerStamp(
      t.db,
      testSchemaOwner(),
      schemaLayerStamp([base, next], inputs(v1)),
    );
    const check = await verifySchemaLayer(t.db, [base, next], inputs(v1));
    expect(check.kind).toBe("not-ready");
    if (check.kind === "not-ready")
      expect(check.detail).toContain("not applied");
  });

  test("the layer alone records nothing: the owner stamps once its whole boot DDL committed", async () => {
    await applySchemaLayerFrom(t.db, [base], inputs(v1), {
      commit: true,
      owner: testSchemaOwner(),
      deferContract: false,
    });
    expect((await verifySchemaLayer(t.db, [base], inputs(v1))).kind).toBe(
      "not-ready",
    );
  });

  test("a rolled-back dry run leaves the owner's stamp", async () => {
    await ownerBoot(t, [base], inputs(v1));
    await applySchemaLayerFrom(t.db, [base, next], inputs(v2), {
      commit: false,
      deferContract: false,
    });
    expect((await verifySchemaLayer(t.db, [base], inputs(v1))).kind).toBe(
      "ready",
    );
  });
});
