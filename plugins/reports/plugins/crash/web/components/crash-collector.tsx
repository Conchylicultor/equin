import { useEffect } from "react";
import { crashFieldsOf } from "@plugins/packages/plugins/error-subject/core";
import { report } from "@plugins/reports/web";
import { claimsResizeLoopError } from "@plugins/primitives/plugins/dom/plugins/element-size/plugins/resize-loop-trace/web";
import { EndpointAgentWriteRefusedError } from "@plugins/infra/plugins/endpoints/web";
import { reachHost } from "@plugins/infra/plugins/health/web";
import { RawApiRequestError } from "@plugins/primitives/plugins/networking/plugins/request-guard/web";
import {
  describeErrorEvent,
  describeRejection,
} from "../internal/describe-caught";
import { isContextTeardown } from "../internal/context-teardown";
import { fileUnlessOffline } from "../internal/fetch-no-answer";
import { takeShellReports } from "../internal/shell-reports";

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
      // WebKit rejecting a lock / permission promise because this document is
      // going away: the page leaving, not a bug (`internal/context-teardown.ts`).
      if (isContextTeardown(e.reason)) {
        console.warn(
          `[reports] not filed — the browser rejected a promise because this page is going away: ${String(e.reason)}`,
        );
        return;
      }
      const err = e.reason instanceof Error ? e.reason : null;
      // Read now: the page may have moved on by the time the host answers.
      const message = describeRejection(e);
      const url = window.location.href;
      // A fetch that got no answer is filed only when this page's host
      // answers HTTP — otherwise it is the visitor's network, not the page
      // (`internal/fetch-no-answer.ts`).
      void fileUnlessOffline(
        e.reason,
        () =>
          void report({
            kind: "crash",
            source: "browser-rejection",
            message,
            url,
            userAgent: navigator.userAgent,
            // No Error object: no type either, so the message is the identity.
            data:
              err === null
                ? { errorType: null, stack: null }
                : crashFieldsOf(err),
          }),
        reachHost,
      );
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    // The page shell's own inline reporter (a boot file that failed to load)
    // cannot send once the request guard is installed: it queues its report
    // for this collector, which sends it through report().
    const releaseShellReports = takeShellReports();

    return () => {
      releaseShellReports();
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}
