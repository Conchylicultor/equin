import type { SignalOriginLine } from "@plugins/packages/plugins/signal-origin/plugins/sink/core";
import type { BuildTermination } from "../../core";

/**
 * Fold the host-global sink down to what it knows about ONE run.
 *
 * Pure (lines in, record out) so every arm is a unit test rather than a
 * filesystem fixture. Filtering is on `buildId` alone and NOT on `worktree`:
 * the id is already unique per run, and a run's own worktree name is not
 * something the reader should have to know to find it.
 *
 * The LAST line of each kind wins. A repeated kill appends a second `signal`
 * line, and the later one carries the higher hit count and the more recent
 * sender — the escalation, not the first tap.
 */
export function selectTermination(
  lines: readonly SignalOriginLine[],
  buildId: string,
): BuildTermination {
  const result: BuildTermination = { signal: null, armFailure: null };
  for (const line of lines) {
    if (line.buildId !== buildId) continue;
    if (line.event === "signal") {
      result.signal = { at: line.at, signal: line.signal, origin: line.origin };
    } else {
      result.armFailure = { at: line.at, reason: line.reason };
    }
  }
  return result;
}
