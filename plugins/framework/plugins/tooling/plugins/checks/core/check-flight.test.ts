import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import {
  createSemaphore,
  type Semaphore,
} from "@plugins/packages/plugins/semaphore/core";
import { gateSlot, runCheckFlight } from "./check-flight";
import type { CheckObservation, CheckOutcome } from "./thrown-outcome";

// Each "run" here is what `runChecks` is to one `./singularity check`: its own
// fan-out gate (`--jobs`), its own run id, and the host-global cache and flight
// directory it shares with every other run. They share one process in this
// test, which is still the real thing for the flight: a kernel flock is held
// per open file description, so two fds in one process contend exactly like
// two processes, and a join waits through a real `flock-wait` child.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "check-flight-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}
function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fakeCheck(id: string): Check {
  return {
    id,
    description: id,
    run: () => Promise.resolve({ ok: true }),
  };
}

interface Run {
  id: string;
  gate: Semaphore;
}

function openRun(id: string, jobs: number): Run {
  return { id, gate: createSemaphore(jobs) };
}

/** What every run of a check saw: bodies run, joins, adoptions. */
interface Log {
  bodies: string[];
  joins: Array<{ run: string; check: string; leader: string | null }>;
}

/**
 * One check in one run, the way `runChecks` drives it: take the gate slot,
 * look the cache up, and on a miss go through the flight. `cache` stands in for
 * the host-global check cache (a pass is recorded in it by the body path).
 */
async function runCheck(
  run: Run,
  check: Check,
  cache: Set<string>,
  log: Log,
  body: (
    runId: string,
    observations: CheckObservation[],
  ) => Promise<CheckResult>,
  hooks: { onJoin?: () => void } = {},
): Promise<CheckOutcome> {
  const slot = gateSlot(run.gate);
  await slot.acquire();
  try {
    const wallStart = performance.now();
    const observations: CheckObservation[] = [];
    const settled = (result: CheckResult, cached: boolean): CheckOutcome => ({
      check,
      result,
      durationMs: 0,
      wallStart,
      cached,
      sharedFrom: null,
      observations,
    });
    const lookup = (): Promise<CheckOutcome | null> =>
      Promise.resolve(cache.has(check.id) ? settled({ ok: true }, true) : null);
    const hit = await lookup();
    if (hit !== null) return hit;
    return await runCheckFlight({
      check,
      dir,
      sig: "",
      treeHash: "tree-1",
      runId: run.id,
      wallStart,
      observations,
      slot,
      lookup,
      run: async () => {
        log.bodies.push(`${run.id}:${check.id}`);
        const result = await body(run.id, observations);
        if (result.ok) cache.add(check.id);
        return settled(result, false);
      },
      onJoin: (leader) => {
        log.joins.push({ run: run.id, check: check.id, leader });
        hooks.onJoin?.();
      },
      onJoinEnd: () => {},
    });
  } finally {
    slot.release();
  }
}

function newLog(): Log {
  return { bodies: [], joins: [] };
}

describe("runCheckFlight", () => {
  test("two runs on the same check and tree: one body runs, the joiner is served the leader's cached pass", async () => {
    const cache = new Set<string>();
    const log = newLog();
    const x = fakeCheck("x");
    const started = deferred();
    const finish = deferred();
    const joined = deferred();

    const a = runCheck(openRun("run-a", 4), x, cache, log, async () => {
      started.resolve();
      await finish.promise;
      return { ok: true };
    });
    await started.promise;
    const b = runCheck(
      openRun("run-b", 4),
      x,
      cache,
      log,
      () => Promise.resolve({ ok: true }),
      { onJoin: () => joined.resolve() },
    );
    await joined.promise;
    finish.resolve();

    const [ra, rb] = await Promise.all([a, b]);
    expect(log.bodies).toEqual(["run-a:x"]);
    expect(log.joins).toEqual([{ run: "run-b", check: "x", leader: "run-a" }]);
    expect(ra).toMatchObject({ cached: false, sharedFrom: null });
    expect(ra.result.ok).toBe(true);
    expect(rb).toMatchObject({ cached: true, sharedFrom: "run-a" });
    expect(rb.result.ok).toBe(true);
  });

  test("a failure is shared: the joiner gets the leader's result and observations", async () => {
    const cache = new Set<string>();
    const log = newLog();
    const x = fakeCheck("x");
    const started = deferred();
    const finish = deferred();
    const joined = deferred();

    const a = runCheck(
      openRun("run-a", 4),
      x,
      cache,
      log,
      async (_run, observations) => {
        started.resolve();
        await finish.promise;
        observations.push({ line: "measured 3", stream: "stdout" });
        return { ok: false, message: "broken", hint: "fix it" };
      },
    );
    await started.promise;
    const b = runCheck(
      openRun("run-b", 4),
      x,
      cache,
      log,
      () => Promise.resolve({ ok: true }),
      { onJoin: () => joined.resolve() },
    );
    await joined.promise;
    finish.resolve();

    const [, rb] = await Promise.all([a, b]);
    expect(log.bodies).toEqual(["run-a:x"]);
    expect(rb.sharedFrom).toBe("run-a");
    expect(rb.cached).toBe(false);
    expect(rb.result).toEqual({
      ok: false,
      message: "broken",
      hint: "fix it",
    });
    expect(rb.observations).toEqual([{ line: "measured 3", stream: "stdout" }]);
  });

  test("an inconclusive result is not shared: the joiner runs the check itself", async () => {
    const cache = new Set<string>();
    const log = newLog();
    const x = fakeCheck("x");
    const started = deferred();
    const finish = deferred();
    const joined = deferred();

    const a = runCheck(openRun("run-a", 4), x, cache, log, async () => {
      started.resolve();
      await finish.promise;
      return { ok: false, message: "host too busy", inconclusive: true };
    });
    await started.promise;
    const b = runCheck(
      openRun("run-b", 4),
      x,
      cache,
      log,
      () => Promise.resolve({ ok: true }),
      { onJoin: () => joined.resolve() },
    );
    await joined.promise;
    finish.resolve();

    const [ra, rb] = await Promise.all([a, b]);
    expect(log.bodies).toEqual(["run-a:x", "run-b:x"]);
    expect(ra.result.ok).toBe(false);
    expect(rb).toMatchObject({ sharedFrom: null, cached: false });
    expect(rb.result.ok).toBe(true);
  });

  test("a leader whose check throws publishes nothing: the joiner runs it", async () => {
    const cache = new Set<string>();
    const log = newLog();
    const x = fakeCheck("x");
    const started = deferred();
    const finish = deferred();
    const joined = deferred();

    const a = runCheck(openRun("run-a", 4), x, cache, log, async () => {
      started.resolve();
      await finish.promise;
      throw new Error("check bug");
    });
    await started.promise;
    const b = runCheck(
      openRun("run-b", 4),
      x,
      cache,
      log,
      () => Promise.resolve({ ok: false, message: "real failure" }),
      { onJoin: () => joined.resolve() },
    );
    await joined.promise;
    finish.resolve();

    const [ra, rb] = await Promise.allSettled([a, b]);
    expect(ra.status).toBe("rejected");
    expect(log.bodies).toEqual(["run-a:x", "run-b:x"]);
    expect(rb.status === "fulfilled" && rb.value.result).toEqual({
      ok: false,
      message: "real failure",
    });
  });

  test("--jobs 1: a check waiting on another run gives its slot back, so the run's next check runs meanwhile", async () => {
    const cache = new Set<string>();
    const log = newLog();
    const x = fakeCheck("x");
    const z = fakeCheck("z");
    const bStarted = deferred();
    const zRan = deferred();

    // B leads x, and its body cannot finish until A's z has run. If A's x
    // held A's only slot through its wait, z would never start: a deadlock
    // this test would hang on.
    const b = runCheck(openRun("run-b", 1), x, cache, log, async () => {
      bStarted.resolve();
      await zRan.promise;
      return { ok: true };
    });
    await bStarted.promise;
    const runA = openRun("run-a", 1);
    const ax = runCheck(runA, x, cache, log, () =>
      Promise.resolve({ ok: true }),
    );
    const az = runCheck(runA, z, cache, log, () => {
      zRan.resolve();
      return Promise.resolve({ ok: true });
    });

    const [rb, rax, raz] = await Promise.all([b, ax, az]);
    expect(log.bodies).toEqual(["run-b:x", "run-a:z"]);
    expect(rb.result.ok).toBe(true);
    expect(rax).toMatchObject({ sharedFrom: "run-b", cached: true });
    expect(raz.result.ok).toBe(true);
  });

  test("--jobs 1, two runs crossing over two checks whose first runs are inconclusive: both finish", async () => {
    const cache = new Set<string>();
    const log = newLog();
    const x = fakeCheck("x");
    const y = fakeCheck("y");
    // The first body of each check comes back inconclusive, so every joiner
    // wakes unable to adopt and must re-take its slot and lead — the path on
    // which a joiner holds a flight lock while it queues for a slot.
    const firstRun = new Set<string>();
    const body = (check: string) => async (): Promise<CheckResult> => {
      await new Promise((r) => setTimeout(r, 20));
      if (!firstRun.has(check)) {
        firstRun.add(check);
        return { ok: false, message: "flaky host", inconclusive: true };
      }
      return { ok: true };
    };
    const runA = openRun("run-a", 1);
    const runB = openRun("run-b", 1);
    const all = Promise.all([
      runCheck(runA, x, cache, log, body("x")),
      runCheck(runA, y, cache, log, body("y")),
      runCheck(runB, y, cache, log, body("y")),
      runCheck(runB, x, cache, log, body("x")),
    ]);
    const outcomes = await all;
    expect(outcomes).toHaveLength(4);
    // Every check settled with a verdict of its own or a shared one; none hung.
    for (const o of outcomes) expect(typeof o.result.ok).toBe("boolean");
  }, 20_000);
});
