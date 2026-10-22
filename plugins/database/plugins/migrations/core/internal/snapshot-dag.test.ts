import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { renderPhasedMigration, renderSnapshotHeader } from "./phases";
import {
  analyzeSnapshotDag,
  NULL_SNAPSHOT_ID,
  readSnapshotNodes,
  schemaSnapshotState,
  snapshotAncestors,
  type SnapshotNode,
} from "./snapshot-dag";

const node = (
  file: string,
  id: string,
  prevId: string,
  mergeParents: string[] | null = null,
): SnapshotNode => ({
  file,
  id,
  prevId,
  mergeParents,
  lineage: mergeParents ? "header" : "legacy",
});

const kinds = (nodes: SnapshotNode[]) =>
  analyzeSnapshotDag(nodes).problems.map((p) => p.kind);

describe("analyzeSnapshotDag", () => {
  test("a linear chain is healthy", () => {
    const dag = analyzeSnapshotDag([
      node("1", "a", NULL_SNAPSHOT_ID),
      node("2", "b", "a"),
      node("3", "c", "b"),
    ]);
    expect(dag.problems).toEqual([]);
    expect(dag.tips.map((t) => t.id)).toEqual(["c"]);
  });

  test("a Y-fork without a merge node has two tips", () => {
    expect(
      analyzeSnapshotDag([
        node("1", "a", NULL_SNAPSHOT_ID),
        node("2", "p", "a"),
        node("3", "u", "a"),
      ]).problems,
    ).toEqual([{ kind: "multiple-tips", files: ["2", "3"] }]);
  });

  test("a merge node joins the fork: one root, one tip", () => {
    const nodes = [
      node("1", "a", NULL_SNAPSHOT_ID),
      node("2", "p", "a"),
      node("3", "u", "a"),
      node("4", "m", "u", ["p", "u"]),
      node("5", "next", "m"),
    ];
    const dag = analyzeSnapshotDag(nodes);
    expect(dag.problems).toEqual([]);
    expect(dag.tips.map((t) => t.id)).toEqual(["next"]);
    expect([...snapshotAncestors(dag, "m")].sort()).toEqual([
      "a",
      "m",
      "p",
      "u",
    ]);
  });

  test("a merge parent that does not exist is reported", () => {
    expect(
      kinds([
        node("1", "a", NULL_SNAPSHOT_ID),
        node("2", "u", "a"),
        node("3", "m", "u", ["gone", "u"]),
      ]),
    ).toEqual(["missing-parent"]);
  });

  test("a merge node whose prevId is not among its parents is reported", () => {
    expect(
      kinds([
        node("1", "a", NULL_SNAPSHOT_ID),
        node("2", "p", "a"),
        node("3", "u", "a"),
        node("4", "m", "a", ["p", "u"]),
      ]),
    ).toEqual(["merge-prev-not-parent"]);
  });

  test("duplicate ids, several roots, and an orphan branch are reported", () => {
    expect(
      kinds([
        node("1", "a", NULL_SNAPSHOT_ID),
        node("2", "a", NULL_SNAPSHOT_ID),
        node("3", "b", "a"),
      ]),
    ).toEqual(["duplicate-id"]);
    expect(
      kinds([
        node("1", "a", NULL_SNAPSHOT_ID),
        node("2", "b", NULL_SNAPSHOT_ID),
      ]),
    ).toEqual(["multiple-roots", "multiple-tips"]);
  });

  test("a cycle through merge parents is reported", () => {
    expect(
      kinds([
        node("1", "a", NULL_SNAPSHOT_ID),
        node("2", "b", "a", ["a", "c"]),
        node("3", "c", "b"),
      ]),
    ).toContain("cycle");
  });
});

describe("readSnapshotNodes / schemaSnapshotState", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";
  const C = "33333333-3333-4333-8333-333333333333";
  const D = "44444444-4444-4444-8444-444444444444";
  const empty = renderPhasedMigration({
    expand: "",
    contract: "",
    claims: [],
    supersedes: null,
  });
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "snapshot-dag-"));
    mkdirSync(join(dir, "meta"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const head = (id: string, prevId: string) =>
    JSON.stringify({ id, prevId, tables: {} }, null, 2);

  test("legacy entries, an unfolded legacy file and headers form one DAG; data migrations are not nodes", async () => {
    writeFileSync(join(dir, "20260101_000000_aaaaaaaa__a.sql"), "SELECT 1;");
    writeFileSync(join(dir, "20260102_000000_bbbbbbbb__b.sql"), "SELECT 1;");
    writeFileSync(
      join(dir, "meta", "legacy-snapshots.json"),
      JSON.stringify({
        "20260101_000000_aaaaaaaa__a": { id: A, prevId: NULL_SNAPSHOT_ID },
      }),
    );
    // Not yet folded: read from its own head.
    writeFileSync(
      join(dir, "meta", "20260102_000000_bbbbbbbb__b_snapshot.json"),
      head(B, A),
    );
    writeFileSync(
      join(dir, "20260103_000000_cccccccc__data.sql"),
      "UPDATE t SET x = 1;",
    );
    writeFileSync(
      join(dir, "20260104_000000_dddddddd__c.sql"),
      renderSnapshotHeader({ id: C, parents: [B] }) + empty,
    );

    const nodes = await readSnapshotNodes(dir);
    expect(
      nodes
        .map((n) => [n.file, n.id, n.prevId, n.lineage])
        .sort((a, b) => a[0]!.localeCompare(b[0]!)),
    ).toEqual([
      ["20260101_000000_aaaaaaaa__a.sql", A, NULL_SNAPSHOT_ID, "legacy"],
      ["20260102_000000_bbbbbbbb__b.sql", B, A, "legacy"],
      ["20260104_000000_dddddddd__c.sql", C, B, "header"],
    ]);
    const dag = analyzeSnapshotDag(nodes);
    expect(dag.problems).toEqual([]);

    expect(schemaSnapshotState(dir, dag)).toEqual({
      ok: false,
      message: expect.stringContaining("is missing"),
    });
    writeFileSync(join(dir, "meta", "schema.snapshot.json"), head(B, A));
    expect(schemaSnapshotState(dir, dag)).toEqual({
      ok: false,
      message: expect.stringContaining(
        `is snapshot ${B}, but the snapshot DAG's tip is`,
      ),
    });
    writeFileSync(join(dir, "meta", "schema.snapshot.json"), head(C, B));
    expect(schemaSnapshotState(dir, dag)).toEqual({ ok: true });
  });

  test("a merge header's parents are the node's edges, its last parent its prevId", async () => {
    writeFileSync(
      join(dir, "meta", "legacy-snapshots.json"),
      JSON.stringify({
        "20260101_000000_aaaaaaaa__a": { id: A, prevId: NULL_SNAPSHOT_ID },
        "20260102_000000_bbbbbbbb__b": { id: B, prevId: A },
        "20260102_000000_cccccccc__c": { id: C, prevId: A },
      }),
    );
    writeFileSync(
      join(dir, "20260103_000000_dddddddd__merge_snapshot.sql"),
      renderSnapshotHeader({ id: D, parents: [B, C] }) + empty,
    );
    const nodes = await readSnapshotNodes(dir);
    const merge = nodes.find((n) => n.id === D)!;
    expect(merge).toMatchObject({ prevId: C, mergeParents: [B, C] });
    const dag = analyzeSnapshotDag(nodes);
    expect(dag.problems).toEqual([]);
    expect(dag.tips.map((t) => t.id)).toEqual([D]);
  });
});
