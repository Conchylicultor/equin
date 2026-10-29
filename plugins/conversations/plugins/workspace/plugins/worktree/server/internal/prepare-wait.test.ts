import { describe, expect, test } from "bun:test";
import { isNonRetryableError } from "@plugins/infra/plugins/jobs/server";
import type { SupervisedRunRow } from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import type { CheckoutState } from "@plugins/infra/plugins/worktree/server";
import { SUPERVISED_EXIT_TEMPFAIL } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core";
import {
  MAX_PREPARE_REQUESTS,
  MAX_TEMPFAIL_REQUESTS,
  prepareWorktree,
  tempfailBackoffMs,
  type PrepareDeps,
} from "./prepare-wait";

/**
 * What one prepare child does when it runs: make the checkout, fail, or be
 * refused a database connection because the database is full (`tempfail`:
 * EX_TEMPFAIL, nothing recorded — the row is in the database that refused it).
 */
type Outcome = "ok" | "tempfail" | { error: string };

/**
 * A fake world for the loop: the checkout on disk, the prepare runs, and the
 * durable ctx. Each wait is where time passes — a requested run is claimed,
 * an open run ends with the next scripted outcome.
 */
function world(opts: {
  state: CheckoutState;
  outcomes?: Outcome[];
  openRun?: boolean;
}) {
  let state = opts.state;
  const outcomes = [...(opts.outcomes ?? [])];
  let run: (SupervisedRunRow & { outcome?: Outcome }) | null = null;
  let pendingRequest = false;
  let nextId = 0;
  const log: string[] = [];
  const steps = new Map<string, unknown>();

  const startRun = (): void => {
    run = {
      id: `run-${nextId++}`,
      startedAt: new Date(),
      open: true,
      exitCode: null,
      errorMessage: null,
    };
  };
  if (opts.openRun) startRun();

  const advance = (): void => {
    if (run?.open) {
      const outcome = outcomes.shift() ?? "ok";
      if (outcome === "ok") {
        state = "complete";
        run = { ...run, open: false, exitCode: 0 };
      } else if (outcome === "tempfail") {
        run = { ...run, open: false, exitCode: SUPERVISED_EXIT_TEMPFAIL };
      } else {
        state = "unfinished";
        run = {
          ...run,
          open: false,
          exitCode: 1,
          errorMessage: outcome.error,
        };
      }
      log.push(`ended:${run.id}`);
    } else if (pendingRequest) {
      pendingRequest = false;
      startRun();
      log.push(`claimed:${run!.id}`);
    }
  };

  const deps: PrepareDeps = {
    kindId: "worktreeprepare",
    checkoutState: () => Promise.resolve(state),
    latestRun: () =>
      Promise.resolve(
        run === null
          ? null
          : {
              id: run.id,
              startedAt: run.startedAt,
              open: run.open,
              exitCode: run.exitCode,
              errorMessage: run.errorMessage,
            },
      ),
    request: () => {
      log.push("request");
      pendingRequest = true;
      return Promise.resolve();
    },
    adopt: () => {
      log.push("adopt");
      return Promise.resolve();
    },
  };

  const ctx = {
    step: async <R>(name: string, fn: () => Promise<R> | R): Promise<R> => {
      if (steps.has(name)) return steps.get(name) as R;
      const value = await fn();
      steps.set(name, value);
      return value;
    },
    waitFor: <T>(
      _event: unknown,
      waitOpts?: { where?: Partial<T>; name?: string },
    ): Promise<T | null> => {
      log.push(`wait:${JSON.stringify(waitOpts?.where)}`);
      advance();
      return Promise.resolve(null);
    },
    sleep: (ms: number): Promise<void> => {
      log.push(`sleep:${String(ms)}`);
      return Promise.resolve();
    },
  };
  return { deps, ctx, log };
}

describe("prepareWorktree", () => {
  test("a complete checkout is adopted in process: no request, no wait", async () => {
    const w = world({ state: "complete" });
    await prepareWorktree(w.ctx, "att-1", w.deps);
    expect(w.log).toEqual(["adopt"]);
  });

  test("an absent checkout is requested once, waited on, then adopted", async () => {
    const w = world({ state: "absent" });
    await prepareWorktree(w.ctx, "att-1", w.deps);
    expect(w.log).toEqual([
      "request",
      // Not claimed yet: wait for any run of the kind.
      'wait:{"kindId":"worktreeprepare"}',
      "claimed:run-0",
      // Open: wait for THAT run.
      'wait:{"kindId":"worktreeprepare","runId":"run-0"}',
      "ended:run-0",
      "adopt",
    ]);
  });

  test("an open run is waited on before the checkout is read — never raced", async () => {
    const w = world({ state: "complete", openRun: true });
    await prepareWorktree(w.ctx, "att-1", w.deps);
    expect(w.log).toEqual([
      'wait:{"kindId":"worktreeprepare","runId":"run-0"}',
      "ended:run-0",
      "adopt",
    ]);
  });

  test("a failed run is requested again; the last failure is non-retryable and names its error", async () => {
    const w = world({
      state: "absent",
      outcomes: [
        { error: "first" },
        { error: "second" },
        { error: "install failed" },
      ],
    });
    const err = await prepareWorktree(w.ctx, "att-1", w.deps).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isNonRetryableError(err)).toBe(true);
    expect((err as Error).message).toContain("install failed");
    expect(w.log.filter((l) => l === "request")).toHaveLength(
      MAX_PREPARE_REQUESTS,
    );
    expect(w.log).not.toContain("adopt");
  });

  test("a failed run then a good one ends adopted", async () => {
    const w = world({
      state: "unfinished",
      outcomes: [{ error: "cut" }, "ok"],
    });
    await prepareWorktree(w.ctx, "att-1", w.deps);
    expect(w.log.filter((l) => l === "request")).toHaveLength(2);
    expect(w.log.at(-1)).toBe("adopt");
  });

  test("a replay re-reads its memoized request instead of making it again", async () => {
    const w = world({ state: "absent" });
    // The first dispatch suspends at its first wait (the jobs plugin's suspend
    // signal leaves the handler); the replay walks the loop from the top with
    // the same step log.
    const suspend = new Error("suspend");
    const waitFor = w.ctx.waitFor;
    let suspended = false;
    const firstCtx = {
      step: w.ctx.step,
      sleep: w.ctx.sleep,
      waitFor: <T>(
        event: unknown,
        o?: { where?: Partial<T>; name?: string },
      ) => {
        if (!suspended) {
          suspended = true;
          // Time passes while suspended: the request is claimed.
          void waitFor(event, o);
          return Promise.reject(suspend);
        }
        return waitFor(event, o);
      },
    };
    const thrown = await prepareWorktree(firstCtx, "att-1", w.deps).then(
      () => null,
      (e: unknown) => e,
    );
    expect(thrown).toBe(suspend);
    await prepareWorktree(w.ctx, "att-1", w.deps);
    expect(w.log.filter((l) => l === "request")).toHaveLength(1);
    expect(w.log.at(-1)).toBe("adopt");
  });

  test("a run refused a database connection (EX_TEMPFAIL) is re-requested after a pause, without spending a request", async () => {
    const w = world({
      state: "absent",
      outcomes: ["tempfail", "tempfail", "ok"],
    });
    await prepareWorktree(w.ctx, "att-1", w.deps);
    expect(w.log.filter((l) => l === "request")).toHaveLength(3);
    expect(w.log.filter((l) => l.startsWith("sleep:"))).toEqual([
      `sleep:${String(tempfailBackoffMs(0))}`,
      `sleep:${String(tempfailBackoffMs(1))}`,
    ]);
    expect(w.log.at(-1)).toBe("adopt");
  });

  test("EX_TEMPFAIL runs do not count against the failure budget", async () => {
    // The 2026-10-28 shape: a launch storm refuses the first runs; real
    // failures afterwards still get their full MAX_PREPARE_REQUESTS.
    const w = world({
      state: "absent",
      outcomes: [
        "tempfail",
        "tempfail",
        { error: "a" },
        { error: "b" },
        { error: "install failed" },
      ],
    });
    const err = await prepareWorktree(w.ctx, "att-1", w.deps).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isNonRetryableError(err)).toBe(true);
    expect((err as Error).message).toContain("install failed");
    expect(w.log.filter((l) => l === "request")).toHaveLength(
      MAX_PREPARE_REQUESTS + 2,
    );
  });

  test("a database full for longer than the tempfail budget fails loudly, naming it", async () => {
    const w = world({
      state: "absent",
      outcomes: Array.from(
        { length: MAX_TEMPFAIL_REQUESTS + 1 },
        () => "tempfail",
      ),
    });
    const err = await prepareWorktree(w.ctx, "att-1", w.deps).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isNonRetryableError(err)).toBe(true);
    expect((err as Error).message).toContain("EX_TEMPFAIL");
    expect(w.log.filter((l) => l.startsWith("sleep:"))).toHaveLength(
      MAX_TEMPFAIL_REQUESTS,
    );
    expect(w.log.filter((l) => l === "request")).toHaveLength(
      MAX_TEMPFAIL_REQUESTS + 1,
    );
  });

  test("the tempfail pause doubles from 15 s and caps at 2 min", () => {
    expect([0, 1, 2, 3, 4, 7].map(tempfailBackoffMs)).toEqual([
      15_000, 30_000, 60_000, 120_000, 120_000, 120_000,
    ]);
  });
});
