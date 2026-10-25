import type { SignalOrigin } from "@plugins/packages/plugins/signal-origin/core";
import { signalOriginLogDir } from "../../data-dirs";

/**
 * The host-global record of who killed an op.
 *
 * Host-global for the reason `build-progress.jsonl` next door already gives: an
 * incident is investigated from whichever shell is free, not from the worktree
 * that died. It is also the ONLY durable record for the cases the deploy receipt
 * cannot cover — `check` and `push` (which own no receipt), a build killed
 * BEFORE it took the build lock, and an arm failure (not a death at all, but
 * still the reason a later death is unattributed).
 */
export const SIGNAL_ORIGIN_FILE = signalOriginLogDir.file(
  "signal-origin.jsonl",
);

/** Fields every line carries, whatever its `event`. */
interface SignalOriginLineBase {
  /** ISO instant the line was appended (a hair after the event it records). */
  at: string;
  /**
   * The op's own run id, unique per run: `build_runs.id` for a build, the push
   * id for a push, the check's run id for a check. Named for the build case
   * because that is the one a reader can join back to a row it can see; the
   * other two own no record anywhere else, and this file is all they have.
   */
  buildId: string;
  worktree: string;
}

/**
 * A signal actually arrived. `origin` is null when the tap was not armed (no C
 * toolchain, or `EQUIN_NO_SIGNAL_ORIGIN=1`) — kept as an explicit field
 * rather than an omitted one so a reader can tell "we looked and could not see"
 * from "we never looked".
 */
export interface SignalRecordedLine extends SignalOriginLineBase {
  event: "signal";
  signal: string;
  origin: SignalOrigin | null;
}

/** The tap could not be armed. Recorded once per op, not per signal. */
export interface ArmFailedLine extends SignalOriginLineBase {
  event: "arm-failed";
  reason: string;
}

export type SignalOriginLine = SignalRecordedLine | ArmFailedLine;

/**
 * What a WRITER hands the sink: a line minus `at`, which the sink stamps itself
 * so every line's timestamp comes from one clock. Written as a union of two
 * `Omit`s rather than `Omit<SignalOriginLine, "at">` — the latter collapses a
 * union to its common keys, which would erase both `origin` and `reason`.
 */
export type SignalOriginLineInput =
  Omit<SignalRecordedLine, "at"> | Omit<ArmFailedLine, "at">;
