/**
 * `conversation-sessions` — the session chain as a FOLLOW TARGET
 * (research/2026-10-24-global-live-narrowed-reads.md §4) — on the TREE ORACLE
 * (tasks-core's `server/testing`): the real declaration compiled with the
 * shipped serve options (`./resources.ts`) against a throwaway database,
 * through the real feed, every subscribed scope converged on a fresh FULL
 * load after every step.
 *
 * A follow COPIES its collection's routes, gate and tuple match included, so
 * what a write costs a scope here is what it costs a follower of that scope:
 * a session recorded on one conversation refills that conversation's chain
 * alone, and reaches no follower of another. The tree script is not run (the
 * chain's table is outside the tree): the workload is the chain's own appends
 * — the table is append-only, so an insert is the only write it ever sees.
 *
 * Requires a running Postgres cluster (started by ./equin build).
 * Run: `./equin test plugins/conversations/plugins/session-chain`.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import type { QueryDb } from "@plugins/infra/plugins/query-resource/server";
import { compileCollection } from "@plugins/network/plugins/live/server/testing";
import {
  createTreeOracle,
  type TreeLoad,
  type TreeOracle,
  type TreeStep,
} from "@plugins/tasks/plugins/tasks-core/server/testing";
import { conversationSessions } from "../../core";
import { conversationSessionsServeOptions } from "./resources";

setDefaultTimeout(120_000);

const KEY = conversationSessions.key;
const [X, Y, Z] = ["conv-x", "conv-y", "conv-z"] as const;

const append = (id: string, conversationId: string, at: string) =>
  `INSERT INTO conversation_sessions (id, conversation_id, claude_session_id, seen_at)
   VALUES ('${id}', '${conversationId}', '${id}-claude', '${at}')`;

/** The chain's writes, each with what it costs the X and Y scopes. */
const STEPS: readonly (TreeStep & { x: TreeLoad[]; y: TreeLoad[] })[] = [
  // An entrant of X's chain only.
  {
    label: "x.append",
    statements: [append("sess-x2", X, "2026-01-02T00:00:00Z")],
    x: [{ ids: ["sess-x2"] }],
    y: [],
  },
  // A chain nobody follows: no scope loads.
  {
    label: "z.append",
    statements: [append("sess-z1", Z, "2026-01-01T00:00:00Z")],
    x: [],
    y: [],
  },
  {
    label: "y.append",
    statements: [append("sess-y2", Y, "2026-01-03T00:00:00Z")],
    x: [],
    y: [{ ids: ["sess-y2"] }],
  },
];

let oracle: TreeOracle;

beforeAll(async () => {
  oracle = await createTreeOracle({
    prefix: "conversation_sessions_oracle",
    persisted: [],
  });
  oracle.registerAll(
    conversationSessions,
    compileCollection(conversationSessions, {
      ...conversationSessionsServeOptions,
      db: oracle.queryDb as unknown as QueryDb,
    }),
  );
  await oracle.start();
});

afterAll(async () => {
  await oracle?.stop();
});

describe("conversation-sessions — a scoped chain over the real feed", () => {
  test("an append refills its own conversation's chain alone", async () => {
    await oracle.run({
      label: "seed",
      statements: [
        append("sess-x1", X, "2026-01-01T00:00:00Z"),
        append("sess-y1", Y, "2026-01-01T00:00:00Z"),
      ],
    });
    await oracle.subscribe(KEY, { conversationId: X });
    await oracle.subscribe(KEY, { conversationId: Y });
    await oracle.converged("seed");
    const from = oracle.loadsOf(KEY).length;
    const seen: unknown[] = [];
    const want: unknown[] = [];
    for (const step of STEPS) {
      const at = oracle.loadsOf(KEY).length;
      await oracle.run(step);
      await oracle.converged(step.label);
      // Loads are counted per key: the two scopes' are told apart by the ids
      // each refill read.
      const sorted = (l: readonly TreeLoad[]) =>
        l.map((x) => JSON.stringify(x.ids)).sort();
      seen.push({
        step: step.label,
        loads: sorted(oracle.loadsOf(KEY).slice(at)),
      });
      want.push({ step: step.label, loads: sorted([...step.x, ...step.y]) });
    }
    expect(seen).toEqual(want);
    expect(
      oracle
        .loadsOf(KEY)
        .slice(from)
        .some((l) => l.ids === "FULL"),
    ).toBe(false);
    // Oldest → newest, per conversation.
    expect(oracle.view(KEY, { conversationId: X })).toEqual([
      expect.objectContaining({ id: "sess-x1", conversationId: X }),
      expect.objectContaining({ id: "sess-x2", conversationId: X }),
    ]);
    expect(oracle.view(KEY, { conversationId: Y })).toEqual([
      expect.objectContaining({ id: "sess-y1" }),
      expect.objectContaining({ id: "sess-y2" }),
    ]);
  });
});
