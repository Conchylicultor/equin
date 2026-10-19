import { demoResource } from "@plugins/framework/plugins/browser-server/plugins/demo/web";
import { spawnFailureRows } from "../../core";

/** Inside a demo scope: every launch started. */
export const spawnFailuresDemo = demoResource(
  "conversation-spawn-failures",
  (s) => [
    s.serveCollection(spawnFailureRows, {
      source: "external",
      changes: { fixed: { reason: "a demo's neutral answer" } },
      rows: () => [],
    }),
  ],
);
