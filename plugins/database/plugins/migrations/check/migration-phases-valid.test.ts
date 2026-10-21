import { describe, expect, test } from "bun:test";
import { renderMergeSnapshotMigration } from "@plugins/database/plugins/migrations/core";
import { findPhaseErrors, type MigrationFile } from "./migration-phases-valid";

const DATA = "20260902_000000_dddddddd__remap_icons.sql";
const DATA_ID = "20260902_000000__remap_icons";
const SCHEMA = "20260903_000000_eeeeeeee__swap_icons.sql";

function phased(expand: string, contract: string, claims: string[]): string {
  return (
    `-- singularity:phase expand\n${expand}\n` +
    `-- singularity:phase contract\n${contract}\n` +
    `-- singularity:claims\n${claims.map((c) => `-- ${c}\n`).join("")}`
  );
}

const data = (file: string): MigrationFile => ({
  file,
  sql: "UPDATE a SET b = 1;",
  isSchema: false,
});
const schema = (file: string, sql: string): MigrationFile => ({
  file,
  sql,
  isSchema: true,
});

const GOOD = phased(
  'ALTER TABLE "agents" ADD COLUMN "icon" text;',
  'ALTER TABLE "agents" ALTER COLUMN "icon" SET NOT NULL;\nALTER TABLE "agents" DROP COLUMN "old";',
  [DATA_ID],
);

describe("findPhaseErrors", () => {
  test("a phased branch-local schema migration claiming an earlier data migration is valid", () => {
    expect(
      findPhaseErrors([data(DATA), schema(SCHEMA, GOOD)], new Set()),
    ).toEqual([]);
  });

  test("a branch-local legacy schema migration is refused; one on main is not", () => {
    const legacy = schema(SCHEMA, 'ALTER TABLE "a" DROP COLUMN "b";');
    expect(findPhaseErrors([legacy], new Set())).toEqual([
      `${SCHEMA}: a branch-local schema migration without phase markers`,
    ]);
    expect(findPhaseErrors([legacy], new Set([SCHEMA]))).toEqual([]);
  });

  test("a statement in the wrong section is refused", () => {
    const moved = phased('ALTER TABLE "a" DROP COLUMN "b";', "", []);
    expect(findPhaseErrors([schema(SCHEMA, moved)], new Set())).toEqual([
      expect.stringContaining(
        "expand statement classifies as contract (drop-column)",
      ),
    ]);
  });

  test("a malformed phased file is refused", () => {
    const broken = "-- singularity:phase expand\nDROP INDEX i;\n";
    expect(findPhaseErrors([schema(SCHEMA, broken)], new Set())).toEqual([
      expect.stringContaining("malformed"),
    ]);
  });

  test("a merge node (empty phased file behind its header) is valid", () => {
    const merge = renderMergeSnapshotMigration([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]);
    expect(findPhaseErrors([schema(SCHEMA, merge)], new Set())).toEqual([]);
  });

  test("a merge node carrying SQL is refused", () => {
    const merge =
      "-- singularity:merge-snapshot parents=11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222\n" +
      phased('ALTER TABLE "agents" ADD COLUMN "icon" text;', "", []);
    expect(findPhaseErrors([schema(SCHEMA, merge)], new Set())).toEqual([
      expect.stringContaining("a merge node must be a no-op"),
    ]);
  });

  test("a superseded hash still on disk is refused, published or not", () => {
    const AUTHORED = "20260901_000000_38bc8c97__add_icon.sql";
    const merged = `-- singularity:supersedes 38bc8c97\n${GOOD}`;
    const files = [
      schema(
        AUTHORED,
        phased('ALTER TABLE "agents" ADD COLUMN "icon" text;', "", []),
      ),
      data(DATA),
      schema(SCHEMA, merged),
    ];
    const expected = [
      `${SCHEMA}: supersedes 38bc8c97, but ${AUTHORED} is still on disk — a reset deletes what it supersedes`,
    ];
    expect(findPhaseErrors(files, new Set())).toEqual(expected);
    expect(findPhaseErrors(files, new Set([AUTHORED, DATA, SCHEMA]))).toEqual(
      expected,
    );
    expect(findPhaseErrors(files.slice(1), new Set())).toEqual([]);
  });
});
