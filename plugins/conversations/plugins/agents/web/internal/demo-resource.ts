import { demoResource } from "@plugins/framework/plugins/browser-server/plugins/demo/web";
import { agentLaunchRows, agentRows } from "../../shared/resources";

/** Inside a demo scope: No agents defined and none launched. */
export const agentsDemo = demoResource("agents", (s) => [
  s.serveCollection(agentRows, {
    source: "external",
    changes: { fixed: { reason: "a demo's neutral answer" } },
    all: () => [],
    rows: () => [],
  }),
  s.serveCollection(agentLaunchRows, {
    source: "external",
    changes: { fixed: { reason: "a demo's neutral answer" } },
    all: () => [],
    rows: () => [],
  }),
]);
