/**
 * The steps making a checkout takes, timed — so a slow launch (or spare
 * refill) says WHICH step took the time, in its own log, every time.
 *
 * Before these spans the `worktree.prepare` child logged only a start and a
 * result line, and its cold path (29–51 s p50, 2–4 min p90) could not be split
 * (research/2026-11-17-global-launch-and-build-latency-benchmark.md §1).
 *
 * The step names are a closed set, so a reader can aggregate a log over time:
 *
 * - `gate-wait`     waiting for a host-wide `worktree-mutate` slot
 * - `claim`         finding, unlocking and moving a ready spare
 * - `switch`        `git switch` of a claimed spare onto the attempt branch
 * - `add`           a cold add, whole — its `tree-write` is reported inside it
 * - `tree-write`    the add's `git reset --hard` (+ `git clean` on a recycled
 *                   tree); twice in one add when a recycled tree fails and the
 *                   add writes from empty (the first marked failed)
 * - `lock`          locking the checkout
 * - `dep-store`     adopting a waiting dependency store, or copying the seed
 * - `install`       the checkout's own `./equin install` (bun install + provisions)
 * - `fsmonitor`     turning the checkout's git fsmonitor on (config + daemon;
 *                   for a checkout already there, renewing a stale index token)
 * - `index-refresh` filling the new checkout's index (untracked cache)
 */
export type SetupStepName =
  | "gate-wait"
  | "claim"
  | "switch"
  | "add"
  | "tree-write"
  | "lock"
  | "dep-store"
  | "install"
  | "fsmonitor"
  | "index-refresh";

export interface SetupStep {
  step: SetupStepName;
  ms: number;
  /** Set when the step threw: its time is still the time it took. */
  failed?: true;
}

/** Called as each step ends — so a hung step's predecessors are already logged. */
export type OnSetupStep = (step: SetupStep) => void;

/** Run `fn` as step `step`, reporting its duration (also when it throws). */
export async function timeStep<T>(
  onStep: OnSetupStep,
  step: SetupStepName,
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = performance.now();
  let out: T;
  try {
    out = await fn();
  } catch (err) {
    onStep({ step, ms: performance.now() - t0, failed: true });
    throw err;
  }
  onStep({ step, ms: performance.now() - t0 });
  return out;
}

function duration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** One step as a log fragment: `install 12.3 s` (`install FAILED after 12.3 s`, `lock 4 ms`). */
export function describeSetupStep(s: SetupStep): string {
  return s.failed
    ? `${s.step} FAILED after ${duration(s.ms)}`
    : `${s.step} ${duration(s.ms)}`;
}

/**
 * Records every step it is handed and forwards it — for a caller that logs
 * each step as it ends and a one-line summary at the end. The summary leads
 * with the wall time since the record was made, so what no step covers (the
 * repo-root and branch reads, convergence of a cut-off checkout, the minter
 * stamp) shows as the difference.
 */
export function recordSetupSteps(forward: OnSetupStep): {
  onStep: OnSetupStep;
  summary: () => string;
} {
  const t0 = performance.now();
  const steps: SetupStep[] = [];
  return {
    onStep(s) {
      steps.push(s);
      forward(s);
    },
    summary: () =>
      [
        `total ${duration(performance.now() - t0)}`,
        ...steps.map(describeSetupStep),
      ].join(", "),
  };
}
