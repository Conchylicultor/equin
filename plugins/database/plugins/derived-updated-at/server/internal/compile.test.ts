import { test, expect } from "bun:test";
import { escapeLiteral as pgEscapeLiteral } from "pg";
import { compileDerivedUpdatedAt, escapeLiteral } from "./compile";

// The compiler's output, per rule kind. What Postgres DOES with it is pinned by
// the real-DB suite in infra/entities (install-derived-updated-at.test.ts).

// ── The compiler ────────────────────────────────────────────────────────────

test("compiles each rule kind into the trigger function", () => {
  const spec = compileDerivedUpdatedAt({
    table: "items",
    updatedAtColumn: "updated_at",
    columns: [
      { key: "id", name: "id", sqlType: "text", rule: false },
      { key: "title", name: "title", sqlType: "text", rule: true },
      {
        key: "status",
        name: "status",
        sqlType: "text",
        rule: { into: ["working", "done"], outOf: ["working"] },
      },
    ],
  });
  expect(spec.table).toBe("items");
  expect(spec.triggerName).toBe("items_derive_updated_at");
  expect(spec.functionDdl).toBe(
    `CREATE OR REPLACE FUNCTION "items_derive_updated_at"() RETURNS trigger LANGUAGE plpgsql AS $derive_updated_at$
BEGIN
  IF NEW."updated_at" IS DISTINCT FROM OLD."updated_at" THEN
    RAISE EXCEPTION USING MESSAGE = 'items.updated_at is derived (declared by its touchedBy); do not write it';
  END IF;
  IF NEW."title" IS DISTINCT FROM OLD."title"
     OR (NEW."status" IS DISTINCT FROM OLD."status" AND (NEW."status" IN ('working', 'done') OR OLD."status" IN ('working'))) THEN
    NEW."updated_at" := now();
  END IF;
  RETURN NEW;
END
$derive_updated_at$`,
  );
  expect(spec.triggerDdl).toBe(
    `CREATE OR REPLACE TRIGGER "items_derive_updated_at" BEFORE UPDATE ON "items" FOR EACH ROW EXECUTE FUNCTION "items_derive_updated_at"()`,
  );
  expect(spec.signature).toMatch(/^[0-9a-f]{64}$/);
});

test("only-into / only-outOf, null values and literal escaping", () => {
  const { functionDdl } = compileDerivedUpdatedAt({
    table: "t",
    updatedAtColumn: "updated_at",
    columns: [
      { key: "a", name: "a", sqlType: "text", rule: { into: ["it's"] } },
      { key: "b", name: "b", sqlType: "text", rule: { outOf: [null, "x"] } },
    ],
  });
  expect(functionDdl).toContain(
    `(NEW."a" IS DISTINCT FROM OLD."a" AND (NEW."a" IN ('it''s')))`,
  );
  expect(functionDdl).toContain(
    `(NEW."b" IS DISTINCT FROM OLD."b" AND (OLD."b" IN ('x') OR OLD."b" IS NULL))`,
  );
});

test("exceptKeys: a jsonb column compared without the listed keys", () => {
  const { functionDdl } = compileDerivedUpdatedAt({
    table: "t",
    updatedAtColumn: "updated_at",
    columns: [
      {
        key: "data",
        name: "data",
        sqlType: "jsonb",
        rule: { exceptKeys: ["icon", "it's", "icon"] },
      },
    ],
  });
  expect(functionDdl).toContain(
    `(NEW."data" - ARRAY['icon', 'it''s']::text[]) IS DISTINCT FROM (OLD."data" - ARRAY['icon', 'it''s']::text[])`,
  );
});

test("exceptKeys is refused off jsonb, and with no keys", () => {
  const compile = (sqlType: string, keys: readonly string[]) =>
    compileDerivedUpdatedAt({
      table: "t",
      updatedAtColumn: "updated_at",
      columns: [{ key: "d", name: "d", sqlType, rule: { exceptKeys: keys } }],
    });
  expect(() => compile("text", ["a"])).toThrow(/only supported on jsonb/);
  expect(() => compile("json", ["a"])).toThrow(/only supported on jsonb/);
  expect(() => compile("jsonb", [])).toThrow(/no keys/);
});

test("no counted column: never bumps, still guards the write", () => {
  const { functionDdl } = compileDerivedUpdatedAt({
    table: "t",
    updatedAtColumn: "updated_at",
    columns: [{ key: "a", name: "a", sqlType: "text", rule: false }],
  });
  expect(functionDdl).toContain("RAISE EXCEPTION");
  expect(functionDdl).not.toContain("now()");
});

test("signature changes with the rules", () => {
  const base = {
    table: "t",
    updatedAtColumn: "updated_at",
  } as const;
  const a = compileDerivedUpdatedAt({
    ...base,
    columns: [{ key: "a", name: "a", sqlType: "text", rule: true }],
  });
  const b = compileDerivedUpdatedAt({
    ...base,
    columns: [{ key: "a", name: "a", sqlType: "text", rule: false }],
  });
  expect(a.signature).not.toBe(b.signature);
});

test("rejects unsupported rules loudly", () => {
  const compileOne = (sqlType: string, rule: unknown) =>
    compileDerivedUpdatedAt({
      table: "t",
      updatedAtColumn: "updated_at",
      columns: [{ key: "a", name: "a", sqlType, rule: rule as boolean }],
    });
  expect(() => compileOne("jsonb", { into: ["x"] })).toThrow(/scalar columns/);
  expect(() => compileOne("text", { into: [{ x: 1 }] })).toThrow(
    /no scalar SQL encoding/,
  );
  expect(() => compileOne("text", {})).toThrow(/declare it false/);
  expect(() =>
    compileDerivedUpdatedAt({
      table: "x".repeat(60),
      updatedAtColumn: "updated_at",
      columns: [],
    }),
  ).toThrow(/63-byte/);
});

// ── escapeLiteral ───────────────────────────────────────────────────────────

test("escapeLiteral is pg's escapeLiteral, character for character", () => {
  for (const v of [
    "",
    "plain",
    "it's",
    "back\\slash",
    "both ' and \\",
    '"quoted"()',
    "unicode ✓ 🎵",
  ]) {
    expect(escapeLiteral(v)).toBe(pgEscapeLiteral(v));
  }
});
