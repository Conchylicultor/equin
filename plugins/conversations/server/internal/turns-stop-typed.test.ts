/**
 * Stop while the turn typed into an idle agent has not been taken yet —
 * through the real `stopTurn` and turn ledger, over a throwaway database
 * standing in for the app's `db`, with a fake runtime as the agent.
 *
 * The bug this pins (2026-11-12, the Home tour's first-launch e2e, flaky): the
 * launch prompt is `typed` (the row already reads `working`) for the second
 * between the agent coming up and its CLI starting the turn. A Stop in that
 * window interrupted an agent running nothing — the sdk runtime's stop
 * answered "nothing to take back" — and the turn then ran in full, the Stop
 * lost. Now Stop waits for the agent to take the turn, then interrupts it.
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
import {
  transcriptUuidOfTurn,
  turnIdKind,
  type TurnId,
} from "@plugins/conversations/plugins/turn-ledger/core";
import { confirmTurn } from "@plugins/conversations/plugins/turn-ledger/server";
import { Runtime, type ConversationRuntime } from "./runtime";
import { stopTurn } from "./turns";

let t: TestDb;

setDefaultTimeout(120_000);

function throwawayDriver(database: Db): DatabaseDriverImpl {
  const unused = (what: string) => () => {
    throw new Error(`[turns-stop-typed test] ${what} is not used here`);
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

const withThrowaway = <T>(fn: () => Promise<T>): Promise<T> =>
  withHostServices(
    [DatabaseDriver.provide(throwawayDriver(t.db as unknown as Db))],
    fn,
  );

async function turnState(id: string): Promise<string | null> {
  const res = await t.db.execute<{ state: string }>(
    sql`SELECT state FROM conversation_turns WHERE id = ${id}`,
  );
  return res.rows[0]?.state ?? null;
}

/**
 * The agent: idle until it takes the typed turn (`take`), then running it;
 * `stop` records the turn's ledger state at the moment of the interrupt and,
 * like the sdk runtime, takes back a turn it was running with no reply.
 */
const agent = {
  conversationId: "",
  turnId: turnIdKind.mint() as TurnId,
  running: false,
  stateAtStop: null as string | null,
  async take(): Promise<void> {
    await confirmTurn(
      this.conversationId,
      this.turnId,
      transcriptUuidOfTurn(this.turnId),
      new Date(),
    );
    this.running = true;
  },
};

const fakeRuntime = {
  id: "sdk",
  async inspect(ids: readonly string[]) {
    return new Map(
      ids.map((id) => [
        id,
        {
          kind: "live" as const,
          info: {
            workingOn: agent.running ? ("turn" as const) : null,
            dead: false,
            claudeSessionId: "session",
            statusWrittenAt: null,
          },
        },
      ]),
    );
  },
  async stop() {
    agent.stateAtStop = await turnState(agent.turnId);
    if (!agent.running) return { returnedPromptUuid: null };
    agent.running = false;
    return {
      returnedPromptUuid: transcriptUuidOfTurn(agent.turnId),
    };
  },
} as unknown as ConversationRuntime;

beforeAll(async () => {
  t = await createTestDb({ prefix: "turns_stop_typed_test" });
  await runMigrations(t.db);
  await installTaskDerivedSchema(t.db);
  await Runtime.define(fakeRuntime).register();
});

afterAll(async () => {
  await t.drop();
});

test("Stop waits for the agent to take the typed turn, then stops it and hands it back", async () => {
  const task = "task-stop-typed-1";
  const attempt = "att-stop-typed-1";
  const conv = "conv-stop-typed-1";
  const turnId = turnIdKind.mint();
  await t.db.execute(sql`
    INSERT INTO tasks (id, cluster_id, title, rank, mandate_ref)
    VALUES (${task}, ${task}, 'stop typed', 'a1', 'interactive')
  `);
  await t.db.execute(sql`
    INSERT INTO attempts (id, task_id, worktree_path)
    VALUES (${attempt}, ${task}, ${`/tmp/${attempt}`})
  `);
  await t.db.execute(sql`
    INSERT INTO conversations (id, attempt_id, status, runtime, model, spawned_by)
    VALUES (${conv}, ${attempt}, 'working', 'sdk', ${FALLBACK_MODEL}, 'test')
  `);
  await t.db.execute(sql`
    INSERT INTO conversation_turns (id, conversation_id, kind, text, typed_text, state)
    VALUES (${turnId}, ${conv}, 'launch', 'the request', 'the request', 'typed')
  `);
  agent.conversationId = conv;
  agent.turnId = turnId;

  await withThrowaway(async () => {
    const stopping = stopTurn(conv);
    // The agent's CLI starts the turn a moment after Stop arrived.
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Stop is waiting: it has not interrupted the idle agent.
    expect(agent.stateAtStop).toBeNull();
    await agent.take();
    expect(await stopping).toBe("the request");
  });
  // The interrupt came once the turn was running, never before.
  expect(agent.stateAtStop).toBe("accepted");
  expect(agent.running).toBe(false);
  expect(await turnState(turnId)).toBe("returned");
});
