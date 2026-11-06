import type { SlowResourceInfo } from "@plugins/network/plugins/live/plugins/live-state/web";
import { canonicalJson } from "@plugins/network/plugins/live/plugins/canonical-params/core";
import type { ConfigValues } from "@plugins/config_v2/core";
import type { slowOpConfig } from "../../core";
import {
  SERVER_JOIN_LAYER,
  TRANSPORT_LAYER,
  WAIT_KIND,
  type SlowOpClientItem,
} from "../../shared/endpoints";

type Thresholds = ConfigValues<(typeof slowOpConfig)["fields"]>;

/**
 * One resource tuple's mount → first-data settle → the `element` slow-op item it
 * files, or null when it does not count.
 *
 * - It is judged on its OWN time: the settle minus the transport bring-up it
 *   waited out (`transportWaitMs`). That wait is not the resource's — it is the
 *   transport's, filed once per page as `wait notifications-transport`
 *   (`transportSlowOp`) — so at or under `elementMs` after it, the resource
 *   was not slow (the same `>` as every other signal). The wait stays in
 *   `waits`, charged to its layer.
 * - Nor the time the server's answer awaited another run already in flight
 *   (`serverJoinedMs`: the push flight it joined, a shared memo's pass). That
 *   run is judged on its own server span (a watcher pass, a `deliver:<key>`),
 *   so counting it here filed one slowness again from the browser. Kept in
 *   `waits` as `server-join`.
 * - `operation` is the resource key alone, so one resource stays one row (one
 *   report, one toast) however many tuples of it settle slowly; which tuple ran
 *   is the `variant` (`canonicalJson(params)`), merged into the row's
 *   `variants` — the same rule as `latencySlowOp`.
 */
export function elementSlowOp(
  info: SlowResourceInfo,
  thresholds: Thresholds,
  route: string,
): SlowOpClientItem | null {
  const thresholdMs = thresholds.elementMs;
  const ownMs = Math.round(
    Math.max(0, info.durationMs - info.transportWaitMs - info.serverJoinedMs),
  );
  if (ownMs <= thresholdMs) return null;
  return {
    operationKind: "element",
    operation: info.key,
    durationMs: Math.round(info.durationMs),
    ownMs,
    thresholdMs,
    // The route under which the element settled is the cheap, reliable "who
    // mounted this resource" attribution.
    caller: { kind: "route", label: route },
    detail: { variant: canonicalJson(info.params) },
    transportColdStart: info.transportColdStart,
    ...(info.transportWaitMs > 0 || info.serverJoinedMs > 0
      ? {
          waits: {
            ...(info.transportWaitMs > 0
              ? { [TRANSPORT_LAYER]: info.transportWaitMs }
              : {}),
            ...(info.serverJoinedMs > 0
              ? { [SERVER_JOIN_LAYER]: info.serverJoinedMs }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * The notifications transport's bring-up — page start → its socket first open
 * (`transportReadyAtMs`, on the performance clock) — as the slow op it is, or
 * null under `elementMs`. Filed once per page (the collector's latch): every
 * resource that mounted before it waited on it, and each now judges only its
 * own time, so the wait itself is reported here, against the transport.
 */
export function transportSlowOp(
  transportReadyAtMs: number,
  thresholds: Thresholds,
  route: string,
): SlowOpClientItem | null {
  const thresholdMs = thresholds.elementMs;
  const durationMs = Math.round(transportReadyAtMs);
  if (durationMs <= thresholdMs) return null;
  return {
    operationKind: WAIT_KIND,
    operation: TRANSPORT_LAYER,
    durationMs,
    ownMs: durationMs,
    thresholdMs,
    caller: { kind: "route", label: route },
  };
}
