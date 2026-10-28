/**
 * The discrimination, pinned: which schemas get a decoder and which do not.
 *
 * The `z.unknown()` case is the design's central claim as a test — the schema is
 * the dial, so a schema that declares nothing gets no decoder and pays nothing.
 * The `z.any()` case is the one next to it that must NOT take that branch: `any`
 * is assignable to every declared type, so skipping the decoder there would let
 * a `jsonField<Foo>({ schema: z.any() })` declare `Foo` with nothing behind it.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { is } from "drizzle-orm";
import { pgTable, PgCustomColumn } from "drizzle-orm/pg-core";
import { SqlColumnError } from "@plugins/database/plugins/sql-column/server/testing";
import { decode } from "./storage";

const CallerSchema = z.object({ caller: z.string(), count: z.number() });

const t = pgTable("json_storage_probe", {
  anything: decode("anything", z.unknown()),
  callers: decode("callers", z.array(CallerSchema)),
  bag: decode("bag", z.record(z.string(), z.unknown())),
});

describe("a schema that does not narrow the column", () => {
  test("gets a plain jsonb column — no decoder, nothing to pay", () => {
    expect(t.anything.getSQLType()).toBe("jsonb");
    expect(is(t.anything, PgCustomColumn)).toBe(false);
    expect(t.anything.mapFromDriverValue({ shape: "whatever" })).toEqual({
      shape: "whatever",
    });
  });

  test("`z.any()` still decodes — `any` would prove nothing", () => {
    const anySchema = pgTable("json_storage_any", {
      c: decode("c", z.any() as z.ZodType<unknown>),
    });
    expect(is(anySchema.c, PgCustomColumn)).toBe(true);
    // `z.any().parse` is a pass-through: it costs nothing and claims nothing.
    expect(anySchema.c.mapFromDriverValue({ a: 1 })).toEqual({ a: 1 });
  });
});

describe("a schema that narrows the column", () => {
  test("gets a decoder that really runs, on a column that is still `jsonb`", () => {
    expect(is(t.callers, PgCustomColumn)).toBe(true);
    // `jsonb` in the DDL is what makes adopting this generate no migration.
    expect(t.callers.getSQLType()).toBe("jsonb");
    expect(
      t.callers.mapFromDriverValue([{ caller: "boot", count: 2 }]),
    ).toEqual([{ caller: "boot", count: 2 }]);
  });

  test("throws on an out-of-shape read, naming the qualified column", () => {
    let err: unknown;
    try {
      t.callers.mapFromDriverValue([{ caller: "boot", count: "two" }]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SqlColumnError);
    expect((err as SqlColumnError).label).toBe("json_storage_probe.callers");
    expect((err as SqlColumnError).direction).toBe("read");
  });

  test("a `z.record` keeps every key — weak, but real", () => {
    // It verifies the value is a non-null object, which is exactly what
    // `Record<string, unknown>` claims, and it drops nothing.
    expect(t.bag.mapFromDriverValue({ a: 1, b: [2] })).toEqual({
      a: 1,
      b: [2],
    });
    expect(() => t.bag.mapFromDriverValue("not an object")).toThrow(
      SqlColumnError,
    );
  });
});
