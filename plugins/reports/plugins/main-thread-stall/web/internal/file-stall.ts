import { report } from "@plugins/reports/web";
import { clientSlowOpSink } from "@plugins/debug/plugins/slow-ops/plugins/sink/core";
import {
  coarseClient,
  mainThreadStallSummary,
  type MainThreadStallDraft,
  type MainThreadStallPayload,
  type StallFrame,
  type StallTab,
} from "../../core";
import { asEpochMs } from "@plugins/primitives/plugins/perfs/plugins/page-clock/core";
import { STALL } from "./constants";
import { topFunction } from "./stall-machine";
import type { TabEvidence } from "@plugins/reports/plugins/main-thread-stall/plugins/tab-evidence/core";
import type { HeapWatch } from "./heap-watch";
import type { StallProfiler } from "./stall-profiler";

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
  // What the tab's own thread ran (a long frame it filed): carried to the
  // op's `slow-op` report as evidence, never its identity.
  evidence?: TabEvidence;
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
    ...(opts.evidence ? { evidence: opts.evidence } : {}),
  });
}

/**
 * File one finished stall: the report (the alert) and its slow-op (the
 * interval). Its stacks are this tab's sampled profile of the stall when the
 * tab is the one that stalled and survived it (`stacksFor` says why not
 * otherwise), and so is its heap; its client is this browser's family and OS. Resolves whether the report landed — the caller acks the
 * watchdog with it, which keeps the stored record on a failure.
 */
export async function fileStall(
  draft: MainThreadStallDraft,
  evidence: { profiler: StallProfiler; heap: HeapWatch },
  ownTabId: string,
): Promise<boolean> {
  const payload: MainThreadStallPayload = {
    ...draft,
    stacks: await evidence.profiler.stacksFor(draft, ownTabId),
    memory: evidence.heap.memoryFor(draft, ownTabId),
    // The filing tab is always of the stalled tab's browser (one origin's
    // SharedWorker, or the tab itself).
    client: coarseClient(navigator.userAgent),
  };
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

/**
 * A recovered long frame under the stall bar: no `main-thread-stall` report,
 * only its `main-thread` slow-op — whose own `slow-op` report then carries
 * what the tab sampled inside the frame and its heap around it (LoAF names
 * only the frame's entry point: a `ResizeObserverCallback`, a port handler).
 * The tab ran the frame and lived through it, so its own profile covers it.
 */
export async function fileSlowFrame(
  frame: StallFrame,
  tab: StallTab,
  evidence: { profiler: StallProfiler; heap: HeapWatch },
): Promise<void> {
  // A frame is on the wall clock from its delivery (toStallFrame).
  const window = {
    startedAt: asEpochMs(frame.startedAt),
    endedAt: asEpochMs(frame.startedAt + frame.durationMs),
  };
  emitSlowOp({
    tab,
    durationMs: frame.durationMs,
    endedAt: window.endedAt,
    topFunction: topFunction([frame]),
    evidence: {
      stacks: await evidence.profiler.stacksIn(window),
      memory: evidence.heap.memoryAround(window),
    },
  });
}
