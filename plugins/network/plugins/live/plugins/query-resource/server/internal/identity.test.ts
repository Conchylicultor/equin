import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  pgTable,
  pgView,
  integer,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";
import { resolveIdentity } from "./identity";

// ── Throwaway physical schema (no live DB) ─────────────────────────────────
const rows = pgTable("rows", {
  id: text("id").primaryKey(),
  parentId: text("parent_id"),
  n: integer("n").notNull(),
});
const junction = pgTable(
  "junction",
  { a: text("a").notNull(), b: text("b").notNull() },
  (t) => [primaryKey({ columns: [t.a, t.b] })],
);
const noPk = pgTable("no_pk", { x: text("x").notNull() });
const rowsView = pgView("rows_v").as((qb) => qb.select().from(rows));

// A structural entity (the `infra/entities` Entity shape the compiler detects).
const entity = {
  name: "widgets",
  table: rows,
  wireColumns: { id: rows.id, n: rows.n },
  schema: z.object({ id: z.string(), n: z.number() }),
};

describe("resolveIdentity", () => {
  test("PgTable: single pk, keyField = pk prop", () => {
    const r = resolveIdentity(rows, undefined, undefined);
    expect(r.rel).toBe(rows);
    expect(r.pkColumn).toBe(rows.id);
    expect(r.keyField).toBe("id");
    expect(r.selectMap).toBeUndefined();
  });

  test("Entity: reads its table, default projection = wireColumns", () => {
    const r = resolveIdentity(entity, undefined, undefined);
    expect(r.rel).toBe(rows);
    expect(r.pkColumn).toBe(rows.id);
    expect(r.keyField).toBe("id");
    expect(r.selectMap).toBe(entity.wireColumns);
  });

  test("alias projection: keyField is the alias, not the DB column", () => {
    const r = resolveIdentity(
      rows,
      { pk: rows.parentId },
      { conversationId: rows.parentId, n: rows.n },
    );
    expect(r.keyField).toBe("conversationId");
    expect(r.pkColumn).toBe(rows.parentId);
  });

  test("composite PK throws", () => {
    expect(() => resolveIdentity(junction, undefined, undefined)).toThrow(
      /composite primary key/,
    );
  });

  test("PgTable with no primary key throws", () => {
    expect(() => resolveIdentity(noPk, undefined, undefined)).toThrow(
      /no primary-key column/,
    );
  });

  test("a PgView has no spelling", () => {
    // A view's changes arrive under its base tables' names, which no route of
    // the view could state — so `RoutedSource` refuses it at compile time, and
    // the runtime refuses a cast-through one loudly.
    expect(() =>
      // @ts-expect-error a view is not a RoutedSource
      resolveIdentity(rowsView, { pk: rowsView.id }, undefined),
    ).toThrow(/unsupported `from` source/);
  });

  test("pk column not present in the projection throws", () => {
    expect(() => resolveIdentity(rows, undefined, { n: rows.n })).toThrow(
      /not present in the select projection/,
    );
  });
});
