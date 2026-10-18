import { readChannelJsonAsync } from "@plugins/primitives/plugins/log-channels/plugins/log-files/server";
import { SlowOpMarkerSchema, type SlowOpMarker } from "../../core";

// Cap on marker lines read per worktree file (newest kept). Generous so a chatty
// backend's window is never truncated before the health pane's read window cuts
// it off; the web layer coalesces markers to the 10s sample grid regardless.
const MAX_LINES = 5000;

// Read this worktree's slow-op markers from its persisted `slow-op-markers`
// channel (logs/slow-op-markers.jsonl): envelope-unwrap + safeParse-drop via the
// log-channels primitive, then filter to the read window. Async: its reader is
// the health pane's live-value loader, which must never block the event loop.
export async function readSlowOpMarkers(
  worktree: string,
  windowMs: number,
): Promise<SlowOpMarker[]> {
  const cutoff = Date.now() - windowMs;
  const markers = await readChannelJsonAsync(
    worktree,
    "slow-op-markers",
    MAX_LINES,
    SlowOpMarkerSchema,
  );
  return markers.filter((m) => m.atTime.getTime() >= cutoff);
}
