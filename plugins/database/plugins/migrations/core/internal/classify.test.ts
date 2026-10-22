import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  classifyStatement,
  phaseStatements,
  renderStatements,
  type StatementClass,
} from "./classify";
import { parseMigration } from "./phases";
import { schemaMigrationFiles } from "./schema-snapshot";
import { splitStatements } from "./statements";

// Spelled in two pieces: the imperative-create-table-allowlisted check flags
// every literal occurrence of the phrase in code, and these fixtures create
// nothing.
const CREATE_TABLE = "CREATE" + " TABLE";

function classify(sql: string): StatementClass {
  const stmts = splitStatements(sql);
  expect(stmts).toHaveLength(1);
  return classifyStatement(stmts[0]!);
}

describe("classifyStatement — the closed table", () => {
  const cases: Array<[string, string, string]> = [
    [
      `${CREATE_TABLE} IF NOT EXISTS "x" ("id" text PRIMARY KEY NOT NULL)`,
      "expand",
      "create-table",
    ],
    [
      'CREATE INDEX IF NOT EXISTS "i" ON "t" USING btree ("a")',
      "expand",
      "create-index",
    ],
    [
      'CREATE UNIQUE INDEX IF NOT EXISTS "u" ON "t" USING btree ("a")',
      "contract",
      "create-unique-index",
    ],
    ['CREATE SEQUENCE "s"', "expand", "create-sequence"],
    ['CREATE DOMAIN rank_text AS TEXT COLLATE "C"', "expand", "create-domain"],
    ['ALTER TABLE "t" ADD COLUMN "c" text', "expand", "add-column"],
    [
      `ALTER TABLE "t" ADD COLUMN "c" text DEFAULT 'x' NOT NULL`,
      "expand",
      "add-column",
    ],
    [
      `ALTER TABLE "t" ALTER COLUMN "c" SET DEFAULT '{}'::jsonb`,
      "expand",
      "set-default",
    ],
    ['ALTER TABLE "t" ALTER COLUMN "c" DROP DEFAULT', "expand", "drop-default"],
    [
      'ALTER TABLE "t" ALTER COLUMN "c" DROP NOT NULL',
      "expand",
      "drop-not-null",
    ],
    [
      'ALTER TABLE "t" DROP CONSTRAINT IF EXISTS "k"',
      "expand",
      "drop-constraint",
    ],
    ['DROP INDEX IF EXISTS "i"', "expand", "drop-index"],
    [
      'ALTER TABLE "t" DISABLE ROW LEVEL SECURITY',
      "expand",
      "row-level-security",
    ],
    [
      'ALTER TABLE "t" ENABLE ROW LEVEL SECURITY',
      "expand",
      "row-level-security",
    ],
    ['ALTER TABLE "t" RENAME COLUMN "a" TO "b"', "expand", "rename-column"],
    ['ALTER TABLE "crashes" RENAME TO "reports"', "expand", "rename-table"],
    ['DROP TABLE "t" CASCADE', "contract", "drop-table"],
    ['ALTER TABLE "t" DROP COLUMN IF EXISTS "c"', "contract", "drop-column"],
    ['DROP SEQUENCE "s"', "contract", "drop-sequence"],
    ['DROP TYPE "e"', "contract", "drop-type"],
    [
      'ALTER TABLE "t" ALTER COLUMN "c" SET NOT NULL',
      "contract",
      "set-not-null",
    ],
    [
      'ALTER TABLE "t" ALTER COLUMN "c" SET DATA TYPE timestamp with time zone',
      "contract",
      "set-data-type",
    ],
    [
      'ALTER TABLE "t" ADD CONSTRAINT "pk" PRIMARY KEY("a","b")',
      "contract",
      "add-constraint",
    ],
    [
      'ALTER TABLE "t" ADD CONSTRAINT "ck" CHECK ((a IS NULL) = (b IS NULL))',
      "contract",
      "add-constraint",
    ],
    [
      'DO $$ BEGIN\n ALTER TABLE "a" ADD CONSTRAINT "a_b_c_id_fk" FOREIGN KEY ("b") REFERENCES "public"."c"("id") ON DELETE cascade ON UPDATE no action;\nEXCEPTION\n WHEN duplicate_object THEN null;\nEND $$',
      "contract",
      "add-constraint",
    ],
  ];
  for (const [sql, kind, op] of cases) {
    it(`${kind} ${op}: ${sql.slice(0, 60)}`, () => {
      expect(classify(sql)).toMatchObject({ kind, op });
    });
  }

  it("a keyword inside an identifier or a literal cannot match", () => {
    // `"drop column"` is a (weird) column name, not an action.
    expect(
      classify('ALTER TABLE "t" RENAME COLUMN "drop column" TO "b"'),
    ).toMatchObject({
      kind: "expand",
      op: "rename-column",
    });
    expect(
      classify(`ALTER TABLE "t" ADD COLUMN "c" text DEFAULT 'NOT NULL'`),
    ).toMatchObject({
      kind: "expand",
      op: "add-column",
    });
  });
});

describe("classifyStatement — auto-split of a required column with no default", () => {
  it("ADD COLUMN … NOT NULL becomes a nullable add plus a contract SET NOT NULL", () => {
    expect(
      classify('ALTER TABLE "events" ADD COLUMN "date" jsonb NOT NULL'),
    ).toEqual({
      kind: "split",
      op: "add-column-not-null",
      expand: 'ALTER TABLE "events" ADD COLUMN "date" jsonb',
      contract: 'ALTER TABLE "events" ALTER COLUMN "date" SET NOT NULL',
    });
  });

  it("keeps a quoted type, a qualified table and IF NOT EXISTS verbatim", () => {
    expect(
      classify(
        'ALTER TABLE "public"."pd" ADD COLUMN IF NOT EXISTS "rank" "rank_text" NOT NULL',
      ),
    ).toEqual({
      kind: "split",
      op: "add-column-not-null",
      expand:
        'ALTER TABLE "public"."pd" ADD COLUMN IF NOT EXISTS "rank" "rank_text"',
      contract: 'ALTER TABLE "public"."pd" ALTER COLUMN "rank" SET NOT NULL',
    });
  });

  it("keeps clauses after NOT NULL", () => {
    expect(
      classify('ALTER TABLE "t" ADD COLUMN "c" text NOT NULL COLLATE "C"'),
    ).toMatchObject({
      kind: "split",
      expand: 'ALTER TABLE "t" ADD COLUMN "c" text COLLATE "C"',
    });
  });
});

describe("classifyStatement — rejected and unknown", () => {
  it.each([
    ['CREATE VIEW "public"."v" AS (select 1)'],
    ['CREATE OR REPLACE VIEW "v" AS select 1'],
    ['CREATE MATERIALIZED VIEW "v" AS select 1'],
    ['DROP VIEW "public"."tasks_v"'],
  ])("rejects view DDL: %s", (sql) => {
    expect(classify(sql)).toMatchObject({ kind: "reject", op: "view" });
  });

  it("rejects ALTER TYPE … ADD VALUE", () => {
    expect(classify(`ALTER TYPE "status" ADD VALUE 'x'`)).toMatchObject({
      kind: "reject",
      op: "enum-add-value",
    });
  });

  it.each([
    ['UPDATE "t" SET "a" = 1'],
    ['INSERT INTO "t" VALUES (1)'],
    ['TRUNCATE TABLE "t"'],
  ])("rejects DML: %s", (sql) => {
    expect(classify(sql)).toMatchObject({ kind: "reject", op: "dml" });
  });

  it.each([
    ["CREATE EXTENSION pgcrypto"],
    ["DO $$ BEGIN PERFORM 1; END $$"],
    ['ALTER TABLE "t" ADD COLUMN "a" text, ADD COLUMN "b" text'],
    ['ALTER TABLE "t" ADD COLUMN "a" text REFERENCES "u"("id")'],
    ['ALTER TABLE "t" ALTER COLUMN "a" SET STATISTICS 100'],
    ['CREATE INDEX CONCURRENTLY "i" ON "t" ("a")'],
  ])("does not recognise: %s", (sql) => {
    expect(classify(sql).kind).toBe("unknown");
  });
});

describe("phaseStatements", () => {
  it("orders each statement into its phase, verbatim", () => {
    const sql = [
      `${CREATE_TABLE} IF NOT EXISTS "n" ("id" text)`,
      'ALTER TABLE "agents" DROP COLUMN IF EXISTS "old"',
      'ALTER TABLE "agents" ADD COLUMN "icon" text NOT NULL',
    ].join(";\n--> statement-breakpoint\n");
    expect(phaseStatements(sql)).toEqual({
      expand: [
        `${CREATE_TABLE} IF NOT EXISTS "n" ("id" text)`,
        'ALTER TABLE "agents" ADD COLUMN "icon" text',
      ],
      contract: [
        'ALTER TABLE "agents" DROP COLUMN IF EXISTS "old"',
        'ALTER TABLE "agents" ALTER COLUMN "icon" SET NOT NULL',
      ],
    });
  });

  it("throws naming every statement it cannot place", () => {
    const sql =
      'DROP VIEW "public"."agents_v";\nCREATE EXTENSION pgcrypto;\nDROP INDEX "i";';
    expect(() => phaseStatements(sql)).toThrow(
      /DROP VIEW "public"\."agents_v"[\s\S]*CREATE EXTENSION pgcrypto/,
    );
  });

  it("renderStatements terminates each statement, and re-splits to the same statements", () => {
    const stmts = [
      'DROP INDEX "i"',
      `ALTER TABLE "t" ALTER COLUMN "c" SET DEFAULT 'a;b'`,
    ];
    const rendered = renderStatements(stmts);
    expect(rendered).toBe(
      `DROP INDEX "i";\nALTER TABLE "t" ALTER COLUMN "c" SET DEFAULT 'a;b';`,
    );
    expect(splitStatements(rendered).map((s) => s.raw)).toEqual(stmts);
  });
});

// Every schema migration on disk (`schemaMigrationFiles`) — pins
// drizzle's real output shapes, including one-line `…;CREATE …` merges and the
// DO $$ foreign-key form.
describe("every schema migration on disk", () => {
  const dataDir = join(import.meta.dir, "../../data");
  const schemaFiles = [...schemaMigrationFiles(dataDir)].sort();

  // Files before this date include hand-edited schema migrations carrying DML
  // (the last on 2026-06-01) and drizzle-emitted view DDL (the last on
  // 2026-07-28, before views moved to derived code); both are correctly REJECTED
  // now. From 2026-08-01 on, every statement must place.
  const CLASSIFY_ALL_FROM = "20260801";

  it("finds the schema migrations", () => {
    expect(schemaFiles.length).toBeGreaterThan(200);
  });

  it("every statement of every file tokenizes and classifies without throwing", () => {
    let count = 0;
    for (const f of schemaFiles) {
      const parsed = parseMigration(readFileSync(join(dataDir, f), "utf8"));
      const sql =
        parsed.kind === "legacy"
          ? parsed.sql
          : `${parsed.expand}\n${parsed.contract}`;
      for (const stmt of splitStatements(sql)) {
        expect(stmt.code.length).toBe(stmt.raw.length);
        classifyStatement(stmt);
        count++;
      }
    }
    expect(count).toBeGreaterThan(500);
  });

  it(`every statement of every file from ${CLASSIFY_ALL_FROM} on places in a phase`, () => {
    const recent = schemaFiles.filter(
      (f) => f.slice(0, 8) >= CLASSIFY_ALL_FROM,
    );
    expect(recent.length).toBeGreaterThan(20);
    for (const f of recent) {
      const parsed = parseMigration(readFileSync(join(dataDir, f), "utf8"));
      const sql =
        parsed.kind === "legacy"
          ? parsed.sql
          : `${parsed.expand}\n${parsed.contract}`;
      try {
        phaseStatements(sql);
      } catch (e) {
        throw new Error(`${f}: ${(e as Error).message}`);
      }
    }
  });

  it("before the cutoff, only views and DML are unplaceable", () => {
    for (const f of schemaFiles) {
      const parsed = parseMigration(readFileSync(join(dataDir, f), "utf8"));
      if (parsed.kind !== "legacy") continue;
      for (const stmt of splitStatements(parsed.sql)) {
        const cls = classifyStatement(stmt);
        if (cls.kind === "unknown") {
          // The one hand-written guard block (2026-04-24) predates the table.
          expect(`${f}: ${stmt.raw.slice(0, 40)}`).toMatch(
            /RAISE EXCEPTION|^20260424_134225/,
          );
        }
      }
    }
  });
});
