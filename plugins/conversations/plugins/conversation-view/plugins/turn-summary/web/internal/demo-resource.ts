import { demoResource } from "@plugins/framework/plugins/browser-server/plugins/demo/web";
import { turnSummaryRows } from "../../shared/schemas";

/** Inside a demo scope: No turn was summarized. */
export const turnSummariesDemo = demoResource("turn-summaries", (s) => [
  s.serveCollection(turnSummaryRows, {
    source: "external",
    changes: { fixed: { reason: "a demo's neutral answer" } },
    rows: () => [],
  }),
]);
