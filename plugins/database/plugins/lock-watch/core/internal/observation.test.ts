import { describe, expect, test } from "bun:test";
import { tagSqlWithOrigin } from "@plugins/database/plugins/connection/core";
import { awakeSessionRows, lockHolders, type SessionRow } from "./observation";

const MIN = 60_000;

function session(over: Partial<SessionRow> & { pid: number }): SessionRow {
  return {
    state: "active",
    applicationName: "",
    query: "select 1",
    xactMs: 1_000,
    stateMs: 1_000,
    blockedBy: [],
    backendStartMs: 0,
    ...over,
  };
}

describe("lockHolders", () => {
  test("names the head of the 2026-11-03 chain: idle in transaction, 15 waiting behind it", () => {
    const head = session({
      pid: 100,
      state: "idle in transaction",
      query: tagSqlWithOrigin(
        'insert into "conversations_ext_usage" values ($1)',
        "conversations.usage:sync",
      ),
      xactMs: 300 * MIN,
      stateMs: 300 * MIN,
    });
    // Each waiter blocked by the previous one, as Postgres showed it.
    const waiters = Array.from({ length: 15 }, (_, i) =>
      session({
        pid: 101 + i,
        stateMs: (15 - i) * MIN,
        blockedBy: [100 + i],
      }),
    );
    const holders = lockHolders([head, ...waiters], MIN);
    expect(holders).toEqual([
      {
        pid: 100,
        origin: "conversations.usage:sync",
        sql: 'insert into "conversations_ext_usage" values ($1)',
        state: "idle in transaction",
        applicationName: "",
        xactMs: 300 * MIN,
        idleMs: 300 * MIN,
        waiting: 15,
        longestWaitMs: 15 * MIN,
      },
    ]);
  });

  test("never names a waiter that also blocks others — only the head", () => {
    const holders = lockHolders(
      [
        session({ pid: 1 }),
        session({ pid: 2, blockedBy: [1], stateMs: 5 * MIN }),
        session({ pid: 3, blockedBy: [2], stateMs: 4 * MIN }),
      ],
      MIN,
    );
    expect(holders.map((h) => [h.pid, h.waiting])).toEqual([[1, 2]]);
    expect(holders[0]!.origin).toBeNull();
  });

  test("stays quiet below the bound", () => {
    expect(
      lockHolders(
        [
          session({ pid: 1, state: "idle in transaction", stateMs: 30_000 }),
          session({ pid: 2, blockedBy: [1], stateMs: 30_000 }),
        ],
        MIN,
      ),
    ).toEqual([]);
  });

  test("names a session idle in its transaction even when nobody waits on it", () => {
    const holders = lockHolders(
      [
        session({
          pid: 7,
          state: "idle in transaction (aborted)",
          stateMs: 2 * MIN,
        }),
        session({ pid: 8, state: "idle", stateMs: 60 * MIN, xactMs: null }),
      ],
      MIN,
    );
    expect(holders).toHaveLength(1);
    expect(holders[0]).toMatchObject({ pid: 7, waiting: 0, idleMs: 2 * MIN });
  });

  test("a blocker outside the read (another database, autovacuum) is not described", () => {
    expect(
      lockHolders(
        [session({ pid: 2, blockedBy: [999], stateMs: 5 * MIN })],
        MIN,
      ),
    ).toEqual([]);
  });

  test("a wait cycle (a deadlock in progress) names nobody and terminates", () => {
    expect(
      lockHolders(
        [
          session({ pid: 1, blockedBy: [2], stateMs: 2 * MIN }),
          session({ pid: 2, blockedBy: [1], stateMs: 2 * MIN }),
        ],
        MIN,
      ),
    ).toEqual([]);
  });
});

describe("awakeSessionRows", () => {
  // main, 2026-11-14 21:31:03: the first look 1.4 s after a 1025 s sleep
  // named a session holding one waiter for "17 min"; a minute later, nothing.
  const observedAt = 1_794_691_863_747;
  const nap = {
    startMs: 1_794_691_862_393 - 1_025_095,
    endMs: 1_794_691_862_393,
  };
  const sleptDuring = (start: number, end: number): number =>
    Math.max(0, Math.min(end, nap.endMs) - Math.max(start, nap.startMs));
  const chain = (waitMs: number, idleMs: number | null): SessionRow[] => [
    session({
      pid: 54152,
      state: idleMs === null ? "active" : "idle in transaction",
      xactMs: Math.max(waitMs, idleMs ?? 0) + 2_000,
      stateMs: idleMs ?? 2_000,
    }),
    session({ pid: 2, stateMs: waitMs, blockedBy: [54152] }),
  ];

  test("a wait open across a nap is not named the moment the machine wakes", () => {
    const rows = chain(1_025_095 + 1_400 + 500, null);
    expect(lockHolders(rows, MIN)).toHaveLength(1);
    expect(
      lockHolders(awakeSessionRows(rows, observedAt, sleptDuring), MIN),
    ).toEqual([]);
  });

  test("an idle transaction open across a nap is not named either", () => {
    const rows = chain(0, 1_025_095 + 3_000).slice(0, 1);
    expect(lockHolders(rows, MIN)).toHaveLength(1);
    expect(
      lockHolders(awakeSessionRows(rows, observedAt, sleptDuring), MIN),
    ).toEqual([]);
  });

  test("a wait that runs on past the bound in awake time is still named, aged in awake time", () => {
    // Blocked 10 s before the nap, still blocked 55 s after the wake: 65 s awake.
    const later = observedAt + 55_000;
    const rows = chain(10_000 + 1_025_095 + 55_000, null);
    const holders = lockHolders(
      awakeSessionRows(rows, later, sleptDuring),
      MIN,
    );
    expect(holders.map((h) => h.pid)).toEqual([54152]);
    expect(Math.round(holders[0]!.longestWaitMs)).toBe(65_000);
  });

  test("on a machine that stays awake, every age and holder is as Postgres reports it", () => {
    const rows = chain(2 * MIN, null);
    const awake = awakeSessionRows(rows, observedAt, () => 0);
    expect(awake).toEqual(rows);
    expect(lockHolders(awake, MIN)).toEqual(lockHolders(rows, MIN));
  });

  test("where the sleep is unknown, the wall-clock ages stand", () => {
    const rows = chain(1_025_095, null);
    expect(awakeSessionRows(rows, observedAt, () => null)).toEqual(rows);
  });
});
