import type { SlowResourceInfo } from "@plugins/primitives/plugins/live-state/web";
import { canonicalJson } from "@plugins/packages/plugins/canonical-params/core";
import type { ConfigValues } from "@plugins/config_v2/core";
import type { slowOpConfig } from "../../core";
import { TRANSPORT_LAYER, type SlowOpClientItem } from "../../shared/endpoints";

type Thresholds = ConfigValues<(typeof slowOpConfig)["fields"]>;

/**
 * One resource tuple's mount → first-data settle → the `element` slow-op item it
 * files, or null when it does not count.
 *
 * - At or under `elementMs` is not slow (the same `>` as every other signal).
 * - `operation` is the resource key alone, so one resource stays one row (one
 *   report, one toast) however many tuples of it settle slowly; which tuple ran
 *   is the `variant` (`canonicalJson(params)`), merged into the row's
 *   `variants` — the same rule as `latencySlowOp`.
 * - The transport bring-up wait is additive attribution, charged to its own
 *   layer so the report says WHY it was slow (transport cold-start vs resource
 *   compute) — never a reason to drop the settle.
 */
export function elementSlowOp(
  info: SlowResourceInfo,
  thresholds: Thresholds,
  route: string,
): SlowOpClientItem | null {
  const thresholdMs = thresholds.elementMs;
  if (info.durationMs <= thresholdMs) return null;
  return {
    operationKind: "element",
    operation: info.key,
    durationMs: Math.round(info.durationMs),
    thresholdMs,
    // The route under which the element settled is the cheap, reliable "who
    // mounted this resource" attribution.
    caller: { kind: "route", label: route },
    detail: { variant: canonicalJson(info.params) },
    transportColdStart: info.transportColdStart,
    ...(info.transportWaitMs > 0
      ? { waits: { [TRANSPORT_LAYER]: info.transportWaitMs } }
      : {}),
  };
}
