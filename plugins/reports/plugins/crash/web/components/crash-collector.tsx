import { useEffect } from "react";
import { crashFieldsOf } from "@plugins/packages/plugins/error-subject/core";
import { report } from "@plugins/reports/web";
import { claimsResizeLoopError } from "@plugins/primitives/plugins/dom/plugins/element-size/plugins/resize-loop-trace/web";
import { EndpointAgentWriteRefusedError } from "@plugins/infra/plugins/endpoints/web";
import { RawApiRequestError } from "@plugins/primitives/plugins/networking/plugins/request-guard/web";
import {
  describeErrorEvent,
  describeRejection,
} from "../internal/describe-caught";

// A Core.Root side-effect component (the old reports ReportCollector, now owned
// by the crash kind). It owns the two browser crash signals that are window
// events — window errors and unhandled rejections — and funnels them into the
// generic report() entry point with kind "crash", wrapping the crash-specific
// fields into the `data` payload. The crash signals other plugins emit into
// their own sinks (React error-boundary catches, live-state wedges, the page
// request guard's refusals, traced ResizeObserver loops) are drained by
// `ReportSinks.Collector` contributions instead (../internal/crash-sinks.ts).
// Renders nothing.
export function CrashCollector() {
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      // A request-guard refusal is filed once, through its own sink (drained by
      // collectRequestGuardCrash, which also gets the ones raised before any
      // handler attached); the guard's
      // `reportError` echo of it is not a second crash.
      if (e.error instanceof RawApiRequestError) return;
      // A ResizeObserver loop is filed by the resize-loop tracer's sink
      // (collectResizeLoopCrash), a frame later, with the observers that caused it.
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

    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}
