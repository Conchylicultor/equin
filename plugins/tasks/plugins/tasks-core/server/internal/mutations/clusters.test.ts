/**
 * Real-DB invariant suite for the monotone membership label (`tasks.cluster_id`)
 * — design: `research/2026-08-03-tasks-monotone-deps-tree-membership.md`.
 *
 * Two harnesses, deliberately, because the two halves need opposite things:
 *
 *  - **`describe("the cluster triggers")`** drives the database's union
 *    (`tasks_union_clusters`), its edge triggers, its relabel check and its
 *    size bound (`../cluster-triggers.ts`) against a THROWAWAY database
 *    (`db-test-fixture` + the real migration chain + `installDbTriggers`) —
 *    the only way to get genuinely concurrent COMMITTED transactions, which
 *    the races need. The fixture's own pool is
 *    `max: 1`, so two extra single-connection handles are opened (the
 *    `page-forest.test.ts` pattern).
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
import { clusterEdgeViolations, clusterLabelOf } from "./clusters";
import { taskClusterTriggers } from "../cluster-triggers";
import { installDbTriggers } from "@plugins/database/plugins/db-triggers/server";
import { TASK_CLUSTER_MAX } from "../../../core";

// Any registered mandate id: these tests never resolve it.
const TEST_MANDATE = defineMandate({ id: "interactive", label: "Interactive" });

// ── Shared helpers ─────────────────────────────────────────────────────────

type Exec = DbExecutor | NodePgDatabase;

/**
 * Seed bare task rows, each its own singleton (`cluster_id = id`, what
 * `createTask` writes) — the starting state every test here wants. Tasks are `dropped` so their computed
 * status is edge-independent and no move/edge write ever flips it.
 */
async function seedTasks(exec: Exec, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i++) {
    await exec.execute(sql`
      INSERT INTO tasks (id, cluster_id, title, title_auto, rank, dropped_at, created_at, updated_at, mandate_ref)
      VALUES (${ids[i]}, ${ids[i]}, ${ids[i]}, true, ${"a" + i}, now(), now(), now(), 'interactive')
    `);
  }
}

/** Raw `cluster_id` per id. */
async function readRawLabels(
  exec: Exec,
  ids: string[],
): Promise<Map<string, string>> {
  const rows = await exec
    .select({ id: _tasks.id, clusterId: _tasks.clusterId })
    .from(_tasks)
    .where(inArray(_tasks.id, ids));
  return new Map(rows.map((r) => [r.id, r.clusterId]));
}

/** The label per id, in `ids` order. */
async function readLabels(
  exec: Exec,
  ids: string[],
): Promise<Map<string, string>> {
  const raw = await readRawLabels(exec, ids);
  return new Map(ids.map((id) => [id, raw.get(id)!]));
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

// ══ 1. The database's union and check, on a throwaway DB ═══════════════════

/** The database's union, called directly (an edge write's trigger calls it). */
async function union(exec: Exec, a: string, b: string): Promise<void> {
  await exec.execute(sql`SELECT tasks_union_clusters(${a}, ${b})`);
}

describe("the cluster triggers", () => {
  let t: TestDb;
  /** Two independent connections, so two unions can genuinely be in flight. */
  let poolA: Pool;
  let poolB: Pool;
  let dbA: NodePgDatabase;
  let dbB: NodePgDatabase;
  /** The fixture handle as the executor the reads take. */
  let tdb: DbExecutor;

  // Ids chosen so lexicographic order is a < b < c < d — `min` is the winner,
  // and the test can name the expected label without recomputing it.
  const A = "clu-a";
  const B = "clu-b";
  const C = "clu-c";
  const D = "clu-d";

  beforeAll(async () => {
    t = await createTestDb({ prefix: "clusters_test" });
    // The REAL schema via the db-parametrized runner, then the trigger set the
    // boot schema layer installs — no hand-mirrored DDL to drift.
    await runMigrations(t.db);
    await installDbTriggers(t.db, [taskClusterTriggers]);
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

  test("a second install of the same set is a no-op", async () => {
    expect(await installDbTriggers(t.db, [taskClusterTriggers])).toEqual([
      { id: taskClusterTriggers.id, outcome: "unchanged", kept: 0 },
    ]);
  });

  test("two never-unioned tasks fuse onto min(id), and BOTH rows are written", async () => {
    await union(t.db, B, A);

    const raw = await readRawLabels(t.db, [A, B]);
    // The loser's whole cluster moves: an endpoint left on its own label would
    // own singleton, which is exactly the split this label exists to prevent.
    expect(raw.get(A)).toBe(A);
    expect(raw.get(B)).toBe(A);
  });

  test("unioning an already-unioned pair is a no-op", async () => {
    await union(t.db, A, B);
    const before = await readRawLabels(t.db, [A, B]);

    await union(t.db, A, B);
    await union(t.db, B, A); // and from the other side
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
      await t.db.execute(sql`UPDATE tasks SET cluster_id = id`);
      for (const [x, y] of order) await union(t.db, x, y);
      expect(await expectOneCluster(t.db, [A, B, C])).toBe(A);
    }
  });

  test("merging two multi-member clusters relabels every member, not just the endpoints", async () => {
    await union(t.db, C, D); // {C,D} → C
    await union(t.db, A, B); // {A,B} → A
    await union(t.db, B, D); // bridge via non-label members

    expect(await expectOneCluster(t.db, [A, B, C, D])).toBe(A);
  });

  test("clusterLabelOf reports id for a never-unioned task and the label after", async () => {
    expect(await clusterLabelOf(B, tdb)).toBe(B);
    await union(t.db, A, B);
    expect(await clusterLabelOf(B, tdb)).toBe(A);
    expect(await clusterLabelOf(A, tdb)).toBe(A);
  });

  test("every edge write unions, whoever writes it — raw SQL included", async () => {
    // No mutation in sight: the edge IS the union.
    await t.db.execute(
      sql`INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (${B}, ${A})`,
    );
    await t.db.execute(sql`UPDATE tasks SET folder_id = ${C} WHERE id = ${D}`);
    expect(await expectOneCluster(t.db, [A, B])).toBe(A);
    expect(await expectOneCluster(t.db, [C, D])).toBe(C);

    await t.db.execute(sql`UPDATE tasks SET group_id = ${B} WHERE id = ${D}`);
    expect(await expectOneCluster(t.db, [A, B, C, D])).toBe(A);

    const E = "clu-e";
    await t.db.execute(sql`
      INSERT INTO tasks (id, cluster_id, folder_id, title, title_auto, rank, created_at, updated_at)
      VALUES (${E}, ${E}, ${D}, ${E}, true, 'z', now(), now())
    `);
    expect(await expectOneCluster(t.db, [A, E])).toBe(A);
    expect(await clusterEdgeViolations(tdb)).toEqual([]);
  });

  test("a label write leaving an edge across clusters is refused", async () => {
    await union(t.db, A, B);
    await t.db.execute(
      sql`INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (${B}, ${A})`,
    );
    // A direct relabel — the one write no union trigger covers — fails, and
    // leaves the database as it was. (`Promise.resolve`: drizzle's `execute`
    // is a lazy thenable, which the matcher does not take.)
    expect(
      Promise.resolve(
        t.db.execute(sql`UPDATE tasks SET cluster_id = ${C} WHERE id = ${B}`),
      ),
    ).rejects.toThrow(/another cluster/);
    expect(await expectOneCluster(t.db, [A, B])).toBe(A);
    // A relabel that keeps every edge inside one cluster commits.
    await t.db.execute(sql`UPDATE tasks SET cluster_id = ${B} WHERE id = ${C}`);
    expect(await clusterLabelOf(C, tdb)).toBe(B);
  });

  test("a union that would outgrow TASK_CLUSTER_MAX is refused, and leaves both clusters", async () => {
    // Two clusters, of max - 1 and 2 tasks: the big one labelled as it is
    // inserted (no edge between its members to check).
    const big = "clu-big";
    await t.db.execute(sql`
      INSERT INTO tasks (id, cluster_id, title, title_auto, rank, created_at, updated_at, mandate_ref)
      SELECT ${big} || '-' || lpad(n::text, 4, '0'), ${big} || '-0001', 'x', true, 'a', now(), now(), 'interactive'
        FROM generate_series(1, ${TASK_CLUSTER_MAX - 1}) n
    `);
    await union(t.db, C, D);
    expect(
      Promise.resolve(
        t.db.execute(
          sql`INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (${C}, ${big + "-0007"})`,
        ),
      ),
    ).rejects.toThrow(`over the declared maximum of ${TASK_CLUSTER_MAX}`);
    expect(await clusterLabelOf(C, tdb)).toBe(C);
    expect(await clusterLabelOf(`${big}-0007`, tdb)).toBe(`${big}-0001`);
    // One task fits: max - 1 + 1 = max.
    await t.db.execute(
      sql`INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (${A}, ${big + "-0007"})`,
    );
    expect(await clusterLabelOf(A, tdb)).toBe(A);
    expect(await clusterLabelOf(`${big}-0007`, tdb)).toBe(A);
  });

  // ── The races ───────────────────────────────────────────────────────────
  //
  // Each forces the overlap with gates: T2 always begins while T1 holds its
  // union uncommitted, and T1 always commits second. Do NOT replace them with
  // a plain `Promise.all` — that leaves the interleaving to chance and the
  // test proves nothing.

  /** Run union(t1) uncommitted, start union(t2) on the other connection, commit T1. */
  async function race(
    t1Pair: [string, string],
    t2Pair: [string, string],
  ): Promise<void> {
    const t1Locked = gate();
    const t1MayCommit = gate();
    const t1 = dbA.transaction(async (tx) => {
      await union(tx, ...t1Pair);
      t1Locked.open();
      await t1MayCommit.wait;
    });
    await t1Locked.wait;
    const t2 = dbB.transaction(async (tx) => {
      await union(tx, ...t2Pair);
    });
    // Give T2 its chance to reach (or block on) its own statements. There is
    // no signal to await BY DESIGN — under the lock T2 cannot make progress
    // until T1 commits, so waiting on it would deadlock the test.
    await raceWindow();
    t1MayCommit.open();
    await Promise.all([t1, t2]);
  }

  test("concurrent unions sharing an endpoint converge to ONE label", async () => {
    // T1 union(A,B), T2 union(B,C): without a lock T2 computes min(B,C) = B
    // from the pre-T1 snapshot and strands C on B.
    await race([A, B], [B, C]);
    expect(await expectOneCluster(t.db, [A, B, C])).toBe(A);
  });

  test("concurrent unions reaching one cluster through DIFFERENT endpoints converge", async () => {
    // B and C share cluster B. T1 union(B, A) moves {B, C} onto A; T2
    // union(C, D) shares no endpoint with T1, so endpoint row locks do not
    // order them — T2 would relabel {B, C}… from a snapshot where they still
    // carry B, missing the rows T1 is moving. The label locks serialize them.
    await union(t.db, B, C);
    await race([B, A], [C, D]);
    expect(await expectOneCluster(t.db, [A, B, C, D])).toBe(A);
    expect(await clusterEdgeViolations(tdb)).toEqual([]);
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

  test("createTask with no folder starts as its own singleton (cluster_id = id)", async () => {
    const raw = await worktreeDbScenario(async (tx) => {
      const solo = await createTask(
        { title: "solo", mandate: TEST_MANDATE },
        tx,
      );
      return { id: solo.id, raw: await readRawLabels(tx, [solo.id]) };
    });

    expect([...raw.raw.values()]).toEqual([raw.id]);
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
      expect(updateTask(solo, { folderId: solo }, tx)).rejects.toThrow(
        /into itself/i,
      );
      return readRawLabels(tx, [solo]);
    });

    expect(raw.get(solo)).toBe(solo);
  });

  test("a REJECTED edge leaves both labels exactly as they were", async () => {
    // Two independent clusters must not fuse just because someone asked for an
    // impossible edge: the union may not run ahead of the validation.
    const [a, ghost] = [P + "r0", P + "missing"];
    const raw = await worktreeDbScenario(async (tx) => {
      await seedTasks(tx, [a]);
      expect(addTaskDependency(a, ghost, tx)).rejects.toThrow(/not found/i);
      return readRawLabels(tx, [a]);
    });

    expect(raw.get(a)).toBe(a);
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
      expect(addTaskDependency(a, b, tx)).rejects.toThrow(/cycle/i);
      return { before, after: await readRawLabels(tx, [a, b]) };
    });

    expect(after).toEqual(before);
  });

  test("createTask with a group unions it into the group's cluster", async () => {
    // A group is a membership edge in its own right — not only because the
    // callers that set one also add a dependency edge.
    const group = P + "g0";
    const labels = await worktreeDbScenario(async (tx) => {
      await seedTasks(tx, [group]);
      const member = await createTask(
        { groupId: group, title: "member", mandate: TEST_MANDATE },
        tx,
      );
      return readLabels(tx, [group, member.id]);
    });

    expect(new Set(labels.values())).toEqual(new Set([group]));
  });

  test("every union point keeps every edge inside one cluster", async () => {
    // THE invariant the cluster-scoped read rests on, driven through every
    // writer of a membership edge: dependency, folder (create and re-file) and
    // group. Read over the whole database inside the scenario — so it holds of
    // the worktree's own rows too, not only of the ones made here.
    const [a, b, c, folder, moved] = [
      P + "e0",
      P + "e1",
      P + "e2",
      P + "e3",
      P + "e4",
    ];
    const clean = await worktreeDbScenario(async (tx) => {
      await seedTasks(tx, [a, b, c, folder, moved]);
      await addTaskDependency(b, a, tx);
      const child = await createTask({ folderId: folder, title: "child" }, tx);
      await createTask(
        { groupId: c, title: "grouped", mandate: TEST_MANDATE },
        tx,
      );
      await updateTask(moved, { folderId: child.id }, tx);
      const clean = await clusterEdgeViolations(tx);
      return clean;
    });

    // (A label written past the union is refused by the database — the
    // throwaway suite above pins it; here it would abort the scenario.)
    expect(clean).toEqual([]);
  });
});
