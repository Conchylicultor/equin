import { useEffect } from "react";
import {
  BOOT_TIMING_PREFIX,
  ROUTE_CONTENT_COMMIT_ID,
} from "@plugins/primitives/plugins/perfs/plugins/boot-trace/core";
import {
  readFirstByteSplit,
  subscribeBootTrace,
} from "@plugins/primitives/plugins/perfs/plugins/boot-trace/web";
import { coarseClient } from "@plugins/reports/plugins/main-thread-stall/core";
import { firstByteOf } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import { report } from "@plugins/reports/web";
import {
  judgeHiddenLoad,
  judgeReadyLoad,
  SLOW_PAGE_LOAD_KIND,
  slowPageLoadSummary,
  type LoadMilestones,
  type SlowPageLoadPayload,
} from "../../core";
import { connectionType } from "../internal/connection";

/**
 * Whether this page load began in a hidden tab (opened in the background): its
 * paint waits for the visitor to look, so its milestones measure the visitor,
 * not the load. From the page's own visibility record where the browser keeps
 * one (Chromium's `visibility-state` entries start at the navigation, so a tab
 * shown before the reporter mounted is still known for what it was); else
 * from whether it is hidden now.
 */
function beganHidden(): boolean {
  const first = performance.getEntriesByType("visibility-state")[0];
  return first
    ? first.name === "hidden"
    : document.visibilityState === "hidden";
}

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
 * Headless (`Core.Root`, page): judges this page load once — when the route's
 * content has committed and the first contentful paint is in (slow when ready
 * at or past the bar), or when the page is hidden before that (slow when the
 * visitor had already waited the bar) — and files a slow one through
 * `report()`, which on a site is the site's channel. A load begun in a hidden
 * tab is not judged. Push-driven: the boot trace notifies as paint timing and
 * spans land.
 */
export function SlowLoadReporter(): null {
  useEffect(() => {
    if (judged) return;
    if (beganHidden()) {
      judged = true;
      return;
    }
    const awaitPaint = paintTimed();
    let unsubscribe: () => void = () => undefined;
    const stop = () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibility);
    };
    const judge = (payload: SlowPageLoadPayload | null) => {
      judged = true;
      stop();
      if (payload) file(payload);
    };
    function onTrace() {
      if (judged) return;
      const m = milestones();
      if (m.readyMs === null || (awaitPaint && m.fcpMs === null)) return;
      judge(judgeReadyLoad(m, context()));
    }
    function onVisibility() {
      if (judged || document.visibilityState !== "hidden") return;
      judge(judgeHiddenLoad(milestones(), performance.now(), context()));
    }
    unsubscribe = subscribeBootTrace(onTrace);
    document.addEventListener("visibilitychange", onVisibility);
    onTrace();
    return stop;
  }, []);
  return null;
}
