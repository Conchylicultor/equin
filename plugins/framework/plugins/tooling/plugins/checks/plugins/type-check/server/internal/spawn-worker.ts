/**
 * THE way to build a TypeScript program and get a buildinfo out of it. Both
 * producers go through here — the `type-check` check and the build's
 * `--skip-checks` fast path — so the compiler options, and the declaration emit
 * that gives every file in the buildinfo a real signature, are written down
 * once (`../../shared/worker.ts`) and cannot drift apart.
 *
 * It is also the one place a worker is ADMITTED, so neither producer can spawn
 * one outside the bound: a host-wide `type-check-worker` slot, then the
 * holder's grant units, and the scheduling tier, all read off the caller's
 * `Grant`. See ./worker-pool.ts.
 */
import { writeFileSync } from "fs";
import os from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import type { Grant } from "@plugins/infra/plugins/host/plugins/host-admission/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import {
  TYPE_CHECK_WORKER_UNITS,
  type TypeCheckWorkerJob,
  type TypeCheckWorkerResult,
} from "../../core";
import { typeCheckWorkerPool } from "./worker-pool";

const WORKER = fileURLToPath(
  new URL("../../shared/worker.ts", import.meta.url),
);

/** What the parent measured about the worker PROCESS, on top of its output. */
export interface TypeCheckWorkerRun {
  result: TypeCheckWorkerResult;
  /**
   * Peak RSS of the worker PROCESS (bytes), measured by the parent after exit.
   * `undefined` when the runtime reported no rusage — an unavailable
   * measurement, not a failure: the footprint line is simply omitted.
   */
  maxRssBytes: number | undefined;
  /**
   * User + system CPU the worker burned, in microseconds. THE cost unit for
   * this fleet: wall clock on this host varies 2.5x with load for the identical
   * program build, so a before/after comparison taken in wall clock measures
   * whoever else was running. Same availability caveat as `maxRssBytes`.
   */
  cpuTimeMicros: number | undefined;
  /**
   * The system (kernel) share of `cpuTimeMicros`. Memory pressure is charged
   * here — page faults, compressor decompressions — so a run whose total
   * balloons on a 99.9 %-warm program while this share grows was paying for
   * the host, not checking more code.
   */
  cpuSystemMicros: number | undefined;
  /** How long the worker queued for its host-wide `type-check-worker` slot. */
  slotWaitMs: number;
}

/**
 * Run the worker to completion. Throws when the worker itself crashed
 * (nonzero exit) — tsc diagnostics are a clean exit with a non-empty
 * `tscErrors`, never an exit code.
 *
 * Admission, in this order:
 * 1. a host-wide `type-check-worker` slot in the grant's lane — the memory
 *    bound the CPU grant cannot express (its weight clamps to each holder's
 *    share, so N holders ran N workers). Taken FIRST so a worker queued for it
 *    holds none of its holder's units, which the holder's other children use;
 * 2. `TYPE_CHECK_WORKER_UNITS` of the holder's grant — the CPU share.
 *
 * The scheduling tier is the lane's: a `background` holder's worker is
 * demoted (`taskpolicy -b`); an `interactive` one runs in whatever tier its
 * holder is in, which `withHostGrant` has already lifted to the foreground.
 * Nothing here reads the branch — a push checks an agent branch and is
 * interactive.
 */
export async function spawnTypeCheckWorker(opts: {
  root: string;
  name: string;
  tsconfigPath: string;
  buildInfoPath: string;
  lintFiles: string[];
  grant: Grant;
}): Promise<TypeCheckWorkerRun> {
  const { root, name, tsconfigPath, buildInfoPath, lintFiles, grant } = opts;
  const queuedAt = performance.now();
  return typeCheckWorkerPool.run(
    () => {
      const slotWaitMs = performance.now() - queuedAt;
      return grant.run(
        async () => ({
          ...(await spawnWorker({
            root,
            name,
            job: { root, name, tsconfigPath, buildInfoPath, lintFiles },
            background: grant.lane === "background",
          })),
          slotWaitMs,
        }),
        { units: TYPE_CHECK_WORKER_UNITS },
      );
    },
    { lane: grant.lane },
  );
}

async function spawnWorker(opts: {
  root: string;
  name: string;
  job: TypeCheckWorkerJob;
  background: boolean;
}): Promise<Omit<TypeCheckWorkerRun, "slotWaitMs">> {
  const { root, name, job, background } = opts;
  const jobPath = join(os.tmpdir(), `type-check-${name}-${process.pid}.json`);
  writeFileSync(jobPath, JSON.stringify(job));
  const spawned = await spawnCaptured([process.execPath, WORKER, jobPath], {
    cwd: root,
    background,
    // A type-check worker builds a whole TypeScript program; cold, that is
    // minutes of unavoidable CPU, and on a saturated box it is longer still by
    // an amount nothing here can predict. There is no shorter deadline to
    // borrow: the human running `./singularity check` IS the deadline, and
    // killing a worker that was making progress would just make the check
    // unusable.
    unbounded:
      "a cold type-check worker legitimately runs for minutes of TS program construction, and the CLI run it belongs to owns no shorter deadline",
  });
  if (spawned.exitCode !== 0) {
    throw new Error(
      `type-check worker for "${name}" exited ${spawned.exitCode}:\n${spawned.stderr.trim() || spawned.stdout.trim()}`,
    );
  }
  // rusage is only final once the child is reaped, and it is a free read (no
  // sampling loop) — getrusage reports the TRUE peak of the run.
  return {
    result: JSON.parse(spawned.stdout) as TypeCheckWorkerResult,
    maxRssBytes: spawned.resourceUsage.maxRssBytes,
    cpuTimeMicros: spawned.resourceUsage.cpuTimeMicros,
    cpuSystemMicros: spawned.resourceUsage.cpuSystemMicros,
  };
}
