// The one record of "this CLI process died on an exception nobody handled".
//
// Commander's async actions reject rather than exiting, so an unhandled throw
// anywhere inside `build` / `check` / `push` unwinds all the way out to `runCli`,
// which prints it and sets exit 1. The build's own failure funnel is never
// reached, so the verdict guard prints `BUILD FAILED — aborted before completing`
// with NO reason: the transcript on disk names no step, no check and no error,
// and the only copy of what actually happened is a stderr line in whatever
// spawned the CLI. That is what made a host-semaphore identity crash read as a
// contentless build failure.
//
// `runCli` records the error here on its way out; the build's verdict guard pulls
// it at exit time (lazily, exactly like the fatal-signal record) and folds it into
// the banner, so build.log names its own cause on every path.
//
// A command run as a supervised job's child (`type-check-backstop`, a build) also
// writes the record to the run's error file (`claimRunErrorFile`), which the job's
// ledger reads as the failed run's error — the end of its transcript is the
// error's STACK, not its message.

import {
  takeRunErrorPath,
  writeRunErrorSync,
} from "@plugins/infra/plugins/jobs/plugins/supervised-job/cli";

let crash: string | null = null;
let runErrorPath: string | null = null;

/**
 * Take, once at the CLI's start, the error file this process records its crash
 * to when it is a supervised run's child — and out of the environment, so a
 * command it spawns cannot write over its record.
 */
export function claimRunErrorFile(): void {
  runErrorPath = takeRunErrorPath();
}

/** Longest error text the verdict banner will carry — a stack is quoted, not dumped. */
const MAX_LINES = 8;

/**
 * Render an unknown thrown value as the few lines worth putting in a verdict.
 * Errors keep `name: message` plus the top frames; anything else is stringified.
 */
function describe(err: unknown): string {
  // `String(err)` for the non-Error case rather than a JSON dump: it cannot throw on
  // a circular value, which matters here because this runs on the way out of a
  // process that is already failing.
  const text =
    err instanceof Error
      ? (err.stack ?? `${err.name}: ${err.message}`)
      : String(err);
  const lines = text.split("\n");
  return lines.length <= MAX_LINES
    ? text
    : [
        ...lines.slice(0, MAX_LINES),
        `  … ${lines.length - MAX_LINES} more line(s)`,
      ].join("\n");
}

/** Record the exception that is ending this CLI process. Last writer wins. */
export function recordCliCrash(err: unknown): void {
  crash = describe(err);
  if (runErrorPath !== null) writeRunErrorSync(runErrorPath, err);
}

/**
 * The recorded crash text, or `null` when this process is not dying on an
 * unhandled exception. Synchronous and pure — safe from a `process.on("exit")`
 * handler, which is the only caller that matters.
 */
export function readCliCrash(): string | null {
  return crash;
}
