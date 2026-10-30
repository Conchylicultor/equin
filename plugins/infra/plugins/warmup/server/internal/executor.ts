import { profilerStart } from "@plugins/framework/plugins/server-core/core";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import { yieldMacrotask } from "@plugins/packages/plugins/macrotask-yield/core";
import { WarmupHost } from "./host";
import { warmupRegistry, type WarmupSpec } from "./registry";
import { recordWarmupRun } from "./runs";

/**
 * How many warm-ups may run at once. Kept deliberately small: warm-ups drain
 * *while the server is already serving requests*, so the cap (plus the heavy-read
 * slot and macrotask yield) keeps the drain from competing with first requests.
 */
export const WARMUP_CONCURRENCY = 2;

/**
 * Injectable dependencies for {@link drainWarmupsWith} — the real wiring lives in
 * {@link drainWarmups}, the seam exists so tests can drive the executor with
 * stubbed scope gate / slot / yield / registry (mirroring `usage-index.ts`'s
 * injectable-deps testability).
 */
export interface WarmupExecDeps {
  warmups: WarmupSpec[];
  /** Whether a warm-up of this scope runs on this host (`WarmupHost.runs`). */
  runs: (scope: WarmupSpec["scope"]) => boolean;
  withSlot: <T>(fn: () => Promise<T>) => Promise<T>;
  yieldMacrotask: () => Promise<void>;
  concurrency: number;
  /** Told when each warm-up starts and settles (in-memory run record). */
  onRun?: (name: string, run: WarmupRun) => void;
}

/**
 * One warm-up's run in this process — kept in memory, since a warm-up runs
 * once per boot. `skipped`: a warm-up whose scope this host does not run (a
 * `host`-scoped one on a desktop backend that is not main) — the executor
 * never started it.
 */
export type WarmupRun =
  | { outcome: "running"; startedAt: Date }
  | {
      outcome: "succeeded" | "failed";
      startedAt: Date;
      finishedAt: Date;
      durationMs: number;
      error: string | null;
    }
  | { outcome: "skipped" };

/**
 * Drain the given warm-ups. Executor semantics (baked in, not per-consumer):
 * - a warm-up whose scope the host does not run (`runs(scope)` false — on the
 *   desktop, a `host`-scoped one off main: kills N×-worktree redundancy on
 *   host-global work) is SKIPPED;
 * - each `run` is gated by a bounded `createSemaphore(concurrency)` and wrapped
 *   in `withSlot` (the host-wide heavy-read budget), with a macrotask
 *   `yieldMacrotask()` before each so request IO/timers interleave;
 * - each is wrapped in a `warmup:<name>` profiler span for boot-Gantt visibility,
 *   timed — like its recorded run — from the moment its slot is granted;
 * - a throw is NEVER fatal — a warm-up is an optimization, so it is logged and
 *   the drain continues (the boot-budget monitor separately flags slow/failed
 *   warm-ups).
 */
export async function drainWarmupsWith(deps: WarmupExecDeps): Promise<void> {
  const gate = createSemaphore(deps.concurrency);
  await Promise.all(
    deps.warmups.map((w) =>
      gate.run(async () => {
        if (!deps.runs(w.scope)) {
          deps.onRun?.(w.name, { outcome: "skipped" });
          return;
        }
        // A real macrotask breath before each heavy unit — unlike a microtask
        // `await Promise.resolve()`, this admits queued request IO/timers.
        await deps.yieldMacrotask();
        // The declared budget rides on BOTH spans, so the boot-budget monitor
        // (boot span) and slow-ops (`bg` span) judge the warm-up on the bar it
        // declared rather than on their global defaults.
        const budget =
          w.budgetMs === undefined ? undefined : { budgetMs: w.budgetMs };
        // The run is timed from the moment the host's slot is GRANTED: a
        // warm-up queued behind others' heavy reads is not slow itself (the
        // boot Gantt bar, `startedAt` and `durationMs` all start inside the
        // slot). The `bg` span (`runTracked`) stays around the slot so the
        // queue is still charged to it, as the gate's wait — which slow-ops
        // takes off its own time.
        let started: { at: Date; t0: number; end: () => void } | null = null;
        let error: string | null = null;
        try {
          // Boot-Gantt bar (profilerStart) and runtime `bg` aggregate
          // (runTracked) are complementary: the former is the coarse boot phase,
          // the latter gives the warm-up's internal DB/file work an ambient span
          // so it appears under its own name in the profiler instead of vanishing.
          await runTracked(
            `warmup:${w.name}`,
            () =>
              deps.withSlot(() => {
                started = {
                  end: profilerStart(
                    `warmup:${w.name}`,
                    "warmup",
                    w.name,
                    w.name,
                    budget,
                  ),
                  at: new Date(),
                  t0: performance.now(),
                };
                deps.onRun?.(w.name, {
                  outcome: "running",
                  startedAt: started.at,
                });
                return w.run();
              }),
            budget,
          );
          // A warm-up is an optimization, never a correctness dependency: every failure maps to the same handling (log loudly + keep draining the other warm-ups), so one bad warm-up can neither abort its siblings nor reject drainWarmups() into the settled phase. Mirrors the framework's own onShutdown isolation loop.
        } catch (err) {
          console.error(`[warmup] ${w.name} failed`, err);
          error = err instanceof Error ? err.message : String(err);
        } finally {
          // Never granted a slot (its acquire threw): it never ran, so it was
          // never timed — the failure above still names it.
          const run = started as {
            at: Date;
            t0: number;
            end: () => void;
          } | null;
          const startedAt = run?.at ?? new Date();
          run?.end();
          deps.onRun?.(w.name, {
            outcome: error === null ? "succeeded" : "failed",
            startedAt,
            finishedAt: new Date(),
            durationMs:
              run === null
                ? 0
                : Math.round((performance.now() - run.t0) * 10) / 10,
            error,
          });
        }
      }),
    ),
  );
}

/**
 * Drain every registered warm-up — this plugin's `onSettled`, so every serving
 * host (the desktop's `serve`, the browser host) runs it once after the
 * `onAllReady` barrier, with all migrations and `onReady` state settled, and
 * an `exec` child never does. Scope and admission are the host's answer
 * (`WarmupHost`).
 */
export async function drainWarmups(): Promise<void> {
  const host = WarmupHost.get();
  await drainWarmupsWith({
    warmups: [...warmupRegistry.values()],
    runs: (scope) => host.runs(scope),
    withSlot: (fn) => host.withSlot(fn),
    yieldMacrotask,
    concurrency: WARMUP_CONCURRENCY,
    onRun: recordWarmupRun,
  });
}
