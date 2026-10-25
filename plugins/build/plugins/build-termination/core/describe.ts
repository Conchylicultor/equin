import { killedSignalName, type BuildStatus } from "@plugins/build/plugins/build-status/core";
import { formatSignalOrigin } from "@plugins/packages/plugins/signal-origin/core";
import type { BuildTermination } from "./termination";

/** What the detail pane prints under the status badge. */
export interface TerminationDescription {
  /** One line naming the signal and, when it is known, its sender. */
  headline: string;
  /**
   * Why the sender is not named, when it is not. Null when it IS named — the
   * headline already says everything, and a permanent "attribution: fine" line
   * would be noise.
   */
  note: string | null;
}

/**
 * The one place a run's death is turned into words. Pure — no hooks, no fetch —
 * so every arm below is a unit test rather than a screenshot.
 *
 * `record: null` means NOT YET LOADED. A loaded response is always an object
 * (`{signal: null, armFailure: null}` when the host recorded nothing), which is
 * exactly the distinction this function needs: while the request is in flight it
 * must not claim there is no record.
 *
 * The invariant across every arm: **when we cannot name the sender, we say so.**
 * Rendering nothing would make "killed by something we could not identify" look
 * identical to "nothing killed it", which is the ambiguity this whole feature
 * exists to remove.
 */
export function describeTermination(
  status: BuildStatus,
  exitCode: number | null,
  record: BuildTermination | null,
): TerminationDescription | null {
  if (status !== "killed" && status !== "interrupted") return null;

  const armNote =
    record?.armFailure != null
      ? `Attribution was unavailable for this run: ${record.armFailure.reason}`
      : null;

  const signalLine = record?.signal ?? null;
  if (signalLine !== null) {
    if (signalLine.origin !== null) {
      // The sender is named. `formatSignalOrigin` owns the wording (pid, exe
      // path, ancestry chain, uid) — never re-derived here.
      return { headline: formatSignalOrigin(signalLine.origin), note: null };
    }
    return {
      headline: `${signalLine.signal} — sender unknown`,
      note:
        armNote ??
        "The signal arrived, but the attribution tap recorded no sender for it.",
    };
  }

  // No signal line for this run. For `interrupted` that is the EXPECTED state,
  // and saying "unknown sender" would imply a lookup that could have succeeded.
  if (status === "interrupted") {
    return {
      headline: "Hard-killed — no signal recorded",
      note:
        record === null
          ? null // still loading; nothing is known yet, so claim nothing
          : (armNote ??
            "SIGKILL cannot be caught, so no sender can ever be recorded for it."),
    };
  }

  // `killed` ⇒ exitCode > 128 by construction; the guard keeps the function
  // total rather than trusting a caller to have derived the status from the
  // same code it passes.
  const named = exitCode === null ? "A fatal signal" : killedSignalName(exitCode);
  return {
    headline: `${named} — sender unknown`,
    note:
      record === null
        ? null // still loading — the sender may yet be named
        : (armNote ??
          "No attribution record for this run — it predates signal attribution, or the record has rotated away."),
  };
}
