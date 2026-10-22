import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  NULL_SNAPSHOT_ID,
  snapshotBodies,
} from "@plugins/database/plugins/migrations/core";
import { dropLegacyEntries, settleSnapshotFiles } from "./snapshot-files";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const TA = "20260101_000000_aaaaaaaa__a";
const TB = "20260102_000000_bbbbbbbb__b";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "snapshot-files-"));
  mkdirSync(join(dir, "meta"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const body = (id: string, prevId: string) =>
  JSON.stringify({ id, prevId, tables: { [id]: {} } }, null, 2);

/** A pre-cutover schema migration: its .sql and its own snapshot file. */
function legacy(tag: string, id: string, prevId: string): void {
  writeFileSync(join(dir, `${tag}.sql`), "SELECT 1;");
  writeFileSync(join(dir, "meta", `${tag}_snapshot.json`), body(id, prevId));
}

const settle = () => settleSnapshotFiles(dir, snapshotBodies(dir, dir));
const legacyJson = () =>
  JSON.parse(
    readFileSync(join(dir, "meta", "legacy-snapshots.json"), "utf8"),
  ) as Record<string, unknown>;

describe("settleSnapshotFiles", () => {
  test("the cutover: tip body written byte-identical, lineage folded, per-migration files gone", async () => {
    legacy(TA, A, NULL_SNAPSHOT_ID);
    legacy(TB, B, A);
    writeFileSync(join(dir, "meta", "_journal.json"), "{}");

    expect(await settle()).toEqual({
      wroteTip: B,
      folded: [`${TA}_snapshot.json`, `${TB}_snapshot.json`],
    });
    expect(readdirSync(join(dir, "meta")).sort()).toEqual([
      "_journal.json",
      "legacy-snapshots.json",
      "schema.snapshot.json",
    ]);
    expect(
      readFileSync(join(dir, "meta", "schema.snapshot.json"), "utf8"),
    ).toBe(body(B, A));
    expect(legacyJson()).toEqual({
      [TA]: { id: A, prevId: NULL_SNAPSHOT_ID },
      [TB]: { id: B, prevId: A },
    });

    // In shape: nothing more to do, nothing rewritten.
    const before = readFileSync(join(dir, "meta", "legacy-snapshots.json"));
    expect(await settle()).toEqual({ wroteTip: null, folded: [] });
    expect(readFileSync(join(dir, "meta", "legacy-snapshots.json"))).toEqual(
      before,
    );
  });

  test("a clone's own leftover legacy file is appended to the recorded entries", async () => {
    legacy(TA, A, NULL_SNAPSHOT_ID);
    await settle();
    legacy(TB, B, A);
    expect(await settle()).toEqual({
      wroteTip: B,
      folded: [`${TB}_snapshot.json`],
    });
    expect(Object.keys(legacyJson())).toEqual([TA, TB]);
  });

  test("a leftover file disagreeing with its recorded entry throws, deleting nothing", async () => {
    legacy(TA, A, NULL_SNAPSHOT_ID);
    await settle();
    writeFileSync(join(dir, "meta", `${TA}_snapshot.json`), body(A, B));
    const err = await settle().catch((e: unknown) => e);
    expect((err as Error).message).toContain("Two lineages for one migration");
    expect(existsSync(join(dir, "meta", `${TA}_snapshot.json`))).toBe(true);
  });

  test("dropLegacyEntries removes a reset's own keys only", async () => {
    legacy(TA, A, NULL_SNAPSHOT_ID);
    legacy(TB, B, A);
    await settle();
    dropLegacyEntries(dir, [TB, "not-a-key"]);
    expect(Object.keys(legacyJson())).toEqual([TA]);
  });
});
