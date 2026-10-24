/**
 * How one spawned `./equin deploy` verb ended, and the single line that
 * says so — the `message` stamped on the run and rendered in the UI.
 *
 * Its own file because the choice of sentence is a pure decision worth testing,
 * and because it is where a whole class of wrong answer was possible: a status
 * of `128 + signo` is what POSIX reports for a KILLED child, so a run that was
 * signalled came back looking exactly like a run that chose to exit with that
 * status. It was then recorded, and shown, as `Exited with code 143` — a
 * sentence about a command that never exited and never refused. Observed:
 * `drun-1787890652933-wr3v6d`, whose `ship` was killed 0.9 s after it spawned
 * because a `./equin build` hot-restarted the backend it was a child of.
 *
 * The verb now runs under the supervised-run primitive, which fixes both halves
 * of that incident: the child is detached, so a backend restart no longer kills
 * it, and `signalCode` is **observed** — the shim's signal trap fired — rather
 * than guessed from the status. Nothing here may re-derive killed-ness from
 * `exitCode > 128`; that is the original guess wearing a different hat.
 */

import { HARD_KILL_EXIT_CODE } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core";

/**
 * The prefix `./equin deploy`'s `refuse()` puts on every named refusal.
 *
 * A failing run's `message` is the CLI's own words, and this is how the ONE line
 * that states the problem is picked out of a failure whose transcript also
 * carries the remote script's whole output. It is a coupling to the CLI's output
 * format, and the honest fix is a shared constant on the CLI side — but that file
 * is the engine and is deliberately not edited from here. When it does not match,
 * the fallback is the last non-blank line, which is never worse than a generic
 * "it failed".
 */
const REFUSAL_PREFIX = "deploy: ";

/**
 * Everything known about a finished leg, as ONE value.
 *
 * `signalCode` is a member rather than something the caller may pass — that is
 * the whole point of the type. Choosing the sentence takes the ending, so it
 * cannot be chosen from an exit code alone, which is the mistake that produced
 * `Exited with code 143`.
 */
export interface VerbEnding {
  /** Which verb was spawned — named in the message, since a run has two legs. */
  verb: "converge" | "ship";
  /**
   * The child's status, in the shell's own convention — `128 + signo` for a
   * signalled death. **Not a status when `signalCode` is set**, and
   * {@link HARD_KILL_EXIT_CODE} when there was no status to read at all.
   */
  exitCode: number;
  /**
   * The signal that killed the leg, bare POSIX name and no `SIG` prefix
   * (`"TERM"`, `"INT"`, `"HUP"`), or null when none was observed.
   *
   * It comes from `RunTerminal.signalCode` — the supervised-run shim's trap
   * having fired — so it is an observation. Read null as "not observed as
   * killed", never as "exited normally": a hard SIGKILL leaves no observer at
   * all and arrives here as {@link HARD_KILL_EXIT_CODE} with a null signal.
   */
  signalCode: string | null;
  /**
   * The tail of the leg's transcript, oldest first.
   *
   * Merged stdout and stderr: a supervised child writes both to one file
   * descriptor, so the interleaving survives and the per-line classification
   * does not. The `deploy: ` scan below is keyed on line content and is
   * unaffected; the fallback that used to be "the last non-blank **stderr**
   * line" is now "the last non-blank line".
   */
  lines: readonly string[];
}

/** Did the CLI run all the way through and say yes? */
export function verbSucceeded(ending: VerbEnding): boolean {
  return ending.signalCode === null && ending.exitCode === 0;
}

/**
 * The one line that says what went wrong.
 *
 * The two endings that are their own answer are checked first, and for the same
 * reason in each: the leg printed no refusal, and its transcript tail is only
 * whatever it had got round to, never the reason — so quoting it would present
 * an unrelated progress line as the cause. Otherwise it is the CLI's named
 * refusal, else its last word, else the status.
 */
export function verbFailureMessage(ending: VerbEnding): string {
  if (ending.exitCode === HARD_KILL_EXIT_CODE && ending.signalCode === null) {
    return hardKilledMessage(ending);
  }
  if (ending.signalCode !== null) return killedMessage(ending);
  const refusal = ending.lines.find((line) => line.startsWith(REFUSAL_PREFIX));
  if (refusal) return refusal.slice(REFUSAL_PREFIX.length);
  const last = [...ending.lines].reverse().find((line) => line.trim() !== "");
  return last ?? `Exited with code ${ending.exitCode}`;
}

/**
 * What to say when the CLI was killed instead of finishing.
 *
 * It no longer names a likely cause, and losing that sentence is the point. The
 * command used to be a plain child of this backend, sharing its process group,
 * so the gateway's hot-restart on every `./equin build` killed whatever
 * was in flight — a cause the user could not see and therefore had to be told.
 * The leg is now detached and survives that restart, so a signal here means
 * something genuinely signalled this run's process group: someone cancelled it,
 * an operator killed the tree, or the machine went down. Naming the old cause
 * would send the reader after a build that is no longer capable of doing this.
 */
function killedMessage(ending: VerbEnding): string {
  return (
    `The \`deploy ${ending.verb}\` command was killed by ${ending.signalCode} ` +
    `before it finished, so it never reported an outcome of its own — this is ` +
    `not a refusal or a failure on the remote host. Whatever the leg had already ` +
    `done on the host stands, and nothing after that point ran, so re-running ` +
    `the deploy is the fix.`
  );
}

/**
 * What to say when the leg's process disappeared without recording anything.
 *
 * Distinct from {@link killedMessage} because the evidence is different in kind:
 * a trapped signal is something the supervising shell watched arrive, while this
 * is the absence of any record at all. Only a SIGKILL (or the machine going
 * down) can produce it, since every other death runs the shim's trap — so the
 * sentence says what is actually known rather than naming a signal nobody saw.
 */
function hardKilledMessage(ending: VerbEnding): string {
  return (
    `The \`deploy ${ending.verb}\` command's process disappeared without ` +
    `recording an outcome, which only a hard kill (SIGKILL) or the machine ` +
    `going down can do — so it never refused and never reported a failure on ` +
    `the remote host. Whatever the leg had already done on the host stands, and ` +
    `nothing after that point ran, so re-running the deploy is the fix.`
  );
}
