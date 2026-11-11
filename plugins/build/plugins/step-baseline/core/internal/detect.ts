import type { BuildSteps, StepFsCalls } from "./steps";

// Judge one build's steps against their own recent baseline: the same step in
// the builds before it. A step that suddenly takes far longer, or makes far
// more file calls while the build rebuilt nothing, is a regression of the
// step — of our code, or of the host under it — and nothing else compares a
// build with its own normal. Pure: the caller reads the history.
//
// Every number is on `STEP_BASELINE_THRESHOLDS`, with the history it was chosen
// from (the plugin's CLAUDE.md, `scripts/replay-build-profiles.ts`).

export const STEP_BASELINE_THRESHOLDS = {
  /** Builds a baseline is read from, newest first. */
  window: 20,
  /** Fewer earlier samples of a step than this: no baseline, no verdict. */
  minSamples: 5,
  time: {
    /** The step took at least this many times its baseline median… */
    ratio: 3,
    /** …and at least this much longer than it (a 2 ms → 9 ms step is noise). */
    minIncreaseMs: 20_000,
    /** …and longer than every one of the baseline's samples but its top 10 %. */
    abovePercentile: 0.9,
  },
  fs: {
    /** File calls at least this many times the baseline median… */
    ratio: 2,
    /** …and at least this many more calls. */
    minIncrease: 5_000,
    /** …and more than the baseline's 90th percentile. */
    abovePercentile: 0.9,
  },
} as const;

export type StepMetric = "time" | "fs-calls";

/** Where a step's extra file calls went: a path prefix, now vs its baseline. */
export interface PrefixIncrease {
  prefix: string;
  calls: number;
  baselineCalls: number;
}

export interface StepRegression {
  step: string;
  metric: StepMetric;
  /** This build's value: ms for `time`, calls for `fs-calls`. */
  value: number;
  /** The baseline median, same unit. */
  baseline: number;
  /** How many earlier builds the baseline was read from. */
  samples: number;
  /** `fs-calls` only: this build's calls by kind. */
  calls: StepFsCalls | null;
  /** `fs-calls` only: the prefixes that grew most (largest increase first). */
  increases: PrefixIncrease[];
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) throw new Error("quantile of an empty sample");
  const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[i]!;
}

function median(sorted: readonly number[]): number {
  const n = sorted.length;
  return n % 2 === 1
    ? sorted[(n - 1) / 2]!
    : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
}

function exceeds(
  value: number,
  samples: number[],
  rule: { ratio: number; abovePercentile: number },
  minIncrease: number,
): { baseline: number } | null {
  const sorted = [...samples].sort((a, b) => a - b);
  const baseline = median(sorted);
  if (value < baseline * rule.ratio) return null;
  if (value - baseline < minIncrease) return null;
  if (value <= quantile(sorted, rule.abovePercentile)) return null;
  return { baseline };
}

function prefixIncreases(
  calls: StepFsCalls,
  baseline: StepFsCalls[],
): PrefixIncrease[] {
  return calls.top
    .map(({ prefix, calls: n }) => {
      const before = baseline
        .map((b) => b.top.find((t) => t.prefix === prefix)?.calls ?? 0)
        .sort((a, b) => a - b);
      return { prefix, calls: n, baselineCalls: median(before) };
    })
    .filter((p) => p.calls > p.baselineCalls)
    .sort((a, b) => b.calls - b.baselineCalls - (a.calls - a.baselineCalls));
}

/** Every step of `current` past its baseline, judged alone. */
function jumps(
  current: BuildSteps,
  earlier: readonly BuildSteps[],
  t: typeof STEP_BASELINE_THRESHOLDS,
): StepRegression[] {
  const found: StepRegression[] = [];
  for (const [step, sample] of current.steps) {
    const timeBase = earlier
      .flatMap((b) => {
        const s = b.steps.get(step);
        return s === undefined ? [] : [s.durationMs];
      })
      .slice(0, t.window);
    if (timeBase.length >= t.minSamples) {
      const hit = exceeds(
        sample.durationMs,
        timeBase,
        t.time,
        t.time.minIncreaseMs,
      );
      if (hit !== null)
        found.push({
          step,
          metric: "time",
          value: sample.durationMs,
          baseline: hit.baseline,
          samples: timeBase.length,
          calls: null,
          increases: [],
        });
    }

    if (sample.fs === null) continue;
    const fsBase = earlier
      .flatMap((b) => {
        const s = b.steps.get(step);
        return s?.fs != null ? [s.fs] : [];
      })
      .slice(0, t.window);
    if (fsBase.length < t.minSamples) continue;
    const hit = exceeds(
      sample.fs.total,
      fsBase.map((f) => f.total),
      t.fs,
      t.fs.minIncrease,
    );
    if (hit !== null)
      found.push({
        step,
        metric: "fs-calls",
        value: sample.fs.total,
        baseline: hit.baseline,
        samples: fsBase.length,
        calls: sample.fs,
        increases: prefixIncreases(sample.fs, fsBase),
      });
  }
  return found;
}

/**
 * The steps of `current` that jumped against `history` (earlier builds, any
 * order; the newest `window` that ran the step are its baseline) and stayed
 * there: the same step, same metric, also jumped in the previous build that
 * did the same work, against ITS baseline. Only a build that rebuilt nothing
 * is judged, against the earlier builds that rebuilt nothing — the same work
 * — on time and on file calls.
 *
 * One slow build is a cache miss or a busy minute (a host snapshot re-taken, a
 * re-keyed memo, the fleet at load 90); a slowdown that holds is a regression
 * of the step or of the host. Holding costs one build of delay.
 */
export function detectStepRegressions(
  current: BuildSteps,
  history: readonly BuildSteps[],
  t = STEP_BASELINE_THRESHOLDS,
): StepRegression[] {
  // Only a build that rebuilt nothing did the same work as another such
  // build: one that rebuilt artifacts compiles for minutes by design.
  if (current.rebuiltNothing !== true) return [];
  const earlier = history
    .filter((b) => b.at < current.at && b.rebuiltNothing === true)
    .sort((a, b) => b.at - a.at);
  const now = jumps(current, earlier, t);
  const previous = earlier[0];
  if (now.length === 0 || previous === undefined) return [];
  const before = new Set(
    jumps(previous, earlier.slice(1), t).map((r) => `${r.metric} ${r.step}`),
  );
  return now.filter((r) => before.has(`${r.metric} ${r.step}`));
}
