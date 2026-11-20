// The dual run's oracle in a process of its own (`./full-check-worker.ts`).
//
// The oracle is ONE fresh whole program over every root — that is what makes
// it the cold ground truth, so it is never batched — and a whole program of
// this repo (~18k sources) is the largest thing the type check ever builds.
// Built inside the worker, it stacked on everything the worker already held
// of its two walks, and that sum went unmeasured: the worker reported one
// peak (16.8 GB on 2026-11-20) under a grant sized for a batched run (7 GB).
// In its own process it holds nothing else, its footprint is measured apart
// (`peakFootprint: "report"`), and the worker spawns it FIRST, while it holds
// nothing of its walks either — so the run's peak is the larger of the two,
// never their sum. The backstop's weight is sized from that measurement
// (`TYPE_CHECK_BACKSTOP_PEAK_BYTES`, `../core/worker-weight.ts`).

import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import type ts from "typescript";
import {
  ChildKilledError,
  spawnCaptured,
} from "@plugins/infra/plugins/spawn/core";
import { parentPacedHeapEnv } from "@plugins/packages/plugins/heap-pacing/core";
import type { PeakFootprint } from "@plugins/packages/plugins/proc-rusage/core";
import {
  type AppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import type { TypeCheckTree } from "../core";
import type { FullCheck } from "./full-check";
import type { NameResult } from "./name-run";

const FULL_CHECK_WORKER = fileURLToPath(
  new URL("./full-check-worker.ts", import.meta.url),
);

/** What the oracle process is handed: the same tree, options and roots as the worker's walks. */
export interface FullCheckJob {
  root: AppPath;
  tree: TypeCheckTree;
  options: ts.CompilerOptions;
  roots: readonly string[];
}

/** The oracle process's stdout. */
export interface FullCheckOutput {
  results: [string, NameResult][];
  programDiagnostics: string[];
}

/** The oracle's answer, and what its process cost. */
export interface FullCheckRun {
  full: FullCheck;
  peakFootprint: PeakFootprint;
  cpuSeconds: number;
}

export async function runFullCheckProcess(
  job: FullCheckJob,
  /** The worker's scratch dir (`TypeCheckWorkerJob.scratch`): the job file goes there, removed with it. */
  scratch: AppPath,
): Promise<FullCheckRun> {
  const jobPath = joinAppPath(scratch, "full-check-job.json");
  writeFileSync(jobPath, JSON.stringify(job));
  const spawned = await spawnCaptured(
    [process.execPath, FULL_CHECK_WORKER, jobPath],
    {
      cwd: job.root,
      // Paced as its worker is (`packages/heap-pacing`): a whole program's
      // heap collected near its live size, not at a multiple of it.
      env: parentPacedHeapEnv(process.env),
      // A bun script: it reports its own peak footprint at exit.
      peakFootprint: "report",
      unbounded:
        "the oracle builds and checks one whole program of the repo: minutes of TS work, bounded by its parent worker, which owns no shorter deadline",
    },
  );
  // Ended by the kernel (the OOM killer takes the biggest process, and the
  // oracle is it): typed, so the worker exits as killed and no layer above
  // reads it as a type error.
  if (spawned.signalCode !== null) {
    throw new ChildKilledError(
      "type-check full check",
      spawned.signalCode,
      spawned.stderr.trim() || spawned.stdout.trim(),
    );
  }
  if (spawned.exitCode !== 0) {
    throw new Error(
      `type-check full check exited ${spawned.exitCode}:\n${spawned.stderr.trim() || spawned.stdout.trim()}`,
    );
  }
  const out = JSON.parse(spawned.stdout) as FullCheckOutput;
  const { cpuTimeMicros, peakFootprint } = spawned.resourceUsage;
  return {
    full: {
      results: new Map(out.results),
      programDiagnostics: out.programDiagnostics,
    },
    peakFootprint,
    cpuSeconds: (cpuTimeMicros ?? 0) / 1e6,
  };
}
