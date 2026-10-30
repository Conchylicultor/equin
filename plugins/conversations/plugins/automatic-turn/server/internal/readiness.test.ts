/**
 * The automatic-turn readiness against the REAL worktree DB, inside
 * rolled-back transactions (`worktreeDbScenario`), with the PendingTurn
 * collection passed in: held while busy, while waiting on the user, while
 * another plugin's turn is pending — never by the sender's own — else ready.
 *
 * Run: `./equin test plugins/conversations/plugins/automatic-turn`.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  worktreeDbScenario,
  type DbExecutor,
} from "@plugins/database/plugins/db-test-fixture/plugins/worktree-db/server/testing";
import { FALLBACK_MODEL } from "@plugins/conversations/plugins/model-provider/core";
import { readinessOn } from "./readiness";
import type { PendingTurnEntry } from "./registry";

let seq = 0;
const uid = (k: string) => `at${k}-${Date.now()}-${++seq}`;

async function conversation(
  tx: DbExecutor,
  status: string,
  waitingFor: string | null = null,
): Promise<string> {
  const taskId = uid("task");
  const attemptId = uid("att");
  const id = uid("conv");
  await tx.execute(sql`
    INSERT INTO tasks (id, title, title_auto, rank, folder_id, created_at, updated_at, mandate_ref)
    VALUES (${taskId}, 'T', true, ${taskId}, NULL, now(), now(), 'interactive')
  `);
  await tx.execute(sql`
    INSERT INTO attempts (id, task_id, worktree_path)
    VALUES (${attemptId}, ${taskId}, ${`/tmp/${attemptId}`})
  `);
  await tx.execute(sql`
    INSERT INTO conversations (id, attempt_id, status, waiting_for, runtime, model, spawned_by)
    VALUES (${id}, ${attemptId}, ${status}, ${waitingFor}, 'sdk', ${FALLBACK_MODEL}, 'test')
  `);
  return id;
}

/** A PendingTurn contributor whose pending set the test controls. */
function pendingEntry(id: string, pendingFor: Set<string>): PendingTurnEntry {
  return {
    id,
    pending: async (conversationId) => pendingFor.has(conversationId),
  };
}

describe("automatic-turn readiness", () => {
  test("busy, waiting on the user, or not found: held / not-found", async () => {
    const got = await worktreeDbScenario(async (tx) => {
      const working = await conversation(tx, "working");
      const starting = await conversation(tx, "starting");
      const asking = await conversation(tx, "waiting", "question");
      return {
        working: await readinessOn(tx, working, [], undefined),
        starting: await readinessOn(tx, starting, [], undefined),
        asking: await readinessOn(tx, asking, [], undefined),
        missing: await readinessOn(tx, uid("nope"), [], undefined),
      };
    });
    expect(got.working).toEqual({ kind: "held", reason: "busy" });
    expect(got.starting).toEqual({ kind: "held", reason: "busy" });
    expect(got.asking).toEqual({ kind: "held", reason: "waiting-for" });
    expect(got.missing).toEqual({ kind: "not-found" });
  });

  test("another plugin's pending turn holds every other sender, not its own", async () => {
    const pendingFor = new Set<string>();
    const mine = pendingEntry("mine", pendingFor);
    const quiet = pendingEntry("quiet", new Set());
    const got = await worktreeDbScenario(async (tx) => {
      const idle = await conversation(tx, "waiting");
      const entries = [quiet, mine];
      const before = await readinessOn(tx, idle, entries, undefined);
      pendingFor.add(idle);
      const other = await readinessOn(tx, idle, entries, undefined);
      const own = await readinessOn(tx, idle, entries, mine);
      pendingFor.delete(idle);
      const after = await readinessOn(tx, idle, entries, undefined);
      return { before, other, own, after };
    });
    expect(got.before).toEqual({ kind: "ready" });
    expect(got.other).toEqual({
      kind: "held",
      reason: "pending-turn",
      by: "mine",
    });
    expect(got.own).toEqual({ kind: "ready" });
    expect(got.after).toEqual({ kind: "ready" });
  });
});
