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
export async function readBootEvents(
  worktree: string,
  windowMs: number,
): Promise<BootEvent[]> {
  const cutoff = Date.now() - windowMs;
  const lines = await readChannelJson(
    worktree,
    "boot",
    MAX_LINES,
    BootLineSchema,
  );
  // A boot's interval starts at processStartedAt and ends at readyAt, at its
  // exit (a boot crash), at the superseding attempt's start, when it was known
  // dead (the watchdog's dead line), or (never-ready latest attempt) extends to
  // now — so it overlaps [cutoff, now] iff its end edge is >= cutoff, with an
  // unbounded end always overlapping.
  return pairBootLines(lines).filter(
    (e) =>
      (e.readyAt ??
        e.exitedAt ??
        e.supersededAtMs ??
        e.deadBy ??
        Number.POSITIVE_INFINITY) >= cutoff,
  );
}

// A restart-heavy month: main booted ~1,900 times in 35 days (2026-11-19,
// ~3,900 lines) — far past MAX_LINES. Starts are counted from enough lines
// for a quarter of that pace, and the answer says when it ran out of lines
// before reaching `sinceMs`.
const COUNT_MAX_LINES = 40_000;

/**
 * Every boot of `worktree` whose process started at or after `sinceMs`, as its
 * start instant (epoch ms), oldest first — a boot is counted whether it became
 * ready or not. `complete: false` when the file's kept lines start after
 * `sinceMs` (rotated away, or more boots than the read covers): the earliest
 * counted boot then marks where knowledge begins (`knownFrom`; its own day is
 * partial). `knownFrom: null` — the read covers the whole window.
 */
export async function readBootStartsSince(
  worktree: string,
  sinceMs: number,
): Promise<{ starts: number[]; knownFrom: number | null }> {
  const lines = await readChannelJson(
    worktree,
    "boot",
    COUNT_MAX_LINES,
    BootLineSchema,
  );
  const starts = pairBootLines(lines)
    .map((e) => e.processStartedAt)
    .sort((a, b) => a - b);
  const oldest = starts[0];
  return {
    starts: starts.filter((s) => s >= sinceMs),
    // The read reached back past `sinceMs` only if it kept a boot before it.
    knownFrom:
      oldest !== undefined && oldest < sinceMs ? null : (oldest ?? null),
  };
}
