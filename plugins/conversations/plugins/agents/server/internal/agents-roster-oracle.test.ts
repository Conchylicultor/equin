/**
 * `agents.roster` as an `all` collection, on the TREE ORACLE (tasks-core's
 * `server/testing`): the real declaration compiled with the real serve options
 * (`./agent-rows.ts`) against a throwaway database, through the real feed, with
 * the agents' derived `updated_at` trigger installed as a backend installs it,
 * and L2 on — so the set is a persisted alias, as it ships (`preload: "boot"`).
 *
 * The tree workload runs with agent writes (and one launch write) spliced in.
 * After every step:
 *
 * - the subscribed `{}` view, the `:rows` point view (over A, B) and the kept
 *   `{}` snapshot equal a fresh FULL load;
 * - the kept set equals `agents_v` row for row and in the declared order —
 *   the parity the five REST handlers (which still read the view) rely on;
 * - both readers' costs are exact: an insert is an entrant (one refill, one
 *   `orderOf`); a rename, a prompt cleared (the row becomes a folder), a
 *   reparent or a colour change that row's refill; a rank move the refill
 *   and one `orderOf`; a delete — a cascade included — an exit with no load;
 *   a tree or launch write nothing;
 * - nothing is ever loaded FULL after the subscribe.
 *
 * Then C39: a tab still running a bundle that subscribed the old value key
 * `agents` is refused `unknown-key`, a `skew` verdict (the Reload prompt).
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
import { asc, sql } from "drizzle-orm";
import { z } from "zod";
import { compileCreateView } from "@plugins/database/plugins/derived-views/core";
import {
  installDerivedUpdatedAt,
  registeredDerivedUpdatedAt,
} from "@plugins/database/plugins/derived-updated-at/server";
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
import { AgentSchema } from "../../core";
import { agentRows } from "../../core";
import { agentRowsServeOptions } from "./agent-rows";
import { agents } from "./views";

setDefaultTimeout(120_000);

const KEY = agentRows.key;
const ROWS_KEY = agentRows.rows.key;
/** The key the roster had as a `liveValue`, before the rename. */
const OLD_KEY = "agents";
const T3 = TREE_IDS.tasks[2];

/** F is a folder holding A and B; C sits at the root; D joins later. */
const [F, A, B, C, D] = [
  "agent-f",
  "agent-a",
  "agent-b",
  "agent-c",
  "agent-d",
] as const;

const agent = (
  id: string,
  parentId: string | null,
  prompt: string | null,
  rank: string,
  minutes: number,
) =>
  `INSERT INTO agents (id, parent_id, name, prompt, rank, created_at)
   VALUES ('${id}', ${parentId === null ? "NULL" : `'${parentId}'`}, '${id} name',
           ${prompt === null ? "NULL" : `'${prompt}'`}, '${rank}',
           '2026-01-01T00:00:00Z'::timestamptz + interval '${minutes} minutes')`;

/** The agent writes (and one launch), each spliced after the tree step it names. */
const AGENT_STEPS: Record<string, TreeStep[]> = {
  "task.insert": [
    { label: "agent.insert", statements: [agent(D, null, "do d", "a2", 4)] },
  ],
  "task.rename": [
    {
      label: "agent.rename",
      statements: [`UPDATE agents SET name = 'renamed' WHERE id = '${A}'`],
    },
  ],
  "task.reorder": [
    // B moves past C and D in the whole order: an order-field move.
    {
      label: "agent.rank-move",
      statements: [`UPDATE agents SET rank = 'a3' WHERE id = '${B}'`],
    },
  ],
  "attempt.insert": [
    {
      label: "launch.insert",
      statements: [
        `INSERT INTO agent_launches (id, agent_id, task_id) VALUES ('launch-a', '${A}', '${T3}')`,
      ],
    },
  ],
  "conversation.insert": [
    // A cleared prompt turns C into a folder: `isFolder` flips in place.
    {
      label: "agent.to-folder",
      statements: [`UPDATE agents SET prompt = NULL WHERE id = '${C}'`],
    },
  ],
  "attempt.move": [
    {
      label: "agent.reparent",
      statements: [`UPDATE agents SET parent_id = NULL WHERE id = '${A}'`],
    },
  ],
  "edge.delete": [
    {
      label: "agent.colour",
      statements: [`UPDATE agents SET icon_color = 'red' WHERE id = '${D}'`],
    },
  ],
  "task.delete": [
    {
      label: "agent.delete",
      statements: [`DELETE FROM agents WHERE id = '${D}'`],
    },
  ],
  "task.drop": [
    // The folder's delete cascades B: two exits, no load.
    {
      label: "agent.delete-folder",
      statements: [`DELETE FROM agents WHERE id = '${F}'`],
    },
  ],
};

/**
 * What each step must cost: the set's loads and `orderOf` calls, and the
 * `:rows` point reader's loads (its point set is A, B).
 */
interface StepCost {
  loads: TreeLoad[];
  orderOf: number;
  rowLoads: TreeLoad[];
}
const NOTHING: StepCost = { loads: [], orderOf: 0, rowLoads: [] };
const COST: Record<string, StepCost> = {
  "agent.insert": { ...NOTHING, loads: [{ ids: [D] }], orderOf: 1 },
  "agent.rename": {
    loads: [{ ids: [A] }],
    orderOf: 0,
    rowLoads: [{ ids: [A] }],
  },
  "agent.rank-move": {
    loads: [{ ids: [B] }],
    orderOf: 1,
    rowLoads: [{ ids: [B] }],
  },
  "agent.to-folder": { ...NOTHING, loads: [{ ids: [C] }] },
  "agent.reparent": {
    loads: [{ ids: [A] }],
    orderOf: 0,
    rowLoads: [{ ids: [A] }],
  },
  "agent.colour": { ...NOTHING, loads: [{ ids: [D] }] },
  // Exits: no load.
  "agent.delete": NOTHING,
  "agent.delete-folder": NOTHING,
};

let oracle: TreeOracle;

/** `agents_v`, as the REST handlers read it, in the set's declared order. */
async function viewRows(): Promise<string> {
  const rows = await oracle.db
    .select()
    .from(agents)
    .orderBy(asc(agents.rank), asc(agents.createdAt), asc(agents.id));
  return canonical(JSON.parse(JSON.stringify(rows)));
}

async function expectParity(label: string): Promise<void> {
  expect({ step: label, set: canonical(oracle.kept(KEY)) }).toEqual({
    step: label,
    set: await viewRows(),
  });
}

beforeAll(async () => {
  oracle = await createTreeOracle({
    prefix: "agents_roster_oracle",
    persisted: [KEY],
  });
  // The agents' derived `updated_at` trigger, as a backend installs it at
  // boot: a rename moves `updatedAt` in the same row, as in production.
  await installDerivedUpdatedAt(
    oracle.db,
    registeredDerivedUpdatedAt().filter((spec) => spec.table === "agents"),
  );
  // `agents_v`, rebuilt from source as boot does (the migration chain still
  // holds a historical CREATE VIEW).
  await oracle.db.execute(sql.raw(`DROP VIEW IF EXISTS "agents_v"`));
  await oracle.db.execute(
    sql.raw(
      compileCreateView({ name: "agents_v", view: agents, dependsOn: [] }),
    ),
  );
  oracle.registerAll(
    agentRows,
    compileCollection(agentRows, {
      ...agentRowsServeOptions,
      db: oracle.queryDb as unknown as QueryDb,
    }),
  );
  await oracle.start();
});

afterAll(async () => {
  await oracle?.stop();
});

describe("agents.roster — an `all` collection on the tree oracle", () => {
  test("every step converges to a fresh FULL load at its exact cost and equals agents_v; nothing loads FULL", async () => {
    for (const step of treeSeed()) await oracle.run(step);
    await oracle.run({
      label: "seed.agents",
      statements: [
        agent(F, null, null, "a0", 0),
        agent(A, F, "do a", "a0", 1),
        agent(B, F, "do b", "a1", 2),
        agent(C, null, "do c", "a1", 3),
      ],
    });
    await oracle.subscribe(KEY);
    const pointParams = agentRows.rows.point.encode([A, B]);
    await oracle.subscribe(ROWS_KEY, pointParams);
    await oracle.converged("seed");
    await expectParity("seed");
    const isFolder = (id: string) =>
      (oracle.kept(KEY) as { id: string; isFolder: boolean }[]).find(
        (r) => r.id === id,
      )?.isFolder;
    expect([isFolder(F), isFolder(A), isFolder(C)]).toEqual([
      true,
      false,
      false,
    ]);
    const baseline = oracle.loadsOf(KEY).length;
    const rowBaseline = oracle.loadsOf(ROWS_KEY).length;

    for (const step of withSteps(treeSteps(), AGENT_STEPS)) {
      const cost = await oracle.run(step);
      await oracle.converged(step.label);
      await expectParity(step.label);
      expect({
        step: step.label,
        loads: cost.loads[KEY] ?? [],
        orderOf: cost.orderOf[KEY] ?? 0,
        rowLoads: cost.loads[ROWS_KEY] ?? [],
      }).toEqual({ step: step.label, ...(COST[step.label] ?? NOTHING) });
      if (step.label === "agent.to-folder") expect(isFolder(C)).toBe(true);
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
    // The folder's cascade took B; A and C remain, A now at the root.
    expect(
      (oracle.kept(KEY) as { id: string }[]).map((r) => r.id).sort(),
    ).toEqual([A, C]);
    oracle.unsubscribe(ROWS_KEY, pointParams);
  });

  test("with nobody subscribed, the persisted `{}` snapshot stays current", async () => {
    oracle.unsubscribe(KEY);
    const baseline = oracle.loadsOf(KEY).length;
    await oracle.run({
      label: "idle.insert",
      statements: [agent("agent-e", null, "do e", "a0", 9)],
    });
    await oracle.run({
      label: "idle.rename",
      statements: [`UPDATE agents SET name = 'idle' WHERE id = '${C}'`],
    });
    await oracle.converged("idle");
    await expectParity("idle");
    expect(
      oracle
        .loadsOf(KEY)
        .slice(baseline)
        .some((l) => l.ids === "FULL"),
    ).toBe(false);
  });
});

describe("C39 — a tab on the old `agents` value", () => {
  test("is refused `unknown-key`, a `skew` verdict", async () => {
    const old = await subscribeAsOldDescriptor(
      { key: OLD_KEY, schema: z.array(AgentSchema) },
      { handler: oracle.runtime.notificationsWsHandler },
    );
    expect(old).toEqual({
      kind: "refused",
      reason: "unknown-key",
      verdict: "skew",
    });
  });
});
