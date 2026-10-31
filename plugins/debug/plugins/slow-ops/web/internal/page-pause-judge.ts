import type { PagePauses } from "@plugins/primitives/plugins/perfs/plugins/page-pauses/web";
import {
  HIDDEN_LAYER,
  STALL_LAYER,
  type SlowOpClientItem,
} from "../../shared/endpoints";

/** A wall-clock span, epoch ms — where a client measurement sat. */
export interface SpanWindow {
  startMs: number;
  endMs: number;
}

/** The window of a measurement that ended now and lasted `durationMs`. */
export function endingNow(durationMs: number): SpanWindow {
  const endMs = Date.now();
  return { startMs: endMs - durationMs, endMs };
}

/**
 * Apply the page's pauses inside an item's window → the item to send, or null
 * when it no longer counts. Each paused class is charged to its own layer and
 * taken off the item's own time; under its bar after that, it was not slow
 * itself:
 *
 * - hidden or frozen: `page-hidden` — a throttled tab's timers and frames
 *   measure the browser, not the system, so only the visible part is judged;
 * - main-thread stalls (outside the hidden time): `main-thread-stall` — the
 *   stall is filed on its own by main-thread-stall.
 *
 * Run at the queue's flush, not at the emit: a long frame's entry is delivered
 * after the frame.
 */
export function judgePagePauses(
  item: SlowOpClientItem,
  pauses: PagePauses,
): SlowOpClientItem | null {
  const hiddenMs = Math.round(pauses.hiddenMs);
  const stalledMs = Math.round(pauses.stalledMs);
  const charged = {
    ...(hiddenMs > 0 ? { [HIDDEN_LAYER]: hiddenMs } : {}),
    ...(stalledMs > 0 ? { [STALL_LAYER]: stalledMs } : {}),
  };
  const pausedMs = Object.values(charged).reduce((a, b) => a + b, 0);
  if (pausedMs <= 0) return item;
  const ownMs = Math.max(0, (item.ownMs ?? item.durationMs) - pausedMs);
  if (ownMs <= item.thresholdMs) return null;
  return { ...item, ownMs, waits: { ...item.waits, ...charged } };
}
