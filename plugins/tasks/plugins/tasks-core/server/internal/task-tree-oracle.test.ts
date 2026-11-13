/**
 * The TASKS TREE (`taskWindow`, key `tasks.tree.v2`, declared `tree: { parent:
 * "folderId", rank: "rank" }`) on a throwaway database through the REAL feed
 * (the tree oracle's harness, `../testing/tree-oracle.ts`), compiled with its
 * shipped serve options (`taskWindowServeOptions`: the materialized status
 * joins and the `task_child_count` rollup as `childCount`).
 *
 * The tree script (every kind of write the app makes) runs with the suite's
 * folder writes spliced in — a filing under a folder, a move between
 * folders, a move out to the root, a child's delete, a drop — against the
 * levels the task list reads: the default window, the roots, two folders'
 * children, a status-filtered window (the hits read) and a `:rows` point
 * reader. After every step each view equals a fresh FULL load of its tuple
 * (`converged`), and every row's `$childCount` equals a count of the
 * folder's children read straight off `tasks` — so a filing, a move (both
 * folders), a delete and a cascade recount the folders they touch, and a
 * task with no child reads 0 (the count's `ifNone`).
 *
 * Then C39: a tab on a bundle from before the window was a tree subscribes
 * the old key (`tasks.window`) and is refused `unknown-key` — the Reload
 * prompt, never the tree's differently ordered default set.
 *
 * Requires a running Postgres cluster (started by ./equin build).
 * Run: `./equin test plugins/tasks/plugins/tasks-core`.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { QueryDb } from "@plugins/network/plugins/live/plugins/query-resource/server";
import {
  compileCollection,
  subscribeAsOldDescriptor,
} from "@plugins/network/plugins/live/server/testing";
import { taskWindow } from "../../core";
import { TaskListItemSchema } from "./schema";
import {
  createTreeOracle,
  TREE_IDS,
  treeSeed,
  treeSteps,
  withSteps,
  type TreeOracle,
  type TreeStep,
} from "../testing/tree-oracle";
import { taskWindowServeOptions } from "./task-rows";

setDefaultTimeout(120_000);

const WINDOW = taskWindow.key;
const ROWS = taskWindow.rows.key;

const [T1, , T3, , T5] = TREE_IDS.tasks;
/** The suite's own tasks: T7 filed under T1, T8 under T7 (a second level). */
const T7 = "tree-t7";
const T8 = "tree-t8";

const child = (id: string, parent: string, rank: string) =>
  `INSERT INTO tasks (id, cluster_id, title, title_auto, rank, folder_id, author_kind) VALUES ('${id}', '${id}', '${id} title', false, '${rank}', '${parent}', 'human')`;

/** The folder writes, each spliced right after the tree step it names. */
const FOLDER_STEPS: Record<string, TreeStep[]> = {
  "task.insert": [
    // A filing under T1: T1 counts it, T7 counts none.
    { label: "folder.file", statements: [child(T7, T1, "b1")] },
    // A second level: T7 counts it.
    { label: "folder.file-deep", statements: [child(T8, T7, "b1")] },
    // A root moved under a folder (a drag onto T1): T1 counts two.
    {
      label: "folder.move-in",
      statements: [`UPDATE tasks SET folder_id = '${T1}' WHERE id = '${T5}'`],
    },
  ],
  "task.hold": [
    // A move between folders: T1 loses T7, T3 gains it.
    {
      label: "folder.move-across",
      statements: [`UPDATE tasks SET folder_id = '${T3}' WHERE id = '${T7}'`],
    },
  ],
  "push.insert": [
    // A move out to the root: T1 loses T5.
    {
      label: "folder.move-out",
      statements: [
        `UPDATE tasks SET folder_id = NULL, mandate_ref = 'interactive' WHERE id = '${T5}'`,
      ],
    },
  ],
  "attempt.delete": [
    // A child's delete: T7 loses T8.
    {
      label: "folder.delete-child",
      statements: [`DELETE FROM tasks WHERE id = '${T8}'`],
    },
  ],
};

let oracle: TreeOracle;

beforeAll(async () => {
  oracle = await createTreeOracle({
    prefix: "task_tree_oracle",
    persisted: [],
  });
  oracle.registerWindow(
    taskWindow,
    compileCollection(taskWindow, {
      ...taskWindowServeOptions,
      db: oracle.queryDb as unknown as QueryDb,
    }),
  );
  await oracle.start();
});

afterAll(async () => {
  await oracle?.stop();
});

type TreeRowView = { id: string; folderId: string | null; $childCount: number };

/** Every task's child count, read straight off `tasks`. */
async function childCounts(): Promise<Map<string, number>> {
  const res = await oracle.db.execute(
    sql`SELECT p.id, (SELECT count(*)::int FROM tasks c WHERE c.folder_id = p.id) AS n FROM tasks p`,
  );
  return new Map(
    (res.rows as { id: string; n: number }[]).map((r) => [r.id, r.n]),
  );
}

describe("tasks.tree.v2 — the tasks tree on the real feed", () => {
  test("every level converges on every write, and every row's $childCount is its folder's count", async () => {
    for (const step of treeSeed()) await oracle.run(step);

    const tuples: Record<string, string>[] = [
      taskWindow.window.defaultParams,
      // The roots (the tree's top level).
      taskWindow.window.window.encode({
        where: { folderId: { isEmpty: true } },
        limit: 100,
      }),
      // Two folders' children (an open node's level), in sibling order.
      taskWindow.window.window.encode({
        where: { folderId: T1 },
        orderBy: [
          ["rank", "asc"],
          ["createdAt", "asc"],
        ],
        limit: 100,
      }),
      taskWindow.window.window.encode({
        where: { folderId: T3 },
        limit: 100,
      }),
      // The hits read: a filter on the derived status, newest first.
      taskWindow.window.window.encode({
        where: { status: "new" },
        orderBy: [["updatedAt", "desc"]],
        limit: 100,
      }),
    ];
    for (const params of tuples) await oracle.subscribe(WINDOW, params);
    const pointParams = taskWindow.rows.point.encode([T1, T3, T7]);
    await oracle.subscribe(ROWS, pointParams);
    await oracle.converged("seed");

    const steps = withSteps(treeSteps(), FOLDER_STEPS);
    const seen = new Set<string>();
    for (const step of steps) {
      await oracle.run(step);
      await oracle.converged(step.label);
      const counts = await childCounts();
      for (const params of [...tuples, pointParams]) {
        const key = params === pointParams ? ROWS : WINDOW;
        const rows = oracle.view(key, params) as readonly TreeRowView[];
        for (const row of rows) {
          const want = counts.get(row.id);
          if (want === undefined) {
            throw new Error(`${step.label}: ${row.id} is no row of tasks`);
          }
          expect({ step: step.label, id: row.id, n: row.$childCount }).toEqual({
            step: step.label,
            id: row.id,
            n: want,
          });
          if (row.$childCount > 0) seen.add(`${step.label}:${row.id}`);
        }
      }
    }

    // The folder writes were really exercised, as the views read them.
    expect(seen).toContain(`folder.file:${T1}`);
    expect(seen).toContain(`folder.file-deep:${T7}`);
    expect(seen).toContain(`folder.move-across:${T3}`);
    // After the script: T5 back at the root, T7 under T3 with no child left.
    const roots = oracle.view(WINDOW, tuples[1]) as readonly TreeRowView[];
    expect(roots.map((r) => r.id)).toContain(T5);
    const t3Kids = oracle.view(WINDOW, tuples[3]) as readonly TreeRowView[];
    expect(t3Kids.map((r) => [r.id, r.$childCount])).toEqual([[T7, 0]]);
    const t1Kids = oracle.view(WINDOW, tuples[2]) as readonly TreeRowView[];
    expect(t1Kids).toEqual([]);
  });
});

describe("C39 — a tab on the flat `tasks.window` (before it was the tree)", () => {
  test("its old key is refused `unknown-key`, a `skew` verdict", async () => {
    // The default read changed meaning (tree order, not newest first), so the
    // tree is a new key: an old bundle gets the Reload prompt, never another set.
    const old = await subscribeAsOldDescriptor(
      { key: "tasks.window", schema: z.array(TaskListItemSchema) },
      { handler: oracle.runtime.notificationsWsHandler },
    );
    expect(old).toEqual({
      kind: "refused",
      reason: "unknown-key",
      verdict: "skew",
    });
  });
});
