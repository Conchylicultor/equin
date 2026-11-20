// What a type-check worker run costs in memory, recorded per run on this host,
// and the check that holds the constants sized from it to the record.
//
// `TYPE_CHECK_WORKER_PEAK_BYTES` (the worker's grant weight, `../core`) and
// host-admission's `PER_UNIT_BYTES` (the fleet's RAM quantum) used to be read
// off transcripts by hand, once, and then left: the 7.2e9 / 3.6e9 pair was
// calibrated on getrusage maxRSS, which counts freed allocator pages, and stayed
// in place after every log line moved to the physical footprint (2026-11-13). A
// constant nobody re-measures drifts silently from what it claims. So each run
// appends its measurement to a bounded host log, and a host check
// (`type-check:worker-weight-measured`, run hourly by main's host audit) fails
// when the constants no longer agree with the last two weeks of runs.

import {
  readHistory,
  statHistory,
} from "@plugins/infra/plugins/file-sink/core";
import { PER_UNIT_BYTES } from "@plugins/infra/plugins/host/plugins/host-admission/core";
import { formatBytes } from "@plugins/packages/plugins/proc-rusage/core";
import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import {
  TYPE_CHECK_BACKSTOP_PEAK_BYTES,
  TYPE_CHECK_BACKSTOP_UNITS,
  TYPE_CHECK_WORKER_PEAK_BYTES,
  TYPE_CHECK_WORKER_UNITS,
} from "../core";
import {
  WORKER_MEMORY_FILE as MEMORY_FILE,
  WORKER_MEMORY_MAX_LINES as MAX_LINES,
  WorkerMemoryRecordSchema,
  type WorkerMemoryRecord,
} from "../shared/worker-memory-log";

export type { WorkerMemoryRecord };

/**
 * A run's tree peak, as the weight is defined: the worker's own peak plus its
 * batches' peak at once — an UPPER bound, since the two need not coincide (a
 * worker sampled during its batches sat at 0.5–1.0 GB, below its own 1.5–2.9 GB
 * peak). Only a run that took the heavy pool, batched and ran the full memory
 * profile counts: that is the run the two units are reserved for. A light run (≤ 0.5–3.4 GB) is not.
 */
export function heavyTreePeak(r: WorkerMemoryRecord): number | null {
  if (r.admission === "light" || r.batches === null) return null;
  // A one-unit run is sized to fit ONE unit, not the full weight: judging the
  // full weight on it would pull the declared peak down toward a profile a
  // roomy host never runs.
  if ((r.profile ?? "full") !== "full") return null;
  return r.workerBytes + r.batches.concurrentBytes;
}

/**
 * A dual run's tree peak, as the backstop's weight is defined: the larger of
 * its two phases — the oracle process beside the worker (spawned first, while
 * the worker holds nothing of its walks; the worker's own LIFETIME peak is
 * added all the same, so an upper bound), and the worker beside its batches.
 * Null for any run that is not a dual one with its oracle measured.
 */
export function backstopTreePeak(r: WorkerMemoryRecord): number | null {
  if (r.mode !== "dual" || r.fullCheckBytes === undefined) return null;
  return Math.max(
    r.workerBytes + r.fullCheckBytes,
    r.workerBytes + (r.batches?.concurrentBytes ?? 0),
  );
}

/** How far a declared constant may sit from the measured mean before it is stale. */
export const WEIGHT_TOLERANCE = 0.2;
/** Fewer heavy runs than this in the window cannot judge a mean. */
export const MIN_SAMPLES = 5;
/** How far back a sample still describes today's code. */
export const WINDOW_MS = 14 * 24 * 3600 * 1000;

export interface WeightConstants {
  peakBytes: number;
  units: number;
  perUnitBytes: number;
}

/** The measured peaks summarized, or the inconclusive verdict when too few. */
function summarize(
  peaks: readonly number[],
  what: string,
): { mean: number; measured: string } | CheckResult {
  if (peaks.length < MIN_SAMPLES) {
    return {
      ok: false,
      inconclusive: true,
      message: `only ${peaks.length} ${what} recorded in the last 14 days (${MEMORY_FILE}); ${MIN_SAMPLES} are needed to judge the weight.`,
    };
  }
  const sorted = [...peaks].sort((a, b) => a - b);
  const mean = sorted.reduce((s, p) => s + p, 0) / sorted.length;
  const p50 = sorted[Math.floor(sorted.length / 2)]!;
  const max = sorted.at(-1)!;
  return {
    mean,
    measured: `${sorted.length} ${what}: tree peak mean ${formatBytes(mean)}, p50 ${formatBytes(p50)}, max ${formatBytes(max)}`,
  };
}

const off = (declared: number, actual: number) =>
  Math.abs(actual - declared) > WEIGHT_TOLERANCE * declared;

const HINT =
  "Re-derive the named constant from these records (type-check core/worker-weight.ts, host-admission core/internal/budget.ts) and say where it came from beside it; never move it by a guessed offset. A moved PER_UNIT_BYTES resizes B: recompute its interval (budget.ts).";

/** The verdict on the worker's constants, given the heavy runs' tree peaks. Pure. */
export function judgeWorkerWeight(
  peaks: readonly number[],
  c: WeightConstants,
): CheckResult {
  const sum = summarize(
    peaks,
    "heavy batched type-check runs (worker + batches at once)",
  );
  if (!("mean" in sum)) return sum;
  const { mean, measured } = sum;
  const problems: string[] = [];
  // The units follow from the declared peak (`TYPE_CHECK_WORKER_UNITS` is
  // derived from it), so the two statements below are each fixable on their
  // own: a stale peak by re-deriving it (the units reflow), and a quantum
  // that no longer matches the worker it is calibrated on by re-deriving
  // `PER_UNIT_BYTES` — never by one to rescue the other.
  if (off(c.peakBytes, mean)) {
    problems.push(
      `TYPE_CHECK_WORKER_PEAK_BYTES is ${formatBytes(c.peakBytes)}, more than ${WEIGHT_TOLERANCE * 100} % from the measured mean`,
    );
  }
  if (off(c.perUnitBytes, mean / c.units)) {
    problems.push(
      `PER_UNIT_BYTES is ${formatBytes(c.perUnitBytes)}, but the worker it is calibrated on measures ${formatBytes(mean / c.units)} per unit spent (${c.units} units)`,
    );
  }
  if (problems.length === 0) return { ok: true };
  return {
    ok: false,
    message: `${problems.join("; ")} — ${measured}.`,
    hint: HINT,
  };
}

/**
 * The verdict on the backstop's declared peak, given the dual runs' tree
 * peaks. Pure. Its units are derived from the peak and the quantum, so only
 * the peak is judged here: the quantum is the fleet's, calibrated on the
 * worker above.
 */
export function judgeBackstopWeight(
  peaks: readonly number[],
  peakBytes: number,
): CheckResult {
  const sum = summarize(
    peaks,
    "dual (backstop) type-check runs (larger of oracle or batches, beside the worker)",
  );
  if (!("mean" in sum)) return sum;
  if (!off(peakBytes, sum.mean)) return { ok: true };
  return {
    ok: false,
    message: `TYPE_CHECK_BACKSTOP_PEAK_BYTES is ${formatBytes(peakBytes)}, more than ${WEIGHT_TOLERANCE * 100} % from the measured mean — ${sum.measured}.`,
    hint: HINT,
  };
}

/** Every run recorded since `sinceMs`. */
export async function readWorkerMemory(
  sinceMs: number,
): Promise<WorkerMemoryRecord[]> {
  // The rotated history read as one ordered whole (file-sink's own reader,
  // which follows a rotation that lands mid-read by birth time).
  const lines = await readHistory(MEMORY_FILE, {
    before: null,
    notBefore: null,
    limit: MAX_LINES,
  });
  const out: WorkerMemoryRecord[] = [];
  for (const { text } of lines) {
    // A malformed line is a writer bug: parse throws, loudly.
    const r = WorkerMemoryRecordSchema.parse(JSON.parse(text));
    if (Date.parse(r.t) >= sinceMs) out.push(r);
  }
  return out;
}

const peaksOf = (
  records: readonly WorkerMemoryRecord[],
  peakOf: (r: WorkerMemoryRecord) => number | null,
): number[] => records.map(peakOf).filter((p): p is number => p !== null);

/**
 * The weights' verdicts as one: any real failure fails (all of them named);
 * otherwise a weight judged ok passes the check even while another is still
 * short of samples (the backstop's, for its first days: it runs once a day);
 * inconclusive only when no weight could be judged at all.
 */
export function combineVerdicts(verdicts: readonly CheckResult[]): CheckResult {
  const notOk = verdicts.filter(
    (v): v is Extract<CheckResult, { ok: false }> => !v.ok,
  );
  const failed = notOk.filter((v) => !v.inconclusive);
  const pick =
    failed.length > 0 ? failed : verdicts.some((v) => v.ok) ? [] : notOk;
  if (pick.length === 0) return { ok: true };
  const hint = pick.find((v) => v.hint !== undefined)?.hint;
  return {
    ok: false,
    ...(failed.length === 0 ? { inconclusive: true as const } : {}),
    message: pick.map((v) => v.message).join("\n"),
    ...(hint !== undefined ? { hint } : {}),
  };
}

export const workerWeightCheck: Check = {
  id: "type-check:worker-weight-measured",
  description:
    "The type-check worker's declared peak (TYPE_CHECK_WORKER_PEAK_BYTES), host admission's RAM quantum per unit it spends (PER_UNIT_BYTES) and the backstop's declared peak (TYPE_CHECK_BACKSTOP_PEAK_BYTES) each agree within 20 % with the last 14 days of measured footprints on this host.",
  // About this machine's record of runs, not the tree: every checkout's runs
  // land in the one host log.
  scope: "host",
  async cacheSignature(): Promise<string> {
    const files = (await statHistory(MEMORY_FILE)).map(
      (f) => `${f.bornKey}:${f.bytes}`,
    );
    // The window slides with the day, so a verdict holds for that day only.
    const day = Math.floor(Date.now() / (24 * 3600 * 1000));
    return [
      ...files,
      `day:${day}`,
      `peak:${TYPE_CHECK_WORKER_PEAK_BYTES}`,
      `units:${TYPE_CHECK_WORKER_UNITS}`,
      `backstop:${TYPE_CHECK_BACKSTOP_PEAK_BYTES}:${TYPE_CHECK_BACKSTOP_UNITS}`,
      `unit:${PER_UNIT_BYTES}`,
    ].join("\n");
  },
  run: async () => {
    const records = await readWorkerMemory(Date.now() - WINDOW_MS);
    return combineVerdicts([
      judgeWorkerWeight(peaksOf(records, heavyTreePeak), {
        peakBytes: TYPE_CHECK_WORKER_PEAK_BYTES,
        units: TYPE_CHECK_WORKER_UNITS,
        perUnitBytes: PER_UNIT_BYTES,
      }),
      judgeBackstopWeight(
        peaksOf(records, backstopTreePeak),
        TYPE_CHECK_BACKSTOP_PEAK_BYTES,
      ),
    ]);
  },
};
