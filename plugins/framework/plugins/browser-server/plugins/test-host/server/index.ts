import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

// The harness is test code, published from `./testing`
// (`@plugins/framework/plugins/browser-server/plugins/test-host/server/testing`),
// which only tests and checks may import.

export default {
  description:
    "Test harness that boots a slice of the app's server registry as a portable host under bun test: the registry or portable dependsOn closure of some roots, plus — derived, never hand-listed — one host provider per service the graph's modules declare (to a fixpoint), the committed migrations and config read off disk, and in-memory host storage.",
} satisfies ServerPluginDefinition;
