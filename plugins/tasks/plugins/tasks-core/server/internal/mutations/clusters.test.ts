/**
 * Real-DB invariant suite for the monotone membership label (`tasks.cluster_id`)
 * — design: `research/2026-08-03-tasks-monotone-deps-tree-membership.md`.
 *
 * Two harnesses, deliberately, because the two halves need opposite things:
 *
 *  - **`describe("unionTaskClusters")`** drives the union primitive against a
 *    THROWAWAY database (`db-test-fixture` + the real migration chain).
 *    `unionTaskClusters` touches only the `tasks` base table, so migrations are
 *    the whole schema it needs — and a throwaway DB is the only way to get two
 *    genuinely concurrent COMMITTED transactions, which the lost-update test at
 *    the bottom requires. The fixture's own pool is `max: 1`, so two extra
 *    single-connection handles are opened (the `page-forest.test.ts` pattern).
 *
 *  - **`describe("union points")`** drives the callers (`addTaskDependency`,
 *    `createTask`, `updateTask`) against the REAL worktree DB inside a
 *    transaction that is rolled back (`worktreeDbScenario`). Those read the
 *    `tasks_v` view for their status snapshot, and only the real boot builds the
 *    derived-view layer — a migrations-only throwaway cannot reproduce it (same
 *    constraint `deps-tree-move.test.ts` documents). Each takes an `exec`, so
 *    the whole scenario joins that transaction and nothing lands in the
 *    worktree DB.
 *
 * Run: `./equin test plugins/tasks/plugins/tasks-core`.
 *
 * Both halves need the running embedded cluster. The `union points` half
 * additionally needs THIS worktree's database as a real boot leaves it, because
 * the derived VIEW layer it reads is rebuilt from source on every boot and is
 * not part of the migration chain — so `./equin build` first. What is no
 * longer part of that requirement is the queue schema: `worktreeDbScenario`
 * installs `graphile_worker` itself before the first scenario opens, so the
 * status-change emits these mutations enqueue no longer depend on a prior boot.
 */

import { defineMandate } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/policy/core";
import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import { inArray, sql } from "drizzle-orm";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { worktreeDbScenario } from "@plugins/database/plugins/db-test-fixture/plugins/worktree-db/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { _tasks } from "../tables";
import type { DbExecutor } from "../status-batch";
import {
  addTaskDependency,
  createTask,
  removeTaskDependency,
  updateTask,
} from "./tasks";
import { clusterLabelOf, unionTaskClusters } from "./clusters";

// Any registered mandate id: these tests never resolve it.
const TEST_MANDATE = defineMandate({ id: "interactive", label: "Interactive" });

// ── Shared helpers ─────────────────────────────────────────────────────────

type Exec = DbExecutor | NodePgDatabase;

/**
 * Seed bare task rows. `cluster_id` is deliberately OMITTED: the column is
 * nullable and `NULL` means "never unioned ⇒ own singleton", which is the
 * starting state every test here wants. Tasks are `dropped` so their computed
 * status is edge-independent and no move/edge write ever flips it.
 */
async function seedTasks(exec: Exec, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i++) {
    await exec.execute(sql`
      INSERT INTO tasks (id, title, title_auto, rank, dropped_at, created_at, updated_at, mandate_ref)
      VALUES (${ids[i]}, ${ids[i]}, true, ${"a" + i}, now(), now(), now(), 'interactive')
    `);
  }
}

/** Raw `cluster_id` per id — NULL included, so "was the row written?" is visible. */
async function readRawLabels(
  exec: Exec,
  ids: string[],
): Promise<Map<string, string | null>> {
  const rows = await exec
    .select({ id: _tasks.id, clusterId: _tasks.clusterId })
    .from(_tasks)
    .where(inArray(_tasks.id, ids));
  return new Map(rows.map((r) => [r.id, r.clusterId]));
}

/** The effective label per id (`cluster_id ?? id`) — what readers actually see. */
async function readLabels(
  exec: Exec,
  ids: string[],
): Promise<Map<string, string>> {
  const raw = await readRawLabels(exec, ids);
  return new Map(ids.map((id) => [id, raw.get(id) ?? id]));
}

/**
 * Assert every id resolves to ONE shared label, and return it. Compared as a
 * whole id→label map against that same map flattened onto the first label, so a
 * failure names the task that drifted and what it drifted to — "distinct: 2"
 * would not.
 */
async function expectOneCluster(exec: Exec, ids: string[]): Promise<string> {
  const labels = await readLabels(exec, ids);
  const first = labels.get(ids[0]!)!;
  expect(Object.fromEntries(labels)).toEqual(
    Object.fromEntries(ids.map((id) => [id, first])),
  );
  return first;
}

/**
 * Await `p` and return the Error it rejected with; throw if it resolved.
 * `expect(p).rejects.toThrow()` is typed `void` under bun:test (see the
 * spawn/git-roots and host-semaphore suites' identical helper), so this asserts
 * the rejection for real and hands back the error to pin its class.
 */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

// ══ 1. The union primitive, on a throwaway DB ══════════════════════════════

describe("unionTaskClusters", () => {
  let t: TestDb;
  /** Two independent connections, so two unions can genuinely be in flight. */
  let poolA: Pool;
  let poolB: Pool;
  let dbA: NodePgDatabase;
  let dbB: NodePgDatabase;
  /** The fixture handle as the executor the mutations take. */
  let tdb: DbExecutor;

  // Ids chosen so lexicographic order is a < b < c < d — `min` is the winner,
  // and the test can name the expected label without recomputing it.
  const A = "clu-a";
  const B = "clu-b";
  const C = "clu-c";
  const D = "clu-d";

  beforeAll(async () => {
    t = await createTestDb({ prefix: "clusters_test" });
    // The REAL schema via the db-parametrized runner — no hand-mirrored DDL to
    // drift from `tasks.cluster_id` and its index.
    await runMigrations(t.db);
    poolA = new Pool({ connectionString: t.connectionString, max: 1 });
    poolB = new Pool({ connectionString: t.connectionString, max: 1 });
    dbA = drizzle(poolA);
    dbB = drizzle(poolB);
    tdb = t.db as DbExecutor;
  });

  afterAll(async () => {
    // Close the extra sessions first — a database with open sessions cannot be
    // dropped.
    await poolA.end();
    await poolB.end();
    await t.drop();
  });

  beforeEach(async () => {
    await t.db.execute(sql`DELETE FROM tasks`);
    await seedTasks(t.db, [A, B, C, D]);
  });

  test("two never-unioned tasks fuse onto min(id), and BOTH rows are written", async () => {
    await unionTaskClusters(B, A, tdb);

    const raw = await readRawLabels(t.db, [A, B]);
    // Neither endpoint may be left NULL: a NULL loser would still READ as its
    // own singleton, which is exactly the split this label exists to prevent.
    expect(raw.get(A)).toBe(A);
    expect(raw.get(B)).toBe(A);
  });

  test("unioning an already-unioned pair is a no-op", async () => {
    await unionTaskClusters(A, B, tdb);
    const before = await readRawLabels(t.db, [A, B]);

    await unionTaskClusters(A, B, tdb);
    await unionTaskClusters(B, A, tdb); // and from the other side
    expect(await readRawLabels(t.db, [A, B])).toEqual(before);
  });

  test("order-independent: every union order lands on the same min(A,B,C)", async () => {
    // min is associative and idempotent, so the three interleavings must be
    // indistinguishable — this is what lets the incremental union and a batch
    // backfill agree by construction.
    const orders: [string, string][][] = [
      [
        [A, B],
        [B, C],
      ],
      [
        [B, C],
        [A, B],
      ],
      [
        [A, C],
        [A, B],
      ],
    ];
    for (const order of orders) {
      await t.db.execute(sql`UPDATE tasks SET cluster_id = NULL`);
      for (const [x, y] of order) await unionTaskClusters(x, y, tdb);
      expect(await expectOneCluster(t.db, [A, B, C])).toBe(A);
    }
  });

  test("merging two multi-member clusters relabels every member, not just the endpoints", async () => {
    await unionTaskClusters(C, D, tdb); // {C,D} → C
    await unionTaskClusters(A, B, tdb); // {A,B} → A
    await unionTaskClusters(B, D, tdb); // bridge via non-label members

    expect(await expectOneCluster(t.db, [A, B, C, D])).toBe(A);
  });

  test("clusterLabelOf reports id for a never-unioned task and the label after", async () => {
    expect(await clusterLabelOf(B, tdb)).toBe(B);
    await unionTaskClusters(A, B, tdb);
    expect(await clusterLabelOf(B, tdb)).toBe(A);
    expect(await clusterLabelOf(A, tdb)).toBe(A);
  });

  // ── THE lost-update race ─────────────────────────────────────────────────
  //
  // This is the only test that proves the `SELECT … FOR UPDATE` is load-bearing.
  // Two concurrent transactions overlapping on B:
  //
  //   T1 union(A,B): reads NULL,NULL → winner A → UPDATE … id IN (A,B)
  //   T2 union(B,C): reads NULL,NULL → winner B → UPDATE … id IN (B,C)
  //
  // WITHOUT the row lock T2's SELECT does not block, so it computes min(B,C)=B
  // from the pre-T1 snapshot. Its UPDATE then blocks on B, re-evaluates after
  // T1 commits, finds B no longer NULL, and writes only C — stranding C on
  // label B, which nobody else carries. That is the reported bug in a form no
  // edge removal explains, and both transactions commit cleanly, so nothing
  // else would ever surface it.
  //
  // WITH the lock, T2's SELECT blocks on B, re-reads it as A after T1 commits,
  // and computes min(A,C)=A. All three land on A.
  //
  // VERIFIED NON-VACUOUS — do not take this on faith, it was measured. A
  // concurrency test that never forces the overlap passes against a broken
  // implementation too, so this interleaving was run against a copy of
  // `unionTaskClusters` with `.for("update")` removed: C ended up labelled B
  // while A and B were labelled A — two clusters, C stranded on a label nobody
  // else carries. The real implementation puts all three on A.
  //
  // The `t1Locked` / `t1MayCommit` gates are what force the overlap: T2 always
  // begins while T1 still holds its rows uncommitted, and T1 always commits
  // second. Do NOT replace them with a plain `Promise.all` of the two unions —
  // that leaves the interleaving to chance and the test proves nothing.
  //
  // Both racers are handed an explicit `tx`, so this exercises the join-the-
  // caller's-transaction path. `unionTaskClusters` self-wrapping when handed the
  // pool is a separate guarantee and does not weaken this one.
  test("concurrent overlapping unions on two connections converge to ONE label", async () => {
    const t1Locked = gate();
    const t1MayCommit = gate();

    const t1 = dbA.transaction(async (tx) => {
      await unionTaskClusters(A, B, tx as DbExecutor);
      t1Locked.open(); // A and B are now write-locked, uncommitted
      await t1MayCommit.wait;
    });

    await t1Locked.wait;

    // T2 overlaps on B. Under the lock its SELECT blocks here; without one it
    // races straight through on a stale snapshot.
    const t2 = dbB.transaction(async (tx) => {
      await unionTaskClusters(B, C, tx as DbExecutor);
    });

    // Give T2 its chance to reach (or block on) its own statements. There is no
    // signal to await BY DESIGN — under the lock T2 cannot make progress until
    // T1 commits, so waiting on it would deadlock the test.
    await raceWindow();
    t1MayCommit.open();
    await Promise.all([t1, t2]);

    expect(await expectOneCluster(t.db, [A, B, C])).toBe(A);
  });
});

/** A promise plus its resolver — the explicit hand-off between two racers. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

const RACE_WINDOW_MS = 200;
const raceWindow = () =>
  new Promise((resolve) => setTimeout(resolve, RACE_WINDOW_MS));

// ══ 2. The union points, on the real DB, rolled back ═══════════════════════

describe("union points", () => {
  const P = "clup-"; // id prefix — isolates our reads from real tasks in the DB

  // Every scenario below satisfies `worktreeDbScenario`'s standing constraint
  // (no statement may raise a Postgres error, or the transaction aborts and the
  // reads after it fail): the rejection tests call a throwing mutation inside
  // the open transaction and then keep reading from that same `tx`, which is
  // sound only because every rejection asserted here is a JS-level `throw` — a
  // `SELECT` returned no rows, or the cycle/self/descendant guard tripped.

  test("MONOTONE: removing the dependency edge does not un-union its endpoints", async () => {
    // The core invariant, and the whole reason the label is persisted state
    // rather than a walk over live edges.
    const [a, b] = [P + "m0", P + "m1"];
    const labels = await worktreeDbScenario(async (tx) => {
      await seedTasks(tx, [a, b]);
      await addTaskDependency(b, a, tx); // b depends on a
      await removeTaskDependency(b, a, tx);
      // The edge really is gone — otherwise the assertion below is vacuous.
      const edges = await tx.execute(
        sql`SELECT 1 FROM task_dependencies WHERE task_id = ${b}`,
      );
      expect(edges.rows).toHaveLength(0);
      return readLabels(tx, [a, b]);
    });

    expect(new Set(labels.values()).size).toBe(1);
  });

  test("addTaskDependency unions a whole chain into one cluster", async () => {
    const [a, b, c] = [P + "c0", P + "c1", P + "c2"];
    const labels = await worktreeDbScenario(async (tx) => {
      await seedTasks(tx, [a, b, c]);
      await addTaskDependency(b, a, tx);
      await addTaskDependency(c, b, tx);
      return readLabels(tx, [a, b, c]);
    });

    expect(new Set(labels.values())).toEqual(new Set([a])); // min of the three
  });

  test("createTask under a folder inherits the folder's label", async () => {
    const folderId = P + "f0";
    const labels = await worktreeDbScenario(async (tx) => {
      await seedTasks(tx, [folderId]);
      const child = await createTask({ folderId, title: "child" }, tx);
      return readLabels(tx, [folderId, child.id]);
    });

    expect(new Set(labels.values()).size).toBe(1);
  });

  test("createTask with no folder starts as its own singleton (cluster_id NULL)", async () => {
    const raw = await worktreeDbScenario(async (tx) => {
      const solo = await createTask(
        { title: "solo", mandate: TEST_MANDATE },
        tx,
      );
      return readRawLabels(tx, [solo.id]);
    });

    expect([...raw.values()]).toEqual([null]);
  });

  test("a folder re-file unions the task into the folder's cluster", async () => {
    // `updateTask`'s folderId branch. Filing IS a membership edge, so the two
    // must end up in one cluster even though no dependency edge exists.
    const [folder, moved] = [P + "u0", P + "u1"];
    const labels = await worktreeDbScenario(async (tx) => {
      await seedTasks(tx, [folder, moved]);
      await updateTask(moved, { folderId: folder }, tx);
      return readLabels(tx, [folder, moved]);
    });

    expect(new Set(labels.values())).toEqual(new Set([folder])); // min of the two
  });

  test("a re-file rejected by the self guard does not union", async () => {
    // The transaction alone cannot guarantee this once `updateTask` wraps its
    // own body: a union that ran BEFORE the guard would be committed along with
    // everything else. Only the union sitting after both guards makes it true.
    const solo = P + "u2";
    const raw = await worktreeDbScenario(async (tx) => {
      await seedTasks(tx, [solo]);
      const err = await rejection(updateTask(solo, { folderId: solo }, tx));
      expect(err.message).toMatch(/into itself/i);
      return readRawLabels(tx, [solo]);
    });

    expect(raw.get(solo)).toBeNull();
  });

  test("a re-file rejected by the descendant guard does not union", async () => {
    // `child` is already filed under `parent`; filing `parent` under `child`
    // would invert the hierarchy. The raw folder seed deliberately bypasses
    // `updateTask`, so both start unlabelled and a stray union would show.
    const [parent, child] = [P + "u3", P + "u4"];
    const raw = await worktreeDbScenario(async (tx) => {
      await seedTasks(tx, [parent, child]);
      await tx.execute(
        sql`UPDATE tasks SET folder_id = ${parent} WHERE id = ${child}`,
      );
      const err = await rejection(updateTask(parent, { folderId: child }, tx));
      expect(err.message).toMatch(/descendant/i);
      return readRawLabels(tx, [parent, child]);
    });

    expect([...raw.values()]).toEqual([null, null]);
  });

  test("a REJECTED edge leaves both labels exactly as they were", async () => {
    // Two independent clusters must not fuse just because someone asked for an
    // impossible edge: the union may not run ahead of the validation.
    const [a, ghost] = [P + "r0", P + "missing"];
    const raw = await worktreeDbScenario(async (tx) => {
      await seedTasks(tx, [a]);
      const err = await rejection(addTaskDependency(a, ghost, tx));
      expect(err.message).toMatch(/not found/i);
      return readRawLabels(tx, [a]);
    });

    expect(raw.get(a)).toBeNull();
  });

  test("a rejected CYCLE leaves the (already shared) label untouched", async () => {
    // Necessarily weaker than the case above, and deliberately so: a cycle can
    // only be formed between tasks that are already in one connected component,
    // hence already unioned — so no cycle rejection can ever fuse two distinct
    // clusters. What this pins is that the rejection path does not RE-label.
    const [a, b] = [P + "y0", P + "y1"];
    const { before, after } = await worktreeDbScenario(async (tx) => {
      await seedTasks(tx, [a, b]);
      await addTaskDependency(b, a, tx);
      const before = await readRawLabels(tx, [a, b]);
      const err = await rejection(addTaskDependency(a, b, tx));
      expect(err.message).toMatch(/cycle/i);
      return { before, after: await readRawLabels(tx, [a, b]) };
    });

    expect(after).toEqual(before);
  });
});
