import { test, expect } from "bun:test";
import {
  integer,
  jsonb,
  pgSchema,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  compileFromTable,
  deriveUpdatedAt,
  derivedUpdatedAt,
  insertWithUpdatedAt,
} from "./from-table";

// `compileFromTable` / `deriveUpdatedAt` on raw drizzle tables. That it compiles
// the same spec as the equivalent `defineEntity` is pinned in infra/entities
// (derived-updated-at.test.ts) — this plugin cannot import entities.

type Status = "idle" | "working" | "done";

function itemsTable(name: string) {
  return pgTable(name, {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    status: text("status").$type<Status>().notNull(),
    lastViewedAt: timestamp("seen_at", { withTimezone: true }),
    updatedAt: derivedUpdatedAt(),
  });
}

test("reads physical column names and SQL types off the table", () => {
  const spec = compileFromTable(itemsTable("dua_raw_items"), {
    id: false,
    title: true,
    status: { into: ["working"] },
    lastViewedAt: true,
  });
  expect(spec.table).toBe("dua_raw_items");
  expect(spec.triggerName).toBe("dua_raw_items_derive_updated_at");
  expect(spec.functionDdl).toContain(
    `NEW."seen_at" IS DISTINCT FROM OLD."seen_at"`,
  );
  expect(spec.functionDdl).not.toContain("last_viewed_at");
  expect(spec.functionDdl).toContain(`NEW."status" IN ('working')`);
  expect(spec.functionDdl).toContain(`NEW."updated_at" := now()`);
});

test("deriveUpdatedAt returns the table and registers its spec", () => {
  const table = itemsTable("dua_raw_registered");
  const touchedBy = {
    id: false,
    title: true,
    status: false,
    lastViewedAt: false,
  } as const;
  expect(deriveUpdatedAt(table, { touchedBy })).toBe(table);
  // Registered: the same table declared again with different rules conflicts.
  expect(() =>
    deriveUpdatedAt(itemsTable("dua_raw_registered"), {
      touchedBy: { ...touchedBy, title: false },
    }),
  ).toThrow(/declared twice with different touchedBy rules/);
});

test("runtime backstops for callers the types cannot see", () => {
  expect(() =>
    compileFromTable(itemsTable("dua_raw_partial"), {
      id: false,
      title: true,
      bogus: true,
    }),
  ).toThrow(
    /deriveUpdatedAt\("dua_raw_partial"\): touchedBy must classify every column but updatedAt exactly once; missing: status, lastViewedAt; not a column: bogus/,
  );
  expect(() =>
    compileFromTable(pgTable("dua_raw_no_col", { id: text("id") }), {
      id: false,
    }),
  ).toThrow(/has no updatedAt column/);
  expect(() =>
    compileFromTable(
      pgSchema("other").table("dua_raw_schema", {
        id: text("id"),
        updatedAt: timestamp("updated_at"),
      }),
      { id: false },
    ),
  ).toThrow(/in schema "other"/);
  expect(() =>
    compileFromTable(itemsTable("dua_raw_where"), {}, "custom site"),
  ).toThrow(/^custom site must classify/);
});

// ── Type tests (never run: they would register tables) ──────────────────────
// Each `@ts-expect-error` line is a declaration the types must refuse.
function _typeTests(): void {
  const t = itemsTable("t_types");

  // A column nobody classified.
  deriveUpdatedAt(t, {
    // @ts-expect-error — lastViewedAt is missing from touchedBy
    touchedBy: { id: false, title: true, status: true },
  });

  // A column that does not exist.
  deriveUpdatedAt(t, {
    touchedBy: {
      id: false,
      title: true,
      status: true,
      lastViewedAt: false,
      // @ts-expect-error — not a column of the table
      bogus: true,
    },
  });

  // A transition value that is not one of the column's values.
  deriveUpdatedAt(t, {
    touchedBy: {
      id: false,
      title: true,
      // @ts-expect-error — "wroking" is not a Status
      status: { into: ["wroking"] },
      lastViewedAt: false,
    },
  });

  // exceptKeys on a scalar column (no keys to except).
  deriveUpdatedAt(t, {
    touchedBy: {
      id: false,
      // @ts-expect-error — title is text, not a jsonb object
      title: { exceptKeys: ["icon"] },
      status: true,
      lastViewedAt: false,
    },
  });

  // exceptKeys naming a key the jsonb object cannot carry.
  const withJson = pgTable("t_json", {
    id: text("id"),
    data: jsonb("data").$type<{ title: string; icon: string | null }>(),
    updatedAt: derivedUpdatedAt(),
  });
  deriveUpdatedAt(withJson, {
    // @ts-expect-error — "cover" is not a key of the data object
    touchedBy: { id: false, data: { exceptKeys: ["cover"] } },
  });
  deriveUpdatedAt(withJson, {
    touchedBy: { id: false, data: { exceptKeys: ["icon"] } },
  });

  // updatedAt classifying itself.
  deriveUpdatedAt(t, {
    touchedBy: {
      id: false,
      title: true,
      status: true,
      lastViewedAt: false,
      // @ts-expect-error — updatedAt is the derived column, not an input
      updatedAt: false,
    },
  });

  // A raw table whose updatedAt is a plain, writable timestamp cannot derive
  // one: its typed writes could still name it. `derivedUpdatedAt()` it.
  const writable = pgTable("t_writable", {
    id: text("id"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  });
  // @ts-expect-error — updatedAt is not declared with derivedUpdatedAt()
  deriveUpdatedAt(writable, { touchedBy: { id: false } });

  // A derived updatedAt has no typed write: not in an insert's values, an
  // update's SET or an upsert's SET; only insertWithUpdatedAt (INSERT, history)
  // names it.
  const db = drizzle.mock();
  const row: (typeof t)["$inferInsert"] = {
    id: "a",
    title: "x",
    status: "idle",
    // @ts-expect-error — derived, not in the insert model
    updatedAt: new Date(),
  };
  void db.update(t).set({
    // @ts-expect-error — derived, not in an update's SET
    updatedAt: new Date(),
  });
  void db
    .insert(t)
    .values(row)
    .onConflictDoUpdate({
      target: t.id,
      set: {
        // @ts-expect-error — derived, not in an upsert's SET
        updatedAt: new Date(),
      },
    });
  void insertWithUpdatedAt(db, t, [
    { id: "a", title: "x", status: "idle", updatedAt: new Date() },
  ]);

  // A table WITHOUT updatedAt cannot derive one.
  const noUpdatedAt = pgTable("t_no_col", { id: text("id"), n: integer("n") });
  // @ts-expect-error — no updatedAt column to derive
  deriveUpdatedAt(noUpdatedAt, { touchedBy: { id: false, n: true } });

  // The well-formed spellings compile, nullable columns included.
  deriveUpdatedAt(t, {
    touchedBy: {
      id: false,
      title: true,
      status: { into: ["working", "done"], outOf: ["working"] },
      lastViewedAt: { into: [null] },
    },
  });
}
void _typeTests;
