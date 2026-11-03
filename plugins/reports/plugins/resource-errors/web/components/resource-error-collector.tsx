import { useEffect } from "react";
import { resourceErrorReportSink } from "@plugins/network/plugins/live/plugins/live-state/web";
import { report } from "@plugins/reports/web";
import { RESOURCE_ERROR_KIND, type ResourceErrorPayload } from "../../core";

// A Core.Root side-effect component. `live-state` is a primitive and must not
// import `reports`, so `NotificationsClient` emits a neutral `ResourceErrorInfo`
// into a module-level sink once per failing (key, params) tuple; this component
// owns the mapping from that body to a `resource-error` report — the same
// inversion live-state-stale-drop uses. Renders nothing.
//
// THE POLICY LIVES HERE. Only a failure a developer must fix is filed:
// `loader-failed` and `not-found`. A `client-outdated` read is a tab running an
// older bundle — the Reload advice's job, and expected after every deploy — and
// a `transport` failure is the network, which the event-driven retry heals.
export function ResourceErrorCollector() {
  useEffect(() => {
    resourceErrorReportSink.register(({ key, params, error }) => {
      if (error.kind !== "loader-failed" && error.kind !== "not-found") return;
      const data: ResourceErrorPayload = {
        key,
        params,
        errorKind: error.kind,
        message: error.message,
      };
      void report({
        kind: RESOURCE_ERROR_KIND,
        source: "client-resource-error",
        message: `Live read failed: ${key} (${error.kind}): ${error.message}`,
        url: window.location.href,
        userAgent: navigator.userAgent,
        data,
      });
    });
    return () => {
      resourceErrorReportSink.register(null);
    };
  }, []);

  return null;
}
