/**
 * The stop backstop against the REAL worktree DB, inside rolled-back
 * transactions (`worktreeDbScenario`): a stop the gates would block gets ONE
 * reminder turn, a retry re-sends the same turn, a second stop still owing is
 * flagged, a stopped agent with no process is flagged at once, and an allowed
 * stop or a busy agent is left alone.
 *
 * Needs this worktree's DB as `./equin build` leaves it (the
 * stop_gate_reminders migration applied).
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  worktreeDbScenario,
  type DbExecutor,
} from "@plugins/database/plugins/db-test-fixture/plugins/worktree-db/server/testing";
import { FALLBACK_MODEL } from "@plugins/conversations/plugins/model-provider/core";
import type { ConversationStatus } from "@plugins/tasks/plugins/tasks-core/core";
import type { StopGateResponse } from "../../core";
import {
  backstopStop,
  reminderText,
  type BackstopPorts,
  type StoppedConversation,
} from "./backstop";

let seq = 0;
const uid = (k: string) => `sgb${k}-${Date.now()}-${++seq}`;

async function conversation(tx: DbExecutor): Promise<string> {
  const taskId = uid("task");
  const attemptId = uid("att");
  const id = uid("conv");
  await tx.execute(sql`
    INSERT INTO tasks (id, cluster_id, title, title_auto, rank, folder_id, created_at, updated_at, mandate_ref, author_kind)
    VALUES (${taskId}, ${taskId}, 'T', true, ${taskId}, NULL, now(), now(), 'interactive', 'human')
  `);
  await tx.execute(sql`
    INSERT INTO attempts (id, task_id, worktree_path)
    VALUES (${attemptId}, ${taskId}, ${`/tmp/${attemptId}`})
  `);
  await tx.execute(sql`
    INSERT INTO conversations (id, attempt_id, status, runtime, model, spawned_by)
    VALUES (${id}, ${attemptId}, 'waiting', 'sdk', ${FALLBACK_MODEL}, 'test')
  `);
  return id;
}

const BLOCK: StopGateResponse = { decision: "block", reason: "report first" };

/** A fake agent and gate set: the conversation's status is the test's to
 * move; a set of seen turn ids models the ledger's no-op on a known id. */
function fake(state: {
  status: ConversationStatus;
  statusSince: Date;
  decision: StopGateResponse;
}) {
  const turns: string[] = [];
  const flags: string[] = [];
  const seen = new Set<string>();
  const ports: BackstopPorts = {
    conversation: async (id): Promise<StoppedConversation> => ({
      id,
      status: state.status,
      statusSince: state.statusSince,
      taskId: "task",
      taskTitle: "T",
    }),
    decide: async () => state.decision,
    readiness: async () => ({ kind: "ready" }),
    submit: async (_id, turn) => {
      if (seen.has(turn.id)) return;
      seen.add(turn.id);
      turns.push(turn.text);
    },
    flag: async (_c, reason) => {
      flags.push(reason);
    },
  };
  return { ports, turns, flags, state };
}

describe("stop backstop", () => {
  test("one reminder, a retry re-sends it, a second stop is flagged", async () => {
    const agent = fake({
      status: "waiting",
      statusSince: new Date(Date.now() - 60_000),
      decision: BLOCK,
    });
    const got = await worktreeDbScenario(async (tx) => {
      const id = await conversation(tx);
      const first = await backstopStop(id, agent.ports, tx);
      // The job retried, the agent has not run since: the same turn again.
      const retry = await backstopStop(id, agent.ports, tx);
      // The agent ran and stopped again, still owing.
      agent.state.statusSince = new Date(Date.now() + 60_000);
      const again = await backstopStop(id, agent.ports, tx);
      return { first, retry, again };
    });
    expect(got.first.kind).toBe("reminded");
    expect(got.retry.kind).toBe("reminded");
    expect(got.again.kind).toBe("flagged");
    expect(agent.turns).toEqual([reminderText("report first")]);
    expect(agent.flags).toEqual(["report first"]);
  });

  test("a stopped agent with no process is flagged, never typed into", async () => {
    const agent = fake({
      status: "gone",
      statusSince: new Date(),
      decision: BLOCK,
    });
    const out = await worktreeDbScenario(async (tx) =>
      backstopStop(await conversation(tx), agent.ports, tx),
    );
    expect(out.kind).toBe("flagged");
    expect(agent.turns).toEqual([]);
  });

  test("an allowed stop, or a busy agent, is left alone", async () => {
    const allowed = fake({
      status: "waiting",
      statusSince: new Date(),
      decision: { decision: "allow", reason: null },
    });
    const busy = fake({
      status: "working",
      statusSince: new Date(),
      decision: BLOCK,
    });
    const got = await worktreeDbScenario(async (tx) => {
      const id = await conversation(tx);
      return {
        allowed: await backstopStop(id, allowed.ports, tx),
        busy: await backstopStop(id, busy.ports, tx),
      };
    });
    expect(got).toEqual({ allowed: { kind: "none" }, busy: { kind: "none" } });
    expect([...allowed.turns, ...busy.turns, ...busy.flags]).toEqual([]);
  });
});
