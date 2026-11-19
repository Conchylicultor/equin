import {
  BUILD_EXIT_HARD_KILLED,
  BUILD_EXIT_OUT_OF_MEMORY,
  BUILD_EXIT_SIGNAL_BASE,
  BUILD_EXIT_SUPERSEDED,
} from "./exit-codes";

/**
 * How a build run ended, as one closed set. Five of the seven arms are *not*
 * defects — only `failed` is a build that ran to a verdict and gave a bad one:
 *
 * - `superseded` — its tree was replaced mid-run, so it never had a subject
 *   (see `BUILD_EXIT_SUPERSEDED`'s docblock).
 * - `interrupted` — its owner was hard-killed by a newer build's restart, so
 *   there is no artifact and no verdict.
 * - `killed` — a signal arrived from outside the build (SIGTERM/SIGINT/…): a
 *   human, a supervisor, another agent. Says nothing about the code.
 * - `out-of-memory` — the computer ran out of memory and the kernel killed a
 *   step (see `BUILD_EXIT_OUT_OF_MEMORY`). Says nothing about the code either,
 *   but unlike `killed` it is the user's to hear: nothing deployed, and only
 *   free memory changes the next attempt.
 *
 * Everything that renders or reasons about a run's outcome goes through
 * `buildStatusOf`, so no call site branches on exit codes again.
 */
export type BuildStatus =
  | "running"
  | "success"
  | "superseded"
  | "interrupted"
  | "killed"
  | "out-of-memory"
  | "failed";

/** The two fields that decide a status — any `BuildRun` satisfies it. */
export interface BuildRunOutcome {
  finishedAt: Date | null;
  exitCode: number | null;
}

const SIGNAL_NAMES: Record<number, string> = {
  1: "SIGHUP",
  2: "SIGINT",
  3: "SIGQUIT",
  4: "SIGILL",
  6: "SIGABRT",
  8: "SIGFPE",
  9: "SIGKILL",
  11: "SIGSEGV",
  13: "SIGPIPE",
  14: "SIGALRM",
  15: "SIGTERM",
  24: "SIGXCPU",
  25: "SIGXFSZ",
  30: "SIGUSR1",
  31: "SIGUSR2",
};

/** Total: every run has exactly one status, and it never depends on the caller. */
export function buildStatusOf(run: BuildRunOutcome): BuildStatus {
  if (run.finishedAt === null) return "running";
  const { exitCode } = run;
  if (exitCode === 0) return "success";
  if (exitCode === BUILD_EXIT_SUPERSEDED) return "superseded";
  if (exitCode === BUILD_EXIT_HARD_KILLED) return "interrupted";
  if (exitCode === BUILD_EXIT_OUT_OF_MEMORY) return "out-of-memory";
  if (exitCode !== null && exitCode > BUILD_EXIT_SIGNAL_BASE) return "killed";
  return "failed";
}

/**
 * The POSIX signal name encoded in a `killed` run's exit code (128 + signo).
 * Total over every number: a signal we have no name for renders as `SIG<n>`
 * rather than vanishing, so the detail line always says something true.
 */
export function killedSignalName(exitCode: number): string {
  const signo = exitCode - BUILD_EXIT_SIGNAL_BASE;
  return SIGNAL_NAMES[signo] ?? `SIG${signo}`;
}
