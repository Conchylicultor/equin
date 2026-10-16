import { demoResource } from "@plugins/framework/plugins/browser-server/plugins/demo/web";
import { allowFiles } from "../../shared/resources";

/** Inside a demo scope: No guard-bypass file in any demo worktree. */
export const allowMonitorDemo = demoResource("allow-monitor", (s) => [
  s.serveValue(allowFiles, {
    source: "external",
    changes: { fixed: { reason: "a demo's neutral answer" } },
    loader: () => ({ allowFiles: [] }),
  }),
]);
