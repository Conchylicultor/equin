import { describe, expect, it } from "bun:test";
import { type SQL } from "drizzle-orm";
import {
  boolean,
  integer,
  PgDialect,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { orderByClauses, seekPredicate, type SortKey } from "./seek";

// Throwaway physical schema purely for SQL rendering in tests.
const t = pgTable("things", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }), // NULLABLE
  active: boolean("active").notNull(),
  score: integer("score").notNull(),
});

const dialect = new PgDialect();
const render = (s: SQL) => dialect.sqlToQuery(s);
const renderSql = (s: SQL | undefined) => (s ? render(s).sql : undefined);

const cols = {
  title: { col: t.title, nullable: false },
  status: { col: t.status, nullable: false },
  createdAt: { col: t.createdAt, nullable: false },
  endedAt: { col: t.endedAt, nullable: true },
} as const;

/** The declared keys, then the pk tiebreaker (asc, non-null) every compiler appends. */
function keysOf(
  rules: readonly (readonly [keyof typeof cols, "asc" | "desc"])[],
): SortKey[] {
  return [
    ...rules.map(([fieldId, dir]) => ({ fieldId, dir, ...cols[fieldId] })),
    { fieldId: "id", col: t.id, dir: "asc" as const, nullable: false },
  ];
}

describe("orderByClauses", () => {
  it("emits explicit NULLS LAST on every key, both directions", () => {
    const keys = keysOf([["endedAt", "desc"]]);
    const rendered = orderByClauses(keys).map(renderSql);
    expect(rendered).toEqual([
      `"things"."ended_at" DESC NULLS LAST`,
      `"things"."id" ASC NULLS LAST`,
    ]);
  });

  it("asc key renders ASC NULLS LAST", () => {
    const keys = keysOf([["title", "asc"]]);
    expect(orderByClauses(keys).map(renderSql)).toEqual([
      `"things"."title" ASC NULLS LAST`,
      `"things"."id" ASC NULLS LAST`,
    ]);
  });
});

describe("seekPredicate", () => {
  it("returns undefined for the first page (null cursor)", () => {
    const keys = keysOf([["createdAt", "desc"]]);
    expect(seekPredicate(keys, null)).toBeUndefined();
  });

  it("single non-nullable desc key + PK tiebreaker", () => {
    const keys = keysOf([["createdAt", "desc"]]);
    const d = new Date("2026-01-01T00:00:00.000Z");
    const q = render(seekPredicate(keys, [d, "abc"])!);
    // OR_0: after(createdAt) ; OR_1: eq(createdAt) AND after(id)
    expect(q.sql).toBe(
      `("things"."created_at" < $1 or ("things"."created_at" = $2 and "things"."id" > $3))`,
    );
    expect(q.params).toEqual([d, d, "abc"]);
  });

  it("ascending key uses > and ascending PK uses >", () => {
    const keys = keysOf([["title", "asc"]]);
    const q = render(seekPredicate(keys, ["m", "id-5"])!);
    expect(q.sql).toBe(
      `("things"."title" > $1 or ("things"."title" = $2 and "things"."id" > $3))`,
    );
    expect(q.params).toEqual(["m", "m", "id-5"]);
  });

  // THE SEAM CASE: nullable desc sort column with a NON-NULL cursor value must
  // include the trailing NULL rows in the after-term (NULLS LAST), else the
  // entire null region is skipped at the seam.
  it("nullable desc key with a non-null cursor includes OR IS NULL", () => {
    const keys = keysOf([["endedAt", "desc"]]);
    const d = new Date("2026-03-03T00:00:00.000Z");
    const q = render(seekPredicate(keys, [d, "abc"])!);
    expect(q.sql).toBe(
      `(("things"."ended_at" < $1 OR "things"."ended_at" IS NULL) or ("things"."ended_at" = $2 and "things"."id" > $3))`,
    );
    expect(q.params).toEqual([d, d, "abc"]);
  });

  // THE NULL-BOUNDARY CASE: cursor value on the nullable key is itself NULL (we
  // are mid-scroll inside the trailing null region). The after-term on that key
  // is dropped; the eq-term becomes `IS NULL` and the seek falls through to the
  // PK tiebreaker only.
  it("nullable key with a NULL cursor value falls through to the PK", () => {
    const keys = keysOf([["endedAt", "desc"]]);
    const q = render(seekPredicate(keys, [null, "abc"])!);
    // OR_0 (after endedAt) dropped; only OR_1: eq(endedAt IS NULL) AND id > $
    expect(q.sql).toBe(`("things"."ended_at" IS NULL and "things"."id" > $1)`);
    expect(q.params).toEqual(["abc"]);
  });

  it("two-level sort: eq-chain across both keys then PK", () => {
    const keys = keysOf([
      ["status", "asc"],
      ["createdAt", "desc"],
    ]);
    const d = new Date("2026-02-02T00:00:00.000Z");
    const q = render(seekPredicate(keys, ["open", d, "abc"])!);
    expect(q.sql).toBe(
      `("things"."status" > $1 or ("things"."status" = $2 and "things"."created_at" < $3) or ("things"."status" = $4 and "things"."created_at" = $5 and "things"."id" > $6))`,
    );
    expect(q.params).toEqual(["open", "open", d, "open", d, "abc"]);
  });
});
