/**
 * A child process we started died of a signal: the kernel ended it (the OOM
 * killer's SIGKILL, a crash's SIGSEGV / SIGABRT) or someone else did. Nothing it
 * was asked to judge got judged, so a caller that reports a verdict must not
 * read this as one — a type-check worker the OOM killer took is not a type
 * error.
 *
 * Thrown by the spawn sites that know their child's death is a signal (its
 * `signalCode`, or the `128 + signo` exit a first-party child authors after
 * seeing one — `signalExitCode`), and read back by `killedByOf` anywhere
 * up the stack, through `cause` chains, so an intermediate layer that wraps the
 * error keeps the fact.
 */
export class ChildKilledError extends Error {
  constructor(
    /** What died, in words ("type-check worker for \"repo\""). */
    readonly what: string,
    /** Its signal's name (`"SIGKILL"`), or `SIG<n>` for one with no name here. */
    readonly signal: string,
    detail?: string,
  ) {
    super(`${what} was killed by ${signal}${detail ? `:\n${detail}` : ""}`);
    this.name = "ChildKilledError";
  }
}

/** The `ChildKilledError` an error is, or carries in its `cause` chain. */
export function killedByOf(err: unknown): ChildKilledError | null {
  let at: unknown = err;
  for (let depth = 0; depth < 16 && at !== undefined && at !== null; depth++) {
    if (at instanceof ChildKilledError) return at;
    at = at instanceof Error ? at.cause : undefined;
  }
  return null;
}

/**
 * The POSIX signal numbers that agree on macOS and Linux, plus the few that
 * differ, per platform. Written out rather than read from `node:os` (`core/`
 * runs on every host); a signal missing here is a loud error, never a guess.
 */
const PORTABLE: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGSEGV: 11,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
  SIGXCPU: 24,
  SIGXFSZ: 25,
};
const BY_PLATFORM: Record<string, Record<string, number>> = {
  darwin: { SIGBUS: 10, SIGSYS: 12, SIGUSR1: 30, SIGUSR2: 31 },
  linux: { SIGBUS: 7, SIGSYS: 31, SIGUSR1: 10, SIGUSR2: 12 },
};

function signalTable(): Record<string, number> {
  return { ...PORTABLE, ...(BY_PLATFORM[process.platform] ?? {}) };
}

/** Signal numbers on this side of 128 + signo (the shell's convention). */
const SIGNAL_EXIT_BASE = 128;

/**
 * The exit code a first-party process authors when what ended its work was a
 * signal — its own (the op CLIs' fatal-signal exits) or a child's it observed:
 * `128 + signo`, the shell's spelling. Throws on a signal this table cannot
 * number: a made-up code would be read back as a different signal.
 */
export function signalExitCode(signal: string): number {
  const numeric = /^\d+$/.test(signal)
    ? Number(signal)
    : /^SIG\d+$/.test(signal)
      ? Number(signal.slice(3))
      : signalTable()[signal];
  if (numeric === undefined || numeric <= 0) {
    throw new Error(
      `[spawn] no signal number for ${JSON.stringify(signal)} on ${process.platform}`,
    );
  }
  return SIGNAL_EXIT_BASE + numeric;
}

/**
 * The signal a FIRST-PARTY child's exit code says ended it (`128 + signo`), or
 * null for any other code.
 *
 * Legal only for a child whose codes this repo authors (a bun script of ours,
 * an op CLI): for an arbitrary command, 143 cannot be told apart from a program
 * that chose `exit(143)`. A caller reading a child it did not write uses the
 * spawn result's `signalCode` alone.
 */
export function authoredSignalOf(exitCode: number): string | null {
  if (exitCode <= SIGNAL_EXIT_BASE || exitCode > SIGNAL_EXIT_BASE + 64)
    return null;
  const signo = exitCode - SIGNAL_EXIT_BASE;
  const named = Object.entries(signalTable()).find(([, n]) => n === signo);
  return named?.[0] ?? `SIG${signo}`;
}

/**
 * What a first-party child's ending says about a signal: the one its kernel
 * reported (`signalCode`), else the one it authored (`authoredSignalOf`), else
 * null — it exited on its own.
 */
export function childSignalOf(ended: {
  exitCode: number;
  signalCode: string | null;
}): string | null {
  return ended.signalCode ?? authoredSignalOf(ended.exitCode);
}
