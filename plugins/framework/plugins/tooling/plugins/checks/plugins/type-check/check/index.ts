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
 * Warm paths are preserved: tsc stays incremental via the shared `.tsbuildinfo`,
 * lint reuses the per-file lint result store (a file's syntactic rule groups
 * re-run only when its text or their rules change, its type-aware rules only
 * when the declarations it can see change too), and a program whose content key
 * is already recorded green runs no worker at all.
 *
 * This file runs on the check runner's thread, which every other check in the
 * pass shares, so it holds nothing that reads file bytes or walks the tree: the
 * git reads (async), the outer read-set, the grant spend, the log lines and
 * the verdict. Everything else — 70–130 s of synchronous work — runs on the
 * preparation thread (`./prepare-thread`, `./prepare`).
 */
import {
  tsBuildInfoPath,
  currentScanView,
  type TscProgram,
} from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import type { TypeCheckWorkerJob, TypeCheckWorkerResult } from "../core";
import { spawnTypeCheckWorker } from "../server";
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
import { readTreeListing } from "./fingerprint";
import { recordOuterReadSet } from "./outer-read-set";
import { openPrepareThread } from "./prepare-thread";
import type { ProgramOutcome } from "./prepare";

/** The worker's output plus what the parent measured about its process. */
interface WorkerResult extends TypeCheckWorkerResult {
  maxRssBytes: number | undefined;
  cpuTimeMicros: number | undefined;
  cpuSystemMicros: number | undefined;
  wallMs: number;
  slotWaitMs: number;
}

async function runWorker(
  root: string,
  program: TscProgram,
  lintFiles: TypeCheckWorkerJob["lintFiles"],
  grant: Grant,
): Promise<WorkerResult> {
  const run = await spawnTypeCheckWorker({
    root,
    name: program.name,
    tsconfigPath: program.tsconfigPath,
    buildInfoPath: tsBuildInfoPath(root, program.name),
    lintFiles,
    grant,
  });
  return {
    ...run.result,
    maxRssBytes: run.maxRssBytes,
    cpuTimeMicros: run.cpuTimeMicros,
    cpuSystemMicros: run.cpuSystemMicros,
    wallMs: run.wallMs,
    slotWaitMs: run.slotWaitMs,
  };
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
// "type-check worker repo: cpu 186.6s (sys 12.0s), wall 95.2s, maxRSS 7.2 GB, slot wait 3.1s".
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
  maxRssBytes: number | undefined,
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
  if (maxRssBytes != null) {
    const gb = maxRssBytes / 1e9;
    parts.push(
      `maxRSS ${gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(maxRssBytes / 1e6)} MB`}`,
    );
  }
  if (parts.length === 0) return null;
  // How long the worker queued for its `type-check-worker` slot — the cap's
  // cost, on the same line as what the worker then cost, so a wait that
  // replaced a thrash can be weighed against it.
  if (slotWaitMs != null) parts.push(`slot wait ${seconds(slotWaitMs)}s`);
  return `${label}: ${parts.join(", ")}`;
}

/** Milliseconds as the seconds figure of a log line, e.g. `71.3`. */
const seconds = (ms: number): string => (ms / 1000).toFixed(1);

const check: Check = {
  id: "type-check",
  description:
    "TypeScript types and type-aware ESLint pass (one shared program for the whole repo)",
  // OUTER input-keyed via validate-by-replay (Stage 2). run() records EVERY input
  // its verdict depends on (lintable-file membership + contents + the global-
  // trigger set) into the recording FileSystemView; on the next run those facts
  // replay against the fresh snapshot, so a change touching NO typecheckable input
  // (e.g. docs-only) is an outer HIT with zero tsc workers. The INNER per-file
  // lint result store (lint-groups.ts / lint-results.ts) is untouched and orthogonal.
  inputKeyed: true,
  async run(ctx: CheckContext) {
    const root = await getWorktreeRoot();

    // ONE reading of the tree's file set, shared by everything that asks what
    // files exist: the lint universe, the outer read-set, the content hashes,
    // and the program key. Four separate walks used to cost
    // seconds and gave the enumeration rules four places to disagree — and, as
    // walks, they answered with files git never puts in this check's cache key.
    const listing = await readTreeListing(root);

    // OUTER input-keyed read-set (Stage 2). Only runs on a cache MISS: the runner
    // reaches run() only when validate-by-replay missed (or nothing was recorded
    // yet). On a HIT it short-circuits before run(), so recording — and every
    // root/graph/worker cost below — is skipped entirely (zero workers). The
    // view is null on the legacy whole-tree path (fail-open: a null snapshot in
    // the runner falls back to that path), in which case nothing is recorded and
    // behaviour is unchanged. See ./outer-read-set for what each fact guards.
    //
    // Recorded HERE, from the listing, before the preparation thread starts:
    // the view belongs to this thread's run, and the facts need no file read.
    const view = currentScanView();
    if (view) recordOuterReadSet(view, listing);

    let result: WorkerResult | undefined;
    let crash: string | undefined;
    let lintLines = "";

    // Everything that reads file bytes or walks the tree — the import graph,
    // content hashes, tsconfig include-expansion, the coverage gate, the lint
    // result store, the warm base, the program key and signature table, and the
    // records after the run —
    // runs on the preparation thread, so this thread (shared by every other
    // check in the pass) keeps servicing timers and sockets throughout.
    const thread = openPrepareThread();
    try {
      const prepareStart = performance.now();
      const plan = await thread.prepare({
        listing,
        cacheEnabled: ctx.cacheEnabled !== false,
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

      const { program, lintFiles, skipped, unkeyed, keysMs } = plan;
      // Emitted on EVERY run, skipped or not — the "running" half is the datum
      // that says the key was computed and did NOT match, which is what
      // separates a cold tree from a broken key. The cost of computing the key
      // is on the same line because it is paid either way.
      ctx.log?.(
        skipped
          ? `type-check: program unchanged since last pass, skipped (program keys ${keysMs}ms)`
          : `type-check: program changed, running (program keys ${keysMs}ms)`,
        "stderr",
      );
      // Which incremental base this run starts from, and how much of it still
      // matches the tree. Without it "why was this run cold?" had no answer
      // anywhere in the transcript — and a pool that hands out a base matching
      // nothing looks exactly like a pool that works.
      ctx.log?.(plan.warmBase, "stderr");
      // Named, not just implied: "running" with no explanation of why there was
      // no key to compare against is the shape of a report that hides a broken
      // key. A cold worktree legitimately says this on its first run.
      if (unkeyed !== undefined) {
        ctx.log?.(`type-check: no program key — ${unkeyed}`, "stderr");
      }

      if (plan.run) {
        ctx.log?.(
          workerPriorityLine(
            `type-check worker ${program.name}`,
            ctx.grant.lane,
            readDarwinBackground(),
          ),
          "stderr",
        );
        // Admission is the spawn's own (`../server`): a host-wide
        // `type-check-worker` slot in the grant's lane — the memory bound the
        // grant's clamped weight could not express — then
        // `TYPE_CHECK_WORKER_UNITS` of the CPU grant the invoking
        // build/check/push already holds (`ctx.grant`). The worker runs in the
        // foreground as the slot's holder, whatever the lane.
        try {
          result = await runWorker(root, program, lintFiles, ctx.grant);
        } catch (err) {
          crash = (err as Error).message;
        }
      }

      // Peak RSS and CPU of the worker, when one ran. Emitted through the
      // runner's `ctx.log` observation seam, so the measurement is DURABLE
      // (check-<id>.log + the build's checks section) — a terminal-only write
      // would evaporate, and calibrating both host-admission's RAM quantum and
      // this check's own weight is exactly an after-the-fact grep over many
      // runs. Purely an observation: a missing rusage, or a crashed worker
      // (which threw before it could be measured), changes nothing about the
      // verdict below.
      const costLine = workerCostLine(
        `type-check worker ${program.name}`,
        result?.maxRssBytes,
        result?.cpuTimeMicros,
        result?.cpuSystemMicros,
        result?.wallMs,
        result?.slotWaitMs,
      );
      if (costLine !== null) ctx.log?.(costLine, "stderr");

      // The record phase, on the thread that holds the session: the warm base,
      // the per-file lint results, the signature table, the lint verdict, the
      // program PASS, the skipped re-record (see `./prepare`). The outcome is handed over only
      // when the worker RETURNED — a crashed or skipped run records nothing
      // new. The lint verdict comes back from there, not from the worker: most
      // files' results are in the store, and exemptions apply at read time.
      const outcome: ProgramOutcome | undefined = result && {
        tscClean: !result.tscErrors,
        lint: result.lint,
        typeFps: result.typeFps,
      };
      const finalizeStart = performance.now();
      const finalized = await thread.finalize(outcome);
      lintLines = finalized.lintViolations ?? "";
      // What the worker linted, and why — on EVERY run, skipped or not. After
      // the worker, because without a signature table only the worker could
      // tell which typed parts were stale.
      ctx.log?.(finalized.lintLine, "stderr");
      // What the record phase published back into the warm-base pool, and
      // whether that entry carries the sha that lets the prune protect it.
      for (const line of finalized.lines) ctx.log?.(line, "stderr");
      // What used to be a freeze of the runner's thread, still measured: the
      // instrument for making the preparation itself cheaper.
      ctx.log?.(
        `type-check: prepared off-thread in ${seconds(prepareMs)}s (finalize ${seconds(performance.now() - finalizeStart)}s)`,
        "stderr",
      );
    } finally {
      thread.close();
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
        'A "Cannot find module" error for a dep you didn\'t touch is usually a missing workspace link — run ./singularity build first (it re-runs bun install) and re-push.',
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

export default check;
