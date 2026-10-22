import { describe, expect, test } from "bun:test";
import {
  migrationClaimId,
  parseMigration,
  renderAdoptionMigration,
  renderMergeSnapshotMigration,
  renderPhasedMigration,
  renderSnapshotHeader,
  snapshotLineage,
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

describe("snapshot header", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";
  const M = "33333333-3333-5333-8333-333333333333";
  const NULL_ID = "00000000-0000-0000-0000-000000000000";
  const empty = {
    kind: "phased" as const,
    expand: "",
    contract: "",
    claims: [],
    supersedes: null,
    adopts: [],
  };

  test("an ordinary schema migration: header, then its phased body", () => {
    const body = renderPhasedMigration({
      expand: 'ALTER TABLE "t" ADD COLUMN "c" text;',
      contract: "",
      claims: [],
      supersedes: { direct: ["38bc8c97"], inherited: [] },
    });
    const sql = renderSnapshotHeader({ id: B, parents: [A] }) + body;
    expect(sql.split("\n")[0]).toBe(
      `-- singularity:snapshot id=${B} parents=${A}`,
    );
    expect(snapshotLineage(sql)).toEqual({ id: B, parents: [A] });
    expect(parseMigration(sql)).toEqual(parseMigration(body));
  });

  test("a root names the null snapshot as its parent", () => {
    expect(
      snapshotLineage(renderSnapshotHeader({ id: A, parents: [NULL_ID] })),
    ).toEqual({ id: A, parents: [NULL_ID] });
  });

  test("a merge node is an empty phased migration behind a two-parent header", () => {
    const sql = renderMergeSnapshotMigration({ id: M, parents: [A, B] });
    expect(sql.split("\n")[0]).toBe(
      `-- singularity:snapshot id=${M} parents=${A},${B}`,
    );
    expect(snapshotLineage(sql)).toEqual({ id: M, parents: [A, B] });
    expect(parseMigration(sql)).toEqual(empty);
  });

  test("any other migration has no lineage", () => {
    expect(snapshotLineage("SELECT 1;")).toBeNull();
    expect(
      snapshotLineage(
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
      snapshotLineage(`-- singularity:snapshot parents=${A}\n`),
    ).toThrow(/malformed/);
    expect(() =>
      snapshotLineage(`-- singularity:snapshot id=${M} parents=x,y\n`),
    ).toThrow(/malformed/);
    expect(() =>
      snapshotLineage(`-- singularity:snapshot id=${M} parents=${A},${A}\n`),
    ).toThrow(/repeats/);
    expect(() =>
      snapshotLineage(`-- singularity:snapshot id=${M} parents=${A} \n`),
    ).not.toThrow();
  });

  test("a header over a legacy body throws", () => {
    expect(() =>
      parseMigration(
        `-- singularity:snapshot id=${M} parents=${A},${B}\nSELECT 1;\n`,
      ),
    ).toThrow(/must be phased/);
    expect(() =>
      parseMigration(`-- singularity:snapshot id=${M} parents=${A},${B}`),
    ).toThrow(/must be phased/);
  });

  test("a merge node of fewer than two parents cannot be rendered", () => {
    expect(() => renderMergeSnapshotMigration({ id: M, parents: [A] })).toThrow(
      /at least two/,
    );
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
