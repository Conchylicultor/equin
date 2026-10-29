/**
 * The FOLLOW TARGETS' gates (research/2026-10-24-global-live-narrowed-reads.md
 * §4) on the tree oracle (`../testing/tree-oracle.ts`): the real migration
 * chain and derived layer, the real feed, each collection compiled with its
 * shipped serve options (`./follow-targets.ts`, `attemptWorkspaces` over
 * `_attempts`), every subscribed tuple converged on a fresh FULL load after
 * every step.
 *
 * A follow COPIES its collection's routes, gate and tuple match included
 * (query-resource's `followRead`), so what a write costs the collection's
 * tuple here is what it costs a follower of that tuple: a load here is a
 * recompute there, nothing here is nothing there. Pinned per step, for every
 * target at once (a mismatch shows the whole script):
 *
 * - the poller's `waiting_for` / `last_viewed_at` write (a `viewed`), a
 *   conversation's retitle and status flips reach no conversation target but
 *   the one carrying that column (`conversationRuntimes` reads `status`);
 * - an insert reaches its own scope only, a move both scopes, a delete its
 *   scope with no load (an exit);
 * - an attempt's task move or `updated_at` reaches nothing; its
 *   `worktree_path` reaches the attempt's row and, through the attempt join's
 *   reverse route, the conversations of that attempt.
 *
 * Then: `conversationWorkspaces` decodes the joined `jsonb` workspace through
 * the field's schema (an undeclared key is stripped), and the C39 check on
 * `attempt-workspaces:rows`, whose row grew `worktreePath` / `createdAt`: a
 * tab on a bundle that read `{ id, workspace }` still parses it.
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
import { z } from "zod";
import type { QueryDb } from "@plugins/infra/plugins/query-resource/server";
import {
  compileCollection,
  subscribeAsOldDescriptor,
} from "@plugins/network/plugins/live/server/testing";
import {
  attemptConversationIds,
  attemptDeliveries,
  attemptPushIds,
  attemptWorkspaces,
  conversationRuntimes,
  conversationSessionTails,
  conversationWorkspaces,
} from "../../core";
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
import { _attempts } from "./tables";
import {
  attemptConversationIdsServeOptions,
  attemptDeliveriesServeOptions,
  attemptPushIdsServeOptions,
  conversationRuntimesServeOptions,
  conversationSessionTailsServeOptions,
  conversationWorkspacesServeOptions,
} from "./follow-targets";

setDefaultTimeout(120_000);

const [A1, A2, A3] = TREE_IDS.attempts;
const [C1, C2, C3] = TREE_IDS.conversations;

const ATTEMPT_WS = attemptWorkspaces.rows.key;
const CONV_IDS = attemptConversationIds.key;
const PUSH_IDS = attemptPushIds.key;
const DELIVERIES = attemptDeliveries.rows.key;
const CONV_WS = conversationWorkspaces.rows.key;
const TAILS = conversationSessionTails.rows.key;
const RUNTIMES = conversationRuntimes.rows.key;

/** Every subscribed tuple, by a short name. */
const TUPLES = {
  attemptWs: {
    key: ATTEMPT_WS,
    params: attemptWorkspaces.rows.point.encode([A2, A3]),
  },
  convIdsA2: { key: CONV_IDS, params: { attemptId: A2 } },
  convIdsA3: { key: CONV_IDS, params: { attemptId: A3 } },
  pushIdsA1: { key: PUSH_IDS, params: { attemptId: A1 } },
  pushIdsA3: { key: PUSH_IDS, params: { attemptId: A3 } },
  deliveries: {
    key: DELIVERIES,
    params: attemptDeliveries.rows.point.encode([A3]),
  },
  convWs: {
    key: CONV_WS,
    params: conversationWorkspaces.rows.point.encode([C2, C3]),
  },
  tails: {
    key: TAILS,
    params: conversationSessionTails.rows.point.encode([C3]),
  },
  runtimes: {
    key: RUNTIMES,
    params: conversationRuntimes.rows.point.encode([C1, C3]),
  },
} as const;
type Tuple = keyof typeof TUPLES;

/** The suite's own writes, each spliced right after the tree step it names. */
const OWN_STEPS: Record<string, TreeStep[]> = {
  "conversation.poller": [
    {
      label: "conversation.retitle",
      statements: [
        `UPDATE conversations SET title = 'renamed' WHERE id = '${C3}'`,
      ],
    },
    {
      label: "conversation.session",
      statements: [
        `UPDATE conversations SET claude_session_id = 'sess-1' WHERE id = '${C3}'`,
      ],
    },
  ],
  "push.insert": [
    {
      label: "delivery.insert",
      statements: [
        `INSERT INTO attempt_deliveries (attempt_id, conversation_id, summary)
         VALUES ('${A3}', '${C3}', 'delivered')`,
      ],
    },
    // The delivery's summary is not carried: no follower re-reads it.
    {
      label: "delivery.summary",
      statements: [
        `UPDATE attempt_deliveries SET summary = 'again' WHERE attempt_id = '${A3}'`,
      ],
    },
    {
      label: "attempt.worktree",
      statements: [
        `UPDATE attempts SET worktree_path = '/tmp/${A3}-moved' WHERE id = '${A3}'`,
      ],
    },
    // C2 re-pointed A2 → A3: both scopes, and its own workspace row.
    {
      label: "conversation.move",
      statements: [
        `UPDATE conversations SET attempt_id = '${A3}' WHERE id = '${C2}'`,
      ],
    },
  ],
};

/** What each step costs each tuple; a step or tuple not listed loads nothing. */
const ids = (...xs: string[]) => [{ ids: [...xs].sort() }];
const COST: Record<string, Partial<Record<Tuple, TreeLoad[]>>> = {
  // An entrant: its row (the point read holds A3 before the row exists).
  "attempt.insert": { attemptWs: ids(A3) },
  // An entrant of A3's scope; the by-id reads holding C3 find it.
  "conversation.insert": {
    convIdsA3: ids(C3),
    convWs: ids(C3),
    tails: ids(C3),
    runtimes: ids(C3),
  },
  // `status` is carried by `conversationRuntimes` alone.
  "conversation.done": { runtimes: ids(C1) },
  // The `viewed` write: no target carries `waiting_for` / `last_viewed_at`.
  "conversation.poller": {},
  "conversation.retitle": {},
  "conversation.session": { tails: ids(C3) },
  "push.insert": { pushIdsA3: ids("tree-p2") },
  "delivery.insert": { deliveries: ids(A3) },
  "delivery.summary": {},
  // The attempt's row, and its conversations through the join's reverse route.
  "attempt.worktree": { attemptWs: ids(A3), convWs: ids(C3) },
  "conversation.move": {
    convIdsA2: ids(C2),
    convIdsA3: ids(C2),
    convWs: ids(C2),
  },
  // An exit: C1, P1 and A1 cascade away with no load.
  "attempt.delete": {},
};

let oracle: TreeOracle;

beforeAll(async () => {
  oracle = await createTreeOracle({
    prefix: "follow_targets_oracle",
    persisted: [],
  });
  const db = oracle.queryDb as unknown as QueryDb;
  oracle.registerLookup(
    attemptWorkspaces,
    compileCollection(attemptWorkspaces, { from: _attempts, db }),
  );
  oracle.registerAll(
    attemptConversationIds,
    compileCollection(attemptConversationIds, {
      ...attemptConversationIdsServeOptions,
      db,
    }),
  );
  oracle.registerAll(
    attemptPushIds,
    compileCollection(attemptPushIds, { ...attemptPushIdsServeOptions, db }),
  );
  oracle.registerLookup(
    attemptDeliveries,
    compileCollection(attemptDeliveries, {
      ...attemptDeliveriesServeOptions,
      db,
    }),
  );
  oracle.registerLookup(
    conversationWorkspaces,
    compileCollection(conversationWorkspaces, {
      ...conversationWorkspacesServeOptions,
      db,
    }),
  );
  oracle.registerLookup(
    conversationSessionTails,
    compileCollection(conversationSessionTails, {
      ...conversationSessionTailsServeOptions,
      db,
    }),
  );
  oracle.registerLookup(
    conversationRuntimes,
    compileCollection(conversationRuntimes, {
      ...conversationRuntimesServeOptions,
      db,
    }),
  );
  await oracle.start();
});

afterAll(async () => {
  await oracle?.stop();
});

describe("follow targets — each one's gate over the real feed", () => {
  test("every step converges, at exactly the cost its gate allows", async () => {
    for (const step of treeSeed()) await oracle.run(step);
    for (const t of Object.values(TUPLES)) {
      await oracle.subscribe(t.key, t.params);
    }
    await oracle.converged("seed");
    // Each key's subscribe loads are its FULL reads; every load after them is
    // a step's.
    const subscribed = new Map(
      Object.values(TUPLES).map((t) => [t.key, oracle.loadsOf(t.key).length]),
    );
    const steps = withSteps(treeSteps(), OWN_STEPS);
    for (const label of Object.keys(COST)) {
      expect(steps.some((s) => s.label === label)).toBe(true);
    }
    const seen: unknown[] = [];
    const want: unknown[] = [];
    for (const step of steps) {
      const at = new Map(
        Object.values(TUPLES).map((t) => [t.key, oracle.loadsOf(t.key).length]),
      );
      await oracle.run(step);
      await oracle.converged(step.label);
      // Loads are counted per key: a key's tuples are told apart by the ids
      // each refill read.
      const sorted = (l: readonly TreeLoad[]) =>
        l.map((x) => JSON.stringify(x.ids)).sort();
      const wanted = new Map<string, TreeLoad[]>();
      for (const [name, t] of Object.entries(TUPLES)) {
        const l = COST[step.label]?.[name as Tuple] ?? [];
        wanted.set(t.key, [...(wanted.get(t.key) ?? []), ...l]);
      }
      seen.push({
        step: step.label,
        ...Object.fromEntries(
          [...at].map(([key, from]) => [
            key,
            sorted(oracle.loadsOf(key).slice(from)),
          ]),
        ),
      });
      want.push({
        step: step.label,
        ...Object.fromEntries([...wanted].map(([k, l]) => [k, sorted(l)])),
      });
    }
    expect(seen).toEqual(want);
    // No step reached any target as a FULL reload.
    for (const [key, from] of subscribed) {
      expect(
        oracle
          .loadsOf(key)
          .slice(from)
          .some((l) => l.ids === "FULL"),
      ).toBe(false);
    }
    // What the scopes hold at the end: C2 moved into A3 beside C3; A1's push
    // went with A1.
    expect(oracle.view(CONV_IDS, TUPLES.convIdsA3.params)).toEqual([
      expect.objectContaining({ id: C2 }),
      expect.objectContaining({ id: C3 }),
    ]);
    expect(oracle.view(CONV_IDS, TUPLES.convIdsA2.params)).toEqual([]);
    expect(oracle.view(PUSH_IDS, TUPLES.pushIdsA1.params)).toEqual([]);
  });

  test("conversationWorkspaces decodes the joined jsonb workspace through its schema", async () => {
    await oracle.run({
      label: "attempt.workspace",
      statements: [
        `UPDATE attempts SET workspace = '{"kind":"worktree","stray":1}'::jsonb WHERE id = '${A3}'`,
      ],
    });
    await oracle.converged("attempt.workspace");
    const rows = oracle.view(CONV_WS, TUPLES.convWs.params) as {
      id: string;
      attemptId: string;
      worktreePath: string;
      workspace: unknown;
    }[];
    expect([...rows].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      {
        id: C2,
        attemptId: A3,
        worktreePath: `/tmp/${A3}-moved`,
        workspace: { kind: "worktree" },
      },
      {
        id: C3,
        attemptId: A3,
        worktreePath: `/tmp/${A3}-moved`,
        workspace: { kind: "worktree" },
      },
    ]);
  });

  test("C39: a tab on a bundle whose `attempt-workspaces` row was `{ id, workspace }` still parses the grown row", async () => {
    // What the old bundle parsed its point payload with, restated as a LITERAL
    // (never derived from the live schema). Not `strict`: an added key (the
    // row's `worktreePath` / `createdAt`) is dropped, only a removed, renamed
    // or retyped one fails.
    const LegacyRows = z.array(
      z.object({
        id: z.string(),
        workspace: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("worktree") }),
          z.object({
            kind: z.literal("scratch"),
            profile: z.string().min(1),
            input: z.unknown(),
          }),
        ]),
      }),
    );
    const params = attemptWorkspaces.rows.point.encode([A2]);
    const old = await subscribeAsOldDescriptor(
      { key: ATTEMPT_WS, schema: LegacyRows },
      { params, handler: oracle.runtime.notificationsWsHandler },
    );
    expect(old.kind).toBe("parsed");
    expect(canonical(old.kind === "parsed" ? old.value : null)).toBe(
      canonical([{ id: A2, workspace: { kind: "worktree" } }]),
    );
    // And the grown row is what the new bundle reads.
    expect(old.kind === "parsed" ? old.raw : null).toEqual([
      expect.objectContaining({
        id: A2,
        worktreePath: `/tmp/${A2}`,
        createdAt: expect.any(String),
      }),
    ]);
  });
});
