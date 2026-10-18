import type {
  BackgroundEntryDraft,
  BackgroundRun,
} from "@plugins/infra/plugins/background/plugins/catalog/core";
import { defineBackgroundKind } from "@plugins/infra/plugins/background/plugins/catalog/server";
import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import {
  listRegisteredWarmups,
  warmupRunOf,
  type WarmupRun,
} from "@plugins/infra/plugins/warmup/server";

function toRun(run: WarmupRun | undefined): BackgroundRun | null {
  if (run === undefined || run.outcome === "skipped") return null;
  if (run.outcome === "running") {
    return {
      startedAt: run.startedAt.toISOString(),
      finishedAt: null,
      outcome: "running",
      durationMs: null,
      error: null,
    };
  }
  return {
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt.toISOString(),
    outcome: run.outcome,
    durationMs: run.durationMs,
    error: run.error,
  };
}

/** Every declared warm-up as a catalog entry, with its run in this process. */
export function listWarmupEntries(): BackgroundEntryDraft[] {
  const main = isMain();
  return listRegisteredWarmups().map(({ spec: w, declaredIn }) => {
    const scope = w.scope === "host" ? "main" : "every-worktree";
    const lastRun = toRun(warmupRunOf(w.name));
    const finished = lastRun !== null && lastRun.outcome !== "running";
    return {
      name: w.name,
      description: w.description,
      group: "After boot",
      trigger: { kind: "boot" },
      scope,
      runsHere: scope === "main" ? main : true,
      declaredIn,
      lastRun,
      history: {
        runs: finished ? 1 : 0,
        failures: lastRun?.outcome === "failed" ? 1 : 0,
        lastSuccessAt:
          lastRun?.outcome === "succeeded" ? lastRun.finishedAt : null,
      },
      canRunNow: false,
      internal: false,
      facts:
        w.budgetMs === undefined
          ? []
          : [{ label: "Budget", value: `${Math.round(w.budgetMs)} ms` }],
    };
  });
}

/** A warm-up runs once per boot: its recent runs are that one run. */
async function warmupRecentRuns(name: string): Promise<BackgroundRun[]> {
  if (!listRegisteredWarmups().some((w) => w.spec.name === name)) {
    throw new Error(`[warmup] no warm-up named "${name}" is registered`);
  }
  const run = toRun(warmupRunOf(name));
  return run === null ? [] : [run];
}

export const warmupsBackgroundKind = defineBackgroundKind({
  kind: "warmup",
  order: 10,
  label: "Warm-ups",
  // Warm-up state is the in-process registry, never Postgres.
  tables: [],
  list: () => Promise.resolve(listWarmupEntries()),
  recentRuns: warmupRecentRuns,
});
