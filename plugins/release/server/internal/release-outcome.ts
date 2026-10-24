/**
 * How one `./equin release` ended, and the single sentence that says so —
 * the string stamped on `release_runs.error` AND returned as the `failed` arm's
 * `message`, which is why they are computed in one place: a caller that reports
 * the failure (the Deploy app's `update`) and a user who later opens the run
 * detail must read one sentence, not two wordings of it.
 *
 * Its own file because the choice of sentence is a pure decision worth testing,
 * and because it is where a whole class of wrong answer is possible: a status of
 * `128 + signo` is what POSIX reports for a KILLED child, so a run that was
 * signalled comes back looking exactly like a run that chose to exit with that
 * status. Nothing here may re-derive killed-ness from `exitCode > 128`;
 * `signalCode` is an OBSERVATION (the supervised-run shim's trap fired) and is
 * the only admissible source.
 */

import { HARD_KILL_EXIT_CODE } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core";

/** Everything known about a finished release, as ONE value. */
export interface ReleaseEnding {
  /**
   * The child's status, in the shell's own convention — `128 + signo` for a
   * signalled death. **Not a status when `signalCode` is set**, and
   * `HARD_KILL_EXIT_CODE` when there was no status to read at all.
   */
  exitCode: number;
  /**
   * The signal that killed the run, bare POSIX name and no `SIG` prefix
   * (`"TERM"`, `"INT"`, `"HUP"`), or null when none was observed. Read null as
   * "not observed as killed", never as "exited normally".
   */
  signalCode: string | null;
  /**
   * Did the CLI write its `RELEASE.json`? The manifest is the artifact's own
   * receipt, so a run without one produced nothing shippable however it exited.
   */
  manifest: boolean;
  /** How long the run took, from its ledger row's start to the child's finish. */
  durationSeconds: number;
}

/**
 * Did the release actually produce something?
 *
 * `signalCode` is deliberately NOT part of this test, which is the one place
 * this differs from deploy's `verbSucceeded`. A SIGINT is *recorded* on a
 * supervised run and cannot stop it — POSIX has a non-interactive shell set INT
 * to ignore for an asynchronous list's commands, so the child runs to completion
 * — and a run that completed, exited 0 and wrote its manifest did succeed. A
 * signal that genuinely killed the CLI shows up as a non-zero status and no
 * manifest, so it is already caught by both other clauses.
 */
export function releaseSucceeded(ending: ReleaseEnding): boolean {
  return ending.exitCode === 0 && ending.manifest;
}

/**
 * The one line that says what went wrong.
 *
 * The two endings that are their own answer are checked first: a killed run and
 * a vanished run never refused and never reported anything, so quoting a status
 * at the user would present a number that means something else. Otherwise the
 * status and the duration, which is what the pipe-era wording said and what the
 * Deploy app already surfaces verbatim.
 */
export function releaseFailureMessage(ending: ReleaseEnding): string {
  if (ending.exitCode === HARD_KILL_EXIT_CODE && ending.signalCode === null) {
    return (
      `The release process disappeared without recording an outcome, which only a ` +
      `hard kill (SIGKILL) or the machine going down can do — so it never reported ` +
      `a failure of its own. Nothing was published, and re-running the release is ` +
      `the fix.`
    );
  }
  if (ending.signalCode !== null) {
    return (
      `The release was killed by ${ending.signalCode} after ${ending.durationSeconds}s, ` +
      `before it finished, so it never reported an outcome of its own. Nothing was ` +
      `published, and re-running the release is the fix.`
    );
  }
  // The CLI ran to a status of its own. A zero status with no manifest is its
  // own case: the command claimed success and produced no artifact, and saying
  // "exited with code 0" about a failure would read as a contradiction.
  if (ending.exitCode === 0) {
    return (
      `The release exited cleanly after ${ending.durationSeconds}s but wrote no ` +
      `RELEASE.json, so there is no artifact to ship or preview.`
    );
  }
  return `Release exited with code ${ending.exitCode} after ${ending.durationSeconds}s`;
}
