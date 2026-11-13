/**
 * snapshot-chain-intact is input-keyed: its PASS is replayed against later
 * trees for as long as the files it read are unchanged. These cases pin that
 * the replay is exactly as wide as the verdict — run the way the runner drives
 * it (the check's `ctx.repo()` recorded into a read-set, then validated
 * against a fresh snapshot of the edited tree):
 *
 *   1. an edit outside the migrations data dir is a HIT — the whole point;
 *   2. an edit to a migration is a MISS, and the re-run sees it;
 *   3. a migration added is a MISS (the data dir's membership);
 *   4. an edit to the tip file is a MISS, and the re-run sees it;
 *   5. the cache signature moves when a migration lands on `main`, and only
 *      then.
 *
 * And the verdict on a history with two merge nodes, one the other's parent:
 * every body is asked in one pass, and a merge node's recompute must not read
 * as descending from itself.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createReadSetRepo,
  type ReadSetRepo,
} from "@plugins/framework/plugins/tooling/plugins/checks/core/testing";
import {
  MIGRATIONS_DATA_DIR,
  NULL_SNAPSHOT_ID,
  publishedMigrationTreesSignature,
} from "@plugins/database/plugins/migrations/core";
import {
  renderMergeSnapshotMigration,
  renderPhasedMigration,
  renderSnapshotHeader,
} from "@plugins/database/plugins/migrations/plugins/phases/core";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";
import { verifySnapshotChain } from "./verify";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const MISSING = "99999999-9999-4999-8999-999999999999";

const data = (rel: string) => `${MIGRATIONS_DATA_DIR}/${rel}`;
const FIRST = data("20260101_000000_aaaaaaaa__a.sql");
const TIP = data("meta/schema.snapshot.json");
const empty = renderPhasedMigration({
  expand: "",
  contract: "",
  claims: [],
  supersedes: null,
});
const body = (id: string, prevId: string) =>
  JSON.stringify({ id, prevId, tables: {} }, null, 2);

let repo: ReadSetRepo;
const git = (...args: string[]) =>
  spawnExpectOk(["git", ...args], { cwd: repo.root, timeoutMs: 30_000 });

beforeAll(async () => {
  repo = await createReadSetRepo("snapshot-chain-intact-", {
    [FIRST]:
      renderSnapshotHeader({ id: A, parents: [NULL_SNAPSHOT_ID] }) + empty,
    [TIP]: body(A, NULL_SNAPSHOT_ID),
    "README.md": "# fixture\n",
  });
  // The fixture's commit is the published history: local `main`.
  await git("branch", "-M", "main");
});

afterAll(() => repo?.dispose());

const record = () => repo.recordRepo((files) => verifySnapshotChain(files));

test("a healthy chain passes, its data dir in the read-set", async () => {
  const { readSet, result } = await record();
  expect(result).toEqual({ ok: true });
  const read = readSet.files.map((f) => f.path);
  expect(read).toContain(FIRST);
  expect(read).toContain(TIP);
  expect(read).not.toContain("README.md");
});

test("case 1: an edit outside the data dir keeps the PASS", async () => {
  const { readSet } = await record();
  repo.write("README.md", "# fixture, edited\n");
  expect((await repo.revalidate(readSet)).hit).toBe(true);
});

test("case 2: an edit to a migration re-runs it, and the re-run fails", async () => {
  const { readSet } = await record();
  repo.write(
    FIRST,
    renderSnapshotHeader({ id: A, parents: [MISSING] }) + empty,
  );
  expect((await repo.revalidate(readSet)).hit).toBe(false);
  const { result } = await record();
  expect(result.ok).toBe(false);
  repo.write(
    FIRST,
    renderSnapshotHeader({ id: A, parents: [NULL_SNAPSHOT_ID] }) + empty,
  );
  expect((await record()).result).toEqual({ ok: true });
});

test("case 3: a migration added re-runs it", async () => {
  const { readSet } = await record();
  const second = data("20260102_000000_bbbbbbbb__b.sql");
  repo.write(second, renderSnapshotHeader({ id: B, parents: [A] }) + empty);
  expect((await repo.revalidate(readSet)).hit).toBe(false);
  // The tip file is still A's: the re-run says so.
  const { result } = await record();
  expect(result.ok).toBe(false);
  repo.remove(second);
});

test("case 4: an edit to the tip file re-runs it, and the re-run fails", async () => {
  const { readSet } = await record();
  repo.write(TIP, body(B, A));
  expect((await repo.revalidate(readSet)).hit).toBe(false);
  expect((await record()).result.ok).toBe(false);
  repo.write(TIP, body(A, NULL_SNAPSHOT_ID));
  expect((await record()).result).toEqual({ ok: true });
});

test("case 5: the signature moves when main's migrations do, not when main does", async () => {
  const before = await publishedMigrationTreesSignature(repo.root);
  await git("add", "README.md");
  await git("commit", "-q", "-m", "docs only");
  expect(await publishedMigrationTreesSignature(repo.root)).toBe(before);
  repo.write(data("20260103_000000_cccccccc__data.sql"), "SELECT 1;\n");
  await git("add", "-A");
  await git("commit", "-q", "-m", "a migration lands");
  expect(await publishedMigrationTreesSignature(repo.root)).not.toBe(before);
});

test("two merge nodes, one the other's parent, below the tip: every body resolves", async () => {
  const P = "33333333-3333-4333-8333-333333333333";
  const U = "44444444-4444-4444-8444-444444444444";
  const M1 = "55555555-5555-4555-8555-555555555555";
  const V = "66666666-6666-4666-8666-666666666666";
  const M2 = "77777777-7777-4777-8777-777777777777";
  const X = "88888888-8888-4888-8888-888888888888";
  const tipOf = (id: string, prevId: string, ...tables: string[]) =>
    JSON.stringify(
      { id, prevId, tables: Object.fromEntries(tables.map((t) => [t, {}])) },
      null,
      2,
    );
  const merges = await createReadSetRepo("snapshot-chain-merges-", {
    [data("20260101_000000_aaaaaaaa__a.sql")]:
      renderSnapshotHeader({ id: A, parents: [NULL_SNAPSHOT_ID] }) + empty,
    [TIP]: tipOf(A, NULL_SNAPSHOT_ID, "a"),
  });
  try {
    const run = (...args: string[]) =>
      spawnExpectOk(["git", ...args], { cwd: merges.root, timeoutMs: 30_000 });
    await run("branch", "-M", "main");
    // Each node committed with its body as the tip: published, read from git.
    const land = async (
      tag: string,
      sql: string,
      id: string,
      prevId: string,
      tables: string[],
    ) => {
      merges.write(data(`${tag}.sql`), sql);
      merges.write(TIP, tipOf(id, prevId, ...tables));
      await run("add", "-A");
      await run("commit", "-q", "-m", tag);
    };
    const header = (id: string, parents: string[]) =>
      renderSnapshotHeader({ id, parents }) + empty;
    await land("20260102_000000_bbbbbbbb__p", header(P, [A]), P, A, ["a", "p"]);
    await land("20260102_000001_cccccccc__u", header(U, [A]), U, A, ["a", "u"]);
    // M1 joins P and U; V forks from P; M2 joins M1 and V (nearest common
    // ancestor P). Their bodies are recomputed, M2's through M1's.
    await land(
      "20260103_000000_dddddddd__m1",
      renderMergeSnapshotMigration({ id: M1, parents: [P, U] }),
      M1,
      U,
      ["a", "p", "u"],
    );
    await land("20260103_000001_eeeeeeee__v", header(V, [P]), V, P, [
      "a",
      "p",
      "v",
    ]);
    await land(
      "20260104_000000_ffffffff__m2",
      renderMergeSnapshotMigration({ id: M2, parents: [M1, V] }),
      M2,
      V,
      ["a", "p", "u", "v"],
    );
    await land("20260105_000000_abababab__x", header(X, [M2]), X, M2, [
      "a",
      "p",
      "u",
      "v",
      "x",
    ]);
    const { result } = await merges.recordRepo((files) =>
      verifySnapshotChain(files),
    );
    expect(result).toEqual({ ok: true });
  } finally {
    merges.dispose();
  }
});
