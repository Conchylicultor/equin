/**
 * `agent-launches` as an `all` collection (P8 v3 step 21), on the TREE ORACLE
 * (tasks-core's `server/testing`): the real declaration compiled with the real
 * serve options against a throwaway database, through the real feed, with the
 * REAL `task_latest_conversation` rollup installed beside tasks-core's own
 * (its two sources: `conversations` through the `attempts` hop, and
 * `attempts` carrying `task_id`), and L2 on — so the set is a persisted alias,
 * as it ships (`preload: "boot"`).
 *
 * The tree workload runs with launch writes and a few conversation / attempt
 * writes spliced in. After every step:
 *
 * - the rollup equals its aggregate recomputed from scratch (its own drift
 *   scan finds no key) — W8 against the shipped declaration: an attempt
 *   deleted (its conversations cascade, and their DELETE resolves no task
 *   through the hop) or moved between tasks re-aggregates both tasks;
 * - the subscribed `{}` view, the `:rows` point view (over L1, L2) and the
 *   kept `{}` snapshot equal a fresh FULL load;
 * - both readers' costs are exact: a launch insert is an entrant (one refill,
 *   one `orderOf`), its delete an exit with no load; a conversation write
 *   the rollup reads (insert, status, title) refills the launches of its task;
 *   an attempt insert, move or delete the launches of its task(s) (the
 *   attempts source's route); a write nothing reads (the poller's
 *   `waiting_for` / `last_viewed_at`, a push, a task or edge write) nothing;
 * - nothing is ever loaded FULL after the subscribe (W1/W2 for this key).
 *
 * Then the C39 old-bundle check against the real key, with a literal frozen
 * copy of the legacy row.
 *
 * Requires a running Postgres cluster (started by ./singularity build).
 * Run: `./singularity test plugins/conversations/plugins/agents`.
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
import { FALLBACK_MODEL } from "@plugins/conversations/plugins/model-provider/core";
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
import { AgentLaunchWithStatusSchema } from "../../core";
import { agentLaunchRows, type AgentLaunchWithStatus } from "../../core";
import { agentLaunchRowsServeOptions } from "./agent-launch-rows";
import { taskLatestConversation } from "./rollup-spec";

setDefaultTimeout(120_000);

const KEY = agentLaunchRows.key;
const ROWS_KEY = agentLaunchRows.rows.key;
const [T1, T2, T3, T4, , T6] = TREE_IDS.tasks;
const [C1, , C3] = TREE_IDS.conversations;
const MODEL = FALLBACK_MODEL.replace(/'/g, "''");

const AGENT = "launch-agent";
/** Launches: two on T1, one each on T2, T3, T4; L6 on T6 joins later. */
const [L1, L2, L3, L4, L5, L6] = [
  "launch-l1",
  "launch-l2",
  "launch-l3",
  "launch-l4",
  "launch-l5",
  "launch-l6",
] as const;
/** A second attempt of T1, with a conversation OLDER than C1 (the W8 fallback). */
const A4 = "launch-a4";
const C4 = "launch-c4";

// What the legacy `agent-launches` descriptor (param-less, keyed) parsed its
// payload with (`z.array(AgentLaunchWithStatusSchema)`),
// restated as a literal frozen at step 21 — `strict` at the row and the
// nested ref, so a field added, removed or renamed fails the parse rather
// than passing it, and the key must then be renamed.
const STATUS = z.enum(["starting", "working", "waiting", "gone", "done"]);
const LegacyRowsSchema = z.array(
  z
    .object({
      id: z.string(),
      agentId: z.string(),
      taskId: z.string(),
      createdAt: z.coerce.date(),
      latestConversationStatus: STATUS.nullable(),
      latestConversation: z
        .object({
          id: z.string(),
          title: z.string().nullable(),
          status: STATUS,
        })
        .strict()
        .nullable(),
    })
    .strict(),
);

const launch = (id: string, taskId: string, minutes: number) =>
  `INSERT INTO agent_launches (id, agent_id, task_id, created_at)
   VALUES ('${id}', '${AGENT}', '${taskId}', '2026-01-01T00:00:00Z'::timestamptz + interval '${minutes} minutes')`;

/** The launch writes and extra tree writes, each spliced after the step it names. */
const LAUNCH_STEPS: Record<string, TreeStep[]> = {
  "task.insert": [{ label: "launch.insert", statements: [launch(L6, T6, 6)] }],
  "push.insert": [
    // A conversation's title: the rollup reads it.
    {
      label: "conversation.retitle",
      statements: [
        `UPDATE conversations SET title = 'renamed' WHERE id = '${C3}'`,
      ],
    },
  ],
  "edge.delete": [
    // T1 gains a second attempt whose one conversation is OLDER than C1, in
    // one statement (one transaction): C1 stays T1's latest.
    {
      label: "attempt.older",
      statements: [
        `WITH a AS (
           INSERT INTO attempts (id, task_id, worktree_path)
           VALUES ('${A4}', '${T1}', '/tmp/${A4}') RETURNING id
         )
         INSERT INTO conversations (id, attempt_id, title, status, model, ended_at, created_at)
         SELECT '${C4}', a.id, '${C4} title', 'done', '${MODEL}', now() - interval '1 day', now() - interval '1 day'
           FROM a`,
      ],
    },
  ],
  "task.drop": [
    {
      label: "launch.delete",
      statements: [`DELETE FROM agent_launches WHERE id = '${L3}'`],
    },
  ],
};

/**
 * What each step must cost: the set's loads and `orderOf` calls, and the
 * `:rows` point reader's loads (its point set is L1, L2).
 */
interface StepCost {
  loads: TreeLoad[];
  orderOf: number;
  rowLoads: TreeLoad[];
}
const NOTHING: StepCost = { loads: [], orderOf: 0, rowLoads: [] };
const T1_LAUNCHES: StepCost = {
  loads: [{ ids: [L1, L5] }],
  orderOf: 0,
  rowLoads: [{ ids: [L1] }],
};
const T3_LAUNCHES: StepCost = { ...NOTHING, loads: [{ ids: [L3] }] };
const COST: Record<string, StepCost> = {
  // An entrant: its refill and one `orderOf`.
  "launch.insert": { ...NOTHING, loads: [{ ids: [L6] }], orderOf: 1 },
  // The attempts source's route ignores the source's `ops` (the rollup's own
  // trigger skips an insert, which cannot move the aggregate): the launches of
  // the new attempt's task refill, reading an unchanged row. Becomes NOTHING
  // once the route honours `ops` (task-1791411816223-6tbpyf).
  "attempt.insert": T3_LAUNCHES,
  "conversation.insert": T3_LAUNCHES,
  "conversation.done": T1_LAUNCHES,
  "conversation.retitle": T3_LAUNCHES,
  // A2 moves from T2 to T4: the attempts source carries both tasks.
  "attempt.move": {
    loads: [{ ids: [L2, L4] }],
    orderOf: 0,
    rowLoads: [{ ids: [L2] }],
  },
  "attempt.older": T1_LAUNCHES,
  // W8: A1's delete cascades C1 away; its conversations' DELETE resolves no
  // task through the hop, and the attempts source reaches T1's launches.
  "attempt.delete": T1_LAUNCHES,
  // An exit: no load.
  "launch.delete": NOTHING,
};

let oracle: TreeOracle;

async function rollupDrift(): Promise<string[]> {
  const res = await oracle.db.execute<{ keys: string[] }>(
    sql.raw(taskLatestConversation.driftSql),
  );
  return res.rows[0]!.keys;
}

const keptRow = (id: string): AgentLaunchWithStatus | undefined =>
  (oracle.kept(KEY) as AgentLaunchWithStatus[] | undefined)?.find(
    (r) => r.id === id,
  );

beforeAll(async () => {
  oracle = await createTreeOracle({
    prefix: "agent_launches_oracle",
    persisted: [KEY],
    rollups: [taskLatestConversation],
  });
  oracle.registerAll(
    agentLaunchRows,
    compileCollection(agentLaunchRows, {
      ...agentLaunchRowsServeOptions,
      db: oracle.queryDb as unknown as QueryDb,
    }),
  );
  await oracle.start();
});

afterAll(async () => {
  await oracle?.stop();
});

describe("agent-launches — an `all` collection on the tree oracle", () => {
  test("every step keeps the rollup exact and converges to a fresh FULL load at its exact cost; nothing loads FULL", async () => {
    for (const step of treeSeed()) await oracle.run(step);
    await oracle.run({
      label: "seed.launches",
      statements: [
        `INSERT INTO agents (id, name, prompt, rank) VALUES ('${AGENT}', 'Agent', 'do it', 'a0')`,
        launch(L1, T1, 1),
        launch(L2, T2, 2),
        launch(L3, T3, 3),
        launch(L4, T4, 4),
        launch(L5, T1, 5),
      ],
    });
    expect(await rollupDrift()).toEqual([]);
    await oracle.subscribe(KEY);
    const pointParams = agentLaunchRows.rows.point.encode([L1, L2]);
    await oracle.subscribe(ROWS_KEY, pointParams);
    await oracle.converged("seed");
    // The seed's shape on the wire: T1's latest is C1, T3 / T4 have none.
    expect(keptRow(L1)?.latestConversation).toEqual({
      id: C1,
      title: `${C1} title`,
      status: "working",
    });
    expect(keptRow(L1)?.latestConversationStatus).toBe("working");
    expect(keptRow(L3)?.latestConversation).toBeNull();
    expect(keptRow(L3)?.latestConversationStatus).toBeNull();
    const baseline = oracle.loadsOf(KEY).length;
    const rowBaseline = oracle.loadsOf(ROWS_KEY).length;

    for (const step of withSteps(treeSteps(), LAUNCH_STEPS)) {
      const cost = await oracle.run(step);
      expect({ step: step.label, drift: await rollupDrift() }).toEqual({
        step: step.label,
        drift: [],
      });
      await oracle.converged(step.label);
      expect({
        step: step.label,
        loads: cost.loads[KEY] ?? [],
        orderOf: cost.orderOf[KEY] ?? 0,
        rowLoads: cost.loads[ROWS_KEY] ?? [],
      }).toEqual({ step: step.label, ...(COST[step.label] ?? NOTHING) });
      if (step.label === "attempt.delete") {
        // W8: T1 falls back to its older conversation, on both launches.
        for (const id of [L1, L5]) {
          expect(keptRow(id)?.latestConversation?.id).toBe(C4);
          expect(keptRow(id)?.latestConversationStatus).toBe("done");
        }
      }
      if (step.label === "attempt.move") {
        // T2 lost its only attempt; T4 gained it, with C2.
        expect(keptRow(L2)?.latestConversation).toBeNull();
        expect(keptRow(L4)?.latestConversation?.id).toBe(
          TREE_IDS.conversations[1],
        );
      }
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

  test("with nobody subscribed, the persisted `{}` snapshot stays current", async () => {
    oracle.unsubscribe(KEY);
    const baseline = oracle.loadsOf(KEY).length;
    await oracle.run({
      label: "idle.conversation",
      statements: [
        `UPDATE conversations SET status = 'done', ended_at = now() WHERE id = '${C3}'`,
      ],
    });
    await oracle.run({
      label: "idle.launch",
      statements: [launch("launch-l7", T3, 7)],
    });
    expect(await rollupDrift()).toEqual([]);
    await oracle.converged("idle");
    expect(
      oracle
        .loadsOf(KEY)
        .slice(baseline)
        .some((l) => l.ids === "FULL"),
    ).toBe(false);
    expect(keptRow("launch-l7")?.latestConversationStatus).toBe("done");
  });
});

describe("C39 — a tab on the legacy `agent-launches` descriptor", () => {
  test("subscribes `{}`, passes the gate, and parses the compiled rows with its OLD schema to the same values", async () => {
    const truth = canonical(oracle.kept(KEY));
    for (const schema of [
      LegacyRowsSchema,
      z.array(AgentLaunchWithStatusSchema),
    ]) {
      const old = await subscribeAsOldDescriptor(
        { key: KEY, schema },
        { handler: oracle.runtime.notificationsWsHandler },
      );
      expect(old.kind).toBe("parsed");
      expect(canonical(old.kind === "parsed" ? old.value : null)).toBe(truth);
    }
  });
});
