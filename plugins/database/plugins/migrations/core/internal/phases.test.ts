import { describe, expect, test } from "bun:test";
import {
  mergeSnapshotParents,
  migrationClaimId,
  parseMigration,
  renderAdoptionMigration,
  renderMergeSnapshotMigration,
  renderPhasedMigration,
} from "./phases";

describe("phased migration grammar", () => {
  test("render → parse round-trips", () => {
    const m = {
      expand: 'CREATE INDEX IF NOT EXISTS "i" ON "x" ("id");',
      contract: 'ALTER TABLE "a" DROP COLUMN IF EXISTS "b";',
      claims: ["20260927_182347__remap_saved_icons_to_symbols"],
      supersedes: null,
    };
    expect(parseMigration(renderPhasedMigration(m))).toEqual({
      kind: "phased",
      ...m,
      adopts: [],
    });
  });

  test("empty sections and no claims round-trip", () => {
    const m = {
      expand: "",
      contract: 'DROP TABLE "q" CASCADE;',
      claims: [],
      supersedes: null,
    };
    expect(parseMigration(renderPhasedMigration(m))).toEqual({
      kind: "phased",
      ...m,
      adopts: [],
    });
  });

  test("a file without the header is legacy", () => {
    const sql = 'ALTER TABLE "agents" ADD COLUMN "x" text;';
    expect(parseMigration(sql)).toEqual({ kind: "legacy", sql });
  });

  test("a phased file missing a marker throws rather than reading as legacy", () => {
    expect(() =>
      parseMigration("-- singularity:phase expand\nDROP INDEX x;\n"),
    ).toThrow(/malformed/);
  });

  test("markers out of order throw", () => {
    expect(() =>
      parseMigration(
        "-- singularity:phase expand\n-- singularity:claims\n-- singularity:phase contract\n",
      ),
    ).toThrow(/malformed/);
  });

  test("a malformed claim throws", () => {
    expect(() =>
      parseMigration(
        "-- singularity:phase expand\n-- singularity:phase contract\n-- singularity:claims\n-- nope\n",
      ),
    ).toThrow(/malformed migration claim/);
  });

  test("claim id drops the content hash", () => {
    expect(
      migrationClaimId(
        "20260927_182347_81e713f0__remap_saved_icons_to_symbols.sql",
      ),
    ).toBe("20260927_182347__remap_saved_icons_to_symbols");
  });
});

describe("merge-snapshot header", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";

  test("a merge node is an empty phased migration behind its header", () => {
    const sql = renderMergeSnapshotMigration([A, B]);
    expect(sql.split("\n")[0]).toBe(
      `-- singularity:merge-snapshot parents=${A},${B}`,
    );
    expect(mergeSnapshotParents(sql)).toEqual([A, B]);
    expect(parseMigration(sql)).toEqual({
      kind: "phased",
      expand: "",
      contract: "",
      claims: [],
      supersedes: null,
      adopts: [],
    });
  });

  test("any other migration has no merge parents", () => {
    expect(mergeSnapshotParents("SELECT 1;")).toBeNull();
    expect(
      mergeSnapshotParents(
        renderPhasedMigration({
          expand: "",
          contract: "",
          claims: [],
          supersedes: null,
        }),
      ),
    ).toBeNull();
  });

  test("a malformed header throws rather than dropping the edge", () => {
    expect(() =>
      mergeSnapshotParents(`-- singularity:merge-snapshot parents=${A}\n`),
    ).toThrow(/malformed/);
    expect(() =>
      mergeSnapshotParents("-- singularity:merge-snapshot parents=x,y\n"),
    ).toThrow(/malformed/);
  });

  test("a header over a legacy body throws", () => {
    expect(() =>
      parseMigration(
        `-- singularity:merge-snapshot parents=${A},${B}\nSELECT 1;\n`,
      ),
    ).toThrow(/must be phased/);
    expect(() =>
      parseMigration(`-- singularity:merge-snapshot parents=${A},${B}`),
    ).toThrow(/must be phased/);
  });

  test("fewer than two parents cannot be rendered", () => {
    expect(() => renderMergeSnapshotMigration([A])).toThrow(/at least two/);
  });
});

describe("supersedes header", () => {
  const body = {
    expand: 'ALTER TABLE "c" ADD COLUMN "w" text;',
    contract: "",
    claims: [],
  };

  test("direct lineage round-trips and leads the file", () => {
    const m = {
      ...body,
      supersedes: { direct: ["38bc8c97", "f09303fa"], inherited: [] },
    };
    const sql = renderPhasedMigration(m);
    expect(sql.split("\n")[0]).toBe(
      "-- singularity:supersedes 38bc8c97 f09303fa",
    );
    expect(parseMigration(sql)).toEqual({ kind: "phased", ...m, adopts: [] });
  });

  test("inherited edges round-trip", () => {
    const m = {
      ...body,
      supersedes: {
        direct: ["a1a1a1a1"],
        inherited: [
          { hash: "a1a1a1a1", replaced: ["38bc8c97", "f09303fa"] },
          { hash: "38bc8c97", replaced: ["0badf00d"] },
        ],
      },
    };
    expect(parseMigration(renderPhasedMigration(m))).toEqual({
      kind: "phased",
      ...m,
      adopts: [],
    });
  });

  test("a malformed hash throws", () => {
    expect(() =>
      parseMigration(
        "-- singularity:supersedes nothex\n" +
          renderPhasedMigration({ ...body, supersedes: null }),
      ),
    ).toThrow(/malformed hash/);
  });

  test("an inherited edge nothing reaches throws", () => {
    expect(() =>
      renderPhasedMigration({
        ...body,
        supersedes: {
          direct: ["a1a1a1a1"],
          inherited: [{ hash: "b2b2b2b2", replaced: ["c3c3c3c3"] }],
        },
      }),
    ).toThrow(/nothing it supersedes reaches/);
  });

  test("inherited lines without a direct line throw", () => {
    expect(() =>
      parseMigration(
        "-- singularity:supersedes a1a1a1a1 <- b2b2b2b2\n" +
          renderPhasedMigration({ ...body, supersedes: null }),
      ),
    ).toThrow(/no direct line/);
  });

  test("a header over a legacy body throws", () => {
    expect(() =>
      parseMigration("-- singularity:supersedes a1a1a1a1\nSELECT 1;\n"),
    ).toThrow(/must be phased/);
  });

  test("a supersedes line inside the body is a duplicate marker", () => {
    expect(() =>
      parseMigration(
        "-- singularity:phase expand\n-- singularity:supersedes a1a1a1a1\n-- singularity:phase contract\n-- singularity:claims\n",
      ),
    ).toThrow(/duplicate marker/);
  });
});

describe("adopts header", () => {
  const lineage = { direct: ["38bc8c97", "f09303fa"], inherited: [] };

  test("an adoption file round-trips: adopts, then the lineage, then empty sections", () => {
    const sql = renderAdoptionMigration(["5d1f2e3a", "77aa01bc"], lineage);
    expect(sql.split("\n").slice(0, 2)).toEqual([
      "-- singularity:adopts 5d1f2e3a 77aa01bc",
      "-- singularity:supersedes 38bc8c97 f09303fa",
    ]);
    expect(parseMigration(sql)).toEqual({
      kind: "phased",
      expand: "",
      contract: "",
      claims: [],
      supersedes: lineage,
      adopts: ["5d1f2e3a", "77aa01bc"],
    });
  });

  test("adopts without a supersedes header throws", () => {
    expect(() =>
      parseMigration(
        "-- singularity:adopts 5d1f2e3a\n" +
          renderPhasedMigration({
            expand: "",
            contract: "",
            claims: [],
            supersedes: null,
          }),
      ),
    ).toThrow(/followed by a supersedes header/);
  });

  test("an adoption file with SQL throws: it only records", () => {
    expect(() =>
      parseMigration(
        "-- singularity:adopts 5d1f2e3a\n" +
          renderPhasedMigration({
            expand: 'ALTER TABLE "c" ADD COLUMN "w" text;',
            contract: "",
            claims: [],
            supersedes: lineage,
          }),
      ),
    ).toThrow(/records only/);
  });

  test("a malformed adopted hash throws", () => {
    expect(() => renderAdoptionMigration(["nothex"], lineage)).toThrow(
      /malformed hash/,
    );
    expect(() => renderAdoptionMigration([], lineage)).toThrow(/no hash/);
  });
});
