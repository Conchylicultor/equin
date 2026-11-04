import { writeSync } from "node:fs";
import {
  renderStepBlock,
  type BuildStepLog,
} from "../core/internal/step-blocks";
import type { SignalTermination } from "./fatal-signals";

export interface StepStatus {
  label: string;
  success: boolean;
}

export type Verdict =
  | {
      ok: true;
      headline: string;
      notes: string[];
      pointers: string[];
      steps: StepStatus[];
    }
  | {
      ok: false;
      headline: string;
      reason: string[];
      pointers: string[];
      steps: StepStatus[];
    };

// Successes first, failures last, stable within each group so the failing step
// is the last quoted block a reader sees.
export function orderStepsForDisplay<T extends { success: boolean }>(
  steps: readonly T[],
): T[] {
  return [
    ...steps.filter((s) => s.success),
    ...steps.filter((s) => !s.success),
  ];
}

// The console half of the two renderers above, so every command that runs the
// heavy section (`build`, `build --hermetic`) writes a byte-identical
// transcript instead of re-deriving the ordering + stream routing. Each line
// keeps its own stream, so a step's stderr still reaches stderr.
export function printStepBlocks(steps: readonly BuildStepLog[]): void {
  for (const step of orderStepsForDisplay(steps)) {
    for (const { text, stream } of renderStepBlock(step)) {
      if (stream === "stderr") process.stderr.write(`${text}\n`);
      else process.stdout.write(`${text}\n`);
    }
  }
}

// Pure. Returns the full banner. `pointers` are always the final lines so an
// agent reading only `| tail` lands on the log paths.
export function renderVerdict(v: Verdict): string {
  const body = v.ok ? v.notes : v.reason;
  const indent = (s: string): string => `  ${s}`;

  const headlineLine = indent(v.headline);
  const bodyLines = body.map(indent);
  const rosterLine = indent(
    v.steps.map((s) => `${s.label} ${s.success ? "✓" : "✗"}`).join("   "),
  );
  const pointerLines = v.pointers.map(indent);

  const width = Math.max(
    60,
    headlineLine.length,
    ...bodyLines.map((l) => l.length),
    ...(v.steps.length > 0 ? [rosterLine.length] : []),
    ...pointerLines.map((l) => l.length),
  );

  const box = [
    `╔${"═".repeat(width)}╗`,
    `║${headlineLine.padEnd(width)}║`,
    `╚${"═".repeat(width)}╝`,
  ];

  const sections: string[][] = [box];
  if (bodyLines.length > 0) sections.push(bodyLines);
  if (v.steps.length > 0) sections.push([rosterLine]);
  if (pointerLines.length > 0) sections.push(pointerLines);

  return sections.map((s) => s.join("\n")).join("\n\n");
}

let emittedVerdict: { ok: boolean } | null = null;

// Prints the build's own verdict to stdout for BOTH success and failure so it
// can never be hidden by `2>/dev/null` and survives `| tail`. writeSync (not
// console.log) because a following process.exit() can truncate buffered writes.
export function emitVerdict(v: Verdict): void {
  emittedVerdict = { ok: v.ok };
  writeSync(1, `\n${renderVerdict(v)}\n`);
}

/**
 * "…still serves the previous build", for however many namespaces this
 * invocation was going to publish. One build can now name several
 * (`build --composition sonata website`), and the sentence has to stay true for
 * both arities: a killed build published nothing, so EVERY namespace it named is
 * still on its previous dist.
 */
function stillServing(urls: string[]): string {
  return urls.length === 1
    ? `${urls[0]} still serves the previous build`
    : `${urls.join(", ")} still serve their previous builds`;
}

// Pure. Given what (if anything) was emitted, the actual exit code and — when
// one arrived — the signal that ended the process, returns the fallback verdict
// the exit-time guard should print, or `null` when the emitted verdict already
// agrees with the exit code and nothing more is needed.
// `null` covers exactly the two agreeing cases — (ok:true, code 0) and
// (ok:false, code≠0); every other combination yields a loud verdict.
//
// `termination` only ever reshapes the "no verdict, non-zero exit" arm, which is
// the arm a killed build lands in: BUILD ABORTED, not BUILD FAILED, because the
// build did not fail — it was ended from outside, and reading it as a code
// defect is exactly the misdiagnosis this argument exists to prevent. The three
// bug-banner arms below are about build.ts contradicting itself and are
// unaffected by who sent what.
// Extracted from installVerdictGuard so the fallback wording is unit-testable.
export function fallbackVerdict(
  emitted: { ok: boolean } | null,
  code: number,
  ctx: { urls: string[]; buildLogPath: string },
  termination?: SignalTermination | null,
  crash?: string | null,
): Verdict | null {
  if (emitted?.ok === true && code === 0) return null;
  if (emitted?.ok === false && code !== 0) return null;

  const pointers = [`Full output: ${ctx.buildLogPath}`];
  let headline: string;
  let reason: string[];
  if (emitted === null && code !== 0 && termination != null) {
    headline = `BUILD ABORTED — terminated by ${termination.signal}`;
    reason = [
      `NOT DEPLOYED. Nothing was published; ${stillServing(ctx.urls)}.`,
      `This build did NOT fail — it was ended from outside by ${termination.signal} ` +
        `at ${termination.at} (exit ${code}).`,
      // Unset until the SA_SIGINFO tap lands; `process.on(sig)` names no sender.
      ...(termination.attribution === undefined
        ? [
            `The sender is unknown — nothing in this process can see who signalled it.`,
          ]
        : [`Sent by ${termination.attribution}.`]),
    ];
  } else if (emitted === null && code !== 0) {
    // An unhandled exception is the dominant way to land here, and the whole point
    // of quoting it is that this banner is the only artifact that outlives the
    // process — a build that dies before its first step writes a transcript with no
    // step, no check and no error in it, so without this the reader is told a build
    // failed and nothing whatsoever about why.
    headline =
      crash != null
        ? `BUILD FAILED — crashed before completing (exit ${code})`
        : `BUILD FAILED — aborted before completing (exit ${code})`;
    reason = [
      `NOT DEPLOYED. Nothing was published; ${stillServing(ctx.urls)}.`,
      ...(crash == null
        ? [`The build aborted before printing its own verdict.`]
        : [
            `The build threw an unhandled exception before printing its own verdict:`,
            ...crash.split("\n").map((l) => `  ${l}`),
          ]),
    ];
  } else if (emitted === null) {
    headline = `BUILD FAILED — exited 0 without deploying. This is a bug in build.ts.`;
    reason = [
      `NOT DEPLOYED, yet the process exited 0 — the success signal is unreliable.`,
      `The build exited without printing a verdict.`,
    ];
  } else if (emitted.ok === false) {
    headline = `BUILD FAILED — the build failed but exited 0. This is a bug in build.ts.`;
    reason = [
      `The build printed a FAILED verdict but the process exited 0.`,
      `Trust the verdict: nothing was deployed.`,
    ];
  } else {
    headline = `BUILD FAILED — reported success but exited ${code}. This is a bug in build.ts.`;
    reason = [
      `The build printed an OK verdict but the process exited ${code}.`,
      `The deploy state is ambiguous — verify ${ctx.urls.join(", ")} manually.`,
    ];
  }
  return { ok: false, headline, reason, pointers, steps: [] };
}

export interface VerdictGuardCtx {
  /**
   * Every namespace this invocation set out to publish — one for a plain build,
   * N for `build --composition a b`. A list rather than a string because the
   * fallback verdict's whole job is to say what was NOT deployed, and a
   * multi-target build that dies leaves every one of them on its previous dist.
   */
  urls: string[];
  /** The run's transcript — the file the verdict's last line points at. */
  buildLogPath: string;
  /**
   * Read LAZILY, at exit time — a signal can arrive at any point after this
   * guard is installed, so the fact cannot be passed by value here. Keeping it
   * a pull rather than a push also means a signal that lands while the process
   * is blocked in synchronous work still reaches whichever exit path runs.
   */
  termination?: () => SignalTermination | null;
  /**
   * The unhandled exception that is ending this process, if one is. Read LAZILY at
   * exit time for the same reason `termination` is: the throw happens long after the
   * guard is installed. Supplied by build.ts from `cli-crash.ts`, whose record
   * `runCli` writes on its way out.
   */
  crash?: () => string | null;
}

/**
 * The guard's exit-time action: print the fallback verdict. Its pointer names
 * the run's transcript, which the build's supervisor writes as the build prints
 * — so the pointer resolves on every path, this banner included.
 *
 * Extracted from `installVerdictGuard` (as `fallbackVerdict` already was) so it
 * is unit-testable without a live exit handler. Returns the verdict it acted
 * on, or null when the emitted verdict already agreed with the exit code.
 */
export function runVerdictGuard(
  emitted: { ok: boolean } | null,
  code: number,
  ctx: VerdictGuardCtx,
): Verdict | null {
  const v = fallbackVerdict(
    emitted,
    code,
    ctx,
    ctx.termination?.() ?? null,
    ctx.crash?.() ?? null,
  );
  if (v === null) return null;
  writeSync(1, `\n${renderVerdict(v)}\n`);
  return v;
}

// process.on("exit") backstop: the build cannot terminate without a verdict, and
// a verdict that disagrees with the exit code prints a loud bug banner. Register
// once, after `name`/`buildId` (and after finalizeBuildLog's own exit hook) exist.
// Thin wrapper over the pure `fallbackVerdict` + `runVerdictGuard`.
export function installVerdictGuard(ctx: VerdictGuardCtx): void {
  process.on("exit", (code) => {
    // Bun silently ignores process.exitCode reassignment inside an exit handler,
    // so this guard can only report a wrong code, never repair it.
    runVerdictGuard(emittedVerdict, code, ctx);
  });
}
