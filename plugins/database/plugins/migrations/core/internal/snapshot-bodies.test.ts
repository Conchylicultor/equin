import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";
import { foldMergeParents, mergeNodeSnapshotText } from "./merge-node";
import {
  renderMergeSnapshotMigration,
  renderPhasedMigration,
  renderSnapshotHeader,
} from "./phases";
import { snapshotBodies } from "./snapshot-bodies";
import {
  analyzeSnapshotDag,
  NULL_SNAPSHOT_ID,
  readSnapshotNodes,
} from "./snapshot-dag";
import type { Snapshot } from "./snapshot-merge";

// Real git in a throwaway repo, with the machine's own config switched off.
const GIT_ENV = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"] as const;
const saved = new Map<string, string | undefined>();
let root = "";

beforeAll(() => {
  for (const k of GIT_ENV) saved.set(k, process.env[k]);
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  root = mkdtempSync(join(tmpdir(), "snapshot-bodies-"));
});

afterAll(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

async function gitIn(cwd: string, ...args: string[]): Promise<string> {
  const r = await spawnExpectOk(
    ["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { cwd, timeoutMs: 60_000 },
  );
  return r.stdout.trim();
}
const git = (...args: string[]) => gitIn(root, ...args);

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const W = "44444444-4444-4444-8444-444444444444";
const DATA = "store/data";
const headId = (text: string) => (JSON.parse(text) as { id: string }).id;

const body = (id: string, prevId: string, table: string) =>
  JSON.stringify({ id, prevId, tables: { [table]: {} } }, null, 2);
const empty = renderPhasedMigration({
  expand: "",
  contract: "",
  claims: [],
  supersedes: null,
});

function write(rel: string, content: string): void {
  const abs = join(root, DATA, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

describe("snapshotBodies", () => {
  test("the tip from the working tree, older bodies from the commits that added them", async () => {
    await git("init", "-q", "-b", "main", root);
    // Before the cutover: a legacy migration with its own snapshot file.
    const legacy = "20260101_000000_aaaaaaaa__a";
    write(`${legacy}.sql`, "SELECT 1;");
    write(`meta/${legacy}_snapshot.json`, body(A, NULL_SNAPSHOT_ID, "a"));
    await git("add", "-A");
    await git("commit", "-q", "-m", "legacy");
    // The cutover: folded, deleted; then a header migration B.
    rmSync(join(root, DATA, `meta/${legacy}_snapshot.json`));
    write(
      "meta/legacy-snapshots.json",
      JSON.stringify({ [legacy]: { id: A, prevId: NULL_SNAPSHOT_ID } }),
    );
    write(
      "20260102_000000_bbbbbbbb__b.sql",
      renderSnapshotHeader({ id: B, parents: [A] }) + empty,
    );
    write("meta/schema.snapshot.json", body(B, A, "b"));
    await git("add", "-A");
    await git("commit", "-q", "-m", "cutover + b");
    // C on top, committed.
    write(
      "20260103_000000_cccccccc__c.sql",
      renderSnapshotHeader({ id: C, parents: [B] }) + empty,
    );
    write("meta/schema.snapshot.json", body(C, B, "c"));
    await git("add", "-A");
    await git("commit", "-q", "-m", "c");

    const bodies = snapshotBodies(root, join(root, DATA));
    expect(await bodies.text(C)).toBe(body(C, B, "c"));
    expect(await bodies.text(B)).toBe(body(B, A, "b"));
    expect(await bodies.text(A)).toBe(body(A, NULL_SNAPSHOT_ID, "a"));
    expect((await bodies.body(B)).tables).toEqual({ b: {} });

    // A branch-local W (uncommitted) whose tip file a later write replaced:
    // nowhere to read it from — loud, never a stand-in.
    write(
      "20260104_000000_dddddddd__w.sql",
      renderSnapshotHeader({ id: W, parents: [C] }) + empty,
    );
    write("meta/schema.snapshot.json", body(C, B, "c"));
    const fresh = snapshotBodies(root, join(root, DATA));
    expect(
      ((await fresh.text(W).catch((e: unknown) => e)) as Error).message,
    ).toContain(`no body for snapshot ${W}`);
    // ...unless the generator handed it over before overwriting the file.
    fresh.remember(W, body(W, C, "w"));
    expect(await fresh.text(W)).toBe(body(W, C, "w"));
    expect(() => fresh.remember(W, body(C, B, "c"))).toThrow(
      /another snapshot/,
    );

    expect(
      ((await fresh.text("nope").catch((e: unknown) => e)) as Error).message,
    ).toContain("not a node of the snapshot DAG");
  });
});

describe("snapshotBodies: a body a rebase rewrote away", () => {
  const R = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  test("is read from the pre-rewrite commit HEAD's reflog still names", async () => {
    const repo = join(root, "rebase-repo");
    const at = (rel: string, content: string) => {
      const abs = join(repo, DATA, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    };
    await gitIn(root, "init", "-q", "-b", "main", repo);
    at(
      "20260101_000000_aaaaaaaa__base.sql",
      renderSnapshotHeader({ id: A, parents: [NULL_SNAPSHOT_ID] }) + empty,
    );
    at("meta/schema.snapshot.json", body(A, NULL_SNAPSHOT_ID, "a"));
    await gitIn(repo, "add", "-A");
    await gitIn(repo, "commit", "-q", "-m", "base");
    // The branch's own migration R, committed with its body as the tip...
    at(
      "20260102_000000_bbbbbbbb__own.sql",
      renderSnapshotHeader({ id: R, parents: [A] }) + empty,
    );
    at("meta/schema.snapshot.json", body(R, A, "r"));
    await gitIn(repo, "add", "-A");
    await gitIn(repo, "commit", "-q", "-m", "own");
    // ...then rewritten the way a rebase's merge driver leaves it: the .sql
    // replayed, the tip file upstream's.
    at("meta/schema.snapshot.json", body(A, NULL_SNAPSHOT_ID, "a"));
    await gitIn(repo, "add", "-A");
    await gitIn(repo, "commit", "-q", "--amend", "-m", "own (rebased)");

    const bodies = snapshotBodies(repo, join(repo, DATA));
    expect(await bodies.text(R)).toBe(body(R, A, "r"));
  });
});

describe("snapshotBodies: a merge node's body is never needed in git", () => {
  const P = "55555555-5555-4555-8555-555555555555";
  const U = "66666666-6666-4666-8666-666666666666";
  const M = "77777777-7777-5777-8777-777777777777";
  const X = "88888888-8888-4888-8888-888888888888";
  const Y = "99999999-9999-4999-8999-999999999999";
  const Z = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  test("one commit carrying a merge node AND a migration on top: M is recomputed, and a later merge based on M works", async () => {
    const repo = join(root, "merge-repo");
    const at = (rel: string, content: string) => {
      const abs = join(repo, DATA, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    };
    const migration = (tag: string, id: string, parents: string[]) =>
      at(`${tag}.sql`, renderSnapshotHeader({ id, parents }) + empty);
    const commit = async (msg: string) => {
      await gitIn(repo, "add", "-A");
      await gitIn(repo, "commit", "-q", "-m", msg);
    };
    const tables = (...names: string[]) =>
      JSON.stringify(
        {
          id: "",
          prevId: "",
          tables: Object.fromEntries(names.map((n) => [n, {}])),
        },
        null,
        2,
      );
    const tip = (id: string, prevId: string, ...names: string[]) =>
      at(
        "meta/schema.snapshot.json",
        tables(...names)
          .replace('"id": ""', `"id": "${id}"`)
          .replace('"prevId": ""', `"prevId": "${prevId}"`),
      );
    await gitIn(root, "init", "-q", "-b", "main", repo);
    const dataDir = join(repo, DATA);

    migration("20260101_000000_aaaaaaaa__base", A, [NULL_SNAPSHOT_ID]);
    tip(A, NULL_SNAPSHOT_ID, "base");
    await commit("base");
    migration("20260102_000000_bbbbbbbb__upstream", P, [A]);
    tip(P, A, "base", "p");
    await commit("upstream");
    // The user's side, forked from A (a commit of its own: both are published).
    migration("20260102_000000_cccccccc__user", U, [A]);
    tip(U, A, "base", "u");
    await commit("user");

    // The join writes M; the same push regenerates X on top of it. Only X's
    // body is ever committed as the tip.
    const dag = analyzeSnapshotDag(await readSnapshotNodes(dataDir));
    const writer = snapshotBodies(repo, dataDir);
    const fold = await foldMergeParents(
      dag,
      [P, U],
      async (id) => (await writer.body(id)) as Snapshot,
    );
    if (!fold.ok) throw new Error("expected a clean fold");
    const mText = mergeNodeSnapshotText(M, [P, U], fold.merged);
    at(
      "20260103_000000_dddddddd__merge_snapshot.sql",
      renderMergeSnapshotMigration({ id: M, parents: [P, U] }),
    );
    migration("20260103_000001_eeeeeeee__merged", X, [M]);
    tip(X, M, "base", "p", "u", "x");
    await commit("merge node + merged migration, one push");
    expect(
      await gitIn(
        repo,
        "log",
        "--format=%H",
        `-S"id": "${M}"`,
        "--",
        `${DATA}/meta/schema.snapshot.json`,
      ),
    ).toBe("");

    // Recomputed from P and U (bodies from git), byte-identical.
    expect(await snapshotBodies(repo, dataDir).text(M)).toBe(mText);

    // A later fork whose nearest common ancestor IS M: Z on X (committed),
    // Y straight on M (the working tree's tip). Joining them reads M's body.
    migration("20260104_000000_99999999__z", Z, [X]);
    tip(Z, X, "base", "p", "u", "x", "z");
    await commit("z");
    migration("20260104_000001_ffffffff__y", Y, [M]);
    tip(Y, M, "base", "p", "u", "y");
    const later = analyzeSnapshotDag(await readSnapshotNodes(dataDir));
    expect(later.tips.map((t) => t.id).sort()).toEqual([Y, Z].sort());
    const reader = snapshotBodies(repo, dataDir);
    const second = await foldMergeParents(
      later,
      [Z, Y],
      async (id) => (await reader.body(id)) as Snapshot,
    );
    expect(
      second.ok && Object.keys(second.merged.tables as object).sort(),
    ).toEqual(["base", "p", "u", "x", "y", "z"]);
    // Every header id in the DAG resolves to a body.
    for (const n of later.byId.values()) {
      expect(headId(await reader.text(n.id))).toBe(n.id);
    }
  });
});
