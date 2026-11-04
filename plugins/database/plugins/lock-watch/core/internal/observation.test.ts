import { describe, expect, test } from "bun:test";
import { tagSqlWithOrigin } from "@plugins/database/plugins/connection/core";
import { lockHolders, type SessionRow } from "./observation";

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
