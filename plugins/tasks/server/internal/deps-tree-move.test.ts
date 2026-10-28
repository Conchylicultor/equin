import { describe, test, expect } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import {
  addTaskDependency,
  removeTaskDependency,
} from "@plugins/tasks/plugins/tasks-core/server";
import { applyDepsTreeMove } from "./deps-tree-move";

// Real-DB suite for the dependency-tree move. `applyDepsTreeMove` reads the
// `tasks_v` view (status snapshot + cycle check), which only the real boot
// builds — a `db-test-fixture` throwaway (migrations only, no derived-view
// registry) cannot reproduce it. So we drive the REAL SQL against the running
// worktree DB, but every scenario runs inside ONE transaction we deliberately
// roll back (the `Rollback` sentinel): nothing is ever committed, so the suite
// is isolated with no seeded rows or emitted events left behind. Seeded tasks
// are `dropped`, whose status is edge-independent, so no `tasks.statusChanged`
// ever fires during a move.
//
// Requires the running embedded cluster with this worktree's DB built
// (`./equin build` first):
//   bun test plugins/tasks/server/internal/deps-tree-move.test.ts

const P = "dmt-"; // id prefix — isolates our reads from real tasks in the DB

class Rollback extends Error {}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function seedTasks(tx: Tx, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i++) {
    // `dropped` (dropped_at set) ⇒ status is 'dropped' regardless of deps, so a
    // move never changes any task's status and never emits an event.
    await tx.execute(sql`
      INSERT INTO tasks (id, title, title_auto, rank, dropped_at, created_at, updated_at, mandate)
      VALUES (${ids[i]}, ${ids[i]}, true, ${"a" + i}, now(), now(), now(), '{}')
    `);
  }
}

// edge A→B = "A depends on B".
async function seedEdge(tx: Tx, a: string, b: string): Promise<void> {
  await tx.execute(sql`
    INSERT INTO task_dependencies (task_id, depends_on_task_id, created_at)
    VALUES (${a}, ${b}, now())
  `);
}

// The same edge, seeded the way production mints one — through the single
// writer of `task_dependencies`, so it also performs the cluster union. The raw
// `seedEdge` above deliberately bypasses that (it predates the label and the
// edge-only tests do not care), but any test that asserts on cluster labels MUST
// use this one: a raw INSERT would leave three unlabelled singletons and the
// assertion would fail for a reason that has nothing to do with the move.
async function seedEdgeVia(tx: Tx, a: string, b: string): Promise<void> {
  await addTaskDependency(a, b, tx);
}

async function readEdges(tx: Tx): Promise<Set<string>> {
  const res = await tx.execute(
    sql`SELECT task_id, depends_on_task_id FROM task_dependencies WHERE task_id LIKE ${P + "%"}`,
  );
  return new Set(
    (res.rows as { task_id: string; depends_on_task_id: string }[]).map(
      (r) => `${r.task_id}->${r.depends_on_task_id}`,
    ),
  );
}

// The effective membership label per seeded task (`cluster_id ?? id`) — what
// `taskClusterIds` filters on client-side. Tasks seeded by `seedTasks` start
// with `cluster_id` NULL (the column is nullable and NULL means "never unioned
// ⇒ own singleton"), which is the correct starting state for these tests.
async function readLabels(tx: Tx): Promise<Map<string, string>> {
  const res = await tx.execute(
    sql`SELECT id, COALESCE(cluster_id, id) AS label FROM tasks WHERE id LIKE ${P + "%"}`,
  );
  return new Map(
    (res.rows as { id: string; label: string }[]).map((r) => [r.id, r.label]),
  );
}

interface MoveState {
  edges: Set<string>;
  labels: Map<string, string>;
}

// Run one scenario in a rolled-back transaction; return the edge set AND the
// membership labels as they stood just after the move (before rollback).
async function scenarioState(seed: (tx: Tx) => Promise<void>): Promise<MoveState> {
  let state: MoveState | undefined;
  try {
    await db.transaction(async (tx) => {
      await seed(tx);
      state = { edges: await readEdges(tx), labels: await readLabels(tx) };
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return state!;
}

// Edge-only run, for the tests that predate the cluster label. Deliberately does
// NOT read `cluster_id`: an edge-algebra test must not start failing because of
// a membership-column change it says nothing about.
async function scenario(seed: (tx: Tx) => Promise<void>): Promise<Set<string>> {
  let edges: Set<string> | undefined;
  try {
    await db.transaction(async (tx) => {
      await seed(tx);
      edges = await readEdges(tx);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return edges!;
}

// Every listed task must resolve to ONE shared membership label. Compared as a
// whole id→label map against that map flattened onto the first label, so a
// failure names the task that fell out of the cluster and what it fell onto.
function expectOneCluster(labels: Map<string, string>, ids: string[]): void {
  const first = labels.get(ids[0]!);
  expect(Object.fromEntries(ids.map((id) => [id, labels.get(id)]))).toEqual(
    Object.fromEntries(ids.map((id) => [id, first])),
  );
}

describe("applyDepsTreeMove", () => {
  test("splice reorders a chain: 0←1←2←3, move 1 onto 2 ⇒ 0←2←1←3", async () => {
    const [t0, t1, t2, t3] = [P + "0", P + "1", P + "2", P + "3"];
    const edges = await scenario(async (tx) => {
      await seedTasks(tx, [t0, t1, t2, t3]);
      await seedEdge(tx, t1, t0);
      await seedEdge(tx, t2, t1);
      await seedEdge(tx, t3, t2);
      await applyDepsTreeMove({ taskId: t1, newParentId: t2, mode: "splice" }, tx);
    });

    expect(edges).toEqual(new Set([`${t2}->${t0}`, `${t1}->${t2}`, `${t3}->${t1}`]));
  });

  test("branch attaches a parallel child without disturbing the parent's other children", async () => {
    const [y, c, x] = [P + "y", P + "c", P + "x"];
    const edges = await scenario(async (tx) => {
      await seedTasks(tx, [y, c, x]);
      await seedEdge(tx, c, y); // c already depends on y
      await applyDepsTreeMove({ taskId: x, newParentId: y, mode: "branch" }, tx);
    });

    // Both c and x depend on y (parallel); nothing rewired onto x.
    expect(edges).toEqual(new Set([`${c}->${y}`, `${x}->${y}`]));
  });

  test("splice rewires the new parent's existing child onto the moved task", async () => {
    const [y, c, x] = [P + "py", P + "pc", P + "px"];
    const edges = await scenario(async (tx) => {
      await seedTasks(tx, [y, c, x]);
      await seedEdge(tx, c, y); // c depends on y
      await applyDepsTreeMove({ taskId: x, newParentId: y, mode: "splice" }, tx);
    });

    // x inserts under y; y's old child c now depends on x instead: y←x←c.
    expect(edges).toEqual(new Set([`${x}->${y}`, `${c}->${x}`]));
  });

  test("branch-to-root heals: ex-children bridge to the ex-parent, moved task becomes a root", async () => {
    const [t0, t1, t2, t3] = [P + "0", P + "1", P + "2", P + "3"];
    const edges = await scenario(async (tx) => {
      await seedTasks(tx, [t0, t1, t2, t3]);
      await seedEdge(tx, t1, t0);
      await seedEdge(tx, t2, t1);
      await seedEdge(tx, t3, t2);
      await applyDepsTreeMove({ taskId: t1, newParentId: null, mode: "splice" }, tx);
    });

    // 1's child (2) bridges to 1's parent (0); 1 is detached (root, no edges).
    expect(edges).toEqual(new Set([`${t2}->${t0}`, `${t3}->${t2}`]));
  });

  test("fan-in heal is a cross-product: the child bridges to EVERY old parent", async () => {
    const [a, b, x, c] = [P + "a", P + "b", P + "x", P + "c"];
    const edges = await scenario(async (tx) => {
      await seedTasks(tx, [a, b, x, c]);
      await seedEdge(tx, x, a); // x depends on a
      await seedEdge(tx, x, b); // x depends on b
      await seedEdge(tx, c, x); // c depends on x
      await applyDepsTreeMove({ taskId: x, newParentId: null, mode: "branch" }, tx);
    });

    // c bridges to both a and b; x is detached.
    expect(edges).toEqual(new Set([`${c}->${a}`, `${c}->${b}`]));
  });
});

// A move rewires edges; it must NEVER change WHICH tasks the dependency tree
// lists. Every test above asserts only `readEdges`, which is precisely why the
// reported bug shipped: the edge algebra was correct and the task still vanished
// from the pane, because membership was derived from those edges. These assert
// the membership label instead — `cluster_id`, monotone, written on edge
// creation and never on removal.
describe("applyDepsTreeMove — membership is monotone (edges alone are not enough)", () => {
  test("PROD REPRO: dropping a task to root must not eject it from its cluster", async () => {
    // The exact reported shape: chain a ← b ← c (c depends on b depends on a),
    // no folder, no group — the dependency edge is the ONLY tie. Dragging c to
    // the root of the tree removes that last edge, and c used to disappear from
    // both tabs and from the pane it was dragged in.
    const [a, b, c] = [P + "pr0", P + "pr1", P + "pr2"];
    const { edges, labels } = await scenarioState(async (tx) => {
      await seedTasks(tx, [a, b, c]);
      await seedEdgeVia(tx, b, a);
      await seedEdgeVia(tx, c, b);
      await applyDepsTreeMove({ taskId: c, newParentId: null, mode: "branch" }, tx);
    });

    // c is genuinely disconnected — otherwise the label assertion is vacuous.
    expect(edges).toEqual(new Set([`${b}->${a}`]));
    // …and still a member, rendering as a parallel root.
    expectOneCluster(labels, [a, b, c]);
  });

  test("a moved task with children but NO parents must not strand its siblings", async () => {
    // The heal bridges each child to every old parent (deps-tree-move.ts:37-40).
    // With no old parents the cross-product is empty, so both children lose
    // their only tie to each other AND to x in the same statement — three
    // isolated nodes from one drag.
    const [x, c1, c2] = [P + "sb0", P + "sb1", P + "sb2"];
    const { edges, labels } = await scenarioState(async (tx) => {
      await seedTasks(tx, [x, c1, c2]);
      await seedEdgeVia(tx, c1, x);
      await seedEdgeVia(tx, c2, x);
      await applyDepsTreeMove({ taskId: x, newParentId: null, mode: "branch" }, tx);
    });

    expect(edges).toEqual(new Set()); // nothing bridged anywhere
    expectOneCluster(labels, [x, c1, c2]);
  });

  test("an explicit detach (the Detach action / 'also after' chip) keeps the label", async () => {
    // `removeTaskDependency` is called directly by DetachAction and by the
    // fan-in chip, bypassing applyDepsTreeMove entirely — the same ejection by
    // another route.
    const [a, b] = [P + "dt0", P + "dt1"];
    const { edges, labels } = await scenarioState(async (tx) => {
      await seedTasks(tx, [a, b]);
      await seedEdgeVia(tx, b, a);
      await removeTaskDependency(b, a, tx);
    });

    expect(edges).toEqual(new Set());
    expectOneCluster(labels, [a, b]);
  });
});
