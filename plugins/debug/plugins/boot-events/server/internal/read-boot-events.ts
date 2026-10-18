import { readChannelJson } from "@plugins/primitives/plugins/log-channels/plugins/log-files/server";
import { BootLineSchema, type BootEvent } from "./schema";
import { pairBootLines } from "./pair-boot-lines";

// Lines read per worktree file (newest kept). Two lines per boot; even a
// deploy-heavy day is tens of boots, so this comfortably covers any realistic
// lookback window.
const MAX_LINES = 1000;

// Read the persisted boot lines (envelope-unwrap + safeParse-drop via the
// log-channels primitive; a missing boot.jsonl — worktree predates this plugin,
// or never booted — is a legitimately-empty history), pair them into boot
// intervals, and keep those overlapping the window.
export function readBootEvents(worktree: string, windowMs: number): BootEvent[] {
  const cutoff = Date.now() - windowMs;
  const lines = readChannelJson(worktree, "boot", MAX_LINES, BootLineSchema);
  // A boot's interval starts at processStartedAt and ends at readyAt, at the
  // superseding attempt's start, or (never-ready latest attempt) extends to
  // now — so it overlaps [cutoff, now] iff its end edge is >= cutoff, with an
  // unbounded end always overlapping.
  return pairBootLines(lines).filter(
    (e) => (e.readyAt ?? e.supersededAtMs ?? Number.POSITIVE_INFINITY) >= cutoff,
  );
}
