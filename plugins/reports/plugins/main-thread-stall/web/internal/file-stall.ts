import { report } from "@plugins/reports/web";
import { clientSlowOpSink } from "@plugins/debug/plugins/slow-ops/plugins/sink/core";
import {
  mainThreadStallSummary,
  type MainThreadStallPayload,
  type StallFrame,
  type StallTab,
} from "../../core";
import { STALL } from "./constants";
import { topFunction } from "./stall-machine";

// The slow-op every main-thread stall lands as: one row per (app, route
// pattern), the attributed function as its variant, the interval at its true
// end instant so the Timeline draws it where it happened.
const OPERATION_KIND = "main-thread";

function emitSlowOp(opts: {
  tab: StallTab;
  durationMs: number;
  endedAt: number;
  topFunction: string | null;
  // A filed stall is alerted by its own `main-thread-stall` report.
  reportedBy?: "main-thread-stall";
}): void {
  clientSlowOpSink.emit({
    operationKind: OPERATION_KIND,
    operation: `${opts.tab.app ?? "-"} ${opts.tab.routePattern}`,
    durationMs: Math.round(opts.durationMs),
    thresholdMs: STALL.SLOW_OP_MIN_MS,
    caller: { kind: "route", label: new URL(opts.tab.url).pathname },
    detail: { variant: opts.topFunction ?? "unattributed" },
    endedAt: Math.round(opts.endedAt),
    ...(opts.reportedBy ? { reportedBy: opts.reportedBy } : {}),
  });
}

/**
 * File one finished stall: the report (the alert) and its slow-op (the
 * interval). Resolves whether the report landed — the caller acks the
 * watchdog with it, which keeps the stored record on a failure.
 */
export async function fileStall(
  payload: MainThreadStallPayload,
): Promise<boolean> {
  emitSlowOp({
    tab: payload,
    durationMs: payload.durationMs,
    endedAt: payload.endedAt,
    topFunction: payload.topFunction,
    reportedBy: "main-thread-stall",
  });
  const res = await report({
    kind: "main-thread-stall",
    source: "client-main-thread-stall",
    data: payload,
    message: mainThreadStallSummary(payload),
    url: payload.url,
    // The tab that froze, not the one filing (the watchdog may hand a stall
    // to another live tab): the bell then names the frozen page and whether
    // it is still open.
    clientId: payload.tabId,
  });
  return res !== null;
}

/** A recovered long frame under the report bar: a slow-op only, never a report. */
export function fileSlowFrame(frame: StallFrame, tab: StallTab): void {
  emitSlowOp({
    tab,
    durationMs: frame.durationMs,
    endedAt: frame.startedAt + frame.durationMs,
    topFunction: topFunction([frame]),
  });
}
