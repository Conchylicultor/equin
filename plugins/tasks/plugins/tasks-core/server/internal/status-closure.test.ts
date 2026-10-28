import { describe, test, expect } from "bun:test";
import { sql } from "drizzle-orm";
import {
  worktreeDbScenario,
  type DbExecutor,
} from "@plugins/database/plugins/db-test-fixture/plugins/worktree-db/server/testing";
import { listDependentClosure, readTaskStatuses } from "./queries/tasks";
import { removeTaskDependency, updateTask } from "./mutations/tasks";
import { runStatusBatchOn } from "./status-batch";

// Real-DB suite for the status closure and the emits it produces. Everything
// under test reads `tasks_v` / `task_blocking_v`, which only the real boot
// builds — a `db-test-fixture` throwaway (migrations only, no derived-view
// registry) cannot reproduce them. So we drive the REAL SQL against the running
// worktree DB through `worktreeDbScenario`, which runs every scenario inside ONE
// transaction it always rolls back: nothing is ever committed, so the suite
// leaves behind no seeded rows, no emissions, and no enqueued jobs.
//
// Requires the running embedded cluster AND this worktree's database as a real
// boot leaves it — the derived VIEW layer above is rebuilt from source on every
// boot and is not part of the migration chain, so `./equin build` first:
//   ./equin test plugins/tasks/plugins/tasks-core
//
// The queue schema is NOT part of that requirement any more: `worktreeDbScenario`
// installs `graphile_worker` itself before the first scenario opens, so the
// status-change emits these mutations enqueue no longer depend on a prior boot.
//
// Edge notation A→B = "A depends on B" = a `task_dependencies` row
// (task_id=A, depends_on_task_id=B). Dependents therefore flow the other way,
// which is the direction the closure walks.

const P = "sc-"; // id prefix — isolates our reads from real tasks in the DB

// The helpers below take the harness's `DbExecutor` — the same db-or-tx union
// every mutation takes, and deliberately NOT the narrow `db.transaction`
// callback type. A batch hands its callback the union (`runStatusBatchOn` must
// accept a pool handle or a tx), so a helper typed to the narrow arm cannot be
// called with the batch's own executor.
type Tx = DbExecutor;

interface StatusEmit {
  taskId: string;
  status: string;
  previousStatus: string;
}

// A plain task: not dropped, not held, no attempts. Under the shared blocking
// rule (views.ts `depIsBlocking`) a plain task is UNRESOLVED, so it blocks
// everything downstream of it — which is what makes the fixtures below non-
// vacuous.
async function seedTask(
  tx: Tx,
  id: string,
  opts: { dropped?: boolean } = {},
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO tasks (id, title, title_auto, rank, dropped_at, created_at, updated_at, mandate)
    VALUES (${id}, ${id}, true, ${id}, ${opts.dropped ? sql`now()` : null}, now(), now(), '{}')
  `);
}

// Raw edge insert — deliberately bypassing `addTaskDependency`, so a scenario
// can seed a shape (a cycle) that the production writer refuses.
async function seedEdge(tx: Tx, a: string, b: string): Promise<void> {
  await tx.execute(sql`
    INSERT INTO task_dependencies (task_id, depends_on_task_id, created_at)
    VALUES (${a}, ${b}, now())
  `);
}

// Every `tasks.statusChanged` emitted for one of OUR tasks, read off the
// emission log on the same transaction the emits were written to. Sorted by
// task id: emissions inside one transaction all carry the same `emitted_at`
// (`now()` is transaction-start), so insertion order is not recoverable — and
// the emitted SET is what the closure rule is about anyway.
async function readStatusEmits(tx: Tx): Promise<StatusEmit[]> {
  const res = await tx.execute<{ payload: StatusEmit }>(sql`
    SELECT payload FROM event_emissions
     WHERE event_name = 'tasks.statusChanged'
       AND payload->>'taskId' LIKE ${P + "%"}
  `);
  return res.rows
    .map((r) => ({
      taskId: r.payload.taskId,
      status: r.payload.status,
      previousStatus: r.payload.previousStatus,
    }))
    .sort((a, b) => a.taskId.localeCompare(b.taskId));
}

async function statusOf(tx: Tx, id: string): Promise<string | null> {
  return (await readTaskStatuses([id], tx)).get(id)?.status ?? null;
}

const sorted = (ids: string[]): string[] => [...ids].sort();

describe("listDependentClosure", () => {
  test("a chain: the closure from the root is the whole chain, from the leaf just itself", async () => {
    const [a, b, c] = [P + "ch-a", P + "ch-b", P + "ch-c"];
    const { fromRoot, fromLeaf, fromMiddle } = await worktreeDbScenario(
      async (tx) => {
        await seedTask(tx, a);
        await seedTask(tx, b);
        await seedTask(tx, c);
        await seedEdge(tx, b, a); // b depends on a
        await seedEdge(tx, c, b); // c depends on b
        return {
          fromRoot: await listDependentClosure([a], tx),
          fromLeaf: await listDependentClosure([c], tx),
          fromMiddle: await listDependentClosure([b], tx),
        };
      },
    );

    expect(sorted(fromRoot)).toEqual(sorted([a, b, c]));
    expect(sorted(fromMiddle)).toEqual(sorted([b, c]));
    expect(fromLeaf).toEqual([c]);
  });

  test("a diamond dedupes the node reachable by two paths", async () => {
    const [a, b, c, d] = [P + "dm-a", P + "dm-b", P + "dm-c", P + "dm-d"];
    const closure = await worktreeDbScenario(async (tx) => {
      for (const id of [a, b, c, d]) await seedTask(tx, id);
      await seedEdge(tx, b, a);
      await seedEdge(tx, c, a);
      await seedEdge(tx, d, b); // d is reachable from a via b AND via c
      await seedEdge(tx, d, c);
      return listDependentClosure([a], tx);
    });

    expect(sorted(closure)).toEqual(sorted([a, b, c, d]));
  });

  test("a multi-id seed returns the union of the seeds' closures", async () => {
    const [a, b, x, y] = [P + "mu-a", P + "mu-b", P + "mu-x", P + "mu-y"];
    const closure = await worktreeDbScenario(async (tx) => {
      for (const id of [a, b, x, y]) await seedTask(tx, id);
      await seedEdge(tx, b, a); // chain 1: a ← b
      await seedEdge(tx, y, x); // chain 2: x ← y (disjoint)
      return listDependentClosure([a, x], tx);
    });

    expect(sorted(closure)).toEqual(sorted([a, b, x, y]));
  });

  test("a cycle terminates (UNION dedupes) even though the writer bars one", async () => {
    const [x, y] = [P + "cy-x", P + "cy-y"];
    const closure = await worktreeDbScenario(async (tx) => {
      await seedTask(tx, x);
      await seedTask(tx, y);
      await seedEdge(tx, x, y); // x depends on y
      await seedEdge(tx, y, x); // …and y depends on x — only reachable by raw SQL
      return listDependentClosure([x], tx);
    });

    expect(sorted(closure)).toEqual(sorted([x, y]));
  });
});

describe("withTaskStatusChange — the incident", () => {
  // The reported bug, as a three-row fixture. `a` is plain (so it blocks), `b`
  // is dropped (so it is settled and does NOT block, and its own status is
  // edge-independent), and `c` runs after `b`. Detaching `b → a` is therefore
  // invisible at the edge's own dependent end — `b` reads `dropped` either side
  // — while `c`, one hop further down, becomes launchable. Naming only the
  // edge's endpoint emitted NOTHING AT ALL; the closure names `c`.
  test("detaching a blocker emits for the downstream task, not for the edge's endpoints", async () => {
    const [a, b, c] = [P + "in-a", P + "in-b", P + "in-c"];
    const { entry, emits, afterStatus } = await worktreeDbScenario(
      async (tx) => {
        await seedTask(tx, a);
        await seedTask(tx, b, { dropped: true });
        await seedTask(tx, c);
        await seedEdge(tx, b, a);
        await seedEdge(tx, c, b);

        const entry = {
          a: await statusOf(tx, a),
          b: await statusOf(tx, b),
          c: await statusOf(tx, c),
        };
        await removeTaskDependency(b, a, tx);
        return {
          entry,
          emits: await readStatusEmits(tx),
          afterStatus: {
            a: await statusOf(tx, a),
            b: await statusOf(tx, b),
            c: await statusOf(tx, c),
          },
        };
      },
    );

    // Non-vacuous: `c` really was blocked (transitively, through the dropped
    // `b`, by the plain `a`) and really is launchable afterwards, while the
    // edge's own endpoints never move.
    expect(entry).toEqual({ a: "new", b: "dropped", c: "blocked" });
    expect(afterStatus).toEqual({ a: "new", b: "dropped", c: "new" });
    expect(emits).toEqual([
      { taskId: c, status: "new", previousStatus: "blocked" },
    ]);
  });
});

describe("runStatusBatchOn — batch-entry semantics", () => {
  test("two writes touching one task record its status at BATCH ENTRY, not between them", async () => {
    const [a, b, c] = [P + "ba-a", P + "ba-b", P + "ba-c"];
    const { entry, betweenWrites, emits } = await worktreeDbScenario(
      async (tx) => {
        await seedTask(tx, a);
        await seedTask(tx, b, { dropped: true });
        await seedTask(tx, c);
        await seedEdge(tx, b, a);
        await seedEdge(tx, c, b);

        const entry = await statusOf(tx, c);
        const betweenWrites = await runStatusBatchOn(tx, async (btx) => {
          // Write 1 records c's entry status (`blocked`) and unblocks it.
          await removeTaskDependency(b, a, btx);
          const mid = await statusOf(btx, c);
          // Write 2 touches c again — its recorded entry status must NOT be
          // overwritten with the intermediate reading above.
          await updateTask(c, { hold: true }, btx);
          return mid;
        });
        return { entry, betweenWrites, emits: await readStatusEmits(tx) };
      },
    );

    expect(entry).toBe("blocked");
    // Non-vacuous: c genuinely passed through a THIRD status mid-batch, so a
    // record-at-second-write implementation would report `new` here.
    expect(betweenWrites).toBe("new");
    expect(emits).toEqual([
      { taskId: c, status: "held", previousStatus: "blocked" },
    ]);
  });
});
