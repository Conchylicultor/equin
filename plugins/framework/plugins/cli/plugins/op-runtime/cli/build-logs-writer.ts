import { readEnv } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import {
  worktreeDataDir,
  worktreeArtifacts,
  pruneWorktreeBuildArtifacts,
} from "@plugins/infra/plugins/paths/server";
import { renderStepBlock, orderStepsForDisplay } from "./build-output";
import type { Namespace } from "@plugins/infra/plugins/namespace/core";

export interface BuildStepLog {
  id: string;
  label: string;
  lines: Array<{ text: string; stream: "stdout" | "stderr" }>;
  durationMs: number;
  success: boolean;
}

export interface BuildLogs {
  steps: BuildStepLog[];
  /**
   * Wall-clock instant (epoch ms) the build reached its terminal state.
   *
   * No longer how a recovered row gets its finish instant — that is the
   * supervised-run exit marker's mtime now (the shim writes it for any command,
   * rather than depending on this CLI remembering to). Kept because it is the
   * transcript's own record of when it was closed, and a human reading the JSON
   * should not have to correlate two files to find out.
   */
  finishedAt: number;
  /**
   * The exit code this build ended on, stamped by whoever writes: 0 on success,
   * 1 / BUILD_EXIT_SUPERSEDED from failBuild, 128+signo from the abort guard.
   *
   * Carried rather than inferred because the artifact is no longer written only
   * at a COMPLETE terminal. An aborted build writes whatever steps it had
   * finished — all of them green, since the one it died inside never closed — so
   * `steps.every(s => s.success)` would read a kill as a successful deploy.
   *
   * The row's own exit code no longer comes from here either (see
   * {@link BuildLogs.finishedAt}); this is the transcript saying what it ended
   * on, beside the steps it ended after.
   */
  exitCode: number;
}

/**
 * One build's step-log accumulator + writer: the collector owns its own
 * `steps[]`, built either by pushing a fully-formed step (`pushStep`, the legacy
 * seam) or incrementally via `beginStep` + `line`. Callers reach the
 * module-default instance through the wrapper exports below.
 */
interface StepLogCollector {
  /**
   * Opens a step and makes it the current one for `line()`. The returned
   * end-closure records the step's `durationMs` + `success` and closes it.
   */
  beginStep(id: string, label: string): (success: boolean) => void;
  /**
   * Appends a line to the currently open step. When no step is open, an implicit
   * verdict-free `output` step is opened to hold it (and left open for the next
   * lines) — the simplest never-drop-a-line behavior, and `success: true` so this
   * synthetic step can never itself fail the orphan-exit verdict.
   */
  line(text: string, stream: "stdout" | "stderr"): void;
  /** Legacy seam: push a fully-formed step (build.ts builds the whole step, then pushes it). */
  pushStep(step: BuildStepLog): void;
  /**
   * Writes `build-logs-<buildId>.json` + `build-<buildId>.log` under worktree
   * `name`, accepting the id-less (`undefined`) case so the module-default
   * collector can still produce the unsuffixed `build-logs.json` / `build.log`,
   * and returning the text-log path for the failure-line pointer. `exitCode` is
   * the code the run ends on — the caller stamps it here and on the run's ledger
   * row from the same value, so artifact and row cannot disagree.
   */
  writeLogs(
    name: Namespace,
    buildId: string | undefined,
    exitCode: number,
    trailer?: string,
  ): string;
}

/** Plain-text render of every step, mirroring the console layout. */
function renderStepsText(allSteps: BuildStepLog[]): string {
  const out: string[] = [];
  for (const step of orderStepsForDisplay(allSteps)) {
    for (const { text } of renderStepBlock(step)) out.push(text);
  }
  return out.join("\n") + "\n";
}

function writeAtomic(path: string, contents: string): void {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}

function makeStepLogCollector(): StepLogCollector {
  const steps: BuildStepLog[] = [];
  // The step `line()` appends to; null between steps until beginStep or an
  // implicit `output` step is opened.
  let currentStep: BuildStepLog | null = null;

  function writeLogs(
    name: Namespace,
    buildId: string | undefined,
    exitCode: number,
    trailer?: string,
  ): string {
    const logs: BuildLogs = { steps, finishedAt: Date.now(), exitCode };
    const dir = worktreeDataDir(name);
    mkdirSync(dir, { recursive: true });
    const jsonPath = worktreeArtifacts.buildLogs(name, buildId);
    // The JSON payload is deliberately push-order and verdict-free:
    // build-fix-section.tsx reads `steps[].success` to name the failing steps.
    writeAtomic(jsonPath, JSON.stringify(logs, null, 2) + "\n");
    const textPath = worktreeArtifacts.buildLogText(name, buildId);
    const text = trailer
      ? `${renderStepsText(steps)}\n${trailer}\n`
      : renderStepsText(steps);
    writeAtomic(textPath, text);
    // Writing a new set trims the old ones — the leak fix. Safe for the just-written
    // files (newest mtime ⇒ always retained) and idempotent with writeBuildProfile's
    // own prune call at the same finalize point.
    pruneWorktreeBuildArtifacts(name);
    return textPath;
  }

  return {
    beginStep(id, label) {
      const start = performance.now();
      const step: BuildStepLog = {
        id,
        label,
        lines: [],
        durationMs: 0,
        success: false,
      };
      steps.push(step);
      currentStep = step;
      return (success: boolean) => {
        step.durationMs = Math.round(performance.now() - start);
        step.success = success;
        if (currentStep === step) currentStep = null;
      };
    },
    line(text, stream) {
      if (!currentStep) {
        currentStep = {
          id: "output",
          label: "output",
          lines: [],
          durationMs: 0,
          success: true,
        };
        steps.push(currentStep);
      }
      currentStep.lines.push({ text, stream });
    },
    pushStep(step) {
      steps.push(step);
    },
    writeLogs,
  };
}

// The module-default collector backing the legacy wrappers below, so every current
// caller (build.ts) is byte-for-byte unaffected.
const defaultCollector = makeStepLogCollector();

export function pushBuildStepLog(step: BuildStepLog): void {
  defaultCollector.pushStep(step);
}

/**
 * Persist the build transcript both as structured JSON (consumed by the
 * profiling UI) and as a human-readable `build.log` text file. Returns the
 * absolute path to the text log so callers can point at it on the last line of
 * a failure — readable directly, even when the console output was piped through
 * `tail`.
 *
 * Fully synchronous (writeFileSync + renameSync), so the exit-time verdict guard
 * — which prints the pointer at that path — can call it from its exit handler.
 *
 * The build-runs ledger reads this file as the build's TERMINAL RECORD (its
 * `exitCode`, and its mtime as the end time) to settle a dead build's still-open
 * row at the next claim — run-ledger's `settleDeadInflightRun` — so every
 * graceful ending must keep writing it.
 */
export function writeBuildLogs(
  name: Namespace,
  trailer: string,
  exitCode: number,
): string {
  return defaultCollector.writeLogs(
    name,
    readEnv("BUILD_ID"),
    exitCode,
    trailer,
  );
}
