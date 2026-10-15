/**
 * The TREE ORACLE (P8 v3, steps 18–22; v2 *Verification*): the scripted tree
 * workload (`server/testing/tree-oracle.ts` — tasks, edges, attempts,
 * conversations and pushes: inserts, a rename, a hold, a drag reorder, a
 * poller write, an attempt moved between tasks, cascade deletes, a drop) on a
 * throwaway database through the REAL feed, and after every step each
 * subscribed view, and each persisted key's kept `{}` snapshot, equals a fresh
 * FULL load of its tuple.
 *
 * Step 18 bootstrapped it with a PROBE — an `all` collection over `tasks`
 * with a children aggregate over `attempts` and a base `where`, the shape the
 * conversions take — whose exact per-step costs it pins: an insert is an
 * entrant (one refill, one `orderOf`), a rename an order move, a child write
 * its host's refill, a delete or a drop an exit with no load, and a write to a
 * table the probe does not read loads nothing.
 *
 * Step 19 adds the REAL `tasks` set (`taskRows`, compiled with its shipped
 * serve options against the throwaway), subscribed `{}` and as a `:rows`
 * point reader of two ids, and pins ITS cost per step: a task write is its
 * own row (plus every transitive dependent when the write moves what the
 * blocking rule reads — `held_at`, `dropped_at`), an attempt / conversation /
 * push write is its task's row plus that task's dependents, an edge write the
 * edge's task and its dependents, a write no field reads (the poller's
 * `waiting_for`) nothing. Beside it, `taskDescriptions` (lookup-only,
 * `task-descriptions:rows`) as a point reader of two ids: a description write
 * is its row's refill, a write to any other `tasks` column loads nothing, a
 * deleted id leaves the read. Then the C39 old-bundle check against the real
 * key, with a literal frozen copy of the legacy row.
 *
 * Step 20 adds the REAL `attempts` set (`attemptRows`, its shipped serve
 * options), subscribed `{}` and as a `:rows` point reader of two ids, and
 * pins its cost per step: an attempt write is its own row (an insert an
 * entrant), a conversation write its attempt's (a retitle and a `system`
 * conversation included — the list's route reads `title`, and the rollup
 * reads every kind's `status`), a push its attempt's, a write to a column
 * nothing reads (the poller's `waiting_for` / `last_viewed_at`) nothing, and
 * a task or edge write nothing — C1: no write reaches it as a FULL. Then its
 * own C39 check.
 * Step 22 adds the conversation lists, each compiled with its shipped serve
 * options (`./conversation-rows.ts`): the live `all` sets
 * `conversations-active` and `conversations-system` (subscribed `{}`,
 * persisted), the `conversations-gone` default window, and the
 * `conversations.by-id:rows` point reader of {C1, C2} — C2 done from the
 * seed, the W9 case: a point read finds a done conversation whatever its age.
 * Their cost per step is pinned: a conversation write is a one-row read in
 * each list it could enter or holds it (the poller's `waiting_for` the one
 * set holding the row), a task rename or an attempt move the conversations
 * it owns, and W4 — every other task and attempt write — nothing. Then the
 * C39 checks: `active` / `system` parse under a frozen legacy row, and a tab
 * on the old param-less `conversations-gone` gets `skew`. The gone window
 * is also held at capacity (a `limit: 1` tuple beside the default one): an
 * entrant evicts its tail, a reopen or a delete backfills it, each converged
 * against a fresh FULL at a pinned per-tuple cost.
 * An entry owned downstream of tasks-core runs in
 * its owner's suite: `task-category`'s `task-categories-oracle.test.ts` is
 * step 18's, `agents`' `agent-launches-oracle.test.ts` step 21's.
 *
 * Requires a running Postgres cluster (started by ./singularity build).
 * Run: `./singularity test plugins/tasks/plugins/tasks-core`.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { floatField } from "@plugins/fields/plugins/float/plugins/config/core";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  aggregate,
  childrenJoin,
} from "@plugins/infra/plugins/query-resource/core";
import type { QueryDb } from "@plugins/infra/plugins/query-resource/server";
import { liveCollection } from "@plugins/network/plugins/live/core";
import {
  compileCollection,
  subscribeAsOldDescriptor,
} from "@plugins/network/plugins/live/server/testing";
import { RankSchema } from "@plugins/primitives/plugins/rank/core";
import {
  attemptRows,
  conversationsActive,
  conversationsById,
  conversationsGone,
  conversationsSystem,
  taskDescriptions,
  taskRows,
} from "../../core";
import { AttemptWithConversationsSchema } from "../../core/schemas";
import { ConversationSchema, TaskListItemSchema } from "./schema";
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
} from "../testing/tree-oracle";
import { _attempts, _tasks } from "./tables";
import { attemptRowsServeOptions } from "./attempt-rows";
import {
  conversationsActiveServeOptions,
  conversationsByIdServeOptions,
  conversationsGoneServeOptions,
  conversationsSystemServeOptions,
} from "./conversation-rows";
import { taskRowsServeOptions } from "./task-rows";

setDefaultTimeout(120_000);

const PROBE = "test.tree-oracle.tasks-probe";

const probe = liveCollection(PROBE, {
  carry: {
    fields: { id: textField(), title: textField(), attempts: floatField() },
  },
  id: "id",
  all: {
    orderBy: [["title", "asc"]],
    unbounded: { reason: "the tree oracle's probe" },
  },
});

const TASKS = taskRows.key;
const TASK_ROWS = taskRows.rows.key;
const DESCRIPTIONS = taskDescriptions.rows.key;
const ATTEMPTS = attemptRows.key;
const ATTEMPT_ROWS = attemptRows.rows.key;
const ACTIVE = conversationsActive.key;
const SYSTEM = conversationsSystem.key;
const GONE = conversationsGone.key;
const BY_ID = conversationsById.rows.key;

let oracle: TreeOracle;

beforeAll(async () => {
  oracle = await createTreeOracle({
    prefix: "tree_oracle",
    persisted: [PROBE, TASKS, ATTEMPTS, ACTIVE, SYSTEM],
  });
  const queryDb = oracle.queryDb as unknown as QueryDb;
  oracle.registerAll(
    conversationsActive,
    compileCollection(conversationsActive, {
      ...conversationsActiveServeOptions,
      db: queryDb,
    }),
  );
  oracle.registerAll(
    conversationsSystem,
    compileCollection(conversationsSystem, {
      ...conversationsSystemServeOptions,
      db: queryDb,
    }),
  );
  oracle.registerWindow(
    conversationsGone,
    compileCollection(conversationsGone, {
      ...conversationsGoneServeOptions,
      db: queryDb,
    }),
  );
  oracle.registerLookup(
    conversationsById,
    compileCollection(conversationsById, {
      ...conversationsByIdServeOptions,
      db: queryDb,
    }),
  );
  oracle.registerAll(
    taskRows,
    compileCollection(taskRows, {
      ...taskRowsServeOptions,
      db: oracle.queryDb as unknown as QueryDb,
    }),
  );
  oracle.registerAll(
    attemptRows,
    compileCollection(attemptRows, {
      ...attemptRowsServeOptions,
      db: oracle.queryDb as unknown as QueryDb,
    }),
  );
  oracle.registerLookup(
    taskDescriptions,
    compileCollection(taskDescriptions, {
      from: _tasks,
      db: oracle.queryDb as unknown as QueryDb,
    }),
  );
  oracle.registerAll(
    probe,
    compileCollection(probe, {
      from: _tasks,
      joins: [
        childrenJoin({
          alias: "att",
          table: _attempts,
          fk: _attempts.taskId,
          aggregates: (c) => ({
            count: aggregate(sql`count(${c.att.id})::int`, {
              decoder: Number,
              sqlType: "integer",
              notNull: true,
              ifNone: sql`0`,
            }),
          }),
        }),
      ],
      columns: { attempts: (j) => j.att.count },
      where: (j) => sql`${j.base.droppedAt} IS NULL`,
      db: oracle.queryDb as unknown as QueryDb,
    }),
  );
  await oracle.start();
});

afterAll(async () => {
  await oracle?.stop();
});

const [T1, T2, T3, T4, T5, T6] = TREE_IDS.tasks;
const [A1, A2, A3] = TREE_IDS.attempts;
const [C1, C2, C3] = TREE_IDS.conversations;
/** A `system` conversation of A3 — machine-spawned, never listed. */
const C4 = "tree-c4";

/** What each scripted step must cost the probe: its loads and `orderOf` calls. */
const PROBE_COST: Record<string, { loads: TreeLoad[]; orderOf: number }> = {
  // An entrant.
  "task.insert": { loads: [{ ids: [T6] }], orderOf: 1 },
  // The probe reads no edge, conversation or push.
  "edge.insert": { loads: [], orderOf: 0 },
  // `title` is the order field: a refill and one `orderOf`.
  "task.rename": { loads: [{ ids: [T2] }], orderOf: 1 },
  // A column the probe does not read: the route gate drops it.
  "task.hold": { loads: [], orderOf: 0 },
  // A child row its aggregate reads: the host's refill, no `orderOf`.
  "attempt.insert": { loads: [{ ids: [T3] }], orderOf: 0 },
  "conversation.insert": { loads: [], orderOf: 0 },
  "conversation.done": { loads: [], orderOf: 0 },
  "conversation.poller": { loads: [], orderOf: 0 },
  "push.insert": { loads: [], orderOf: 0 },
  "task.reorder": { loads: [], orderOf: 0 },
  // The child moved: both hosts' aggregates refill, in one load.
  "attempt.move": { loads: [{ ids: [T2, T4].sort() }], orderOf: 0 },
  "edge.delete": { loads: [], orderOf: 0 },
  "attempt.delete": { loads: [{ ids: [T1] }], orderOf: 0 },
  // A spliced step (`TASK_STEPS`): `title` is the order field.
  "task.rename-live": { loads: [{ ids: [T3] }], orderOf: 1 },
  // An exit: no load at all (its attempts' cascade reaches a host now gone).
  "task.delete": { loads: [], orderOf: 0 },
  // A where-flip out: the refill omits the id.
  "task.drop": { loads: [{ ids: [T4] }], orderOf: 0 },
};

/** The suite's own writes, each spliced right after the tree step it names. */
const TASK_STEPS: Record<string, TreeStep[]> = {
  "task.rename": [
    // A description autosave: no row field reads `description`, but the
    // derived `updated_at` moves — the task's one-row refill (accepted).
    {
      label: "task.describe",
      statements: [
        `UPDATE tasks SET description = 'described' WHERE id = '${T1}'`,
      ],
    },
  ],
  "conversation.poller": [
    // The waiting agent works again: the rollup's `has_waiting_conv` clears
    // (`need_action`'s input) — its task's row and its dependents.
    {
      label: "conversation.resume",
      statements: [
        `UPDATE conversations SET status = 'working', waiting_for = NULL WHERE id = '${C3}'`,
      ],
    },
  ],
  "push.insert": [
    // A conversation's title: the `attempts` list reads it, no rollup does.
    {
      label: "conversation.retitle",
      statements: [
        `UPDATE conversations SET title = 'renamed' WHERE id = '${C3}'`,
      ],
    },
    // A `system` conversation: the `attempts` list leaves it out (its
    // children `where`), but the conversation rollup aggregates every kind,
    // so both sets refill its attempt's task / attempt row.
    {
      label: "conversation.system",
      statements: [
        `INSERT INTO conversations (id, attempt_id, title, status, model, kind)
         SELECT '${C4}', '${A3}', 'system', 'working', model, 'system'
           FROM conversations WHERE id = '${C3}'`,
      ],
    },
    // A rename of a task with LIVE conversations (C3, and the system C4): the
    // conversation lists carry its `taskTitle` (the owner join's reverse
    // route through `attempts`).
    {
      label: "task.rename-live",
      statements: [
        `UPDATE tasks SET title = '${T3} renamed' WHERE id = '${T3}'`,
      ],
    },
  ],
};

/**
 * What each step must cost the real `tasks` set: its loads and `orderOf`
 * calls, and the `:rows` point reader's loads (its point set is T1, T3).
 * The edges at each step are the script's: T2 → T1, T3 → T2, T4 → T1, then
 * T6 → T3 (`edge.insert`), and T3 → T2 gone (`edge.delete`).
 */
interface TasksCost {
  loads: TreeLoad[];
  orderOf: number;
  rowLoads: TreeLoad[];
}
const NOTHING: TasksCost = { loads: [], orderOf: 0, rowLoads: [] };
const ids = (...xs: string[]) => ({ ids: [...xs].sort() });
const sortLoads = (loads: readonly TreeLoad[]) =>
  [...loads].sort((a, b) =>
    JSON.stringify(a.ids).localeCompare(JSON.stringify(b.ids)),
  );
const TASKS_COST: Record<string, TasksCost> = {
  // An entrant.
  "task.insert": { ...NOTHING, loads: [ids(T6)], orderOf: 1 },
  // T6's own edge: its `dependencies` and its closure (nothing depends on T6).
  "edge.insert": { ...NOTHING, loads: [ids(T6)] },
  // `title` is no order field and no blocking input: T2 alone.
  "task.rename": { ...NOTHING, loads: [ids(T2)] },
  // `updated_at` moves with it.
  "task.describe": {
    loads: [ids(T1)],
    orderOf: 0,
    rowLoads: [ids(T1)],
  },
  // `held_at` is a blocking input: T3 and what depends on it (T6).
  "task.hold": {
    loads: [ids(T3, T6)],
    orderOf: 0,
    rowLoads: [ids(T3)],
  },
  // An attempt, its conversation and its push: the task and its dependents.
  "attempt.insert": {
    loads: [ids(T3, T6)],
    orderOf: 0,
    rowLoads: [ids(T3)],
  },
  "conversation.insert": {
    loads: [ids(T3, T6)],
    orderOf: 0,
    rowLoads: [ids(T3)],
  },
  // T1 completes: every transitive dependent (T2, T4; T3 via T2; T6 via T3).
  "conversation.done": {
    loads: [ids(T1, T2, T3, T4, T6)],
    orderOf: 0,
    rowLoads: [ids(T1, T3)],
  },
  // `waiting_for` / `last_viewed_at`: no rollup reads them.
  "conversation.poller": NOTHING,
  // `status` is a rollup input (`has_waiting_conv`): T3 and its dependent T6.
  "conversation.resume": {
    loads: [ids(T3, T6)],
    orderOf: 0,
    rowLoads: [ids(T3)],
  },
  "push.insert": {
    loads: [ids(T3, T6)],
    orderOf: 0,
    rowLoads: [ids(T3)],
  },
  // No rollup reads `title`.
  "conversation.retitle": NOTHING,
  // `title` again: T3 alone.
  "task.rename-live": { loads: [ids(T3)], orderOf: 0, rowLoads: [ids(T3)] },
  // The conversation rollup's source route fires on the insert.
  "conversation.system": {
    loads: [ids(T3, T6)],
    orderOf: 0,
    rowLoads: [ids(T3)],
  },
  // `rank` is the order field.
  "task.reorder": { ...NOTHING, loads: [ids(T5)], orderOf: 1 },
  // Both hosts, and the dependents of each (T2's: T3, T6).
  "attempt.move": {
    loads: [ids(T2, T3, T4, T6)],
    orderOf: 0,
    rowLoads: [ids(T3)],
  },
  // T3's edge: T3 and its dependent T6.
  "edge.delete": {
    loads: [ids(T3, T6)],
    orderOf: 0,
    rowLoads: [ids(T3)],
  },
  // A1 (T1's) with its conversation and push: T1 and its dependents now (T2,
  // T4 — T3 no longer runs after T2).
  "attempt.delete": {
    loads: [ids(T1, T2, T4)],
    orderOf: 0,
    rowLoads: [ids(T1)],
  },
  // An exit. Its own edge (T2 → T1) is cascade-deleted in the same
  // transaction, and the edge's route asks for T2's refill — one scoped load
  // that reads nothing (a pending holds the delete and the refill as sets, so
  // the order between them is gone and the runtime cannot skip it). Nothing
  // depends on T2 any more, so no dependent loads.
  "task.delete": { ...NOTHING, loads: [ids(T2)] },
  // `dropped_at` is a blocking input, but nothing depends on T4.
  "task.drop": { ...NOTHING, loads: [ids(T4)] },
};

/**
 * What each step must cost the `task-descriptions:rows` point reader of
 * {T1, T2}: only a write to a column its row reads (`description`) of an id in
 * the set loads — a rename (T2) or a hold (T3) is gated out, an attempt or a
 * conversation is a table it does not read. Any step not listed loads nothing.
 */
const DESCRIPTIONS_COST: Record<string, TreeLoad[]> = {
  "task.describe": [ids(T1)],
};

/**
 * What each step must cost the real `attempts` set: its loads and `orderOf`
 * calls, and the `:rows` point reader's loads (its point set is A2, A3).
 * The attempts are A1 (T1), A2 (T2, then T4) and A3 (T3, from
 * `attempt.insert`). Any step not listed loads nothing — every task and edge
 * write, the drag, the poller's `waiting_for` / `last_viewed_at` write.
 */
const ATTEMPTS_COST: Record<string, TasksCost> = {
  // An entrant.
  "attempt.insert": { loads: [ids(A3)], orderOf: 1, rowLoads: [ids(A3)] },
  // A conversation write: its attempt's row (the list and the rollup).
  "conversation.insert": { loads: [ids(A3)], orderOf: 0, rowLoads: [ids(A3)] },
  "conversation.done": { loads: [ids(A1)], orderOf: 0, rowLoads: [] },
  "conversation.resume": { loads: [ids(A3)], orderOf: 0, rowLoads: [ids(A3)] },
  // A push: its attempt's row, through the push rollup's source route (C1).
  "push.insert": { loads: [ids(A3)], orderOf: 0, rowLoads: [ids(A3)] },
  "conversation.retitle": {
    loads: [ids(A3)],
    orderOf: 0,
    rowLoads: [ids(A3)],
  },
  "conversation.system": {
    loads: [ids(A3)],
    orderOf: 0,
    rowLoads: [ids(A3)],
  },
  // `task_id` is a row field: the attempt's own refill.
  "attempt.move": { loads: [ids(A2)], orderOf: 0, rowLoads: [ids(A2)] },
  // An exit. Its conversation and push are cascade-deleted in the same
  // transaction, and their routes ask for A1's refill — one scoped load that
  // reads nothing (the pending holds the delete and the refill as sets; see
  // `tasks`' `task.delete`).
  "attempt.delete": { ...NOTHING, loads: [ids(A1)] },
};

/**
 * What each step must cost the conversation lists (step 22): the two live
 * `all` sets (`conversations-active`, `conversations-system`: loads and
 * `orderOf` calls), the `conversations-gone` default window, and the
 * `conversations.by-id:rows` point reader of {C1, C2} (C2 is done from the
 * seed, C1 closes mid-script). The conversations are C1 (A1, T1), C2 (A2,
 * T2, then T4), C3 (A3, T3, from `conversation.insert`) and the `system` C4
 * (A3). Any step not listed loads nothing — W4: a task or attempt write no
 * field reads (a hold, a describe, a reorder, a drop, an insert, an edge)
 * reaches no list; only a rename (`taskTitle`) or an attempt's move
 * (`taskId`, `worktreePath`) reaches the conversations it owns.
 */
interface ConversationsCost {
  active: TreeLoad[];
  activeOrderOf: number;
  system: TreeLoad[];
  systemOrderOf: number;
  gone: TreeLoad[];
  byId: TreeLoad[];
}
const QUIET: ConversationsCost = {
  active: [],
  activeOrderOf: 0,
  system: [],
  systemOrderOf: 0,
  gone: [],
  byId: [],
};
const one = (id: string) => [ids(id)];
const CONVERSATIONS_COST: Record<string, ConversationsCost> = {
  // T2's `title` is a projected owner column (value role): it refills the
  // rows that HOLD a conversation of T2 — C2, in the gone window and the
  // by-id reader — and no live set (C2 is done).
  "task.rename": { ...QUIET, gone: one(C2), byId: one(C2) },
  // An insert: an entrant of `active` (one refill, one `orderOf`); `system`
  // and the gone window check it with a one-row read that finds it outside
  // their membership.
  "conversation.insert": {
    ...QUIET,
    active: one(C3),
    activeOrderOf: 1,
    system: one(C3),
    gone: one(C3),
  },
  // C1 closes: an exit of `active` (the refill omits it), an entrant of the
  // gone window, a refill of the by-id reader that holds it; `system`
  // re-checks it (`status` is a `where` column).
  "conversation.done": {
    ...QUIET,
    active: one(C1),
    system: one(C1),
    gone: one(C1),
    byId: one(C1),
  },
  // The poller's `waiting_for` / `last_viewed_at`: the ONE-ROW refill of the
  // set that holds C3 (`waitingFor` is a row field). Nothing else holds it,
  // and neither column is a `where` column, so nothing else loads.
  "conversation.poller": { ...QUIET, active: one(C3) },
  // `status` moves (`where`): every list re-checks C3.
  "conversation.resume": {
    ...QUIET,
    active: one(C3),
    system: one(C3),
    gone: one(C3),
  },
  // `title`: a value write — the one set holding C3.
  "conversation.retitle": { ...QUIET, active: one(C3) },
  // A `system` insert: the entrant of `system`, checked by the other two.
  "conversation.system": {
    ...QUIET,
    active: one(C4),
    system: one(C4),
    systemOrderOf: 1,
    gone: one(C4),
  },
  // T3's `title`: its live conversations' `taskTitle`, each in the set that
  // holds it (C3 active, C4 system).
  "task.rename-live": { ...QUIET, active: one(C3), system: one(C4) },
  // A2 moves to T4: `attempt.task_id` keys the `task` lookup — a REQUIRED
  // join, so membership — so every list re-checks C2 (A2's conversation),
  // and the by-id reader refills it (`taskId` / `taskTitle` moved).
  "attempt.move": {
    ...QUIET,
    active: one(C2),
    system: one(C2),
    gone: one(C2),
    byId: one(C2),
  },
  // Everything else is QUIET — the W4 steps: a task insert, hold, describe,
  // reorder, drop or delete, an edge, an attempt insert, a push. A1's cascade
  // delete takes C1 out of the gone window and the by-id reader as an exit
  // with no load.
};

describe("tree oracle — the scripted workload over the real feed", () => {
  test("every step converges to a fresh FULL load, at its exact cost, and nothing loads FULL", async () => {
    for (const step of treeSeed()) {
      await oracle.run(step);
    }
    await oracle.subscribe(PROBE);
    await oracle.subscribe(TASKS);
    const pointParams = taskRows.rows.point.encode([T1, T3]);
    await oracle.subscribe(TASK_ROWS, pointParams);
    await oracle.subscribe(ATTEMPTS);
    // A3 is inserted mid-script: the point set holds an id before its row.
    const attemptParams = attemptRows.rows.point.encode([A2, A3]);
    await oracle.subscribe(ATTEMPT_ROWS, attemptParams);
    await oracle.subscribe(ACTIVE);
    await oracle.subscribe(SYSTEM);
    const goneParams = conversationsGone.window.defaultParams;
    await oracle.subscribe(GONE, goneParams);
    const byIdParams = conversationsById.rows.point.encode([C1, C2]);
    await oracle.subscribe(BY_ID, byIdParams);
    await oracle.converged("seed");
    const conversationBaselines = new Map(
      [ACTIVE, SYSTEM, GONE, BY_ID].map((k) => [k, oracle.loadsOf(k).length]),
    );
    const conversationsSeen: unknown[] = [];
    const conversationsWant: unknown[] = [];
    const baseline = oracle.loadsOf(PROBE).length;
    const tasksBaseline = oracle.loadsOf(TASKS).length;
    const rowsBaseline = oracle.loadsOf(TASK_ROWS).length;
    const attemptsBaseline = oracle.loadsOf(ATTEMPTS).length;
    const attemptRowsBaseline = oracle.loadsOf(ATTEMPT_ROWS).length;

    // The description point reader: T1 (described), T2 (deleted).
    const descriptionParams = taskDescriptions.rows.point.encode([T1, T2]);
    await oracle.subscribe(DESCRIPTIONS, descriptionParams);
    await oracle.converged("seed.descriptions");
    const descriptionsBaseline = oracle.loadsOf(DESCRIPTIONS).length;

    const steps = withSteps(treeSteps(), TASK_STEPS);
    expect(new Set(treeSteps().map((s) => s.label))).toEqual(
      new Set(
        Object.keys(PROBE_COST).filter((label) => label !== "task.rename-live"),
      ),
    );
    expect(new Set(steps.map((s) => s.label))).toEqual(
      new Set(Object.keys(TASKS_COST)),
    );
    for (const step of steps) {
      const cost = await oracle.run(step);
      await oracle.converged(step.label);
      expect({
        step: step.label,
        loads: cost.loads[PROBE],
        orderOf: cost.orderOf[PROBE],
      }).toEqual({
        step: step.label,
        ...(PROBE_COST[step.label] ?? { loads: [], orderOf: 0 }),
      });
      expect({
        step: step.label,
        loads: cost.loads[TASKS] ?? [],
        orderOf: cost.orderOf[TASKS] ?? 0,
        rowLoads: cost.loads[TASK_ROWS] ?? [],
      }).toEqual({ step: step.label, ...TASKS_COST[step.label]! });
      expect({
        step: step.label,
        loads: cost.loads[DESCRIPTIONS] ?? [],
      }).toEqual({
        step: step.label,
        loads: DESCRIPTIONS_COST[step.label] ?? [],
      });
      conversationsSeen.push({
        step: step.label,
        active: cost.loads[ACTIVE] ?? [],
        activeOrderOf: cost.orderOf[ACTIVE] ?? 0,
        system: cost.loads[SYSTEM] ?? [],
        systemOrderOf: cost.orderOf[SYSTEM] ?? 0,
        gone: cost.loads[GONE] ?? [],
        byId: cost.loads[BY_ID] ?? [],
      });
      conversationsWant.push({
        step: step.label,
        ...(CONVERSATIONS_COST[step.label] ?? QUIET),
      });
      expect({
        step: step.label,
        loads: cost.loads[ATTEMPTS] ?? [],
        orderOf: cost.orderOf[ATTEMPTS] ?? 0,
        rowLoads: cost.loads[ATTEMPT_ROWS] ?? [],
      }).toEqual({
        step: step.label,
        ...(ATTEMPTS_COST[step.label] ?? NOTHING),
      });
    }
    // Every step's cost on the conversation lists, compared at once so a
    // mismatch shows the whole script.
    expect(conversationsSeen).toEqual(conversationsWant);
    for (const [key, from] of [
      [PROBE, baseline],
      [TASKS, tasksBaseline],
      [ATTEMPTS, attemptsBaseline],
      [ACTIVE, conversationBaselines.get(ACTIVE)!],
      [SYSTEM, conversationBaselines.get(SYSTEM)!],
      [GONE, conversationBaselines.get(GONE)!],
      [BY_ID, conversationBaselines.get(BY_ID)!],
    ] as const) {
      expect(
        oracle
          .loadsOf(key)
          .slice(from)
          .some((l) => l.ids === "FULL"),
      ).toBe(false);
    }
    expect(oracle.loadsOf(ATTEMPT_ROWS).slice(attemptRowsBaseline)).toEqual(
      steps.flatMap((s) => (ATTEMPTS_COST[s.label] ?? NOTHING).rowLoads),
    );
    oracle.unsubscribe(ATTEMPT_ROWS, attemptParams);
    // Every point-reader load after the subscribe is one a step pinned.
    expect(oracle.loadsOf(TASK_ROWS).slice(rowsBaseline)).toEqual(
      steps.flatMap((s) => TASKS_COST[s.label]!.rowLoads),
    );
    oracle.unsubscribe(TASK_ROWS, pointParams);
    // T2 left the read with its delete: the view holds T1 alone.
    expect(oracle.loadsOf(DESCRIPTIONS).slice(descriptionsBaseline)).toEqual(
      steps.flatMap((s) => DESCRIPTIONS_COST[s.label] ?? []),
    );
    oracle.unsubscribe(DESCRIPTIONS, descriptionParams);
    oracle.unsubscribe(GONE, goneParams);
    oracle.unsubscribe(BY_ID, byIdParams);
  });

  test("with nobody subscribed, the persisted `{}` snapshots stay current through the workload's writes", async () => {
    oracle.unsubscribe(PROBE);
    oracle.unsubscribe(TASKS);
    oracle.unsubscribe(ATTEMPTS);
    oracle.unsubscribe(ACTIVE);
    oracle.unsubscribe(SYSTEM);
    const conversationBaselines = new Map(
      [ACTIVE, SYSTEM].map((k) => [k, oracle.loadsOf(k).length]),
    );
    const baseline = oracle.loadsOf(PROBE).length;
    const tasksBaseline = oracle.loadsOf(TASKS).length;
    const attemptsBaseline = oracle.loadsOf(ATTEMPTS).length;
    await oracle.run({
      label: "idle.rename",
      statements: [`UPDATE tasks SET title = 'zz' WHERE id = '${T1}'`],
    });
    await oracle.run({
      label: "idle.edge",
      statements: [
        `INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ('${T6}', '${T1}')`,
      ],
    });
    await oracle.run({
      label: "idle.attempt",
      statements: [
        `INSERT INTO attempts (id, task_id, worktree_path) VALUES ('tree-a4', '${T1}', '/tmp/tree-a4')`,
      ],
    });
    // A live and a `system` conversation on T1's new attempt: entrants of
    // the kept sets, which outlive T3's delete below (the C39 cases read them).
    await oracle.run({
      label: "idle.conversations",
      statements: [
        `INSERT INTO conversations (id, attempt_id, title, status, model)
         SELECT 'tree-c5', 'tree-a4', 'live', 'working', model
           FROM conversations WHERE id = '${C3}'`,
        `INSERT INTO conversations (id, attempt_id, title, status, model, kind)
         SELECT 'tree-c6', 'tree-a4', 'system', 'working', model, 'system'
           FROM conversations WHERE id = '${C3}'`,
      ],
    });
    await oracle.run({
      label: "idle.poller",
      statements: [
        `UPDATE conversations SET waiting_for = 'permission' WHERE id = 'tree-c5'`,
      ],
    });
    // T3's attempt A3 goes with it (and its conversations and push).
    await oracle.run({
      label: "idle.delete",
      statements: [`DELETE FROM tasks WHERE id = '${T3}'`],
    });
    await oracle.converged("idle");
    expect(oracle.kept(PROBE)).toBeDefined();
    expect(oracle.kept(TASKS)).toBeDefined();
    expect(oracle.kept(ATTEMPTS)).toBeDefined();
    expect(oracle.kept(ACTIVE)).toBeDefined();
    expect(oracle.kept(SYSTEM)).toBeDefined();
    for (const key of [ACTIVE, SYSTEM]) {
      expect(
        oracle
          .loadsOf(key)
          .slice(conversationBaselines.get(key)!)
          .some((l) => l.ids === "FULL"),
      ).toBe(false);
    }
    expect(
      oracle
        .loadsOf(ATTEMPTS)
        .slice(attemptsBaseline)
        .some((l) => l.ids === "FULL"),
    ).toBe(false);
    expect(
      oracle
        .loadsOf(PROBE)
        .slice(baseline)
        .some((l) => l.ids === "FULL"),
    ).toBe(false);
    expect(
      oracle
        .loadsOf(TASKS)
        .slice(tasksBaseline)
        .some((l) => l.ids === "FULL"),
    ).toBe(false);
  });

  // The script never holds more ended conversations than the default
  // window's limit, so it never binds there. A tuple at `limit: 1` makes it
  // bind: an entrant must evict the tail row and an exit — a reopen (a
  // `where` flip) or a delete — must backfill the next one, the case the
  // retired `conversations-gone` declared `recompute: full` for. A live
  // `tree-c7` on the idle test's `tree-a4` closes, reopens, closes and is
  // deleted; C2 (done since the seed, older) is the row it evicts and that
  // backfills. (Its own row, not the idle test's `tree-c5`: the C39 cases
  // below need the live sets non-empty.)
  test("the gone window at capacity evicts its tail on an entrant and backfills it on an exit", async () => {
    const C7 = "tree-c7";
    await oracle.run({
      label: "gone.live",
      statements: [
        `INSERT INTO conversations (id, attempt_id, title, status, model)
         SELECT '${C7}', 'tree-a4', 'gone', 'working', model
           FROM conversations WHERE id = '${C2}'`,
      ],
    });
    const tight = conversationsGone.window.window.encode({ limit: 1 });
    const wide = conversationsGone.window.defaultParams;
    await oracle.subscribe(GONE, tight);
    await oracle.subscribe(GONE, wide);
    await oracle.converged("gone.subscribe");
    const idsOf = (params: Record<string, string>) =>
      (oracle.view(GONE, params) as { id: string }[]).map((r) => r.id);
    expect({ tight: idsOf(tight), wide: idsOf(wide) }).toEqual({
      tight: [C2],
      wide: [C2],
    });
    const baseline = oracle.loadsOf(GONE).length;
    const close = `UPDATE conversations SET status = 'done', ended_at = now() WHERE id = '${C7}'`;
    // Per step: each tuple's contents after it, and the step's loads of the
    // key (both tuples' — a scoped load is per tuple). An entrant is one
    // refill per tuple, the tail it evicts from the tight one a delete frame
    // with no read; a reopen refills C7 in each tuple (it leaves both) and
    // backfills C2 into the tight one; a delete reads nothing for the gone
    // row and backfills C2 alone.
    const script: {
      step: TreeStep;
      tight: string[];
      wide: string[];
      loads: TreeLoad[];
    }[] = [
      {
        step: { label: "gone.enter", statements: [close] },
        tight: [C7],
        wide: [C7, C2],
        loads: [ids(C7), ids(C7)],
      },
      {
        step: {
          label: "gone.reopen",
          statements: [
            `UPDATE conversations SET status = 'working', ended_at = NULL WHERE id = '${C7}'`,
          ],
        },
        tight: [C2],
        wide: [C2],
        loads: [ids(C7), ids(C7), ids(C2)],
      },
      {
        step: { label: "gone.re-enter", statements: [close] },
        tight: [C7],
        wide: [C7, C2],
        loads: [ids(C7), ids(C7)],
      },
      {
        step: {
          label: "gone.delete",
          statements: [`DELETE FROM conversations WHERE id = '${C7}'`],
        },
        tight: [C2],
        wide: [C2],
        loads: [ids(C2)],
      },
    ];
    for (const { step, ...want } of script) {
      const cost = await oracle.run(step);
      await oracle.converged(step.label);
      expect({
        step: step.label,
        tight: idsOf(tight),
        wide: idsOf(wide),
        // The two tuples' loads land in either order.
        loads: sortLoads(cost.loads[GONE] ?? []),
      }).toEqual({ step: step.label, ...want, loads: sortLoads(want.loads) });
    }
    expect(
      oracle
        .loadsOf(GONE)
        .slice(baseline)
        .some((l) => l.ids === "FULL"),
    ).toBe(false);
    oracle.unsubscribe(GONE, tight);
    oracle.unsubscribe(GONE, wide);
  });
});

// What the legacy `tasks` descriptor (param-less, keyed on `id`) parsed its
// payload with (`z.array(TaskListItemSchema)`), restated as a LITERAL frozen at step 19 —
// never derived from the live `TaskListItemSchema`, which would change with
// the row and so pass whatever the row becomes. Not `strict`: the old bundle's
// schema was a plain `z.object`, which strips unknown keys, so a field ADDED to
// the row is compatible with an old tab (and modelling a stricter client than
// ever shipped would fail on every additive change). A field removed, renamed
// or retyped fails the parse as a missing or invalid key — the change C39 says
// must rename the key.
const LegacyRowsSchema = z.array(
  z.object({
    id: z.string(),
    folderId: z.string().nullable(),
    groupId: z.string().nullable(),
    clusterId: z.string().nullable(),
    title: z.string(),
    titleAuto: z.boolean(),
    author: z.string().nullable(),
    droppedAt: z.coerce.date().nullable(),
    heldAt: z.coerce.date().nullable(),
    rank: RankSchema,
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
    status: z.enum([
      "new",
      "in_progress",
      "need_action",
      "attempted",
      "done",
      "held",
      "dropped",
      "blocked",
      "in_progress_blocked",
    ]),
    active: z.boolean(),
    finishedAt: z.coerce.date().nullable(),
    dependencies: z.array(z.string()),
  }),
);

describe("C39 — a tab on the legacy `tasks` descriptor", () => {
  test("subscribes `{}`, passes the gate, and parses the compiled rows with its OLD schema to the same values", async () => {
    // The truth as an old tab would hold it: the kept set, over the wire.
    const wire: unknown = JSON.parse(JSON.stringify(oracle.kept(TASKS)));
    for (const schema of [LegacyRowsSchema, z.array(TaskListItemSchema)]) {
      const old = await subscribeAsOldDescriptor(
        { key: TASKS, schema },
        { handler: oracle.runtime.notificationsWsHandler },
      );
      expect(old.kind).toBe("parsed");
      expect(canonical(old.kind === "parsed" ? old.value : null)).toBe(
        canonical(schema.parse(wire)),
      );
    }
  });
});

// What the legacy `attempts` descriptor (param-less, keyed) parsed its payload
// with (`z.array(AttemptWithConversationsSchema)`), restated as a LITERAL frozen at step 20 — never derived from the live
// schema (see `LegacyRowsSchema` above). Not `strict` at either level (see
// there): only a removed, renamed or retyped key fails the parse.
const LegacyAttemptsSchema = z.array(
  z.object({
    id: z.string(),
    taskId: z.string(),
    worktreePath: z.string(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
    status: z.enum([
      "pending",
      "in_progress",
      "pushed",
      "completed",
      "dormant",
      "closed",
    ]),
    active: z.boolean(),
    retained: z.boolean(),
    finishedAt: z.coerce.date().nullable(),
    conversations: z.array(
      z.object({
        id: z.string(),
        title: z.string().nullable(),
        status: z.enum(["starting", "working", "waiting", "gone", "done"]),
        kind: z.enum(["user", "agent", "system"]),
        createdAt: z.coerce.date(),
        spawnedBy: z.string().nullable(),
      }),
    ),
  }),
);

describe("C39 — a tab on the legacy `attempts` descriptor", () => {
  test("subscribes `{}`, passes the gate, and parses the compiled rows with its OLD schema to the same values", async () => {
    const wire: unknown = JSON.parse(JSON.stringify(oracle.kept(ATTEMPTS)));
    // The set is not trivially empty: the conversation list is what changed shape.
    expect(
      (wire as { conversations: unknown[] }[]).some(
        (a) => a.conversations.length > 0,
      ),
    ).toBe(true);
    for (const schema of [
      LegacyAttemptsSchema,
      z.array(AttemptWithConversationsSchema),
    ]) {
      const old = await subscribeAsOldDescriptor(
        { key: ATTEMPTS, schema },
        { handler: oracle.runtime.notificationsWsHandler },
      );
      expect(old.kind).toBe("parsed");
      expect(canonical(old.kind === "parsed" ? old.value : null)).toBe(
        canonical(schema.parse(wire)),
      );
    }
  });
});

// What the legacy `conversations-active` / `-system` descriptors parsed their
// payload with (param-less, keyed on `id`: `z.array(ConversationSchema)`, the
// `conversations_v` row), restated as a
// LITERAL frozen at step 22 — never derived from the live schema (see
// `LegacyRowsSchema` above). Not `strict` (see there): an additive key such as
// `waitingMenu` or `$columns` is stripped, as the old tab's schema did.
// `model` is the stored version as text.
const LegacyConversationsSchema = z.array(
  z.object({
    id: z.string(),
    attemptId: z.string(),
    title: z.string().nullable(),
    status: z.enum(["starting", "working", "waiting", "gone", "done"]),
    runtime: z.string(),
    model: z.string(),
    kind: z.enum(["user", "agent", "system"]),
    claudeSessionId: z.string().nullable(),
    waitingFor: z.string().nullable(),
    spawnedBy: z.string().nullable(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
    endedAt: z.coerce.date().nullable(),
    closeRequested: z.boolean(),
    hibernatedAt: z.coerce.date().nullable(),
    lastViewedAt: z.coerce.date().nullable(),
    worktreePath: z.string(),
    taskId: z.string(),
    taskTitle: z.string(),
    active: z.boolean(),
  }),
);

describe("C39 — tabs on the legacy conversation-list descriptors", () => {
  test("`conversations-active` / `-system`: subscribes `{}`, passes the gate, and parses the compiled rows with its OLD schema to the same values", async () => {
    for (const key of [ACTIVE, SYSTEM]) {
      const wire: unknown = JSON.parse(JSON.stringify(oracle.kept(key)));
      // The idle steps leave one row in each.
      expect((wire as unknown[]).length).toBeGreaterThan(0);
      for (const schema of [
        LegacyConversationsSchema,
        z.array(ConversationSchema),
      ]) {
        const old = await subscribeAsOldDescriptor(
          { key, schema },
          { handler: oracle.runtime.notificationsWsHandler },
        );
        expect({ key, kind: old.kind }).toEqual({ key, kind: "parsed" });
        expect(canonical(old.kind === "parsed" ? old.value : null)).toBe(
          canonical(schema.parse(wire)),
        );
      }
    }
  });

  test("a tab on the legacy param-less `conversations-gone` descriptor, now a window", async () => {
    const old = await subscribeAsOldDescriptor(
      { key: GONE, schema: LegacyConversationsSchema },
      { handler: oracle.runtime.notificationsWsHandler },
    );
    // The window decodes `{}` as no window at all: a `contract-mismatch`, so
    // the old tab gets the `skew` verdict (a reload), never rows it would
    // misread.
    expect(old).toEqual({
      kind: "refused",
      reason: "contract-mismatch",
      verdict: "skew",
    });
  });
});
