import type { SlowOpReportPayload } from "../../core";
import { TRANSPORT_LAYER } from "../../shared/endpoints";

/**
 * What a wait layer's dominance points at. Keyed by layer name, not by
 * operation kind: a layer means the same thing whichever signal charged it, so
 * the description stays generic. A layer with no entry is still named with its
 * share — a hint only adds where to look.
 */
const WAIT_LAYER_HINTS: Readonly<Record<string, string>> = {
  [TRANSPORT_LAYER]:
    "The notifications socket was still coming up — look at transport/boot readiness, not this resource.",
  // perfs/latency-signal `update` phases.
  "server-notice":
    "The server took long to notice the change (commit → first notify): a long-held transaction, a slow change-feed consumer, or a stalled serving thread.",
  "server-deliver":
    "The server took long to recompute and send the frame after noticing (notify → send): look at this resource's loader and the push lane.",
  transport:
    "The frame took long on the wire (send → receipt) — the one phase measured across two clocks, so skew lands here too; on one machine it is socket backpressure or a busy browser main thread.",
  "client-apply":
    "The browser took long to apply the frame (receipt → cache written): a busy main thread.",
  // perfs/latency-signal `confirm` phases.
  "send-lane":
    "The write queued behind earlier writes on its send lane before leaving the browser.",
  retry: "The write failed and was retried before it went through.",
  "server-ack":
    "The server took long to answer the write (last send → ack): look at the endpoint's handler and its DB time.",
  "confirm-frame":
    "The confirming push frame arrived long after the ack: the same path as a slow live update.",
};

/** The largest layer of the trip's `waits` and its share of the duration, when any. */
function dominantWait(
  d: Pick<SlowOpReportPayload, "durationMs" | "waits">,
): { layer: string; ms: number; share: number } | undefined {
  let best: { layer: string; ms: number } | undefined;
  for (const [layer, ms] of Object.entries(d.waits ?? {})) {
    if (ms > 0 && (!best || ms > best.ms)) best = { layer, ms };
  }
  if (!best || d.durationMs <= 0) return undefined;
  return { ...best, share: Math.min(1, best.ms / d.durationMs) };
}

/**
 * The report description's "where the time went" lines: the trip's largest
 * wait layer, its share of the duration and its hint, then every layer by size.
 * Generic over operation kinds — empty when the trip carried no positive wait.
 */
export function describeWaits(
  d: Pick<SlowOpReportPayload, "durationMs" | "waits">,
): string[] {
  const dominant = dominantWait(d);
  if (!dominant) return [];
  const hint = WAIT_LAYER_HINTS[dominant.layer];
  return [
    `**Where the time went:** \`${dominant.layer}\` — ` +
      `${Math.round(dominant.ms)}ms, ${Math.round(dominant.share * 100)}% of this trip.` +
      (hint ? ` ${hint}` : ""),
    `All layers: ${Object.entries(d.waits ?? {})
      .sort(([, a], [, b]) => b - a)
      .map(([layer, ms]) => `\`${layer}\` ${Math.round(ms)}ms`)
      .join(", ")}.`,
  ];
}
