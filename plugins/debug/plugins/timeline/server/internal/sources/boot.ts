import { readBootEvents } from "@plugins/debug/plugins/boot-events/server";
import type { TimelineEvent } from "../../../core";
import { mapBootEvents } from "./boot-map";

// Disk-backed boot lane for one worktree. readBootEvents takes a lookback
// window relative to now, so we hand it now − fromMs (exact overlap on the
// lower edge, since processStartedAt <= readyAt) and let mapBootEvents apply
// the precise [fromMs, toMs] overlap.
export async function loadBootEvents(
  worktree: string,
  fromMs: number,
  toMs: number,
): Promise<TimelineEvent[]> {
  const windowMs = Math.max(0, Date.now() - fromMs);
  return mapBootEvents(
    await readBootEvents(worktree, windowMs),
    worktree,
    fromMs,
    toMs,
  );
}
