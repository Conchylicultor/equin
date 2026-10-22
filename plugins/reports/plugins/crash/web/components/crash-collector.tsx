import { useEffect } from "react";
import { boundaryReportSink } from "@plugins/primitives/plugins/error-boundary/web";
import { wedgeReportSink } from "@plugins/infra/plugins/health/web";
import { report } from "@plugins/reports/web";
import { EndpointAgentWriteRefusedError } from "@plugins/infra/plugins/endpoints/web";

// A Core.Root side-effect component (the old reports ReportCollector, now owned
// by the crash kind). It owns the three browser crash signals — window errors,
// unhandled rejections, and React error-boundary catches — and funnels all of
// them into the generic report() entry point with kind "crash", wrapping the
// crash-specific fields into the `data` payload. Renders nothing.
export function CrashCollector() {
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      const err = e.error instanceof Error ? e.error : null;
      void report({
        kind: "crash",
        source: "browser-error",
        message: err?.message ?? e.message,
        url: window.location.href,
        userAgent: navigator.userAgent,
        data: { errorType: err?.name ?? null, stack: err?.stack ?? null },
      });
    };

    const onRejection = (e: PromiseRejectionEvent) => {
      // Main refusing an agent session's write is by design (main is read-only
      // for agents), not a crash: a fire-and-forget write it refuses (a
      // notification the "Request failed" toast posts, a rank write) must not
      // file one report per click.
      if (e.reason instanceof EndpointAgentWriteRefusedError) return;
      const err = e.reason instanceof Error ? e.reason : null;
      void report({
        kind: "crash",
        source: "browser-rejection",
        message: err?.message ?? String(e.reason ?? "Unhandled rejection"),
        url: window.location.href,
        userAgent: navigator.userAgent,
        data: { errorType: err?.name ?? null, stack: err?.stack ?? null },
      });
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);

    boundaryReportSink.register((r) => {
      const promise = report({
        kind: "crash",
        source: "react-boundary",
        message: r.error.message,
        url: window.location.href,
        userAgent: navigator.userAgent,
        data: {
          errorType: r.error.name,
          stack: r.error.stack ?? null,
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

    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      boundaryReportSink.register(null);
      wedgeReportSink.register(null);
    };
  }, []);

  return null;
}
