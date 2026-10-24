/**
 * `task-categories` as an `all` collection (P8 v3 step 18), on the TREE
 * ORACLE (tasks-core's `server/testing`): the real declaration compiled with
 * the real serve options against a throwaway database, through the real feed
 * (`tasks_ext_category` gets its first routed layout), with L2 on — so the
 * set is a persisted alias, as it ships (`preload: "boot"`).
 *
 * The tree workload runs with the category writes the filing plugins make
 * spliced in. After every step the subscribed `{}` view and the `:rows` point
 * view (over T1, T2) equal a fresh FULL load, and both readers' costs are
 * exact:
 *
 * - a category set (the filing upsert) is an ENTRANT: one refill of the task,
 *   one `orderOf`;
 * - a category change is a one-row refill, no `orderOf` (the order is the
 *   task id);
 * - the filing path's re-file — an `ON CONFLICT DO UPDATE` that leaves the
 *   category as it was — loads nothing: the route gate sees no column change;
 * - one statement changing two rows is ONE refill of both;
 * - a category cleared (`setTaskCategory(id, null)`), or the task deleted (the
 *   FK cascade), is an EXIT with no load;
 * - every other tree write (tasks, edges, attempts, conversations, pushes)
 *   loads nothing — the set reads only `tasks_ext_category`;
 * - the `:rows` point reader refills only for a change to a row in its point
 *   set, and only that row — never for a tree write, nor for a category write
 *   to a task outside it;
 * - nothing is ever loaded FULL after the subscribe (W1/W2 for this key).
 *
 * Then the C39 old-bundle check against the real key: a tab still running a
 * bundle that declared `task-categories` with a legacy param-less keyed
 * descriptor subscribes `{}`, passes the `all` gate, and
 * parses the compiled rows with its OLD row schema to the same values — the
 * wire row is byte-compatible, so the key keeps its name.
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
import { z } from "zod";
import type { QueryDb } from "@plugins/infra/plugins/query-resource/server";
import {
  compileCollection,
  subscribeAsOldDescriptor,
} from "@plugins/network/plugins/live/server/testing";
import {
  canonical,
  createTreeOracle,
  TREE_IDS,
  treeSeed,
  treeSteps,
  withSteps,
  type TreeLoad,
  type TreeOracle,
  type TreeStep,
} from "@plugins/tasks/plugins/tasks-core/server/testing";
import { taskCategories, TaskCategoryRowSchema } from "../../shared/resources";
import { taskCategoriesServeOptions } from "./serve-options";

setDefaultTimeout(120_000);

const KEY = taskCategories.key;
const ROWS_KEY = taskCategories.rows.key;
const [T1, T2, T3, , , T6] = TREE_IDS.tasks;

// What the legacy `task-categories` descriptor (param-less, keyed) parsed its
// payload with (`z.array(TaskCategoryRowSchema)` over the extension's
// `{ taskId, category }`), restated as a literal — `strict`, so a
// field added to the row would fail the parse, not pass it.
const LegacyRowsSchema = z.array(
  z.object({ taskId: z.string(), category: z.string() }).strict(),
);

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

/**
 * What each step must cost: the set's loads and `orderOf` calls, and the
 * `:rows` point reader's loads (its point set is T1, T2).
 */
interface StepCost {
  loads: TreeLoad[];
  orderOf: number;
  rowLoads: TreeLoad[];
}
const NOTHING: StepCost = { loads: [], orderOf: 0, rowLoads: [] };
const COST: Record<string, StepCost> = {
  // T6 is outside the point set: the point reader loads nothing.
  "category.set": { ...NOTHING, loads: [{ ids: [T6] }], orderOf: 1 },
  "category.change": {
    loads: [{ ids: [T1] }],
    orderOf: 0,
    rowLoads: [{ ids: [T1] }],
  },
  "category.same": NOTHING,
  "category.set-held": { ...NOTHING, loads: [{ ids: [T3] }], orderOf: 1 },
  // One statement, two rows: one refill of both; the point reader refills
  // only its own T1.
  "category.change-two": {
    loads: [{ ids: [T1, T3] }],
    orderOf: 0,
    rowLoads: [{ ids: [T1] }],
  },
  "category.clear": NOTHING,
  // T2 is categorized: its delete cascades the row away — an exit, no load.
  "task.delete": NOTHING,
};

let oracle: TreeOracle;

beforeAll(async () => {
  oracle = await createTreeOracle({
    prefix: "task_categories_oracle",
    persisted: [KEY],
  });
  oracle.registerAll(
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

describe("task-categories — an `all` collection on the tree oracle", () => {
  test("every step converges to a fresh FULL load at its exact cost; tree writes load nothing; nothing loads FULL", async () => {
    for (const step of treeSeed()) await oracle.run(step);
    await oracle.run({
      label: "seed.categories",
      statements: [categorize(T1, "improvements"), categorize(T2, "reports")],
    });
    await oracle.subscribe(KEY);
    // The `:rows` point sibling for two ids, one of them deleted mid-script.
    const pointParams = taskCategories.rows.point.encode([T1, T2]);
    await oracle.subscribe(ROWS_KEY, pointParams);
    await oracle.converged("seed");
    const baseline = oracle.loadsOf(KEY).length;
    const rowBaseline = oracle.loadsOf(ROWS_KEY).length;

    for (const step of withSteps(treeSteps(), CATEGORY_STEPS)) {
      const cost = await oracle.run(step);
      await oracle.converged(step.label);
      expect({
        step: step.label,
        loads: cost.loads[KEY] ?? [],
        orderOf: cost.orderOf[KEY] ?? 0,
        rowLoads: cost.loads[ROWS_KEY] ?? [],
      }).toEqual({ step: step.label, ...(COST[step.label] ?? NOTHING) });
    }
    expect(
      oracle
        .loadsOf(KEY)
        .slice(baseline)
        .some((l) => l.ids === "FULL"),
    ).toBe(false);
    // Every point-reader load after the subscribe is one a step pinned.
    expect(oracle.loadsOf(ROWS_KEY).slice(rowBaseline)).toEqual(
      Object.values(COST).flatMap((c) => c.rowLoads),
    );
    oracle.unsubscribe(ROWS_KEY, pointParams);
  });

  test("with nobody subscribed, the persisted `{}` snapshot stays current, and its floor persist writes it", async () => {
    oracle.unsubscribe(KEY);
    const baseline = oracle.loadsOf(KEY).length;
    await oracle.run({
      label: "idle.set",
      statements: [categorize(T1, "conversations")],
    });
    await oracle.run({
      label: "idle.clear",
      statements: [uncategorize(T6)],
    });
    await oracle.converged("idle");
    const current = canonical(oracle.kept(KEY));
    expect(
      oracle
        .loadsOf(KEY)
        .slice(baseline)
        .some((l) => l.ids === "FULL"),
    ).toBe(false);
    // The trailing floor window writes the kept value (the L2 row a cold boot
    // seeds from) — never a FULL replace.
    const deadline = Date.now() + 10_000;
    while (
      !oracle
        .persistsOf(KEY)
        .some((p) => p.meta.mode === "floor" && canonical(p.value) === current)
    ) {
      if (Date.now() > deadline)
        throw new Error("no floor persist of the kept value");
      await new Promise((r) => setTimeout(r, 20));
    }
  });
});

describe("C39 — a tab on the legacy `task-categories` descriptor", () => {
  test("subscribes `{}`, passes the gate, and parses the compiled rows with its OLD schema to the same values", async () => {
    const truth = canonical(oracle.kept(KEY));
    for (const schema of [LegacyRowsSchema, z.array(TaskCategoryRowSchema)]) {
      const old = await subscribeAsOldDescriptor(
        { key: KEY, schema },
        { handler: oracle.runtime.notificationsWsHandler },
      );
      expect(old.kind).toBe("parsed");
      expect(canonical(old.kind === "parsed" ? old.value : null)).toBe(truth);
    }
  });
});
