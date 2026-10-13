import { handleResourceHttp } from "@plugins/framework/plugins/server-core/core";
import { serveValue } from "@plugins/network/plugins/live/server";
import {
  resourcesDebug,
  resourcesDebugSchema,
  type ResourcesDebug,
} from "../../core";

// The runtime's own `_debug` read, taken in-process through its HTTP handler
// (the one place the payload is built — `handleResourcesDebug`, reached at the
// reserved `_debug` key). Parsed with the value's own schema, so a payload that
// moved under the panes fails this load (`loader-failed`, reported) instead of
// rendering wrong.
// Debt (task-1791822660-w6qvkd): the runtime exposes no direct builder for the
// payload, so this goes through a synthetic Request and a JSON round trip.
async function measureResources(): Promise<ResourcesDebug> {
  const res = await handleResourceHttp(
    new Request("http://localhost/api/resources/_debug"),
    { key: "_debug" },
  );
  if (!res.ok) {
    throw new Error(
      `resource runtime _debug read failed (${res.status}): ${await res.text()}`,
    );
  }
  const payload = resourcesDebugSchema.parse(await res.json());
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
  loader: measureResources,
});
