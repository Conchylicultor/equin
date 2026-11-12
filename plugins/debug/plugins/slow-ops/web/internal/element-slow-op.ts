import type { SlowResourceInfo } from "@plugins/network/plugins/live/plugins/live-state/web";
import { canonicalJson } from "@plugins/network/plugins/live/plugins/canonical-params/core";
import type { ConfigValues } from "@plugins/config_v2/core";
import type { HostBootInfo } from "@plugins/framework/plugins/browser-server/web";
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
 * One pipeline's transport bring-up — its first socket opened
 * (`transportStartedAtMs`) → the transport first ready (`transportReadyAtMs`),
 * both on the performance clock — as the slow op it is, or null under
 * `elementMs`. Filed once per transport (the collector's latch, keyed by
 * `transportId`): every resource that mounted before it waited on it, and
 * each now judges only its own time, so the wait itself is reported here,
 * against the transport.
 *
 * Measured from the pipeline's own start, never the page's: a scoped pipeline
 * (a demo's in-browser server) is built when its subtree mounts — after the
 * visitor entered and its host booted — so "page start → socket open" was the
 * page's age, filed as transport (a visitor's 33 s at the demo's gate came
 * back as a 37.9 s `wait notifications-transport`). The page's own time before
 * its socket opens is its load (`page-load`); a browser host's boot is its own
 * op (`hostBootSlowOp`).
 */
export function transportSlowOp(
  transportStartedAtMs: number,
  transportReadyAtMs: number,
  thresholds: Thresholds,
  route: string,
): SlowOpClientItem | null {
  const thresholdMs = thresholds.elementMs;
  const durationMs = Math.round(
    Math.max(0, transportReadyAtMs - transportStartedAtMs),
  );
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

/** The op kind and operation prefix a browser host's boot files under. */
export const HOST_BOOT_KIND = "boot";
export const HOST_BOOT_OPERATION_PREFIX = "browser-host:";

/**
 * An in-browser server's boot — the page asking for its host → the host ready
 * — as its own slow op, or null within `browserHostBootMs`. One item per boot:
 * nothing that reads the host mounts before it is ready, so the boot is in no
 * element's settle; it is reported here, once, against the host.
 *
 * - `operation` names the host (`browser-host:<scenario>`), so each host is one
 *   row and one report however many pages boot it; its data source (a
 *   snapshot, what an earlier visit stored, a seed) is the `variant`.
 * - `waits` split the wait by where it went — the worker's own stages
 *   (`host-script`, `host-storage`, `host-graph`, `host-ready`, `host-seed`)
 *   and the rest of the wait (`host-unstaged`: the page asking, loading the
 *   host module and connecting, and worker time outside a named stage) — so
 *   the report names the dominant one. They are a split of the boot, not time
 *   taken off it: `ownMs` is the whole wait. (A worker started before the page
 *   asked — the head's prestart — may have run stages before the wait began,
 *   so the stages can sum past it.)
 * - Not windowed against the page's pauses: the boot runs in the worker, which
 *   a busy page does not stall.
 */
export function hostBootSlowOp(
  info: HostBootInfo,
  thresholds: Thresholds,
  route: string,
): SlowOpClientItem | null {
  const thresholdMs = thresholds.browserHostBootMs;
  const durationMs = Math.round(info.waitedMs);
  if (durationMs <= thresholdMs) return null;
  const stages: Record<string, number> = {};
  let workerMs = 0;
  for (const stage of info.boot.stages) {
    const layer = `host-${stage.name}`;
    stages[layer] = (stages[layer] ?? 0) + stage.ms;
    workerMs += stage.ms;
  }
  const unstagedMs = Math.max(0, durationMs - workerMs);
  return {
    operationKind: HOST_BOOT_KIND,
    operation: `${HOST_BOOT_OPERATION_PREFIX}${info.host}`,
    durationMs,
    ownMs: durationMs,
    thresholdMs,
    caller: { kind: "route", label: route },
    detail: { variant: info.boot.data ?? "no data kept" },
    waits: {
      ...stages,
      ...(unstagedMs > 0 ? { "host-unstaged": unstagedMs } : {}),
    },
  };
}
