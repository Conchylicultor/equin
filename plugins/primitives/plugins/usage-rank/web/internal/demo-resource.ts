import { demoResource } from "@plugins/framework/plugins/browser-server/plugins/demo/web";
import { usageStats } from "../../core";

/** Inside a demo scope: No usage recorded: every frecency order is its default. */
export const usageStatsDemo = demoResource("usage-rank", (s) => [
  s.serveCollection(usageStats, {
    source: "external",
    changes: { fixed: { reason: "a demo's neutral answer" } },
    window: () => [],
    rows: () => [],
    keyText: { lastUsedAt: (at) => at.toISOString() },
  }),
]);
