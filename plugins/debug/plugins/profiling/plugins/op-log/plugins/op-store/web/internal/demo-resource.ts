import { demoResource } from "@plugins/framework/plugins/browser-server/plugins/demo/web";
import { opsHistory, opsInFlight } from "../../core";

/** Inside a demo scope: No op in flight and none recorded: a demo runs no builds, tests or pushes. */
export const opStoreDemo = demoResource("op-store", (s) => [
  s.serveCollection(opsInFlight, {
    source: "external",
    changes: { fixed: { reason: "a demo's neutral answer" } },
    all: () => [],
    rows: () => [],
  }),
  s.serveCollection(opsHistory, {
    source: "external",
    changes: { fixed: { reason: "a demo's neutral answer" } },
    window: () => [],
    rows: () => [],
    keyText: {
      requestedAt: (at) => at.toISOString(),
      completedAt: (at) => at?.toISOString() ?? null,
    },
  }),
]);
