import { describe, expect, test } from "bun:test";
import { classifyMigrationMetadata } from "./index";

const empty = {
  orphanSql: [],
  orphanJournal: [],
  orphanLegacy: [],
  duplicateHeaderIds: [],
};

describe("classifyMigrationMetadata", () => {
  test("fully consistent tree -> all empty", () => {
    // J === S; the legacy entry and the header id map to real migrations; one
    // lineage-less data migration (data_backfill) is in J/S only — and must NOT
    // be flagged.
    const journal = [
      "20260101_a__legacy",
      "20260102_b__data_backfill",
      "20261101_c__new",
    ];
    const sql = [...journal];
    expect(
      classifyMigrationMetadata(
        journal,
        sql,
        ["20260101_a__legacy"],
        [{ tag: "20261101_c__new", id: "x" }],
      ),
    ).toEqual(empty);
  });

  test("orphan sql (.sql with no journal entry)", () => {
    expect(
      classifyMigrationMetadata(
        ["20260101_a__schema"],
        ["20260101_a__schema", "20260102_b__orphan"],
        [],
        [],
      ),
    ).toEqual({ ...empty, orphanSql: ["20260102_b__orphan"] });
  });

  test("orphan journal (journal entry with no .sql)", () => {
    expect(
      classifyMigrationMetadata(
        ["20260101_a__schema", "20260102_b__ghost"],
        ["20260101_a__schema"],
        [],
        [],
      ),
    ).toEqual({ ...empty, orphanJournal: ["20260102_b__ghost"] });
  });

  test("orphan legacy entry (legacy-snapshots.json key with no .sql)", () => {
    expect(
      classifyMigrationMetadata(
        ["20260101_a__schema"],
        ["20260101_a__schema"],
        ["20260101_a__schema", "20260102_b__ghost"],
        [],
      ),
    ).toEqual({ ...empty, orphanLegacy: ["20260102_b__ghost"] });
  });

  test("two headers naming one snapshot id", () => {
    const tags = ["20261101_a__x", "20261102_b__y"];
    expect(
      classifyMigrationMetadata(
        tags,
        tags,
        [],
        [
          { tag: tags[1]!, id: "same" },
          { tag: tags[0]!, id: "same" },
        ],
      ),
    ).toEqual({ ...empty, duplicateHeaderIds: [{ id: "same", tags }] });
  });
});
