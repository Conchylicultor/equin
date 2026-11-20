// What a type-check worker run costs in memory, recorded per run on this host.
//
// Written by `spawnTypeCheckWorker` (`../server/internal/spawn-worker.ts`),
// the one place a worker starts — so every caller's run lands here (the check,
// the build's `--skip-checks` path, the dual backstop), and a caller cannot
// spawn a worker whose memory goes unrecorded. It used to be written by the
// check alone, after its record phase: the backstop's dual run, the heaviest
// of all (a whole-program oracle, 14.9–21.3 GB of process tree on six nights
// to 2026-11-19, under a 7 GB weight), was never in it, so the weight check
// could not see it.
//
// Read by `../check/worker-memory.ts`, whose host check holds each declared
// weight (`../core/worker-weight.ts`) to this record.

import { z } from "zod";
import { defineFileSink } from "@plugins/infra/plugins/file-sink/core";
import { workerMemoryLogDir } from "../data-dirs";

export const WORKER_MEMORY_FILE = workerMemoryLogDir.file(
  "worker-memory.jsonl",
);

// ~200 bytes a line: 2 MB × 3 files holds ~30k runs, weeks of this host's.
export const WORKER_MEMORY_MAX_LINES = 50_000;
const memorySink = defineFileSink({
  id: "type-check-worker-memory",
  description:
    "One JSONL line per type-check worker run on this host: how it was admitted, the worker's peak physical footprint, its batch processes' and (dual runs) its whole-program oracle's — what the worker's and the backstop's grant weights and host admission's RAM quantum are checked against.",
  path: WORKER_MEMORY_FILE,
  maxBytes: 2 * 1024 * 1024,
  keep: 2,
});

export const WorkerMemoryRecordSchema = z.object({
  /** When the run ended (ISO). */
  t: z.string(),
  worktree: z.string(),
  /** Which pool admitted it: `type-check-light`, or `type-check-worker` (heavy / escalated). */
  admission: z.enum(["light", "heavy", "escalated"]),
  /**
   * The memory profile the worker ran (`typeCheckProfileFor`). Absent on a
   * record written before profiles existed: every such run was `full`.
   */
  profile: z.enum(["full", "one-unit"]).optional(),
  /**
   * The worker's mode (`TscMode`). Absent on a record written before the
   * spawner recorded runs: only the check recorded then, always `keyed`.
   */
  mode: z.enum(["keyed", "walks", "dual"]).optional(),
  /** The worker process's own peak physical footprint. */
  workerBytes: z.number().nonnegative(),
  /** Its batch processes, when it ran any: how many, and the upper bound on their peaks alive at once. */
  batches: z
    .object({
      count: z.number().int().positive(),
      concurrentBytes: z.number().nonnegative(),
    })
    .nullable(),
  /**
   * `dual` only: the oracle process's peak physical footprint (one fresh
   * whole program, `./full-check-process.ts`). Absent otherwise.
   */
  fullCheckBytes: z.number().nonnegative().optional(),
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
