import type { ClientLatencySample } from "@plugins/primitives/plugins/perfs/plugins/latency-signal/core";
import { canonicalJson } from "@plugins/packages/plugins/canonical-params/core";
import type { ConfigValues } from "@plugins/config_v2/core";
import { CLIENT_SIGNAL_THRESHOLD, type slowOpConfig } from "../../core";
import type { SlowOpClientItem } from "../../shared/endpoints";

type Thresholds = ConfigValues<(typeof slowOpConfig)["fields"]>;

/**
 * One client latency sample → the slow-op item it files, or null when it does
 * not count. Generic over the signal vocabulary: the threshold comes from
 * `CLIENT_SIGNAL_THRESHOLD`, the layers are the sample's own phases, so a new
 * signal needs no branch here.
 *
 * - A `hidden` sample is skipped: a background tab's timers and frames are
 *   throttled, so its number measures the browser, not the system.
 * - At or under the threshold is not slow (the same `>` as every other signal).
 * - `operation` is the resource key alone, so one resource stays one row; which
 *   instance ran (its params, or a confirm's `mode/edge`) is the `variant`.
 */
export function latencySlowOp(
  sample: ClientLatencySample,
  thresholds: Thresholds,
  route: string,
): SlowOpClientItem | null {
  if (sample.hidden) return null;
  const thresholdMs = thresholds[CLIENT_SIGNAL_THRESHOLD[sample.signal]];
  if (sample.totalMs <= thresholdMs) return null;
  return {
    operationKind: sample.signal,
    operation: sample.key,
    durationMs: Math.round(sample.totalMs),
    thresholdMs,
    caller: { kind: "route", label: route },
    detail: { variant: sample.variant ?? canonicalJson(sample.params) },
    waits: { ...sample.phases },
  };
}
