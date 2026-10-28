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
 * - A CENSORED sample (the operation had not finished by its deadline — a
 *   write that never confirmed) is filed the same way, as its own row: its
 *   `operation` is `<key> (unconfirmed)`, so its report (fingerprinted on the
 *   operation) is never merged into the slow-but-confirmed one — "never
 *   confirmed" is a different bug from "confirmed late". `detail.censored`
 *   marks it, its waits are the phases it reached (the missing one is where
 *   it stalled), and any `detail` it carries (an ack watermark) rides along.
 */
export function latencySlowOp(
  sample: ClientLatencySample,
  thresholds: Thresholds,
  route: string,
): SlowOpClientItem | null {
  if (sample.hidden) return null;
  const thresholdMs = thresholds[CLIENT_SIGNAL_THRESHOLD[sample.signal]];
  if (sample.totalMs <= thresholdMs) return null;
  const variant = sample.variant ?? canonicalJson(sample.params);
  if (sample.censored) {
    const waits: Record<string, number> = {};
    for (const [phase, ms] of Object.entries(sample.phases))
      if (ms !== undefined) waits[phase] = ms;
    return {
      operationKind: sample.signal,
      operation: `${sample.key}${UNCONFIRMED_SUFFIX}`,
      durationMs: Math.round(sample.totalMs),
      thresholdMs,
      caller: { kind: "route", label: route },
      detail: {
        variant,
        censored: true,
        ...(sample.detail === undefined ? {} : { evidence: sample.detail }),
      },
      waits,
    };
  }
  return {
    operationKind: sample.signal,
    operation: sample.key,
    durationMs: Math.round(sample.totalMs),
    thresholdMs,
    caller: { kind: "route", label: route },
    detail: { variant },
    waits: { ...sample.phases },
  };
}

/** What a censored sample's `operation` ends with — its own row and report. */
export const UNCONFIRMED_SUFFIX = " (unconfirmed)";
