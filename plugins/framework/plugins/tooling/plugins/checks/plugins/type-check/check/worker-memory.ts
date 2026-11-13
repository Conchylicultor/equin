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

import { z } from "zod";
import {
  defineFileSink,
  readHistory,
  statHistory,
} from "@plugins/infra/plugins/file-sink/core";
import { PER_UNIT_BYTES } from "@plugins/infra/plugins/host/plugins/host-admission/core";
import { formatBytes } from "@plugins/packages/plugins/proc-rusage/core";
import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import { TYPE_CHECK_WORKER_PEAK_BYTES, TYPE_CHECK_WORKER_UNITS } from "../core";
import { workerMemoryLogDir } from "../data-dirs";

const MEMORY_FILE = workerMemoryLogDir.file("worker-memory.jsonl");
const KEEP = 2;

// ~200 bytes a line: 2 MB × 3 files holds ~30k runs, weeks of this host's.
const MAX_LINES = 50_000;
const memorySink = defineFileSink({
  id: "type-check-worker-memory",
  description:
    "One JSONL line per type-check worker run on this host: how it was admitted, the worker's peak physical footprint and its batch processes' — what the worker's grant weight and host admission's RAM quantum are checked against.",
  path: MEMORY_FILE,
  maxBytes: 2 * 1024 * 1024,
  keep: KEEP,
});

export const WorkerMemoryRecordSchema = z.object({
  /** When the run ended (ISO). */
  t: z.string(),
  worktree: z.string(),
  /** Which pool admitted it: `type-check-light`, or `type-check-worker` (heavy / escalated). */
  admission: z.enum(["light", "heavy", "escalated"]),
  /** The worker process's own peak physical footprint. */
  workerBytes: z.number().nonnegative(),
  /** Its batch processes, when it ran any: how many, and the upper bound on their peaks alive at once. */
  batches: z
    .object({
      count: z.number().int().positive(),
      concurrentBytes: z.number().nonnegative(),
    })
    .nullable(),
});
export type WorkerMemoryRecord = z.infer<typeof WorkerMemoryRecordSchema>;

/** Append one run's measurement. */
export async function recordWorkerMemory(
  record: WorkerMemoryRecord,
): Promise<void> {
  await memorySink.append(
    JSON.stringify(WorkerMemoryRecordSchema.parse(record)),
  );
}

/**
 * A run's tree peak, as the weight is defined: the worker's own peak plus its
 * batches' peak at once — an UPPER bound, since the two need not coincide (a
 * worker sampled during its batches sat at 0.5–1.0 GB, below its own 1.5–2.9 GB
 * peak). Only a run that took the heavy pool and batched counts: that is the
 * run the two units are reserved for. A light run (≤ 0.5–3.4 GB) is not.
 */
export function heavyTreePeak(r: WorkerMemoryRecord): number | null {
  if (r.admission === "light" || r.batches === null) return null;
  return r.workerBytes + r.batches.concurrentBytes;
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

/** The verdict on the constants, given the heavy runs' tree peaks. Pure. */
export function judgeWorkerWeight(
  peaks: readonly number[],
  c: WeightConstants,
): CheckResult {
  if (peaks.length < MIN_SAMPLES) {
    return {
      ok: false,
      inconclusive: true,
      message: `only ${peaks.length} heavy batched type-check runs recorded in the last 14 days (${MEMORY_FILE}); ${MIN_SAMPLES} are needed to judge the worker's weight.`,
    };
  }
  const sorted = [...peaks].sort((a, b) => a - b);
  const mean = sorted.reduce((s, p) => s + p, 0) / sorted.length;
  const p50 = sorted[Math.floor(sorted.length / 2)]!;
  const max = sorted.at(-1)!;
  const measured = `${sorted.length} heavy batched runs: tree peak (worker + batches at once) mean ${formatBytes(mean)}, p50 ${formatBytes(p50)}, max ${formatBytes(max)}`;
  const off = (declared: number, actual: number) =>
    Math.abs(actual - declared) > WEIGHT_TOLERANCE * declared;
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
    hint: "Re-derive the named constant from these records (type-check core/worker-weight.ts, host-admission core/internal/budget.ts) and say where it came from beside it; never move it by a guessed offset. A moved PER_UNIT_BYTES resizes B: recompute its interval (budget.ts).",
  };
}

/** The heavy runs' tree peaks recorded since `sinceMs`. */
export async function readHeavyTreePeaks(sinceMs: number): Promise<number[]> {
  // The rotated history read as one ordered whole (file-sink's own reader,
  // which follows a rotation that lands mid-read by birth time).
  const lines = await readHistory(MEMORY_FILE, {
    before: null,
    notBefore: null,
    limit: MAX_LINES,
  });
  const peaks: number[] = [];
  for (const { text } of lines) {
    // A malformed line is a writer bug: parse throws, loudly.
    const r = WorkerMemoryRecordSchema.parse(JSON.parse(text));
    if (Date.parse(r.t) < sinceMs) continue;
    const peak = heavyTreePeak(r);
    if (peak !== null) peaks.push(peak);
  }
  return peaks;
}

export const workerWeightCheck: Check = {
  id: "type-check:worker-weight-measured",
  description:
    "The type-check worker's declared peak (TYPE_CHECK_WORKER_PEAK_BYTES) and host admission's RAM quantum per unit it spends (PER_UNIT_BYTES) each agree within 20 % with the last 14 days of heavy runs' measured footprints on this host.",
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
      `unit:${PER_UNIT_BYTES}`,
    ].join("\n");
  },
  run: async () =>
    judgeWorkerWeight(await readHeavyTreePeaks(Date.now() - WINDOW_MS), {
      peakBytes: TYPE_CHECK_WORKER_PEAK_BYTES,
      units: TYPE_CHECK_WORKER_UNITS,
      perUnitBytes: PER_UNIT_BYTES,
    }),
};
