/**
 * `type-check` — the unified TypeScript + type-aware-ESLint check.
 *
 * The old `typescript` and `eslint` checks each built the full TS program over
 * the repo (tsc for diagnostics, typescript-eslint via projectService for the
 * type-aware rules). Type-aware linting is ~99% TS-program construction — the
 * same work tsc does — so the cold cost was paid twice. This check builds the
 * repo's ONE program once, in a worker process, and reads both tsc diagnostics
 * and lint results off it.
 *
 * One program, not seven. Until 2026-09-18 there was a tsc target per runtime
 * (web-core, server-core, central-core, cli, tooling, tools, test); measured,
 * they held 30,649 file instances for 8,252 distinct files, and six of them
 * loaded the identical type environment. The split cost 3.7 checks of the
 * average file per cold miss and bought no type isolation.
 *
 * Warm paths: tsc checks only the files with no valid stored result, in at
 * most two programs sized by what changed (`../shared/name-run.ts`, over a
 * host-wide per-file store), and lint reuses the per-file lint result store (a
 * file's syntactic rule groups re-run only when its text or their rules
 * change, its type-aware rules only when its result key moves too).
 *
 * This file runs on the check runner's thread, which every other check in the
 * pass shares, so it holds nothing that reads file bytes or walks the tree: the
 * git reads (async), the outer read-set, the grant spend, the log lines and
 * the verdict. Everything else — 70–130 s of synchronous work — runs on the
 * preparation thread (`./prepare-thread`, `./prepare`).
 */
import {
  currentScanView,
  type TscProgram,
} from "@plugins/framework/plugins/tooling/plugins/checks/core";
import type {
  TypeCheckStats,
  TypeCheckWorkerJob,
  TypeCheckWorkerResult,
} from "../core";
import { spawnTypeCheckWorker, type WorkerAdmission } from "../server";
import type {
  Check,
  CheckContext,
} from "@plugins/framework/plugins/tooling/core";
import type {
  Grant,
  Lane,
} from "@plugins/infra/plugins/host/plugins/host-admission/core";
import {
  readDarwinBackground,
  type DarwinBackground,
} from "@plugins/packages/plugins/spawn-priority/server";
import { recordOuterReadSet } from "./outer-read-set";
import { recordWorkerMemory, workerWeightCheck } from "./worker-memory";
import { checkoutWorktreeName } from "@plugins/infra/plugins/paths/core";
import { openPrepareThread } from "./prepare-thread";
import type { ProgramOutcome } from "./prepare";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  formatBytes,
  peakFootprintText,
  type PeakFootprint,
} from "@plugins/packages/plugins/proc-rusage/core";

/** The worker's output plus what the parent measured about its process. */
interface WorkerResult extends TypeCheckWorkerResult {
  peakFootprint: PeakFootprint;
  cpuTimeMicros: number | undefined;
  cpuSystemMicros: number | undefined;
  wallMs: number;
  slotWaitMs: number;
  admission: WorkerAdmission;
}

async function runWorker(
  root: AppPath,
  program: TscProgram,
  lint: Pick<
    TypeCheckWorkerJob,
    "lintFiles" | "typedParts" | "lintBase" | "walkBase" | "tree"
  >,
  grant: Grant,
): Promise<WorkerResult> {
  const run = await spawnTypeCheckWorker({
    root,
    name: program.name,
    tsconfigPath: program.tsconfigPath,
    // The two-program check decides. `dual` (beside a full check) is the
    // backstop job's and the validation script's, never a check run's.
    tscMode: "keyed",
    // A miss in the affected set must not fail this run (nor, since a failed
    // run records nothing, every later one): one whole program answers, and
    // the miss is filed as a report below.
    onMiss: "whole",
    lintFiles: lint.lintFiles,
    typedParts: lint.typedParts,
    // The run base every file outside `lintFiles` carries from.
    lintBase: lint.lintBase,
    // The walk base bound to it: the files the walk does not visit keep the
    // keys the lint base holds.
    walkBase: lint.walkBase,
    // The tree the plan keyed lint on: the worker versions every
    // file the same way.
    tree: lint.tree,
    grant,
  });
  return {
    ...run.result,
    peakFootprint: run.peakFootprint,
    cpuTimeMicros: run.cpuTimeMicros,
    cpuSystemMicros: run.cpuSystemMicros,
    wallMs: run.wallMs,
    slotWaitMs: run.slotWaitMs,
    admission: run.admission,
  };
}

// Which pool the worker was admitted through (one line per run), e.g.
// "type-check worker repo: admitted light (type-check-light)", or
// "… admitted heavy (type-check-worker), escalated: a program of 409 sources
// > 100; the light attempt cpu 3.1s, wall 4.0s". What says whether the small
// pool is sized right: escalations, and what each one wasted.
function admissionLine(label: string, a: WorkerAdmission): string {
  if (a.kind === "light") return `${label}: admitted light (type-check-light)`;
  if (a.kind === "heavy") {
    return `${label}: admitted heavy (type-check-worker): ${a.why}`;
  }
  const cpu =
    a.lightCpuMicros === undefined
      ? ""
      : `cpu ${(a.lightCpuMicros / 1e6).toFixed(1)}s, `;
  return `${label}: admitted heavy (type-check-worker), escalated: a program of ${a.sources} sources > ${a.bound}; the light attempt ${cpu}wall ${seconds(a.lightWallMs)}s`;
}

// Which scheduling tier the worker runs in, and why — one greppable line beside
// the cost line, e.g.
// "type-check worker repo: lane background, priority foreground (slot holder)".
//
// The worker is spawned through its `type-check-worker` slot, a
// `holder: "foreground"` pool, so it starts out of darwinbg whatever its lane
// and whatever tier this process is in — an agent session runs entirely under
// darwinbg, which the worker would otherwise inherit. The lane picks only the
// slot window. A host with no darwinbg tier says so instead
// (research/2026-10-16-global-scarce-slot-holders-run-foreground.md).
function workerPriorityLine(
  label: string,
  lane: Lane,
  parent: DarwinBackground,
): string {
  const priority =
    parent.kind === "unsupported"
      ? `unknown (${parent.reason})`
      : "foreground (slot holder)";
  return `${label}: lane ${lane}, priority ${priority}`;
}

// One greppable line for the worker, e.g.
// "type-check worker repo: cpu 186.6s (sys 12.0s), wall 95.2s, peak footprint 1.2 GB, slot wait 3.1s".
//
// The memory is the worker's peak PHYSICAL FOOTPRINT (its own report at exit),
// what the kernel charges against memory pressure. Until 2026-11-13 this line
// printed getrusage's maxRSS instead, which also counts allocator pages the
// worker had already freed and shared library text — ~0.65 GB too high on a
// 1.15 GB worker (research/2026-11-12-global-type-check-worker-memory-split.md).
// Older transcripts' "maxRSS" numbers, and the constants calibrated on them,
// read high by that much.
// THIS process is the class host-admission's `PER_UNIT_BYTES` (3.6e9) claims to
// size — "one type-check-class worker's resident set" — and it had never
// actually been observed; the budget's RAM quantum was calibrated on vite
// samples alone. See research/2026-07-12-global-host-admission-memory-dimension.md.
// It is also what `TYPE_CHECK_WORKER_UNITS` (`../core`) is measured from, so
// these lines are the instrument behind the weight this check spends.
//
// Units are DECIMAL (1 GB = 1e9 B, 1 MB = 1e6 B), the same convention as the
// CLI's own footprint lines (cli/plugins/build/cli/run.ts `maxRssLine`), because
// PER_UNIT_BYTES is decimal. Labelling a 2**30 division "GB" would understate
// the byte count by ~7% and silently corrupt the very constant these lines
// calibrate. Kept as a private 5-line pure formatter rather than importing the
// CLI's copy: `bin/` is not an importable barrel, and one duplicated formatter
// beats inventing a shared plugin for it.
//
// CPU seconds sit beside the peak because they are the only load-independent
// cost this worker has: the identical program build measured 105s at load 12.8
// and 266s at load 14.0, so a wall-clock before/after on a shared box measures
// the neighbours. Every claim about what this check costs — and the skip's
// whole payoff — is read off these numbers. Wall time rides beside them
// anyway, as the slot's HOLD time: every worker queued for the slot waits it
// out, so wall ≫ cpu is a hold stretched by the host, not more work.
//
// `null` when there is nothing to report — no worker ran, or the runtime
// reported no rusage and no wall time was measured — an unavailable reading,
// not a swallowed failure: the line is omitted and nothing else changes. Any
// part alone still prints, so one missing number never hides the others.
//
// The system share rides in parentheses: memory pressure is charged there (page
// faults, compressor decompressions), so it is what tells a worker that did
// more work from one that paid for a thrashing host.
function workerCostLine(
  label: string,
  peakFootprint: PeakFootprint | undefined,
  cpuTimeMicros: number | undefined,
  cpuSystemMicros: number | undefined,
  wallMs: number | undefined,
  slotWaitMs: number | undefined,
): string | null {
  const parts: string[] = [];
  if (cpuTimeMicros != null)
    parts.push(
      `cpu ${(cpuTimeMicros / 1e6).toFixed(1)}s${cpuSystemMicros != null ? ` (sys ${(cpuSystemMicros / 1e6).toFixed(1)}s)` : ""}`,
    );
  if (wallMs != null) parts.push(`wall ${seconds(wallMs)}s`);
  if (peakFootprint !== undefined) parts.push(peakFootprintText(peakFootprint));
  if (parts.length === 0) return null;
  // How long the run queued for its host-wide slot(s) — the cap's
  // cost, on the same line as what the worker then cost, so a wait that
  // replaced a thrash can be weighed against it.
  if (slotWaitMs != null) parts.push(`slot wait ${seconds(slotWaitMs)}s`);
  return `${label}: ${parts.join(", ")}`;
}

/**
 * What the worker type-checked and linted, e.g. "type-check worker repo
 * programs: 1: 3 sources (3 checked) + 412 .d.ts, 2: 41 (40 checked) + 3,310
 * .d.ts; 43 checked of 12,369; linted typed 41, syntactic 3".
 */
function programsLine(label: string, s: TypeCheckStats): string {
  const p = (n: string, x: TypeCheckStats["first"]): string =>
    x === null
      ? `${n}: none`
      : `${n}: ${x.sources} sources (${x.checked} checked) + ${x.contracts} .d.ts`;
  return `${label} programs: ${p("1", s.first)}, ${p("2", s.second)}; ${s.checked} checked of ${s.files}; linted typed ${s.typedLinted}, syntactic ${s.syntacticLinted}`;
}

/** Milliseconds as the seconds figure of a log line, e.g. `71.3`. */
const seconds = (ms: number): string => (ms / 1000).toFixed(1);

const check: Check = {
  id: "type-check",
  description:
    "TypeScript types and type-aware ESLint pass (at most two programs, sized by what changed)",
  // OUTER input-keyed via validate-by-replay (Stage 2). run() records EVERY input
  // its verdict depends on (lintable-file membership + contents + the global-
  // trigger set) into the recording FileSystemView; on the next run those facts
  // replay against the fresh snapshot, so a change touching NO typecheckable input
  // (e.g. docs-only) is an outer HIT with zero tsc workers. The INNER per-file
  // lint result store (lint-groups.ts / lint-results.ts) is untouched and orthogonal.
  //
  // There is no input outside the tree: a gitignored file — a build's
  // `*.composition.*.generated.ts` registry — does not exist for the check
  // (`../shared/repo-view.ts`), so the read-set replay sees all it reads.
  inputKeyed: true,
  async run(ctx: CheckContext) {
    // The run's tree: its hash and every blob's sha, as git hashed the working
    // tree — the same snapshot the cache key and the replay read, and taken
    // under `--no-cache` too (a tree hash is a fact, not a cache). Every file
    // this check keys is versioned by its blob sha in it, so its verdict is a
    // function of this tree.
    const snapshot = await ctx.snapshot();
    const { root } = snapshot;

    // OUTER input-keyed read-set (Stage 2). Only runs on a cache MISS: the runner
    // reaches run() only when validate-by-replay missed (or nothing was recorded
    // yet). On a HIT it short-circuits before run(), so recording — and every
    // root/graph/worker cost below — is skipped entirely (zero workers). The
    // view is null on the legacy whole-tree path (fail-open: a null snapshot in
    // the runner falls back to that path), in which case nothing is recorded and
    // behaviour is unchanged. See ./outer-read-set for what each fact guards.
    //
    // Recorded HERE, from the snapshot's paths, before the preparation thread
    // starts: the view belongs to this thread's run, and the facts need no
    // file read.
    const view = currentScanView();
    if (view) recordOuterReadSet(view, snapshot.paths());

    let result: WorkerResult | undefined;
    let crash: string | undefined;
    let lintLines = "";

    // Everything that reads file bytes or the tree — the tsconfig
    // include-expansion, the coverage gate, the lint rule groups, the lint
    // result store, and the records after the run — runs on the preparation
    // thread, so this thread (shared by every other check in the pass) keeps
    // servicing timers and sockets throughout. It gets the tree by HASH and
    // loads its own copy: one `git ls-tree`, cheaper than structured-cloning
    // 12k paths and versions into it.
    const thread = openPrepareThread();
    try {
      const prepareStart = performance.now();
      const plan = await thread.prepare({
        root,
        treeHash: snapshot.treeHash,
      });
      const prepareMs = performance.now() - prepareStart;

      // The coverage gate: a file outside the program would never be linted or
      // type-checked — fail loudly.
      if (plan.kind === "uncovered") {
        ctx.log?.(
          `type-check: prepared off-thread in ${seconds(prepareMs)}s (finalize skipped: coverage gate failed)`,
          "stderr",
        );
        const { uncovered } = plan;
        return {
          ok: false,
          message: `type-check: ${uncovered.length} lintable file(s) are outside the repo's TypeScript program:\n  ${uncovered.slice(0, 40).join("\n  ")}`,
          hint: "The root `tsconfig.json` includes `plugins`, `test` and the root `*.config.ts`, which is every place repo source lives — so an uncovered file sits somewhere else (a stray `scripts/x.ts` at the repo root, a new top-level directory). Move it under `plugins/` where it belongs. If it is genuinely a new top-level source tree, add it to the root tsconfig `include`. If it is NOT source, it does not belong in the git tree: delete it, or add it to .gitignore.",
        };
      }

      const { program } = plan;

      {
        ctx.log?.(
          workerPriorityLine(
            `type-check worker ${program.name}`,
            ctx.grant.lane,
            readDarwinBackground(),
          ),
          "stderr",
        );
        // Admission is the spawn's own (`../server`): a host-wide slot in the
        // grant's lane — `type-check-light` for a run whose programs stay
        // small, else `type-check-worker`; the memory bound the grant's
        // clamped weight could not express — then
        // `TYPE_CHECK_WORKER_UNITS` of the CPU grant the invoking
        // build/check/push already holds (`ctx.grant`). The worker runs in the
        // foreground as the slot's holder, whatever the lane.
        try {
          result = await runWorker(root, program, plan, ctx.grant);
        } catch (err) {
          crash = (err as Error).message;
        }
      }

      // Peak footprint and CPU of the worker, when one ran. Emitted through the
      // runner's `ctx.log` observation seam, so the measurement is DURABLE
      // (check-<id>.log + the build's checks section) — a terminal-only write
      // would evaporate, and calibrating both host-admission's RAM quantum and
      // this check's own weight is exactly an after-the-fact grep over many
      // runs. Purely an observation: a missing rusage, or a crashed worker
      // (which threw before it could be measured), changes nothing about the
      // verdict below.
      const costLine = workerCostLine(
        `type-check worker ${program.name}`,
        result?.peakFootprint,
        result?.cpuTimeMicros,
        result?.cpuSystemMicros,
        result?.wallMs,
        result?.slotWaitMs,
      );
      if (costLine !== null) ctx.log?.(costLine, "stderr");
      if (result) {
        ctx.log?.(
          admissionLine(`type-check worker ${program.name}`, result.admission),
          "stderr",
        );
      }
      // Where that CPU went, phase by phase (in the worker's own clock, so it
      // excludes process start-up): the type check (the walk, both programs'
      // build and check) and lint — then what each program held and checked.
      if (result) {
        const { check, lint } = result.phaseCpuSeconds;
        const b = result.batchProcesses;
        ctx.log?.(
          `type-check worker ${program.name} phases: type check ${check.toFixed(1)}s, lint ${lint.toFixed(1)}s (cpu)` +
            // The batch processes' share of the cost line's cpu (a reaped
            // child counts in its parent's rusage) and their memory.
            (b === null
              ? ""
              : `; ${b.count} batch processes: cpu ${b.cpuSeconds.toFixed(1)}s (type check and lint), peak footprint ${formatBytes(b.peakFootprintBytes)} each, ≤ ${formatBytes(b.concurrentFootprintBytes)} at once${b.unmeasured > 0 ? ` (${b.unmeasured} unmeasured)` : ""}`),
          "stderr",
        );
        ctx.log?.(
          programsLine(`type-check worker ${program.name}`, result.stats),
          "stderr",
        );
;
        }
        for (const line of result.tscLines) ctx.log?.(line, "stderr");
      }

      // The record phase, on the thread that holds the session: the per-file
      // lint results and the lint verdict (see `./prepare`). The outcome is
      // handed over only when the worker RETURNED — a crashed run records
      // nothing new. The lint verdict comes back from there, not from the
      // worker: most files' results are in the store, and exemptions apply at
      // read time.
      const outcome: ProgramOutcome | undefined = result && {
        tscClean: !result.tscErrors,
        lint: result.lint,
        keys: result.lintKeys,
        walkRoot: result.walkRoot,
      };
      const finalizeStart = performance.now();
      const finalized = await thread.finalize(outcome);
      lintLines = finalized.lintViolations ?? "";
      // What the worker linted, and why — after the worker, because only it
      // can tell which typed parts were stale.
      ctx.log?.(finalized.lintLine, "stderr");
      // What used to be a freeze of the runner's thread, still measured: the
      // instrument for making the preparation itself cheaper — and which run
      // base it carried from, how much that left to send, and what the record
      // phase wrote back.
      ctx.log?.(
        `type-check: prepared off-thread in ${seconds(prepareMs)}s (${plan.phaseMs.map(([n, ms]) => `${n} ${seconds(ms)}s`).join(", ")}; ${plan.baseLine}; finalize ${seconds(performance.now() - finalizeStart)}s — ${finalized.baseLine})`,
        "stderr",
      );
    } finally {
      thread.close();
    }

    // The run's memory, as a host record: what the worker's grant weight and
    // host admission's RAM quantum are judged against
    // (`type-check:worker-weight-measured`, ./worker-memory.ts). After the
    // record phase, so a failed append — which fails this check, loudly —
    // never costs a returned run its lint results or bases. A run with any
    // part unmeasured records nothing: a partial peak would read as a small one.
    const batches = result?.batchProcesses ?? null;
    if (
      result?.peakFootprint.kind === "measured" &&
      (batches === null || batches.unmeasured === 0)
    ) {
      await recordWorkerMemory({
        t: new Date().toISOString(),
        worktree: checkoutWorktreeName(root),
        admission: result.admission.kind,
        workerBytes: result.peakFootprint.bytes,
        batches:
          batches === null
            ? null
            : {
                count: batches.count,
                concurrentBytes: batches.concurrentFootprintBytes,
              },
      });
    }

    // Aggregate the two failure categories.
    const tscErrors = result?.tscErrors ?? "";

    if (crash === undefined && !tscErrors && !lintLines) return { ok: true };

    const parts: string[] = [];
    if (crash !== undefined) {
      parts.push(`type-check worker failed:\n  ${crash}`);
    }
    if (tscErrors) {
      parts.push(
        `TypeScript type errors:\n  ${tscErrors.split("\n").join("\n  ")}`,
      );
    }
    if (lintLines) {
      parts.push(`ESLint violations:\n  ${lintLines.split("\n").join("\n  ")}`);
    }

    const hasMissingModule = /error TS2307: Cannot find module/.test(tscErrors);
    const hints: string[] = [];
    if (hasMissingModule) {
      hints.push(
        'A "Cannot find module" error for a dep you didn\'t touch is usually a missing workspace link — run ./equin build first (it re-runs bun install) and re-push.',
      );
    }
    if (tscErrors) {
      hints.push(
        "Fix type errors before pushing. If a cast is necessary, fix the type definition instead.",
      );
    }
    if (lintLines) {
      hints.push(
        "Global rules live in plugins/framework/plugins/tooling/plugins/lint/; plugin rules in plugins/<name>/lint/index.ts. Do NOT silence violations with eslint-disable or rule-config edits. If you believe a violation is a false positive, STOP and report it to the user.",
      );
    }

    return {
      ok: false,
      message: parts.join("\n\n"),
      hint: hints.join(" ") || undefined,
    };
  },
};

export default [check, workerWeightCheck];
