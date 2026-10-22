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
import { dirname, join } from "path";
import { stageDrizzleOut, UnjoinedSnapshotTipsError } from "./drizzle-stage";
import { renderPhasedMigration, renderSnapshotHeader } from "./phases";
import { NULL_SNAPSHOT_ID } from "./snapshot-dag";

let pluginDir: string;
let data: string;
beforeEach(() => {
  pluginDir = mkdtempSync(join(tmpdir(), "drizzle-stage-"));
  data = join(pluginDir, "data");
  mkdirSync(join(data, "meta"), { recursive: true });
  writeFileSync(join(data, "meta", "_journal.json"), '{"entries":[]}');
  writeFileSync(join(data, "meta", "_x_answers.json"), "{}");
});
afterEach(() => rmSync(pluginDir, { recursive: true, force: true }));

const body = (id: string, prevId: string) =>
  JSON.stringify({ id, prevId, tables: {} }, null, 2);

/** A schema migration with its snapshot header; its body becomes the tip snapshot. */
function snapshot(tag: string, id: string, prevId: string): void {
  writeFileSync(
    join(data, `${tag}.sql`),
    renderSnapshotHeader({ id, parents: [prevId] }) +
      renderPhasedMigration({
        expand: "",
        contract: "",
        claims: [],
        supersedes: null,
      }),
  );
  writeFileSync(join(data, "meta", "schema.snapshot.json"), body(id, prevId));
}

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

describe("stageDrizzleOut", () => {
  test("stages only the journal and the tip body under the tip's tag, with a cwd-relative out", async () => {
    snapshot("20260901_000000_aaaaaaaa__a", A, NULL_SNAPSHOT_ID);
    snapshot("20260902_000000_bbbbbbbb__b", B, A);
    writeFileSync(join(data, "meta", "legacy-snapshots.json"), "{}\n");
    const stage = await stageDrizzleOut(pluginDir, data);
    try {
      const stageDir = join(pluginDir, dirname(stage.configPath));
      expect(readdirSync(join(stageDir, "data", "meta")).sort()).toEqual([
        "20260902_000000_bbbbbbbb__b_snapshot.json",
        "_journal.json",
      ]);
      expect(
        readFileSync(
          join(
            stageDir,
            "data",
            "meta",
            "20260902_000000_bbbbbbbb__b_snapshot.json",
          ),
          "utf8",
        ),
      ).toBe(body(B, A));
      // drizzle-kit reads snapshots as `./<path>`: an absolute out breaks it.
      expect(readFileSync(join(pluginDir, stage.configPath), "utf8")).toContain(
        'out: "./.drizzle-stage-',
      );
      expect(stage.emitted()).toEqual({ sql: [], snapshots: [] });

      // What drizzle-kit would write: the .sql lands in data/ on move, the
      // snapshot is handed back, never written there.
      writeFileSync(join(stageDir, "data", "0NaN_x.sql"), "SELECT 2;");
      writeFileSync(
        join(stageDir, "data", "meta", "0NaN_snapshot.json"),
        body(C, B),
      );
      expect(stage.moveEmittedInto(data)).toEqual({
        sql: ["0NaN_x.sql"],
        snapshot: { id: C, prevId: B, text: body(C, B) },
      });
      expect(existsSync(join(data, "0NaN_x.sql"))).toBe(true);
      expect(existsSync(join(data, "meta", "0NaN_snapshot.json"))).toBe(false);
      expect(
        readFileSync(join(data, "meta", "schema.snapshot.json"), "utf8"),
      ).toBe(body(B, A));
    } finally {
      stage.dispose();
    }
    expect(
      readdirSync(pluginDir).filter((f) => f.startsWith(".drizzle-stage-")),
    ).toEqual([]);
  });

  test("an unjoined fork is refused: drizzle-kit has no single snapshot to diff against", async () => {
    snapshot("20260901_000000_aaaaaaaa__a", A, NULL_SNAPSHOT_ID);
    snapshot("20260902_000000_bbbbbbbb__b", B, A);
    snapshot("20260903_000000_cccccccc__c", C, A);
    const err = await stageDrizzleOut(pluginDir, data).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnjoinedSnapshotTipsError);
  });

  test("a tip body that is not the DAG's tip is refused: drizzle-kit would diff against the wrong schema", async () => {
    snapshot("20260901_000000_aaaaaaaa__a", A, NULL_SNAPSHOT_ID);
    snapshot("20260902_000000_bbbbbbbb__b", B, A);
    writeFileSync(
      join(data, "meta", "schema.snapshot.json"),
      body(A, NULL_SNAPSHOT_ID),
    );
    const err = await stageDrizzleOut(pluginDir, data).catch((e: unknown) => e);
    expect((err as Error).message).toContain(
      `is snapshot ${A}, but the snapshot DAG's tip`,
    );
    expect(
      readdirSync(pluginDir).filter((f) => f.startsWith(".drizzle-stage-")),
    ).toEqual([]);
  });
});
