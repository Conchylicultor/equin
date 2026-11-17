import { readResourcesDebug } from "@plugins/framework/plugins/server-core/core";
import { serveValue } from "@plugins/network/plugins/live/server";
import {
  resourcesDebug,
  resourcesDebugSchema,
  type ResourcesDebug,
} from "../../core";

// The runtime's own `_debug` payload, built in-process (`readResourcesDebug` —
// the same builder `GET /api/resources/_debug` serves, with no request and so no
// access gate to fabricate a caller for). Parsed with the value's own schema, so
// a payload that moved under the panes fails this load (`loader-failed`,
// reported) instead of rendering wrong.
function measureResources(): ResourcesDebug {
  const payload = resourcesDebugSchema.parse(readResourcesDebug());
  // Self-inspection: this value's own entry would only report this very read.
  return {
    resources: payload.resources.filter((r) => r.key !== resourcesDebug.key),
  };
}

export const resourcesDebugServed = serveValue(resourcesDebug, {
  source: "external",
  changes: {
    snapshot: {
      reason:
        "a measurement of the resource runtime's registry (subscribers, versions, read-sets, notify counters); re-measured on refresh()",
    },
  },
  loader: async () => measureResources(),
});
