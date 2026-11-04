import { describe, expect, test } from "bun:test";
import { tagSqlWithOrigin } from "@plugins/database/plugins/connection/core";
import {
  idleEndedPayloadFromWatch,
  idleSessionsEnded,
  idleSessionsSeen,
  type IdleSessionSeen,
} from "./idle-ended";
import type { SessionRow } from "./observation";

const MIN = 60_000;
const BOUND = 5 * MIN;

function row(over: Partial<SessionRow> & { pid: number }): SessionRow {
  return {
    state: "idle",
    applicationName: "",
    query: "select 1",
    xactMs: null,
    stateMs: 1_000,
    blockedBy: [],
    backendStartMs: 1_000 * over.pid,
    ...over,
  };
}

function seen(
  over: Partial<IdleSessionSeen> & { pid: number },
): IdleSessionSeen {
  return {
    backendStartMs: 1_000 * over.pid,
    query: "select 1",
    applicationName: "",
    xactMs: 4 * MIN,
    idleMs: 4.5 * MIN,
    observedAt: 0,
    ...over,
  };
}

describe("idleSessionsSeen", () => {
  test("keeps only sessions idle inside a transaction, aborted ones included", () => {
    const rows = [
      row({ pid: 1, state: "idle in transaction", stateMs: 10 }),
      row({ pid: 2, state: "idle in transaction (aborted)", stateMs: 20 }),
      row({ pid: 3, state: "active" }),
      row({ pid: 4, state: "idle" }),
    ];
    expect(idleSessionsSeen(rows, 5).map((s) => [s.pid, s.idleMs])).toEqual([
      [1, 10],
      [2, 20],
    ]);
  });
});

describe("idleSessionsEnded", () => {
  test("a session gone after reaching the bound, with a FATAL end since, was ended by the timeout", () => {
    const s = seen({
      pid: 7,
      query: tagSqlWithOrigin("update t set n = 1", "psql-script"),
    });
    const ended = idleSessionsEnded({
      previous: [s],
      current: [],
      now: MIN,
      fatalEnds: 1,
      boundMs: BOUND,
    });
    expect(ended).toEqual([s]);
    expect(idleEndedPayloadFromWatch(ended[0]!, BOUND)).toMatchObject({
      observedBy: "lock-watch",
      origin: "psql-script",
      sql: "update t set n = 1",
      pid: 7,
      boundMs: BOUND,
    });
  });

  test("no FATAL end since: it committed or its client closed — nothing", () => {
    expect(
      idleSessionsEnded({
        previous: [seen({ pid: 7 })],
        current: [],
        now: MIN,
        fatalEnds: 0,
        boundMs: BOUND,
      }),
    ).toEqual([]);
  });

  test("still there (same pid, same backend) — nothing, even past the bound", () => {
    expect(
      idleSessionsEnded({
        previous: [seen({ pid: 7 })],
        current: [row({ pid: 7, state: "idle" })],
        now: MIN,
        fatalEnds: 1,
        boundMs: BOUND,
      }),
    ).toEqual([]);
  });

  test("a reused pid is another session: the one seen is gone", () => {
    expect(
      idleSessionsEnded({
        previous: [seen({ pid: 7 })],
        current: [row({ pid: 7, backendStartMs: 99_999 })],
        now: MIN,
        fatalEnds: 1,
        boundMs: BOUND,
      }),
    ).toHaveLength(1);
  });

  test("gone before it could have reached the bound — ended otherwise", () => {
    expect(
      idleSessionsEnded({
        previous: [seen({ pid: 7, idleMs: 2 * MIN })],
        current: [],
        now: MIN,
        fatalEnds: 1,
        boundMs: BOUND,
      }),
    ).toEqual([]);
  });

  test("fewer FATAL ends than candidates: the longest idle, as many as ended", () => {
    const ended = idleSessionsEnded({
      previous: [
        seen({ pid: 1, idleMs: 4.2 * MIN }),
        seen({ pid: 2, idleMs: 4.9 * MIN }),
        seen({ pid: 3, idleMs: 4.5 * MIN }),
      ],
      current: [],
      now: MIN,
      fatalEnds: 2,
      boundMs: BOUND,
    });
    expect(ended.map((s) => s.pid)).toEqual([2, 3]);
  });

  test("the timeout off (0) — nothing", () => {
    expect(
      idleSessionsEnded({
        previous: [seen({ pid: 7 })],
        current: [],
        now: MIN,
        fatalEnds: 1,
        boundMs: 0,
      }),
    ).toEqual([]);
  });
});
