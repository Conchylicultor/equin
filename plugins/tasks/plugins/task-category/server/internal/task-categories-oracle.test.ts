/**
 * `task-categories.by-id` — the lookup-only category read — on the TREE
 * ORACLE (tasks-core's `server/testing`): the real declaration compiled with
 * the real serve options against a throwaway database, through the real feed.
 *
 * The tree workload runs with the category writes the filing plugins make
 * spliced in. After every step the `:rows` point view (over T1, T2) equals a
 * fresh FULL load, and it refills only for a change to a row in its point
 * set, and only that row:
 *
 * - a category set or change on T1 / T2 is a one-row refill of it;
 * - the filing path's re-file — an `ON CONFLICT DO UPDATE` that leaves the
 *   category as it was — loads nothing: the route gate sees no column change;
 * - one statement changing two rows refills only the one in the point set;
 * - a category cleared, or the task deleted (the FK cascade), loads nothing;
 * - a category write to a task outside the point set, and every other tree
 *   write (tasks, edges, attempts, conversations, pushes), loads nothing.
 *
 * Requires a running Postgres cluster (started by ./equin build).
 * Run: `./equin test plugins/tasks/plugins/task-category`.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import type { QueryDb } from "@plugins/network/plugins/live/plugins/query-resource/server";
import { compileCollection } from "@plugins/network/plugins/live/server/testing";
import {
  createTreeOracle,
  TREE_IDS,
  treeSeed,
  treeSteps,
  withSteps,
  type TreeLoad,
  type TreeOracle,
  type TreeStep,
} from "@plugins/tasks/plugins/tasks-core/server/testing";
import { taskCategories } from "../../shared/resources";
import { taskCategoriesServeOptions } from "./serve-options";

setDefaultTimeout(120_000);

const ROWS_KEY = taskCategories.rows.key;
const [T1, T2, T3, , , T6] = TREE_IDS.tasks;

const categorizeAll = (rows: [taskId: string, category: string][]) =>
  `INSERT INTO tasks_ext_category (parent_id, category) VALUES ${rows
    .map(([taskId, category]) => `('${taskId}', '${category}')`)
    .join(", ")}
   ON CONFLICT (parent_id) DO UPDATE SET category = EXCLUDED.category`;
const categorize = (taskId: string, category: string) =>
  categorizeAll([[taskId, category]]);
const uncategorize = (taskId: string) =>
  `DELETE FROM tasks_ext_category WHERE parent_id = '${taskId}'`;

/** The category writes, each spliced right after the tree step it names. */
const CATEGORY_STEPS: Record<string, TreeStep[]> = {
  "task.insert": [
    { label: "category.set", statements: [categorize(T6, "agents")] },
  ],
  "task.rename": [
    { label: "category.change", statements: [categorize(T1, "reports")] },
    // The filing path re-filing T1 under the category it already has.
    { label: "category.same", statements: [categorize(T1, "reports")] },
  ],
  "task.hold": [
    { label: "category.set-held", statements: [categorize(T3, "system")] },
    {
      label: "category.change-two",
      statements: [
        categorizeAll([
          [T1, "improvements"],
          [T3, "agents"],
        ]),
      ],
    },
  ],
  "attempt.delete": [
    { label: "category.clear", statements: [uncategorize(T1)] },
  ],
};

/** The `:rows` point reader's loads per step (its point set is T1, T2). */
const ROW_LOADS: Record<string, TreeLoad[]> = {
  "category.change": [{ ids: [T1] }],
  // One statement, two rows: the point reader refills only its own T1.
  "category.change-two": [{ ids: [T1] }],
};

let oracle: TreeOracle;

beforeAll(async () => {
  oracle = await createTreeOracle({
    prefix: "task_categories_oracle",
    persisted: [],
  });
  oracle.registerLookup(
    taskCategories,
    compileCollection(taskCategories, {
      ...taskCategoriesServeOptions,
      db: oracle.queryDb as unknown as QueryDb,
    }),
  );
  await oracle.start();
});

afterAll(async () => {
  await oracle?.stop();
});

describe("task-categories.by-id — a lookup-only collection on the tree oracle", () => {
  test("the point view converges to a fresh FULL load after every step, refilling only its own changed rows", async () => {
    for (const step of treeSeed()) await oracle.run(step);
    await oracle.run({
      label: "seed.categories",
      statements: [categorize(T1, "improvements"), categorize(T2, "reports")],
    });
    // The point set for two ids, one of them (T2) deleted mid-script.
    const pointParams = taskCategories.rows.point.encode([T1, T2]);
    await oracle.subscribe(ROWS_KEY, pointParams);
    await oracle.converged("seed");
    const rowBaseline = oracle.loadsOf(ROWS_KEY).length;

    for (const step of withSteps(treeSteps(), CATEGORY_STEPS)) {
      const cost = await oracle.run(step);
      await oracle.converged(step.label);
      expect({
        step: step.label,
        rowLoads: cost.loads[ROWS_KEY] ?? [],
      }).toEqual({ step: step.label, rowLoads: ROW_LOADS[step.label] ?? [] });
    }
    // Every point-reader load after the subscribe is one a step pinned.
    expect(oracle.loadsOf(ROWS_KEY).slice(rowBaseline)).toEqual(
      Object.values(ROW_LOADS).flat(),
    );
    oracle.unsubscribe(ROWS_KEY, pointParams);
  });
});
