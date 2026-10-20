/**
 * Real-DB suite for the ledger's writes (store.ts): the accept's row lock
 * against the status flip, idempotent ids, the one-claimant `deliver`, and the
 * hook / Stop resolutions. Every guarantee here lives in Postgres locks and
 * conditional writes, so a fake `db` would prove nothing. Drives the
 * db-parametrized functions against a throwaway database (db-test-fixture)
 * seeded with the REAL migration chain.
 *
 * Only side-effect-free transitions are driven: `answer` rows (which emit no
 * `userTurnSent`) and no merge or unverified verdicts (which file reports into
 * the worktree's own database). The rules behind those are pure and pinned in
 * transition.test.ts.
 *
 * Requires the running embedded cluster — `./singularity build` first.
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
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { FALLBACK_MODEL } from "@plugins/conversations/plugins/model-provider/core";
import { turnIdKind } from "../../core/id-kind";
import {
  acceptTurn,
  applyTurnEvent,
  getTurn,
  hasHeldTurns,
  holdIfStarting,
  latestSubmitAt,
  listHeldTurns,
  resolvePromptSubmit,
  returnTurnByText,
  returnTurnsSince,
  type NewTurn,
} from "./store";

const AT = new Date("2026-10-18T15:53:10Z");

let t: TestDb;
// `createTestDb`'s own pool holds ONE connection; the race cases need two
// transactions that genuinely block on each other, so everything runs on a
// pool of its own.
let pool: Pool;
let conn: NodePgDatabase;

setDefaultTimeout(120_000);

beforeAll(async () => {
  t = await createTestDb({ prefix: "turn_ledger_test" });
  await runMigrations(t.db);
  pool = new Pool({ connectionString: t.connectionString, max: 6 });
  conn = drizzle(pool);
});

afterAll(async () => {
  await pool.end();
  await t.drop();
});

let seq = 0;
const nextId = (kind: string): string => `${kind}-${++seq}-${Date.now()}`;

async function seedConversation(status: string): Promise<string> {
  const taskId = nextId("task");
  const attemptId = nextId("att");
  const conversationId = nextId("conv");
  await t.db.execute(sql`
    INSERT INTO tasks (id, title, rank) VALUES (${taskId}, ${`title ${taskId}`}, ${`a${seq}`})
  `);
  await t.db.execute(sql`
    INSERT INTO attempts (id, task_id, worktree_path)
    VALUES (${attemptId}, ${taskId}, ${`/tmp/${attemptId}`})
  `);
  await t.db.execute(sql`
    INSERT INTO conversations (id, attempt_id, status, runtime, model, spawned_by)
    VALUES (${conversationId}, ${attemptId}, ${status}, 'sdk', ${FALLBACK_MODEL}, 'test')
  `);
  return conversationId;
}

// `answer` rows: no `userTurnSent` to emit into the real worktree database.
const turn = (text: string): NewTurn => ({
  id: turnIdKind.mint(),
  kind: "answer",
  text,
  typedText: text,
});

const heldTexts = async (conversationId: string): Promise<string[]> =>
  (await listHeldTurns(conversationId, conn)).map((h) => h.typedText);

/** Resolves once some backend is waiting on a lock it has not been granted. */
async function untilSomeoneWaitsOnALock(): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const res = await t.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if ((res.rows[0]?.n ?? 0) > 0) return;
    if (Date.now() > deadline) throw new Error("nobody ever waited on a lock");
    await Bun.sleep(20);
  }
}

describe("acceptTurn", () => {
  test("a conversation still starting holds the turn", async () => {
    const id = await seedConversation("starting");
    const accepted = await acceptTurn(id, turn("hello"), conn);
    expect(accepted.kind).toBe("held");
    expect(await heldTexts(id)).toEqual(["hello"]);
  });

  test("a conversation past starting records it as typing, holding nothing", async () => {
    const id = await seedConversation("waiting");
    const accepted = await acceptTurn(id, turn("hello"), conn);
    expect(accepted.kind).toBe("send");
    if (accepted.kind === "send") expect(accepted.turn.state).toBe("typing");
    expect(await hasHeldTurns(id, conn)).toBe(false);
  });

  test("an unknown conversation is not-found", async () => {
    expect(await acceptTurn("conv-missing", turn("x"), conn)).toEqual({
      kind: "not-found",
    });
  });

  test("the same id twice is one row: the second accept is a duplicate", async () => {
    const id = await seedConversation("waiting");
    const once = turn("hello");
    expect((await acceptTurn(id, once, conn)).kind).toBe("send");
    const again = await acceptTurn(id, { ...once, text: "other" }, conn);
    expect(again.kind).toBe("duplicate");
    if (again.kind === "duplicate") expect(again.turn.text).toBe("hello");
  });

  test("an id another conversation owns is refused loudly", async () => {
    const a = await seedConversation("waiting");
    const b = await seedConversation("waiting");
    const once = turn("hello");
    await acceptTurn(a, once, conn);
    let caught: unknown;
    try {
      await acceptTurn(b, once, conn);
    } catch (err) {
      caught = err;
    }
    expect(String(caught)).toContain("already belongs to conversation");
  });

  test("a hookless text is marked at the accept", async () => {
    const id = await seedConversation("waiting");
    const accepted = await acceptTurn(
      id,
      { ...turn("/compact"), kind: "turn" },
      conn,
    );
    if (accepted.kind !== "send") throw new Error(accepted.kind);
    expect(accepted.turn.hookless).toBe(true);
  });

  test("a flip in progress makes the accept wait, then record it for sending", async () => {
    // The reconciler's flip is an UPDATE of the row the accept locks. While it
    // is uncommitted the accept must not read `starting` and hold — the flush
    // the flip enqueues may already have looked, stranding the turn.
    const id = await seedConversation("starting");
    const flip = await pool.connect();
    try {
      await flip.query("BEGIN");
      await flip.query(
        "UPDATE conversations SET status = 'waiting' WHERE id = $1",
        [id],
      );
      let settled = false;
      const accepted = acceptTurn(id, turn("racing"), conn).then((r) => {
        settled = true;
        return r;
      });
      await untilSomeoneWaitsOnALock();
      expect(settled).toBe(false);
      await flip.query("COMMIT");
      expect((await accepted).kind).toBe("send");
    } finally {
      flip.release();
    }
    expect(await hasHeldTurns(id, conn)).toBe(false);
  });

  test("an accept in progress makes the flip wait, and the flush after it sees the turn", async () => {
    const id = await seedConversation("starting");
    const holder = await pool.connect();
    const flipper = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT 1 FROM conversations WHERE id = $1 FOR UPDATE",
        [id],
      );
      await holder.query(
        "INSERT INTO conversation_turns (id, conversation_id, kind, text, typed_text, state) VALUES ($1, $2, 'answer', 'early', 'early', 'held')",
        [turnIdKind.mint(), id],
      );
      let flipped = false;
      const flip = flipper
        .query("UPDATE conversations SET status = 'waiting' WHERE id = $1", [
          id,
        ])
        .then(() => {
          flipped = true;
        });
      await untilSomeoneWaitsOnALock();
      expect(flipped).toBe(false);
      await holder.query("COMMIT");
      await flip;
    } finally {
      holder.release();
      flipper.release();
    }
    // What the flush the reconciler enqueues after its write reads.
    expect(await heldTexts(id)).toEqual(["early"]);
  });

  test("held turns list in the order they were accepted", async () => {
    const id = await seedConversation("starting");
    for (const text of ["one", "two", "three"]) {
      await acceptTurn(id, turn(text), conn);
    }
    expect(await heldTexts(id)).toEqual(["one", "two", "three"]);
  });
});

describe("delivery claims", () => {
  test("two claimants of one held turn: exactly one gets it", async () => {
    const id = await seedConversation("starting");
    const accepted = await acceptTurn(id, turn("once"), conn);
    const turnId = accepted.kind === "held" ? accepted.turn.id : "";
    const claims = await Promise.all([
      applyTurnEvent(turnId, { kind: "deliver", typedText: "once" }, conn),
      applyTurnEvent(turnId, { kind: "deliver", typedText: "once" }, conn),
    ]);
    expect(claims.map((c) => c.state)).toEqual(["typing", "typing"]);
    expect(await hasHeldTurns(id, conn)).toBe(false);
    // The second claim found it typing already and wrote nothing: the
    // `deliver` transition does not apply to `typing`.
    expect((await getTurn(turnId, conn))?.state).toBe("typing");
  });

  test("a launch that threw puts the turn back to held, as it was typed", async () => {
    const id = await seedConversation("starting");
    const accepted = await acceptTurn(id, turn("first"), conn);
    const turnId = accepted.kind === "held" ? accepted.turn.id : "";
    await applyTurnEvent(
      turnId,
      { kind: "deliver", typedText: "<preprompt>\n\nfirst" },
      conn,
    );
    await applyTurnEvent(turnId, { kind: "release", typedText: "first" }, conn);
    expect(await heldTexts(id)).toEqual(["first"]);
  });

  test("holdIfStarting holds a typing turn only while the conversation starts", async () => {
    const id = await seedConversation("waiting");
    const accepted = await acceptTurn(id, turn("resumed"), conn);
    const turnId = accepted.kind === "send" ? accepted.turn.id : "";
    expect(await holdIfStarting(turnId, conn)).toBe(false);
    await t.db.execute(
      sql`UPDATE conversations SET status = 'starting' WHERE id = ${id}`,
    );
    expect(await holdIfStarting(turnId, conn)).toBe(true);
    expect(await heldTexts(id)).toEqual(["resumed"]);
  });
});

describe("resolvePromptSubmit", () => {
  test("the hook accepts the oldest row with exactly its text, even before `typed`", async () => {
    const id = await seedConversation("waiting");
    const first = await acceptTurn(id, turn("same"), conn);
    const second = await acceptTurn(id, turn("same"), conn);
    const resolved = await resolvePromptSubmit(id, "same", AT, conn);
    expect<string | undefined>(resolved?.id).toBe(
      first.kind === "send" ? first.turn.id : "",
    );
    expect(resolved?.state).toBe("accepted");
    const later = await getTurn(
      second.kind === "send" ? second.turn.id : "",
      conn,
    );
    expect(later?.state).toBe("typing");
  });

  test("a prompt matching no row is not ours", async () => {
    const id = await seedConversation("waiting");
    await acceptTurn(id, turn("mine"), conn);
    expect(null);
  });

  test("the submit check landing after the hook changes nothing", async () => {
    const id = await seedConversation("waiting");
    const accepted = await acceptTurn(id, turn("hi"), conn);
    const turnId = accepted.kind === "send" ? accepted.turn.id : "";
    await resolvePromptSubmit(id, "hi", AT, conn);
    const after = await applyTurnEvent(
      turnId,
      { kind: "typed", hookless: false },
      conn,
    );
    expect(after.state).toBe("accepted");
  });
});

describe("returnTurnByText", () => {
  test("Stop's rewound text returns the newest delivered row carrying it", async () => {
    const id = await seedConversation("waiting");
    const accepted = await acceptTurn(id, turn("stop me"), conn);
    const turnId = accepted.kind === "send" ? accepted.turn.id : "";
    await resolvePromptSubmit(id, "stop me", AT, conn);
    expect<string | undefined>(
      (await returnTurnByText(id, "stop me\n", conn))?.id,
    ).toBe(turnId);
    expect((await getTurn(turnId, conn))?.state).toBe("returned");
  });

  test("text no recent row carries returns nothing", async () => {
    const id = await seedConversation("waiting");
    await acceptTurn(id, turn("kept"), conn);
    expect(await returnTurnByText(id, "something else", conn)).toBe(null);
  });
});

describe("latestSubmitAt", () => {
  test("is when the CLI last confirmed a turn, absent before any", async () => {
    const id = await seedConversation("waiting");
    await acceptTurn(id, turn("first"), conn);
    expect((await latestSubmitAt([id], conn)).has(id)).toBe(false);
    await resolvePromptSubmit(id, "first", AT, conn);
    const later = new Date(AT.getTime() + 5_000);
    await acceptTurn(id, turn("second"), conn);
    await resolvePromptSubmit(id, "second", later, conn);
    expect((await latestSubmitAt([id], conn)).get(id)).toEqual(later);
  });
});

describe("returnTurnsSince", () => {
  test("returns the delivered turns sent at or after the cut, not before", async () => {
    const id = await seedConversation("waiting");
    const before = await acceptTurn(id, turn("kept"), conn);
    await resolvePromptSubmit(id, "kept", AT, conn);
    const [{ now }] = (
      await t.db.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`)
    ).rows as [{ now: Date }];
    const after = await acceptTurn(id, turn("cut"), conn);
    await resolvePromptSubmit(id, "cut", AT, conn);
    const returned = await returnTurnsSince(id, new Date(now), conn);
    expect<string[]>(returned.map((row) => row.id)).toEqual([
      after.kind === "send" ? after.turn.id : "",
    ]);
    expect(
      (await getTurn(before.kind === "send" ? before.turn.id : "", conn))
        ?.state,
    ).toBe("accepted");
  });
});
