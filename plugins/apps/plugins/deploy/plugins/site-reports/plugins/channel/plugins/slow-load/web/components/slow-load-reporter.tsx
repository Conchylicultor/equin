import { useEffect } from "react";
import {
  BOOT_TIMING_PREFIX,
  ROUTE_CONTENT_COMMIT_ID,
} from "@plugins/primitives/plugins/perfs/plugins/boot-trace/core";
import {
  readFirstByteSplit,
  readPageShown,
  subscribeBootTrace,
} from "@plugins/primitives/plugins/perfs/plugins/boot-trace/web";
import { countPageDrop } from "@plugins/apps/plugins/deploy/plugins/site-reports/plugins/channel/web";
import { coarseClient } from "@plugins/reports/plugins/main-thread-stall/core";
import { firstByteOf } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import { report } from "@plugins/reports/web";
import {
  judgeLoad,
  SLOW_PAGE_LOAD_KIND,
  slowPageLoadSummary,
  type LoadMilestones,
  type LoadVerdict,
  type SlowPageLoadPayload,
} from "../../core";
import { connectionType } from "../internal/connection";

/** Whether the browser reports paint timing at all (else FCP is never awaited). */
function paintTimed(): boolean {
  return PerformanceObserver.supportedEntryTypes?.includes("paint") ?? false;
}

/**
 * One verdict per page load, at module scope: a remount of the reporter (a
 * root re-key, an error boundary reset) must not file the same load again.
 */
let judged = false;

function startOf(name: string): number | null {
  return performance.getEntriesByName(name)[0]?.startTime ?? null;
}

/**
 * The load's milestones so far, read straight from the browser's timeline (the
 * boot trace mirrors its route-content instant as a User Timing mark) — the
 * same definitions analytics' `LoadTiming` records, without assembling the
 * whole boot trace on every notify.
 */
function milestones(): LoadMilestones {
  const nav = performance.getEntriesByType("navigation")[0] as
    PerformanceNavigationTiming | undefined;
  const fcp = startOf("first-contentful-paint");
  const content = startOf(`${BOOT_TIMING_PREFIX}${ROUTE_CONTENT_COMMIT_ID}`);
  return {
    ttfbMs: nav ? nav.responseStart : null,
    fcpMs: fcp,
    readyMs: content === null ? null : Math.max(content, fcp ?? 0),
  };
}

function file(payload: SlowPageLoadPayload): void {
  void report({
    kind: SLOW_PAGE_LOAD_KIND,
    source: "client-slow-op",
    message: slowPageLoadSummary(payload),
    data: payload,
  });
}

function context() {
  return {
    firstByte: firstByteOf(readFirstByteSplit()),
    client: coarseClient(navigator.userAgent),
    connection: connectionType(),
  };
}

/**
 * Headless (`Core.Root`, page): judges this page load once (`judgeLoad`) —
 * on what the visitor could see, read from records that start with the page
 * (boot-trace's `readPageShown`: the shell's first-hide record, Chromium's
 * visibility entries, prerendering), never from the moment it mounted: a
 * page hidden before the app booted, or loaded before it was shown, is not
 * a wait. Re-judged as the boot trace lands milestones and on every
 * visibility change, until a verdict: a slow load is filed through
 * `report()` (the site's channel), a load no one waited for is counted as
 * the intake's drop under its reason.
 */
export function SlowLoadReporter(): null {
  useEffect(() => {
    if (judged) return;
    const awaitPaint = paintTimed();
    let unsubscribe: () => void = () => undefined;
    const stop = () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", judgeNow);
    };
    const settle = (verdict: LoadVerdict) => {
      if (verdict.kind === "pending") return;
      judged = true;
      stop();
      if (verdict.kind === "slow") file(verdict.payload);
      else if (verdict.kind === "not-waited") countPageDrop(verdict.reason);
    };
    function judgeNow() {
      if (judged) return;
      settle(
        judgeLoad(milestones(), readPageShown(), { ...context(), awaitPaint }),
      );
    }
    unsubscribe = subscribeBootTrace(judgeNow);
    document.addEventListener("visibilitychange", judgeNow);
    judgeNow();
    return stop;
  }, []);
  return null;
}
