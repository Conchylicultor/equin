/**
 * The discrimination, pinned: which schemas get a decoder and which do not.
 *
 * The second test is the COST claim as a test. Decoding a column that is not
 * narrowed costs the same as decoding one that is (345 ns vs 322 ns per value)
 * for zero guarantee, so a plain `textField()` must keep a plain `text` column.
 * If that ever regresses, every string column in the repo silently starts paying
 * for a `z.string().parse` that verifies nothing.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { is } from "drizzle-orm";
import { pgTable, PgCustomColumn } from "drizzle-orm/pg-core";
import { SqlColumnError } from "@plugins/database/plugins/sql-column/server/testing";
import { tolerantEnum } from "@plugins/primitives/plugins/live-state/core";
import { decode } from "./storage";

const KindSchema = z.enum(["user", "agent", "system"]);

const t = pgTable("text_storage_probe", {
  plain: decode("plain", z.string()),
  refined: decode("refined", z.string().min(1)),
  kind: decode("kind", KindSchema),
});

describe("a schema that does not narrow the column", () => {
  test("gets a plain text column — no decoder, nothing to pay", () => {
    expect(t.plain.getSQLType()).toBe("text");
    expect(is(t.plain, PgCustomColumn)).toBe(false);
    // The base `Column.mapFromDriverValue` is the identity, so an unknown value
    // passes straight through: there is no parse on this column at all.
    expect(t.plain.mapFromDriverValue("anything at all")).toBe(
      "anything at all",
    );
  });
});

describe("a schema that narrows the column", () => {
  test("a checked string (`.min(1)`) decodes — it claims something about the rows", () => {
    expect(is(t.refined, PgCustomColumn)).toBe(true);
    expect(t.refined.getSQLType()).toBe("text");
    expect(t.refined.mapFromDriverValue("ok")).toBe("ok");
    expect(() => t.refined.mapFromDriverValue("")).toThrow(SqlColumnError);
  });

  test("gets a decoder that really runs, on a column that is still `text`", () => {
    expect(is(t.kind, PgCustomColumn)).toBe(true);
    // `text` in the DDL is what makes adopting this generate no migration.
    expect(t.kind.getSQLType()).toBe("text");
    expect(t.kind.mapFromDriverValue("agent")).toBe("agent");
  });

  // A tolerant column is a `.catch` over the enum, not a bare string — so it
  // must land on the decoding branch. It is the one arm where a wrong branch
  // would be invisible: the identity branch would accept the legacy value AND
  // hand it on unnormalized, which is the bug the tolerant schema exists to fix.
  test("a tolerant schema decodes, and normalizes on read", () => {
    const tolerant = pgTable("text_storage_tolerant", {
      model: decode(
        "model",
        tolerantEnum(z.enum(["opus-5", "sonnet-5"]), { fallback: "opus-5" }),
      ),
    });
    expect(is(tolerant.model, PgCustomColumn)).toBe(true);
    expect(tolerant.model.mapFromDriverValue("legacy-name")).toBe("opus-5");
  });

  test("throws on an out-of-set read, naming the qualified column", () => {
    let err: unknown;
    try {
      t.kind.mapFromDriverValue("wizard");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SqlColumnError);
    expect((err as SqlColumnError).label).toBe("text_storage_probe.kind");
  });
});
