import { demoResource } from "@plugins/framework/plugins/browser-server/plugins/demo/web";
import { outcomeReportRows } from "../../core";

/** Inside a demo scope: No automated task submitted an outcome report. */
export const outcomeReportsDemo = demoResource("outcome-reports", (s) => [
  s.serveCollection(outcomeReportRows, {
    source: "external",
    changes: { fixed: { reason: "a demo's neutral answer" } },
    rows: () => [],
  }),
]);
