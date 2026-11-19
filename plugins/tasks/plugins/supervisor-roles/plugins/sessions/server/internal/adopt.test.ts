/**
 * Adoption's writes against the REAL worktree DB, inside rolled-back
 * transactions: `after` is wired in the same transaction as the move, so the
 * task is blocked before anything can arm it; a cycle or a task no longer in
 * the backlog rolls the whole adoption back.
 *
 * Run: `./equin test plugins/tasks/plugins/supervisor-roles/plugins/sessions`.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  worktreeDbScenario,
  type DbExecutor,
} from "@plugins/database/plugins/db-test-fixture/plugins/worktree-db/server/testing";
import { DependencyCycleError } from "@plugins/tasks/plugins/tasks-core/server";
import { AdoptRefused, moveIntoSession } from "./adopt";

let seq = 0;
const uid = (k: string) => `${k}-ad${Date.now()}-${++seq}`;

async function task(
  tx: DbExecutor,
  opts: { folderId: string | null; mandate: string | null; owner?: string },
): Promise<string> {
  const id = uid("task");
  await tx.execute(sql`
    INSERT INTO tasks (id, cluster_id, title, title_auto, rank, folder_id, created_at, updated_at, mandate_ref, author_kind)
    VALUES (${id}, ${opts.folderId ?? id}, 'T', true, ${id}, ${opts.folderId}, now(), now(), ${opts.mandate}, 'human')
  `);
  if (opts.owner !== undefined)
    await tx.execute(sql`
      INSERT INTO tasks_ext_supervisor (parent_id, supervisor) VALUES (${id}, ${opts.owner})
    `);
  return id;
}

/** A role, its session root, a backlog task and a task of the session's tree. */
async function world(tx: DbExecutor) {
  const role = uid("srole");
  await tx.execute(
    sql`INSERT INTO supervisor_roles (id, name) VALUES (${role}, ${role})`,
  );
  const root = await task(tx, {
    folderId: null,
    mandate: "supervisor-role",
    owner: role,
  });
  const backlog = await task(tx, {
    folderId: null,
    mandate: "interactive",
    owner: role,
  });
  const running = await task(tx, { folderId: root, mandate: null });
  return { role, root, backlog, running };
}

async function depsOf(tx: DbExecutor, id: string): Promise<string[]> {
  const rows = await tx.execute<{ dep: string }>(
    sql`SELECT depends_on_task_id AS dep FROM task_dependencies WHERE task_id = ${id}`,
  );
  return rows.rows.map((r) => r.dep);
}

describe("adopt: moveIntoSession", () => {
  test("moves the task under the session root and wires `after` in the same transaction", async () => {
    const got = await worktreeDbScenario(async (tx) => {
      const w = await world(tx);
      await moveIntoSession(tx, {
        taskId: w.backlog,
        roleId: w.role,
        rootTaskId: w.root,
        after: [w.running],
      });
      const [row] = (
        await tx.execute<{ folder: string | null; owners: number }>(sql`
          SELECT folder_id AS folder,
            (SELECT count(*)::int FROM tasks_ext_supervisor WHERE parent_id = ${w.backlog}) AS owners
          FROM tasks WHERE id = ${w.backlog}`)
      ).rows;
      return { w, row, deps: await depsOf(tx, w.backlog) };
    });
    expect(got.row).toEqual({ folder: got.w.root, owners: 0 });
    expect(got.deps).toEqual([got.w.running]);
  });

  test("refuses a task no longer in the backlog, and a cycle", async () => {
    const got = await worktreeDbScenario(async (tx) => {
      const w = await world(tx);
      const outcome = async (p: Promise<void>) =>
        p.then(
          () => "ok",
          (err: unknown) => {
            if (err instanceof AdoptRefused) return err.refusal.kind;
            if (err instanceof DependencyCycleError) return "cycle";
            throw err;
          },
        );
      const notInBacklog = await outcome(
        moveIntoSession(tx, {
          taskId: w.running,
          roleId: w.role,
          rootTaskId: w.root,
          after: [],
        }),
      );
      // The running task already waits on the backlog task: adopting it after
      // the running task closes a cycle.
      await tx.execute(
        sql`INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (${w.running}, ${w.backlog})`,
      );
      const cycle = await outcome(
        moveIntoSession(tx, {
          taskId: w.backlog,
          roleId: w.role,
          rootTaskId: w.root,
          after: [w.running],
        }),
      );
      return { notInBacklog, cycle };
    });
    expect(got).toEqual({ notInBacklog: "not-in-backlog", cycle: "cycle" });
  });
});
