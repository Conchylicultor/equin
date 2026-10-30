import type { PagePauses } from "@plugins/primitives/plugins/perfs/plugins/page-pauses/web";
import { STALL_LAYER, type SlowOpClientItem } from "../../shared/endpoints";

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
 * when it no longer counts:
 *
 * - hidden or frozen at any point: dropped — a throttled tab's timers and
 *   frames measure the browser, not the system;
 * - main-thread stalls inside it: charged to `main-thread-stall` (the stall is
 *   filed on its own by main-thread-stall) and taken off its own time; under
 *   its bar after that, it was not slow itself.
 *
 * Run at the queue's flush, not at the emit: a long frame's entry is delivered
 * after the frame.
 */
export function judgePagePauses(
  item: SlowOpClientItem,
  pauses: PagePauses,
): SlowOpClientItem | null {
  if (pauses.hidden) return null;
  if (pauses.stalledMs <= 0) return item;
  const ownMs = Math.max(
    0,
    (item.ownMs ?? item.durationMs) - Math.round(pauses.stalledMs),
  );
  if (ownMs <= item.thresholdMs) return null;
  return {
    ...item,
    ownMs,
    waits: { ...item.waits, [STALL_LAYER]: Math.round(pauses.stalledMs) },
  };
}
