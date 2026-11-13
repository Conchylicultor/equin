/**
 * A turn sent to a STOPPED conversation (`done` / `gone`: no agent) — through
 * the real `submitTurn`, over a throwaway database standing in for the app's
 * `db`.
 *
 * The bug this pins (2026-11-08): `submitTurn` only brought back a hibernated
 * conversation, so a turn to a `done` one went straight to the runtime's send,
 * which threw "no SDK agent is running" — a 500 to the user who typed it, and
 * a `failed` ledger row whose error said nothing about why. Now the turn's kind
 * decides (`resumesStopped`): a user's turn resumes the conversation, and an
 * automatic one is refused as `stopped` with no row written.
 *
 * The rows here have no Claude session, so the resume a user's turn asks for
 * is refused by its preflight before any workspace, runtime or Claude Code is
 * touched: that refusal (a `ResumeBlockedError`, the endpoint's 409) is how
 * the test sees the resume was attempted. A resume that runs is covered live
 * (the task's verification), not here.
 *
 * Requires the running embedded cluster — `./equin build` first.
 */

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  DatabaseDriver,
  type DatabaseDriverImpl,
  type Db,
} from "@plugins/database/server";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { withHostServices } from "@plugins/framework/plugins/server-core/core/testing";
import { installTaskDerivedSchema } from "@plugins/tasks/plugins/tasks-core/server/testing";
import { FALLBACK_MODEL } from "@plugins/conversations/plugins/model-provider/core";
import { turnIdKind } from "@plugins/conversations/plugins/turn-ledger/core";
import { ResumeBlockedError } from "./lifecycle";
import { submitTurn } from "./turns";

let t: TestDb;

// Provisioning a throwaway DB and running the full migration chain overruns
// bun's 5s default.
setDefaultTimeout(120_000);

/** The throwaway as the app's database: `db` forwards every call to it. */
function throwawayDriver(database: Db): DatabaseDriverImpl {
  const unused = (what: string) => () => {
    throw new Error(`[turns-stopped test] ${what} is not used here`);
  };
  return {
    db: () => database,
    ready: async () => {},
    bootDdl: unused("bootDdl"),
    listen: unused("listen"),
    holdSchemaGeneration: unused("holdSchemaGeneration"),
    awaitGenerationsGone: unused("awaitGenerationsGone"),
    awaitOlderProcessesGone: unused("awaitOlderProcessesGone"),
  };
}

beforeAll(async () => {
  t = await createTestDb({ prefix: "turns_stopped_test" });
  await runMigrations(t.db);
  await installTaskDerivedSchema(t.db);
});

afterAll(async () => {
  await t.drop();
});

let seq = 0;
async function seedConversation(status: "done" | "gone"): Promise<string> {
  const n = ++seq;
  const task = `task-turns-stopped-${n}`;
  const attempt = `att-turns-stopped-${n}`;
  const conv = `conv-turns-stopped-${n}`;
  await t.db.execute(sql`
    INSERT INTO tasks (id, cluster_id, title, rank, mandate_ref, author_kind)
    VALUES (${task}, ${task}, 'stopped', ${`a${n}`}, 'interactive', 'human')
  `);
  await t.db.execute(sql`
    INSERT INTO attempts (id, task_id, worktree_path)
    VALUES (${attempt}, ${task}, ${`/tmp/${attempt}`})
  `);
  await t.db.execute(sql`
    INSERT INTO conversations (id, attempt_id, status, runtime, model, launch_cause)
    VALUES (${conv}, ${attempt}, ${status}, 'sdk', ${FALLBACK_MODEL}, 'direct')
  `);
  return conv;
}

const withThrowaway = <T>(fn: () => Promise<T>): Promise<T> =>
  withHostServices(
    [DatabaseDriver.provide(throwawayDriver(t.db as unknown as Db))],
    fn,
  );

async function turnRow(id: string) {
  const res = await t.db.execute<{ state: string; error: string | null }>(
    sql`SELECT state, error FROM conversation_turns WHERE id = ${id}`,
  );
  return res.rows[0] ?? null;
}

test("a user's turn to a stopped conversation resumes it, never typing into the absent agent", async () => {
  await withThrowaway(async () => {
    for (const status of ["done", "gone"] as const) {
      const conv = await seedConversation(status);
      const id = turnIdKind.mint();
      let caught: unknown;
      try {
        await submitTurn(conv, {
          id,
          kind: "turn",
          text: "hi",
          typedText: "hi",
        });
      } catch (err) {
        caught = err;
      }
      // The resume was asked for and refused (no session to resume) — not a
      // send to an agent that is not there.
      expect(caught).toBeInstanceOf(ResumeBlockedError);
      expect((caught as ResumeBlockedError).reason).toBe("no-session");
      expect(await turnRow(id)).toEqual({
        state: "failed",
        error: `Conversation ${conv} has no saved Claude session to resume.`,
      });
    }
  });
});

test("an automatic turn to a stopped conversation is refused, nothing recorded", async () => {
  await withThrowaway(async () => {
    for (const status of ["done", "gone"] as const) {
      const conv = await seedConversation(status);
      const id = turnIdKind.mint();
      expect(
        await submitTurn(conv, {
          id,
          kind: "event",
          text: "x",
          typedText: "x",
        }),
      ).toEqual({ kind: "stopped", status });
      expect(await turnRow(id)).toBeNull();
    }
  });
});
