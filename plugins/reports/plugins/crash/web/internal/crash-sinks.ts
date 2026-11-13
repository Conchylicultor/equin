import { crashFieldsOf } from "@plugins/packages/plugins/error-subject/core";
import type { BoundaryErrorReport } from "@plugins/primitives/plugins/error-boundary/web";
import type { WedgeReport } from "@plugins/infra/plugins/health/web";
import type { ResizeLoopReport } from "@plugins/primitives/plugins/dom/plugins/element-size/plugins/resize-loop-trace/web";
import type { RawApiRequestError } from "@plugins/primitives/plugins/networking/plugins/request-guard/web";
import { report } from "@plugins/reports/web";
import { describeResizeLoop } from "./describe-resize-loop";
import { describeError } from "./describe-caught";

// The handlers of the four crash signals other plugins emit into their own
// sinks, each drained through a `ReportSinks.Collector` keyed by the plugin
// that declares the sink (crash's web/index.ts), so each ships only where its
// producer does. The window error / unhandled-rejection signals stay in
// `CrashCollector` (they are listeners, not sinks). None of these producers may
// import `reports`; crash owns the mapping of each body to a `kind: "crash"`
// report.

/**
 * error-boundary's `boundaryReportSink` (a request sink): a React
 * error-boundary catch. Answers the context the boundary hands its
 * ErrorBoundary.Action contributions (the Fix button).
 */
export function collectBoundaryCrash(r: BoundaryErrorReport) {
  const promise = report({
    kind: "crash",
    source: "react-boundary",
    message: describeError(r.error),
    url: window.location.href,
    userAgent: navigator.userAgent,
    data: {
      ...crashFieldsOf(r.error),
      componentStack: r.componentStack,
      slot: r.slot,
      label: r.label,
      uiContext: r.uiContext ?? null,
    },
  });
  // Only a recorded report has a row for the Fix button to investigate; a
  // shed or storm-collapsed occurrence has no id of its own (the engine
  // accounts for it in a rollup), so the button stays disabled.
  return promise.then((result) =>
    result?.outcome === "recorded"
      ? { reportId: result.reportId, taskId: result.taskId }
      : { reportId: null, taskId: null },
  );
}

/**
 * The live-state wedge watchdog (infra.health) emits a neutral WedgeReport;
 * crash owns the mapping to a `kind: "crash"` report (both are crash-kind
 * client sources). The discriminator carries the per-failure-mode fingerprint.
 */
export function collectWedgeCrash(w: WedgeReport): void {
  void report({
    kind: "crash",
    source: "live-state-wedge",
    message: w.message,
    url: window.location.href,
    userAgent: navigator.userAgent,
    data: {
      errorType: `LiveStateWedge:${w.discriminator}`,
      label: "live-state.watchdog",
    },
  });
}

/**
 * The page request guard refused a raw request to the app's server. Its sink
 * holds every refusal raised before this handler attached (the guard is
 * installed before anything else evaluates), and replays them here.
 * `CrashCollector`'s window listeners skip the guard's `reportError` echo, so a
 * refusal is filed once.
 */
export function collectRequestGuardCrash(err: RawApiRequestError): void {
  void report({
    kind: "crash",
    source: "browser-error",
    message: describeError(err),
    url: window.location.href,
    userAgent: navigator.userAgent,
    data: crashFieldsOf(err),
  });
}

/**
 * A ResizeObserver loop error, traced (resize-loop-trace): the same stackless
 * browser-error crash as before — so it lands on the same row — carrying the
 * observer callbacks around it in place of a stack. `CrashCollector`'s window
 * listener skips the browser's own loop error, so it is filed once, here.
 */
export function collectResizeLoopCrash(r: ResizeLoopReport): void {
  void report({
    kind: "crash",
    source: "browser-error",
    message: r.message,
    url: window.location.href,
    userAgent: navigator.userAgent,
    data: {
      errorType: null,
      stack: null,
      resizeLoop: describeResizeLoop(r),
    },
  });
}
