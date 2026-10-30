import { describe, expect, test } from "bun:test";
import { getProfilingData } from "@plugins/framework/plugins/server-core/core";
import {
  onSlowSpan,
  type SlowSpan,
} from "@plugins/infra/plugins/runtime-profiler/core";
import {
  drainWarmupsWith,
  type WarmupExecDeps,
  type WarmupRun,
} from "./executor";
import { DEFAULT_WARMUP_BUDGET_MS, type WarmupSpec } from "./registry";

// A passthrough heavy-read slot + a real macrotask yield, so the tests exercise
// the executor's own concurrency gate / scope gate (`runs`, stubbed — the host's
// `WarmupHost.runs` in production) / error handling without the
// host flock semaphore or the profiler wiring.
function baseDeps(
  warmups: WarmupSpec[],
  overrides: Partial<WarmupExecDeps> = {},
): WarmupExecDeps {
  return {
    warmups,
    runs: () => true,
    withSlot: (fn) => fn(),
    yieldMacrotask: () => new Promise<void>((r) => setImmediate(r)),
    concurrency: 2,
    ...overrides,
  };
}

describe("drainWarmupsWith", () => {
  test("skips a warm-up whose scope the host does not run", async () => {
    let ran = false;
    const warmups: WarmupSpec[] = [
      {
        name: "host-one",
        description: "Test warm-up.",
        scope: "host",
        run: async () => {
          ran = true;
        },
      },
    ];
    const runs: Record<string, WarmupRun> = {};
    await drainWarmupsWith(
      baseDeps(warmups, {
        runs: (scope) => scope === "worktree",
        onRun: (name, run) => {
          runs[name] = run;
        },
      }),
    );
    expect(ran).toBe(false);
    expect(runs["host-one"]).toEqual({ outcome: "skipped" });
  });

  test("runs host-scoped warm-ups when the host runs that scope", async () => {
    let ran = false;
    const warmups: WarmupSpec[] = [
      {
        name: "host-one",
        description: "Test warm-up.",
        scope: "host",
        run: async () => {
          ran = true;
        },
      },
    ];
    await drainWarmupsWith(baseDeps(warmups, { runs: () => true }));
    expect(ran).toBe(true);
  });

  test("asks the host per scope", async () => {
    let ran = false;
    const warmups: WarmupSpec[] = [
      {
        name: "wt-one",
        description: "Test warm-up.",
        scope: "worktree",
        run: async () => {
          ran = true;
        },
      },
    ];
    const asked: string[] = [];
    await drainWarmupsWith(
      baseDeps(warmups, {
        runs: (scope) => {
          asked.push(scope);
          return scope === "worktree";
        },
      }),
    );
    expect(ran).toBe(true);
    expect(asked).toEqual(["worktree"]);
  });

  test("never exceeds the concurrency cap", async () => {
    let active = 0;
    let maxObserved = 0;
    const makeRun = () => async () => {
      active++;
      maxObserved = Math.max(maxObserved, active);
      await new Promise<void>((r) => setTimeout(r, 5));
      active--;
    };
    const warmups: WarmupSpec[] = Array.from({ length: 6 }, (_, i) => ({
      name: `w${i}`,
      description: "Test warm-up.",
      scope: "worktree" as const,
      run: makeRun(),
    }));
    await drainWarmupsWith(baseDeps(warmups, { concurrency: 2 }));
    expect(maxObserved).toBeLessThanOrEqual(2);
    expect(maxObserved).toBeGreaterThan(0);
  });

  test("a throwing warm-up does not abort the others", async () => {
    const ran: string[] = [];
    const warmups: WarmupSpec[] = [
      {
        name: "before",
        description: "Test warm-up.",
        scope: "worktree",
        run: async () => {
          ran.push("before");
        },
      },
      {
        name: "boom",
        description: "Test warm-up.",
        scope: "worktree",
        run: async () => {
          throw new Error("kaboom");
        },
      },
      {
        name: "after",
        description: "Test warm-up.",
        scope: "worktree",
        run: async () => {
          ran.push("after");
        },
      },
    ];
    // Must resolve (not reject) despite the throwing warm-up.
    await drainWarmupsWith(baseDeps(warmups, { concurrency: 1 }));
    expect(ran).toContain("before");
    expect(ran).toContain("after");
  });

  test("yields (a macrotask) before each warm-up that runs", async () => {
    let yields = 0;
    const warmups: WarmupSpec[] = [
      {
        name: "a",
        description: "Test warm-up.",
        scope: "worktree",
        run: async () => {},
      },
      {
        name: "b",
        description: "Test warm-up.",
        scope: "worktree",
        run: async () => {},
      },
    ];
    await drainWarmupsWith(
      baseDeps(warmups, {
        yieldMacrotask: async () => {
          yields++;
        },
      }),
    );
    expect(yields).toBe(2);
  });

  test("stamps the budget on the bg span only — slow-ops is a warm-up's one judge", async () => {
    const seen: SlowSpan[] = [];
    const sub = onSlowSpan((span) => seen.push(span), { thresholdMs: 0 });
    try {
      await drainWarmupsWith(
        baseDeps([
          {
            name: "budgeted-one",
            description: "Test warm-up.",
            scope: "worktree",
            budgetMs: 15_000,
            run: async () => {},
          },
          {
            name: "unbudgeted-one",
            description: "Test warm-up.",
            scope: "worktree",
            run: async () => {},
          },
        ]),
      );
    } finally {
      sub.dispose();
    }
    // The boot span stays, as the Gantt bar.
    const boot = getProfilingData().spans;
    expect(boot.find((s) => s.id === "warmup:budgeted-one")).toBeDefined();
    const bg = (label: string) =>
      seen.find((s) => s.kind === "bg" && s.label === label);
    expect(bg("warmup:budgeted-one")?.budgetMs).toBe(15_000);
    expect(bg("warmup:unbudgeted-one")?.budgetMs).toBe(
      DEFAULT_WARMUP_BUDGET_MS,
    );
  });

  test("a run is timed from its slot grant, not from when it queued for it", async () => {
    const runs: Record<string, WarmupRun> = {};
    const warmups: WarmupSpec[] = [
      {
        name: "queued",
        description: "Test warm-up.",
        scope: "worktree",
        run: async () => {
          await new Promise<void>((r) => setTimeout(r, 5));
        },
      },
    ];
    await drainWarmupsWith(
      baseDeps(warmups, {
        // The host's slot grants only after 80 ms of queueing.
        withSlot: async (fn) => {
          await new Promise<void>((r) => setTimeout(r, 80));
          return fn();
        },
        onRun: (name, run) => {
          runs[name] = run;
        },
      }),
    );
    const run = runs["queued"]!;
    expect(run.outcome).toBe("succeeded");
    if (run.outcome !== "succeeded") return;
    expect(run.durationMs).toBeLessThan(60);
  });
});
