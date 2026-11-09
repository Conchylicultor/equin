/**
 * Real-DB suite for the job lock: **every running job's advisory lock lives on
 * ONE session per process**, and that changes none of what the lock means —
 * one holder per job id, released when the handler ends however it ends, and
 * every holder told when the session dies.
 *
 * Run: `./equin test plugins/infra/plugins/jobs`
 * (requires the running embedded cluster — `./equin build` first).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "pg";
import { z } from "zod";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { createJobLocks, type JobLocks, LOCK_HELD } from "./job-lock";

let t: TestDb;
let observer: Client;
let locks: JobLocks;

beforeAll(async () => {
  t = await createTestDb({ prefix: "job_lock_test" });
  observer = new Client({ connectionString: t.connectionString });
  await observer.connect();
  locks = createJobLocks({ connectionString: async () => t.connectionString });
});

afterAll(async () => {
  await locks.end();
  await observer.end();
  await t.drop();
});

// Distinct keys per test, well clear of anything else on the cluster (advisory
// locks are per database, and this one is throwaway anyway).
let nextKey = 9_100_000_000;
const key = (): string => String(nextKey++);

/** The backend pid holding `jobId`'s lock in the test database, or null. */
async function holderOf(jobId: string): Promise<number | null> {
  const { rows } = await observer.query(
    `SELECT pid FROM pg_locks
      WHERE locktype = 'advisory' AND granted AND objsubid = 1
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND ((classid::bigint << 32) | objid::bigint) = $1::bigint`,
    [jobId],
  );
  const row = z.array(z.object({ pid: z.number() })).parse(rows)[0];
  return row?.pid ?? null;
}

/** {@link holderOf} for each id, one query at a time on the observer. */
async function holdersOf(ids: string[]): Promise<(number | null)[]> {
  const out: (number | null)[] = [];
  for (const id of ids) out.push(await holderOf(id));
  return out;
}

/** How many `job-lock` sessions the test database has open. */
async function lockSessions(): Promise<number> {
  const { rows } = await observer.query(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND application_name LIKE '%:job-lock'`,
  );
  return z.array(z.object({ n: z.number() })).parse(rows)[0]?.n ?? 0;
}

/** A handler that runs until `finish()` is called. */
function gate(): { promise: Promise<void>; finish: () => void } {
  let finish!: () => void;
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
}

const neverLost = (err: unknown) => {
  throw new Error(`lock reported lost unexpectedly: ${String(err)}`);
};

describe("withJobLock", () => {
  test("concurrent jobs hold their locks on one shared session", async () => {
    const [a, b, c] = [key(), key(), key()];
    const g = gate();
    const started: string[] = [];
    const runs = [a, b, c].map((id) =>
      locks.withJobLock(id, neverLost, async () => {
        started.push(id);
        await g.promise;
        return id;
      }),
    );
    while (started.length < 3) await new Promise((r) => setTimeout(r, 5));

    const pids = await holdersOf([a, b, c]);
    expect(pids[0]).not.toBeNull();
    expect(new Set(pids).size).toBe(1);
    expect(await lockSessions()).toBe(1);

    g.finish();
    expect(await Promise.all(runs)).toEqual([a, b, c]);
    expect(await holdersOf([a, b, c])).toEqual([null, null, null]);
  });

  test("a second dispatch of a running job id in this process is LOCK_HELD", async () => {
    // The shared session would GRANT a key it already holds; the in-process
    // check is what keeps one holder per job id.
    const id = key();
    const g = gate();
    let entered = false;
    const outer = locks.withJobLock(id, neverLost, async () => {
      entered = true;
      await g.promise;
      return "outer";
    });
    while (!entered) await new Promise((r) => setTimeout(r, 5));

    let ranInner = false;
    const inner = await locks.withJobLock(id, neverLost, async () => {
      ranInner = true;
      return "inner";
    });
    expect(inner).toBe(LOCK_HELD);
    expect(ranInner).toBe(false);

    g.finish();
    expect(await outer).toBe("outer");
    expect(await holderOf(id)).toBeNull();
  });

  test("a job whose lock another live session holds is LOCK_HELD", async () => {
    const id = key();
    await observer.query("SELECT pg_advisory_lock($1::bigint)", [id]);
    try {
      let ran = false;
      const out = await locks.withJobLock(id, neverLost, async () => {
        ran = true;
      });
      expect(out).toBe(LOCK_HELD);
      expect(ran).toBe(false);
    } finally {
      await observer.query("SELECT pg_advisory_unlock($1::bigint)", [id]);
    }
  });

  test("a throwing handler releases its own lock and leaves its siblings' held", async () => {
    const [stays, throws] = [key(), key()];
    const g = gate();
    let entered = false;
    const sibling = locks.withJobLock(stays, neverLost, async () => {
      entered = true;
      await g.promise;
    });
    while (!entered) await new Promise((r) => setTimeout(r, 5));
    const pid = await holderOf(stays);

    expect(
      locks.withJobLock(throws, neverLost, async () => {
        throw new Error("handler failed");
      }),
    ).rejects.toThrow("handler failed");
    await new Promise((r) => setTimeout(r, 20));

    expect(await holderOf(throws)).toBeNull();
    expect(await holderOf(stays)).toBe(pid);

    g.finish();
    await sibling;
    expect(await holderOf(stays)).toBeNull();
  });

  test("the session goes back to the pool between jobs and the next one reuses it", async () => {
    const first = key();
    let pidFirst: number | null = null;
    await locks.withJobLock(first, neverLost, async () => {
      pidFirst = await holderOf(first);
    });
    const second = key();
    let pidSecond: number | null = null;
    await locks.withJobLock(second, neverLost, async () => {
      pidSecond = await holderOf(second);
    });
    expect(pidFirst).not.toBeNull();
    expect(pidSecond).toBe(pidFirst);
    expect(await lockSessions()).toBe(1);
  });

  test("a dead session tells every job holding a lock on it, and the next job gets a fresh one", async () => {
    const [a, b] = [key(), key()];
    const g = gate();
    const lost: string[] = [];
    let allLost!: () => void;
    const bothLost = new Promise<void>((resolve) => {
      allLost = resolve;
    });
    const onLost = (id: string) => () => {
      lost.push(id);
      if (lost.length === 2) allLost();
    };
    let entered = 0;
    const runs = [a, b].map((id) =>
      locks.withJobLock(id, onLost(id), async () => {
        entered++;
        await g.promise;
        return id;
      }),
    );
    while (entered < 2) await new Promise((r) => setTimeout(r, 5));
    const pid = await holderOf(a);
    expect(await holderOf(b)).toBe(pid);

    await observer.query("SELECT pg_terminate_backend($1)", [pid]);
    await bothLost;
    expect(lost.sort()).toEqual([a, b].sort());
    expect(await holderOf(a)).toBeNull();

    // The handlers themselves are not stopped — nothing can un-run them.
    g.finish();
    expect(await Promise.all(runs)).toEqual([a, b]);

    const next = key();
    let pidNext: number | null = null;
    await locks.withJobLock(next, neverLost, async () => {
      pidNext = await holderOf(next);
    });
    expect(pidNext).not.toBeNull();
    expect(pidNext).not.toBe(pid);
  });
  test("a job whose session died can run again at once in this process", async () => {
    // A retry of the same graphile job id after the loss must not read as held
    // here: the lost session's locks are gone, and so is its claim on the id.
    const id = key();
    let entered = false;
    let lostOnce!: () => void;
    const lost = new Promise<void>((resolve) => {
      lostOnce = resolve;
    });
    const g = gate();
    const run = locks.withJobLock(
      id,
      () => lostOnce(),
      async () => {
        entered = true;
        await g.promise;
      },
    );
    while (!entered) await new Promise((r) => setTimeout(r, 5));
    await observer.query("SELECT pg_terminate_backend($1)", [
      await holderOf(id),
    ]);
    await lost;
    g.finish();
    await run;

    expect(await locks.withJobLock(id, neverLost, async () => "again")).toBe(
      "again",
    );
  });

  test("a failed connection-string read is not cached", async () => {
    let calls = 0;
    const flaky = createJobLocks({
      connectionString: async () => {
        calls++;
        if (calls === 1) throw new Error("not ready yet");
        return t.connectionString;
      },
    });
    try {
      expect(
        flaky.withJobLock(key(), neverLost, async () => "never"),
      ).rejects.toThrow("not ready yet");
      await new Promise((r) => setTimeout(r, 20));
      expect(await flaky.withJobLock(key(), neverLost, async () => "ok")).toBe(
        "ok",
      );
    } finally {
      await flaky.end();
    }
  });
});
