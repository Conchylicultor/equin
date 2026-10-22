/**
 * THE way to type-check the repo program. Every caller goes through here — the
 * `type-check` check, the build's `--skip-checks` fast path, and the dual
 * backstop — so the compiler options, the declaration emit that gives every
 * checked file a real signature, and the keyed check that decides what to
 * re-check are written down once (`../../shared/worker.ts`) and cannot drift
 * apart.
 *
 * It is also the one place a worker is ADMITTED, so neither producer can spawn
 * one outside the bound: a host-wide `type-check-worker` slot in the caller's
 * `Grant` lane, then the holder's grant units. The worker is spawned through
 * that slot, so it runs in the foreground. See ./worker-pool.ts.
 */
import { writeFileSync } from "fs";
import os from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import type { Grant } from "@plugins/infra/plugins/host/plugins/host-admission/core";
import type { ForegroundSlot } from "@plugins/infra/plugins/host/plugins/host-admission/server";
import {
  TYPE_CHECK_WORKER_UNITS,
  type TypeCheckTree,
  type TypeCheckWorkerJob,
  type TypeCheckWorkerResult,
} from "../../core";
import { readCheckTree } from "../../shared/repo-view";
import { fileReportFromProcess } from "@plugins/reports/plugins/outbox/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { reportMisses, type MissReportSink } from "./miss-reports";
import { typeCheckWorkerPool } from "./worker-pool";

// A wedge-breaker for one metadata read, not a latency budget.
const GIT_TIMEOUT_MS = 30_000;

/** The real outbox, and the checkout's HEAD. */
function outboxSink(root: string): MissReportSink {
  return {
    file: fileReportFromProcess,
    async head() {
      const rev = await spawnCaptured(["git", "rev-parse", "HEAD"], {
        cwd: root,
        env: process.env,
        timeoutMs: GIT_TIMEOUT_MS,
      });
      // The report is filed either way: what it names is the miss.
      return rev.exitCode === 0
        ? rev.stdout.trim()
        : `unknown (git rev-parse HEAD exited ${rev.exitCode})`;
    },
  };
}

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
  /**
   * Wall time of the worker process, spawn to reap — the slot's HOLD time
   * (every holder queued behind this one waits it out), read beside
   * `cpuTimeMicros` so a hold stretched by the host shows as wall ≫ cpu.
   */
  wallMs: number;
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
 * The lane picks only the slot window. The scheduling tier is the pool's:
 * the worker is spawned through the held slot (`holder: "foreground"`), so it
 * starts out of darwinbg in either lane — even from a darwinbg agent session —
 * and nothing here can spawn it demoted. Nothing here reads the branch — a push
 * checks an agent branch and is interactive.
 */
export async function spawnTypeCheckWorker(opts: {
  root: string;
  name: string;
  tsconfigPath: string;
  tscMode: TypeCheckWorkerJob["tscMode"];
  onMiss: TypeCheckWorkerJob["onMiss"];
  lintFiles: TypeCheckWorkerJob["lintFiles"];
  /** The typed parts the lint jobs decide (none: a run that lints nothing). */
  typedParts?: TypeCheckWorkerJob["typedParts"];
  /** The run base the lint jobs were planned against (none: every file is a job). */
  lintBase?: TypeCheckWorkerJob["lintBase"];
  /**
   * The walk base the type check's walk starts from — by default this
   * checkout's last walk (`hint`), which only a run with no lint base may use.
   */
  walkBase?: TypeCheckWorkerJob["walkBase"];
  /**
   * The input to check — the git tree and its overlay — when the caller has
   * already read it: the check's preparation does, and keys lint on the same
   * versions. Omitted, it is read here, from the working tree as it is now.
   */
  tree?: TypeCheckTree;
  grant: Grant;
}): Promise<TypeCheckWorkerRun> {
  const { root, name, tsconfigPath, tscMode, onMiss, lintFiles, grant } = opts;
  const typedParts = opts.typedParts ?? { split: [], whole: [] };
  const lintBase = opts.lintBase ?? null;
  const walkBase = opts.walkBase ?? { kind: "hint" };
  const tree = opts.tree ?? (await readCheckTree(root, tsconfigPath)).tree;
  const queuedAt = performance.now();
  const run = await typeCheckWorkerPool.run(
    (slot) => {
      const slotWaitMs = performance.now() - queuedAt;
      return grant.run(
        async () => ({
          ...(await spawnWorker({
            root,
            name,
            job: {
              root,
              name,
              tsconfigPath,
              tscMode,
              onMiss,
              lintFiles,
              typedParts,
              lintBase,
              walkBase,
              tree,
            },
            slot,
          })),
          slotWaitMs,
        }),
        { units: TYPE_CHECK_WORKER_UNITS },
      );
    },
    { lane: grant.lane },
  );
  // A miss in the affected set answered from one whole program: filed here,
  // so no caller can forget to.
  run.result.tscLines.push(
    ...(await reportMisses(run.result.missed, outboxSink(root))),
  );
  return run;
}

async function spawnWorker(opts: {
  root: string;
  name: string;
  job: TypeCheckWorkerJob;
  slot: ForegroundSlot;
}): Promise<Omit<TypeCheckWorkerRun, "slotWaitMs">> {
  const { root, name, job, slot } = opts;
  const jobPath = join(os.tmpdir(), `type-check-${name}-${process.pid}.json`);
  writeFileSync(jobPath, JSON.stringify(job));
  const startedAt = performance.now();
  const spawned = await slot.spawn([process.execPath, WORKER, jobPath], {
    cwd: root,
    // A type-check worker builds a whole TypeScript program; cold, that is
    // minutes of unavoidable CPU, and on a saturated box it is longer still by
    // an amount nothing here can predict. There is no shorter deadline to
    // borrow: the human running `./singularity check` IS the deadline, and
    // killing a worker that was making progress would just make the check
    // unusable.
    unbounded:
      "a cold type-check worker legitimately runs for minutes of TS program construction, and the CLI run it belongs to owns no shorter deadline",
  });
  const wallMs = performance.now() - startedAt;
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
    wallMs,
  };
}
