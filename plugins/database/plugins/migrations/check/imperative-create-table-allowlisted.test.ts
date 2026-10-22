import { describe, expect, test } from "bun:test";
import type { CodeMatch } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import {
  allowlistIdentifiers,
  callsRuntimeAssert,
  findOffenders,
  usesThrowawayTestDb,
} from "./imperative-create-table-allowlisted";

// A stand-in for the shorthand `IMPERATIVE_PUBLIC_TABLES` record and the barrel
// namespace it must agree with. Written out rather than imported so each half can
// be perturbed independently below.
const SAMPLE_MAPPING = {
  MIGRATIONS_TABLE_NAME: "__singularity_migrations",
  DERIVED_VIEW_STATE_TABLE_NAME: "derived_view_state",
  LIVE_STATE_SNAPSHOT_TABLE: "live_state_snapshot",
};
const SAMPLE_EXPORTS: Record<string, unknown> = {
  ...SAMPLE_MAPPING,
  compileCreateView: () => "",
};

const m = (path: string, line: number, text: string): CodeMatch => ({
  path,
  line,
  text,
});

// Real DDL lines are spelled with the keyword split so this source file never
// contains the literal token the check greps for (belt-and-suspenders; the file
// is also exempt in the migrations manifest).
const CT = "CREATE " + "TABLE";

describe("allowlistIdentifiers", () => {
  test("returns the record's keys when every one names a matching barrel export", () => {
    expect(allowlistIdentifiers(SAMPLE_MAPPING, SAMPLE_EXPORTS)).toEqual(
      new Set([
        "MIGRATIONS_TABLE_NAME",
        "DERIVED_VIEW_STATE_TABLE_NAME",
        "LIVE_STATE_SNAPSHOT_TABLE",
      ]),
    );
  });

  test("ignores barrel exports that are not allowlist entries", () => {
    // `compileCreateView` is exported from the same barrel but is not a table
    // constant, so it must never become an allowlist identifier.
    expect(
      allowlistIdentifiers(SAMPLE_MAPPING, SAMPLE_EXPORTS).has(
        "compileCreateView",
      ),
    ).toBe(false);
  });

  test("throws on a NON-SHORTHAND key (the alias names no export)", () => {
    // `{ ALIAS: MIGRATIONS_TABLE_NAME }` — the value is right, the key is not the
    // identifier a create site spells, so the textual coupling is broken.
    const aliased = { ...SAMPLE_MAPPING, ALIAS: "__singularity_migrations" };
    expect(() => allowlistIdentifiers(aliased, SAMPLE_EXPORTS)).toThrow(
      /ALIAS/,
    );
  });

  test("throws when a key names an export holding a DIFFERENT value", () => {
    const skewed = {
      ...SAMPLE_EXPORTS,
      LIVE_STATE_SNAPSHOT_TABLE: "renamed_elsewhere",
    };
    expect(() => allowlistIdentifiers(SAMPLE_MAPPING, skewed)).toThrow(
      /LIVE_STATE_SNAPSHOT_TABLE/,
    );
  });

  test("throws when a key is absent from the barrel (constant not re-exported)", () => {
    const missing = { ...SAMPLE_MAPPING, NEW_TABLE: "new_table" };
    expect(() => allowlistIdentifiers(missing, SAMPLE_EXPORTS)).toThrow(
      /NEW_TABLE/,
    );
  });

  test("throws when the record is empty (would enforce a vacuous allowlist)", () => {
    expect(() => allowlistIdentifiers({}, SAMPLE_EXPORTS)).toThrow();
  });
});

describe("findOffenders", () => {
  const ids = new Set(["MIGRATIONS_TABLE_NAME", "LIVE_STATE_SNAPSHOT_TABLE"]);

  test("passes a line that names an allowlist constant", () => {
    const matches = [
      m(
        "plugins/database/plugins/migrations/server/internal/runner.ts",
        63,
        `    ${CT} IF NOT EXISTS \${drizzleSql.raw(MIGRATIONS_TABLE_NAME)} (`,
      ),
      m(
        "plugins/database/plugins/live-state-snapshot/server/internal/tables-ddl.ts",
        18,
        `${CT} IF NOT EXISTS \${LIVE_STATE_SNAPSHOT_TABLE} (`,
      ),
    ];
    expect(findOffenders(matches, ids)).toEqual([]);
  });

  test("passes a generated line that carries the runtime allowlist assert", () => {
    // derived-tables' defineRollup renders the table name from a handle, so the
    // line holds an expression: the assert call is its evidence instead.
    const line = `const ddl = \`${CT} IF NOT EXISTS "public".\${quoteIdent(assertImperativePublicTable(table))} (\``;
    expect(callsRuntimeAssert(line)).toBe(true);
    expect(
      findOffenders(
        [
          m(
            "plugins/database/plugins/derived-tables/core/internal/define-rollup.ts",
            1,
            line,
          ),
        ],
        ids,
      ),
    ).toEqual([]);
  });

  test("the assert's name alone (not a call) is no evidence", () => {
    const line = `  ${CT} IF NOT EXISTS rogue_tbl -- see assertImperativePublicTable`;
    expect(callsRuntimeAssert(line)).toBe(false);
    expect(findOffenders([m("x.ts", 3, line)], ids)).toHaveLength(1);
  });

  test("flags a bare CREATE TABLE with a literal name", () => {
    const matches = [
      m(
        "plugins/database/plugins/migrations/server/internal/x.ts",
        10,
        `  ${CT} IF NOT EXISTS rogue_tbl (id int)`,
      ),
    ];
    expect(findOffenders(matches, ids)).toEqual([
      "plugins/database/plugins/migrations/server/internal/x.ts:10:" +
        `${CT} IF NOT EXISTS rogue_tbl (id int)`,
    ]);
  });

  test("flags a CREATE TABLE using a non-allowlist constant", () => {
    const matches = [
      m(
        "plugins/database/plugins/migrations/server/internal/x.ts",
        5,
        `${CT} IF NOT EXISTS \${SOME_OTHER_CONST} (`,
      ),
    ];
    expect(findOffenders(matches, ids).length).toBe(1);
  });

  test("flags CREATE UNLOGGED TABLE without an allowlist constant", () => {
    const matches = [
      m(
        "plugins/database/plugins/migrations/server/internal/x.ts",
        7,
        `CREATE UNLOGGED ${"TABLE"} scratch (id int)`,
      ),
    ];
    expect(findOffenders(matches, ids).length).toBe(1);
  });

  test("does not require a full-word identifier match on a substring collision", () => {
    // A constant that merely CONTAINS an allowlist id as a substring must not pass.
    const matches = [
      m(
        "plugins/database/plugins/migrations/server/internal/x.ts",
        9,
        `${CT} IF NOT EXISTS \${XMIGRATIONS_TABLE_NAMEX} (`,
      ),
    ];
    expect(findOffenders(matches, ids).length).toBe(1);
  });

  test("drops a path the caller's `skips` exempts, and only an offender is asked", () => {
    const asked: string[] = [];
    const matches = [
      m(
        "plugins/database/plugins/migrations/server/ok.ts",
        1,
        `${CT} \${MIGRATIONS_TABLE_NAME} (id int)`,
      ),
      m(
        "plugins/database/plugins/migrations/server/skipped.ts",
        2,
        `${CT} foo (id int)`,
      ),
      m(
        "plugins/database/plugins/migrations/server/bad.ts",
        3,
        `${CT} bar (id int)`,
      ),
    ];
    const out = findOffenders(matches, ids, new Set(), (p) => {
      asked.push(p);
      return p.endsWith("skipped.ts");
    });
    expect(out.length).toBe(1);
    expect(asked).toEqual([
      "plugins/database/plugins/migrations/server/skipped.ts",
      "plugins/database/plugins/migrations/server/bad.ts",
    ]);
  });

  test("exempts a path the caller resolved as a throwaway-test-db file", () => {
    const path =
      "plugins/database/plugins/change-feed/server/internal/triggers.test.ts";
    const matches = [m(path, 45, `${CT} widgets (id text PRIMARY KEY)`)];
    expect(findOffenders(matches, ids, new Set([path]))).toEqual([]);
    // …and is still an offender when the caller did NOT exempt it.
    expect(findOffenders(matches, ids).length).toBe(1);
  });
});

// The exemption is deliberately evidence-based: a file qualifies only by being a
// test AND importing the throwaway-database fixture. These pin both halves, so a
// future loosening of either has to break a test first.
describe("usesThrowawayTestDb", () => {
  const FIXTURE_IMPORT = `import { createTestDb } from "@plugins/database/plugins/db-test-fixture/server/testing";`;
  // Bare basenames on purpose: usesThrowawayTestDb keys only off the `.test.ts`
  // SUFFIX, so the dir is irrelevant — and a `plugins/<x>/…` shaped literal here
  // would trip the plugin-refs-resolve check on a plugin that does not exist.
  const TEST_PATH = "some-file.test.ts";
  const SRC_PATH = "some-file.ts";

  test("accepts a test file that imports the throwaway-db fixture", () => {
    expect(usesThrowawayTestDb(TEST_PATH, FIXTURE_IMPORT)).toBe(true);
  });

  test("rejects a NON-test file even if it imports the fixture", () => {
    expect(usesThrowawayTestDb(SRC_PATH, FIXTURE_IMPORT)).toBe(false);
  });

  test("rejects a test file that does NOT import the fixture", () => {
    expect(usesThrowawayTestDb(TEST_PATH, "const a = 1;")).toBe(false);
  });

  test("rejects a test file that reaches the REAL db instead of the fixture", () => {
    // The one way a test could create a table that actually persists — must stay
    // covered by the rule.
    const src = `import { db } from "@plugins/database/server";`;
    expect(usesThrowawayTestDb(TEST_PATH, src)).toBe(false);
  });

  test("accepts a test file that opens its own in-memory PGlite", () => {
    expect(
      usesThrowawayTestDb(TEST_PATH, "const d = createPgliteDriver();"),
    ).toBe(true);
    expect(usesThrowawayTestDb(TEST_PATH, "const c = new PGlite();")).toBe(
      true,
    );
  });

  test("rejects a PGlite opened on a data dir (storage that outlives the test)", () => {
    expect(
      usesThrowawayTestDb(
        TEST_PATH,
        `createPgliteDriver({ dataDir: "idb://x" })`,
      ),
    ).toBe(false);
  });

  test("rejects a NON-test file that opens an in-memory PGlite", () => {
    expect(usesThrowawayTestDb(SRC_PATH, "createPgliteDriver();")).toBe(false);
  });
});
