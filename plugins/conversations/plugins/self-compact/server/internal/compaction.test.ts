/**
 * The compaction policy against the REAL worktree DB, inside rolled-back
 * transactions (`worktreeDbScenario`): a request waits while the agent cannot
 * take an automatic turn, is then sent as `/compact` + the continuation, is
 * idempotent across a retry, and a second request replaces the first; while
 * it waits it is a pending turn (other automatic senders hold), and not once
 * it went out.
 *
 * Needs this worktree's DB as `./equin build` leaves it (the
 * conversation_compactions migration applied).
 *
 * Run: `./equin test plugins/conversations/plugins/self-compact`.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  worktreeDbScenario,
  type DbExecutor,
} from "@plugins/database/plugins/db-test-fixture/plugins/worktree-db/server/testing";
import { FALLBACK_MODEL } from "@plugins/conversations/plugins/model-provider/core";
import type { TurnReadiness } from "@plugins/conversations/plugins/automatic-turn/server";
import {
  compactionTurn,
  continuationText,
  hasPendingCompaction,
  requestCompaction,
  sendCompaction,
  type CompactionPorts,
} from "./compaction";

let seq = 0;
const uid = (k: string) => `sc${k}-${Date.now()}-${++seq}`;

async function conversation(tx: DbExecutor): Promise<string> {
  const taskId = uid("task");
  const attemptId = uid("att");
  const id = uid("conv");
  await tx.execute(sql`
    INSERT INTO tasks (id, title, title_auto, rank, folder_id, created_at, updated_at, mandate)
    VALUES (${taskId}, 'T', true, ${taskId}, NULL, now(), now(), '{}'::jsonb)
  `);
  await tx.execute(sql`
    INSERT INTO attempts (id, task_id, worktree_path)
    VALUES (${attemptId}, ${taskId}, ${`/tmp/${attemptId}`})
  `);
  await tx.execute(sql`
    INSERT INTO conversations (id, attempt_id, status, runtime, model, spawned_by)
    VALUES (${id}, ${attemptId}, 'working', 'sdk', ${FALLBACK_MODEL}, 'test')
  `);
  return id;
}

/** A fake agent recording every submitted turn; a set of seen ids models
 * the ledger's no-op on a known turn id. */
function fakeAgent(state: { readiness: TurnReadiness }) {
  const turns: { kind: string; text: string }[] = [];
  const seen = new Set<string>();
  const ports: CompactionPorts = {
    readiness: async () => state.readiness,
    submit: async (_id, turn) => {
      if (seen.has(turn.id)) return;
      seen.add(turn.id);
      turns.push({ kind: turn.kind, text: turn.text });
    },
  };
  return { ports, turns, state };
}

describe("self-compact", () => {
  test("held while busy or waiting on the user, then sent once, in order", async () => {
    const agent = fakeAgent({ readiness: { kind: "held", reason: "busy" } });
    const got = await worktreeDbScenario(async (tx) => {
      const id = await conversation(tx);
      await requestCompaction(id, { keep: "old", next: "old next" }, tx);
      await requestCompaction(
        id,
        { keep: "the plan", next: "file wave 2" },
        tx,
      );
      const busy = await sendCompaction(id, agent.ports, tx);
      agent.state.readiness = { kind: "held", reason: "waiting-for" };
      const waiting = await sendCompaction(id, agent.ports, tx);
      const pendingBefore = await hasPendingCompaction(id, tx);
      const turnPendingBefore = await compactionTurn.pending(id, tx);
      agent.state.readiness = { kind: "ready" };
      const sent = await sendCompaction(id, agent.ports, tx);
      const again = await sendCompaction(id, agent.ports, tx);
      const pendingAfter = await hasPendingCompaction(id, tx);
      const turnPendingAfter = await compactionTurn.pending(id, tx);
      return {
        busy,
        waiting,
        sent,
        again,
        pendingBefore,
        pendingAfter,
        turnPendingBefore,
        turnPendingAfter,
      };
    });
    expect(got.busy).toEqual({ kind: "held", reason: "busy" });
    expect(got.waiting).toEqual({ kind: "held", reason: "waiting-for" });
    expect(got.pendingBefore).toBe(true);
    expect(got.sent).toEqual({ kind: "sent" });
    expect(got.again).toEqual({ kind: "none" });
    expect(got.pendingAfter).toBe(false);
    // Other automatic senders hold while it waits, and no longer once sent.
    expect(got.turnPendingBefore).toBe(true);
    expect(got.turnPendingAfter).toBe(false);
    // The second request replaced the first; the compaction comes first.
    expect(agent.turns).toEqual([
      { kind: "compact", text: "/compact the plan" },
      { kind: "event", text: continuationText("file wave 2") },
    ]);
  });
});
