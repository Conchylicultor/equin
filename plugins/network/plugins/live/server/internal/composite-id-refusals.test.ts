import { describe, expect, test } from "bun:test";
import { integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { compositeKey } from "@plugins/network/plugins/live/plugins/query-resource/core";
import type { QueryDb } from "@plugins/network/plugins/live/plugins/query-resource/server";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { compileCollection } from "./serve-collection";

// A composite id (`compositeKey([...])`) is a whole ordered set's alone, over
// the table's composite primary key, field for column
// (research/2026-11-02-global-live-composite-key-collections.md, Decision 3).
// Everything else is refused at declaration or at compile, loudly.

const fields = {
  surface: textField({ label: "Surface" }),
  rowKey: textField({ label: "Row" }),
  idx: intField({ label: "Index" }),
  value: textField({ label: "Value" }),
};
const cells = pgTable(
  "cir_cells",
  {
    surface: text("surface").notNull(),
    rowKey: text("row_key").notNull(),
    idx: integer("idx").notNull(),
    value: text("value").notNull(),
  },
  (t) => [primaryKey({ columns: [t.surface, t.rowKey, t.idx] })],
);
const single = pgTable("cir_single", {
  surface: text("surface").primaryKey(),
  rowKey: text("row_key").notNull(),
  idx: integer("idx").notNull(),
  value: text("value").notNull(),
});
// Never run: every case throws at compile.
const db = {} as QueryDb;
let n = 0;
const key = () => `test.live.composite-refusal-${n++}`;
const scoped = (id: unknown) =>
  liveCollection(key(), {
    fields,
    id: id as never,
    all: {
      by: ["surface"],
      orderBy: [["value", "asc"]],
      unbounded: { reason: "test" },
    },
  });

describe("composite id refusals", () => {
  test("a window or a lookup-only collection cannot declare one", () => {
    expect(() =>
      liveCollection(key(), {
        fields,
        id: compositeKey(["surface", "rowKey", "idx"]) as never,
      }),
    ).toThrow(/only a whole ordered set \(`all`\) takes one/);
  });

  test("a scope naming every part holds one row", () => {
    expect(() =>
      liveCollection(key(), {
        fields,
        id: compositeKey(["surface", "rowKey"]),
        all: {
          by: ["surface", "rowKey"],
          orderBy: [["value", "asc"]],
          unbounded: { reason: "test" },
        },
      }),
    ).toThrow(/names every part of the composite id/);
  });

  test("a part that is no row field is refused", () => {
    expect(() => scoped(compositeKey(["surface", "nope" as "rowKey"]))).toThrow(
      /id part "nope" is not a field of the row/,
    );
  });

  test("the key must be the table's composite primary key, field for column, in order", () => {
    expect(() =>
      compileCollection(scoped(compositeKey(["surface", "rowKey", "idx"])), {
        from: single,
        db,
      }),
    ).toThrow(/composite key over 3 fields, but the base table/);
    expect(() =>
      compileCollection(scoped(compositeKey(["rowKey", "surface", "idx"])), {
        from: cells,
        db,
      }),
    ).toThrow(/does not read the primary key's column "surface"/);
  });

  test("a single id over a composite-keyed table names the composite spelling", () => {
    expect(() =>
      compileCollection(scoped("rowKey"), { from: cells, db }),
    ).toThrow(/declare the collection's id as `compositeKey\(\[\.\.\.\]\)`/);
  });
});
