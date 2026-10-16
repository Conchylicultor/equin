import { demoResource } from "@plugins/framework/plugins/browser-server/plugins/demo/web";
import { subagentActivity } from "../../core";

/** Inside a demo scope: No demo conversation spawned a sub-agent. */
export const subagentActivityDemo = demoResource("subagents", (s) => [
  s.serveValue(subagentActivity, {
    source: "external",
    changes: { fixed: { reason: "a demo's neutral answer" } },
    loader: () => [],
  }),
]);
