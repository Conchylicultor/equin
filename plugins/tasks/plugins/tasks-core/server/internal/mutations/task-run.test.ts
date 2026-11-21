/**
 * Which conversation runs its task, against the REAL worktree DB inside a
 * rolled-back transaction (`worktreeDbScenario`): a side chat takes over
 * running its task once the conversation it was opened beside closes — the
 * newest open, non-system one — and nothing moves while that one is open
 * (task-1795221280-0armjx: a user carried a supervisor task on in a side chat,
 * closed the original, and the side chat stayed `interactive`).
 *
 * Run: `./equin test plugins/tasks/plugins/tasks-core`.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { worktreeDbScenario } from "@plugins/database/plugins/db-test-fixture/plugins/worktree-db/server/testing";
import { FALLBACK_MODEL } from "@plugins/conversations/plugins/model-provider/core";
import type { DbExecutor } from "../status-batch";
import { attemptHasOpenRunner, handOverTaskRuns } from "./task-run";

const T = "task-run-test-t";
const A = "att-run-test-a";

async function seed(
  tx: DbExecutor,
  convs: {
    id: string;
    mandateRef: string | null;
    status: string;
    kind?: string;
    at: string;
  }[],
): Promise<void> {
  await tx.execute(
    sql`INSERT INTO tasks (id, cluster_id, title, title_auto, rank, mandate_ref, author_kind)
        VALUES (${T}, ${T}, 't', false, 'a0', 'interactive', 'human')`,
  );
  await tx.execute(
    sql`INSERT INTO attempts (id, task_id, worktree_path) VALUES (${A}, ${T}, '/tmp/x')`,
  );
  for (const c of convs)
    await tx.execute(
      sql`INSERT INTO conversations (id, attempt_id, title, status, model, launch_cause, kind, mandate_ref, created_at, ended_at)
          VALUES (${c.id}, ${A}, 'c', ${c.status}, ${FALLBACK_MODEL}, 'direct', ${c.kind ?? "user"}, ${c.mandateRef},
                  ${c.at}::timestamptz, ${c.status === "done" ? sql`now()` : null})`,
    );
}

async function mandateRefs(
  tx: DbExecutor,
): Promise<Record<string, string | null>> {
  const rows = await tx.execute<{ id: string; mandate_ref: string | null }>(
    sql`SELECT id, mandate_ref FROM conversations WHERE attempt_id = ${A}`,
  );
  return Object.fromEntries(rows.rows.map((r) => [r.id, r.mandate_ref]));
}

describe("handOverTaskRuns", () => {
  test("the runner closed: the newest open side chat (not a system one) runs the task", async () => {
    const out = await worktreeDbScenario(async (tx) => {
      await seed(tx, [
        { id: "run", mandateRef: null, status: "done", at: "2026-01-01" },
        {
          id: "old",
          mandateRef: "interactive",
          status: "waiting",
          at: "2026-01-02",
        },
        {
          id: "new",
          mandateRef: "interactive",
          status: "waiting",
          at: "2026-01-03",
        },
        {
          id: "sys",
          mandateRef: "interactive",
          status: "waiting",
          kind: "system",
          at: "2026-01-04",
        },
        {
          id: "gone",
          mandateRef: "interactive",
          status: "done",
          at: "2026-01-05",
        },
      ]);
      const handed = await handOverTaskRuns({ ofConversation: "run" }, tx);
      return {
        handed,
        refs: await mandateRefs(tx),
        runner: await attemptHasOpenRunner(A, tx),
      };
    });
    expect(out.handed).toEqual(["new"]);
    expect(out.refs).toEqual({
      run: null,
      old: "interactive",
      new: null,
      sys: "interactive",
      gone: "interactive",
    });
    expect(out.runner).toBe(true);
  });

  test("the runner still open: a side chat stays a side chat", async () => {
    const out = await worktreeDbScenario(async (tx) => {
      await seed(tx, [
        { id: "run", mandateRef: null, status: "waiting", at: "2026-01-01" },
        {
          id: "side",
          mandateRef: "interactive",
          status: "waiting",
          at: "2026-01-02",
        },
      ]);
      return {
        handed: await handOverTaskRuns({ ofConversation: "side" }, tx),
        // Other attempts of the forked DB may be handed over too: only this
        // attempt's answer is asserted.
        all: await handOverTaskRuns({ createdAfter: null }, tx),
        runner: await attemptHasOpenRunner(A, tx),
      };
    });
    expect(out.handed).toEqual([]);
    expect(out.all).not.toContain("side");
    expect(out.runner).toBe(true);
  });

  test("the boot backstop hands over an attempt left with nobody running it", async () => {
    const out = await worktreeDbScenario(async (tx) => {
      await seed(tx, [
        { id: "run", mandateRef: null, status: "done", at: "2026-01-01" },
        {
          id: "side",
          mandateRef: "interactive",
          status: "waiting",
          at: "2026-01-02",
        },
      ]);
      const before = await attemptHasOpenRunner(A, tx);
      const handed = await handOverTaskRuns({ createdAfter: null }, tx);
      return { before, handed, refs: await mandateRefs(tx) };
    });
    expect(out.before).toBe(false);
    expect(out.handed).toContain("side");
    expect(out.refs.side).toBeNull();
  });
});

test("the boot backstop leaves a fork's copies of another database's rows alone", async () => {
  const handed = await worktreeDbScenario(async (tx) => {
    await seed(tx, [
      { id: "run", mandateRef: null, status: "done", at: "2026-01-01" },
      {
        id: "side",
        mandateRef: "interactive",
        status: "waiting",
        at: "2026-01-02",
      },
    ]);
    // Forked after both were created: they are the source database's rows.
    return handOverTaskRuns({ createdAfter: new Date("2026-02-01") }, tx);
  });
  expect(handed).not.toContain("side");
});
