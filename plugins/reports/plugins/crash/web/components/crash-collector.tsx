import { useEffect } from "react";
import { crashFieldsOf } from "@plugins/packages/plugins/error-subject/core";
import { boundaryReportSink } from "@plugins/primitives/plugins/error-boundary/web";
import { wedgeReportSink } from "@plugins/infra/plugins/health/web";
import { report } from "@plugins/reports/web";
import {
  claimsResizeLoopError,
  resizeLoopReportSink,
} from "@plugins/primitives/plugins/dom/plugins/element-size/plugins/resize-loop-trace/web";
import { EndpointAgentWriteRefusedError } from "@plugins/infra/plugins/endpoints/web";
import {
  RawApiRequestError,
  requestGuardReportSink,
} from "@plugins/primitives/plugins/networking/plugins/request-guard/web";
import { describeResizeLoop } from "../internal/describe-resize-loop";
import {
  describeError,
  describeErrorEvent,
  describeRejection,
} from "../internal/describe-caught";

// A Core.Root side-effect component (the old reports ReportCollector, now owned
// by the crash kind). It owns the three browser crash signals — window errors,
// unhandled rejections, and React error-boundary catches — and funnels all of
// them into the generic report() entry point with kind "crash", wrapping the
// crash-specific fields into the `data` payload — and files the page request
// guard's refusals (its own sink). Renders nothing.
export function CrashCollector() {
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      // A request-guard refusal is filed once, through its own sink (below,
      // which also holds the ones raised before this mounted); the guard's
      // `reportError` echo of it is not a second crash.
      if (e.error instanceof RawApiRequestError) return;
      // A ResizeObserver loop is filed by the resize-loop tracer's sink
      // (below), a frame later, with the observers that caused it.
      if (claimsResizeLoopError(e)) return;
      const err = e.error instanceof Error ? e.error : null;
      void report({
        kind: "crash",
        source: "browser-error",
        message: describeErrorEvent(e),
        url: window.location.href,
        userAgent: navigator.userAgent,
        // No Error object: no type either, so the message is the identity.
        data:
          err === null ? { errorType: null, stack: null } : crashFieldsOf(err),
      });
    };

    const onRejection = (e: PromiseRejectionEvent) => {
      // Main refusing an agent session's write is by design (main is read-only
      // for agents), not a crash: a fire-and-forget write it refuses (a
      // notification the "Request failed" toast posts, a rank write) must not
      // file one report per click.
      if (e.reason instanceof EndpointAgentWriteRefusedError) return;
      // Filed through the request guard's sink already (see onError).
      if (e.reason instanceof RawApiRequestError) return;
      const err = e.reason instanceof Error ? e.reason : null;
      void report({
        kind: "crash",
        source: "browser-rejection",
        message: describeRejection(e),
        url: window.location.href,
        userAgent: navigator.userAgent,
        // No Error object: no type either, so the message is the identity.
        data:
          err === null ? { errorType: null, stack: null } : crashFieldsOf(err),
      });
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);

    boundaryReportSink.register((r) => {
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
    });

    // The live-state wedge watchdog (infra.health) emits a neutral WedgeReport;
    // crash owns the mapping to a `kind: "crash"` report (both are crash-kind
    // client sources). The discriminator carries the per-failure-mode fingerprint.
    wedgeReportSink.register((w) => {
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
    });

    // The page request guard refused a raw request to the app's server. Its
    // sink holds every refusal raised before this effect ran (the guard is
    // installed before anything else evaluates), and replays them here.
    requestGuardReportSink.register((err) => {
      void report({
        kind: "crash",
        source: "browser-error",
        message: describeError(err),
        url: window.location.href,
        userAgent: navigator.userAgent,
        data: crashFieldsOf(err),
      });
    });

    // A ResizeObserver loop error, traced (resize-loop-trace): the same
    // stackless browser-error crash as before — so it lands on the same row —
    // carrying the observer callbacks around it in place of a stack.
    resizeLoopReportSink.register((r) => {
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
    });

    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      boundaryReportSink.register(null);
      wedgeReportSink.register(null);
      requestGuardReportSink.register(null);
      resizeLoopReportSink.register(null);
    };
  }, []);

  return null;
}
