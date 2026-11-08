/**
 * THE way to type-check the repo program. Every caller goes through here — the
 * `type-check` check, the build's `--skip-checks` fast path, and the dual
 * backstop — so the compiler options, the declaration emit that gives every
 * checked file a real signature, and the keyed check that decides what to
 * re-check are written down once (`../../shared/worker.ts`) and cannot drift
 * apart.
 *
 * It is also the one place a worker is ADMITTED, so neither producer can spawn
 * one outside the bound: a host-wide slot in the caller's `Grant` lane — of
 * the small-run pool, or the heavy one — then the holder's grant units. The
 * worker is spawned through that slot, so it runs in the foreground. See
 * ./worker-pool.ts.
 */
import {
  asAppPath,
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { writeFile } from "node:fs/promises";
import os from "os";
import { fileURLToPath } from "url";
import type { Grant } from "@plugins/infra/plugins/host/plugins/host-admission/core";
import type { ForegroundSlot } from "@plugins/infra/plugins/host/plugins/host-admission/server";
import {
  TYPE_CHECK_BATCH_FILES,
  TYPE_CHECK_LIGHT_SOURCES,
  TYPE_CHECK_WORKER_UNITS,
  type TypeCheckTree,
  type TypeCheckWorkerJob,
  type TypeCheckWorkerOutput,
  type TypeCheckWorkerResult,
} from "../../core";
import { fileReportFromProcess } from "@plugins/reports/plugins/outbox/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { pacedHeapEnv } from "@plugins/packages/plugins/heap-pacing/core";
import { reportMisses, type MissReportSink } from "./miss-reports";
import { typeCheckLightPool, typeCheckWorkerPool } from "./worker-pool";

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
  /**
   * How long the run queued for its host-wide slots — the small-run pool's,
   * the heavy pool's, or both when it was escalated.
   */
  slotWaitMs: number;
  /** Which pool the worker that answered was admitted through, and why. */
  admission: WorkerAdmission;
}

/**
 * How a run was admitted: as small (`type-check-light`), as heavy from the
 * start (`type-check-worker`, `why` it was not tried small), or escalated —
 * tried small, refused a larger program, re-admitted heavy (with what the
 * small attempt cost: CPU-s, the one figure that says what escalation wastes).
 */
export type WorkerAdmission =
  | { kind: "light" }
  | { kind: "heavy"; why: string }
  | {
      kind: "escalated";
      sources: number;
      bound: number;
      lightCpuMicros: number | undefined;
      lightWallMs: number;
    };

/**
 * Why a run is not tried small, or null when it is. Only what is known before
 * the worker runs: its mode, and the files it is sent to lint (each one is a
 * source of some program, so more than the bound can never fit). The program
 * sizes themselves are known only inside the worker, which refuses past the
 * bound.
 */
function heavyFromTheStart(
  tscMode: TypeCheckWorkerJob["tscMode"],
  lintFiles: number,
  batch: TypeCheckWorkerJob["batch"] | undefined,
): string | null {
  if (tscMode !== "keyed") return `tscMode ${tscMode}`;
  if (batch !== undefined) return "a batching the caller chose";
  if (lintFiles > TYPE_CHECK_LIGHT_SOURCES) {
    return `${lintFiles} lint files > ${TYPE_CHECK_LIGHT_SOURCES}`;
  }
  return null;
}

/**
 * Run the worker to completion. Throws when the worker itself crashed
 * (nonzero exit) — tsc diagnostics are a clean exit with a non-empty
 * `tscErrors`, never an exit code.
 *
 * Admission, in this order:
 * 1. a host-wide slot in the grant's lane — the memory bound the CPU grant
 *    cannot express (its weight clamps to each holder's share, so N holders
 *    ran N workers). Taken FIRST so a worker queued for it holds none of its
 *    holder's units, which the holder's other children use. A run is first
 *    tried SMALL, in the `type-check-light` pool, with `batch: refuse` — its
 *    worker builds no program over `TYPE_CHECK_LIGHT_SOURCES` — unless it
 *    plainly is not small (`heavyFromTheStart`); a refused run (or one not
 *    tried) takes a `type-check-worker` slot, batching past
 *    `TYPE_CHECK_BATCH_FILES`. The two slots are taken one after the other,
 *    never one inside the other. Before the split, a 4-s run waited up to
 *    16 min behind whole-tree runs on the heavy pool's one background slot;
 * 2. `TYPE_CHECK_WORKER_UNITS` of the holder's grant — the CPU share. A set
 *    larger than `TYPE_CHECK_BATCH_FILES` is checked in batch processes the
 *    worker runs one at a time, inside the same share
 *    (research/2026-10-23-global-type-check-bounded-batches.md).
 *
 * The lane picks only the slot window. The scheduling tier is the pool's:
 * the worker is spawned through the held slot (`holder: "foreground"`), so it
 * starts out of darwinbg in either lane — even from a darwinbg agent session —
 * and nothing here can spawn it demoted. Nothing here reads the branch — a push
 * checks an agent branch and is interactive.
 */
export async function spawnTypeCheckWorker(opts: {
  root: AppPath;
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
   * The input to check — the git tree and its overlay. The check's
   * preparation reads it (and keys lint on the same versions); another caller
   * reads the working tree with `readTypeCheckTree` (`../../cli`). Required,
   * and never read here: reading it loads the TypeScript compiler and the check
   * runner, and this module is a server barrel's — in every backend's closure
   * (`boot:closure-no-dev-tooling`, `boot:closure-digestable`). One read also
   * hands the light attempt and its heavy retry the same tree.
   */
  tree: TypeCheckTree;
  /**
   * Batching, by default a small run's refusal past
   * `TYPE_CHECK_LIGHT_SOURCES`, then batches of `TYPE_CHECK_BATCH_FILES`.
   * Given, the run is admitted heavy with exactly this batching.
   */
  batch?: TypeCheckWorkerJob["batch"];
  grant: Grant;
}): Promise<TypeCheckWorkerRun> {
  const { root, name, tsconfigPath, tscMode, onMiss, lintFiles, tree, grant } =
    opts;
  const typedParts = opts.typedParts ?? { split: [], whole: [] };
  const lintBase = opts.lintBase ?? null;
  const walkBase = opts.walkBase ?? { kind: "hint" };
  const job = (batch: TypeCheckWorkerJob["batch"]): TypeCheckWorkerJob => ({
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
    batch,
  });
  const admitted = (
    pool: typeof typeCheckWorkerPool,
    batch: TypeCheckWorkerJob["batch"],
  ) => {
    const queuedAt = performance.now();
    return pool.run(
      (slot) => {
        const slotWaitMs = performance.now() - queuedAt;
        return grant.run(
          async () => ({
            ...(await spawnWorker({ root, name, job: job(batch), slot })),
            slotWaitMs,
          }),
          { units: TYPE_CHECK_WORKER_UNITS },
        );
      },
      { lane: grant.lane },
    );
  };
  const heavyBatch = opts.batch ?? {
    kind: "batches",
    k: TYPE_CHECK_BATCH_FILES,
  };
  const heavy = async (admission: WorkerAdmission, waitedMs: number) => {
    const { output, ...ran } = await admitted(typeCheckWorkerPool, heavyBatch);
    if (output.kind !== "done") {
      throw new Error(
        `type-check worker for "${name}" answered over-budget under batching ${heavyBatch.kind}, which never refuses`,
      );
    }
    return {
      ...ran,
      result: output.result,
      slotWaitMs: waitedMs + ran.slotWaitMs,
      admission,
    };
  };

  const why = heavyFromTheStart(tscMode, lintFiles.length, opts.batch);
  let run: TypeCheckWorkerRun;
  if (why !== null) {
    run = await heavy({ kind: "heavy", why }, 0);
  } else {
    const { output, ...small } = await admitted(typeCheckLightPool, {
      kind: "refuse",
      sources: TYPE_CHECK_LIGHT_SOURCES,
    });
    run =
      output.kind === "done"
        ? { ...small, result: output.result, admission: { kind: "light" } }
        : await heavy(
            {
              kind: "escalated",
              sources: output.sources,
              bound: output.bound,
              lightCpuMicros: small.cpuTimeMicros,
              lightWallMs: small.wallMs,
            },
            small.slotWaitMs,
          );
  }
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
}): Promise<
  Omit<TypeCheckWorkerRun, "slotWaitMs" | "admission" | "result"> & {
    output: TypeCheckWorkerOutput;
  }
> {
  const { root, name, job, slot } = opts;
  const jobPath = joinAppPath(
    asAppPath(os.tmpdir()),
    `type-check-${name}-${process.pid}.json`,
  );
  await writeFile(jobPath, JSON.stringify(job));
  const startedAt = performance.now();
  const spawned = await slot.spawn([process.execPath, WORKER, jobPath], {
    cwd: root,
    // A multi-GB heap, paced against what one process may hold rather than
    // the machine's whole RAM; its batch processes inherit the same pacing.
    env: pacedHeapEnv(process.env),
    // A type-check worker builds a whole TypeScript program; cold, that is
    // minutes of unavoidable CPU, and on a saturated box it is longer still by
    // an amount nothing here can predict. There is no shorter deadline to
    // borrow: the human running `./equin check` IS the deadline, and
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
    output: JSON.parse(spawned.stdout) as TypeCheckWorkerOutput,
    maxRssBytes: spawned.resourceUsage.maxRssBytes,
    cpuTimeMicros: spawned.resourceUsage.cpuTimeMicros,
    cpuSystemMicros: spawned.resourceUsage.cpuSystemMicros,
    wallMs,
  };
}
