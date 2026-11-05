import type { BootEvent, BootLine } from "./schema";

// Pure pairing of parsed boot lines into BootEvents — co-located bun tests.
//
// A ready line is authoritative for its boot (pre-cutover history is
// ready-lines-only, so a ready line must never require a matching start). A
// start line without a ready line is a boot that never became ready: crashed
// when an exited line pairs with it (`exitedAt`), known dead when the boot
// watchdog's dead line pairs with it (`deadBy`), else bounded by the next
// boot attempt's start when one follows (a crash-loop must not render as a
// stack of eternal open bars), and open-ended when it is the latest line —
// possibly still booting, possibly wedged right now.
export function pairBootLines(lines: readonly BootLine[]): BootEvent[] {
  const readyStarts = new Set<number>();
  const exits = new Map<number, number>();
  const deaths = new Map<number, number>();
  for (const line of lines) {
    if ("readyAt" in line) readyStarts.add(line.processStartedAt);
    else if (line.phase === "exited")
      exits.set(line.processStartedAt, line.exitedAt);
    else if (line.phase === "dead")
      deaths.set(line.processStartedAt, line.deadBy);
  }

  const events: BootEvent[] = [];
  const unpaired: BootEvent[] = [];
  for (const line of lines) {
    if ("readyAt" in line) {
      events.push({
        worktree: line.worktree,
        processStartedAt: line.processStartedAt,
        readyAt: line.readyAt,
        exitedAt: null,
        deadBy: null,
        supersededAtMs: null,
      });
    } else if (
      line.phase === "start" &&
      !readyStarts.has(line.processStartedAt)
    ) {
      unpaired.push({
        worktree: line.worktree,
        processStartedAt: line.processStartedAt,
        readyAt: null,
        exitedAt: exits.get(line.processStartedAt) ?? null,
        deadBy: deaths.get(line.processStartedAt) ?? null,
        supersededAtMs: null,
      });
    }
  }

  // Bound each never-ready attempt by the next boot's start (per worktree —
  // one file normally holds one worktree, but the pairing shouldn't rely on
  // that). Sort a copy by start time to find successors.
  if (unpaired.length > 0) {
    const startsByWorktree = new Map<string, number[]>();
    for (const line of lines) {
      // Only start (and ready) lines are attempts; the terminal lines repeat
      // their boot's processStartedAt.
      if (line.phase === "exited" || line.phase === "dead") continue;
      const list = startsByWorktree.get(line.worktree) ?? [];
      list.push(line.processStartedAt);
      startsByWorktree.set(line.worktree, list);
    }
    for (const list of startsByWorktree.values()) list.sort((a, b) => a - b);
    for (const ev of unpaired) {
      const starts = startsByWorktree.get(ev.worktree)!;
      const next = starts.find((s) => s > ev.processStartedAt);
      ev.supersededAtMs = next ?? null;
    }
    events.push(...unpaired);
  }

  return events.sort((a, b) => a.processStartedAt - b.processStartedAt);
}
