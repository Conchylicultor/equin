import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { depsInstallJob } from "./internal/install-job";

// The server half: the install job (and `requestDep`, which enqueues it from
// a request). The `deps.states` live value and the endpoints are the machine/
// half's (needsMachine: the dependencies are on this computer). The daily
// sweep is the `sweep` sub-plugin.
// Declaring, ensuring and reading a dependency is the host-only `deps` barrel
// (`@plugins/infra/plugins/deps/deps`).
export { onDepInstallSettled, requestDep } from "./internal/install-job";

export default {
  description:
    "The server half of on-demand dependencies: requestDep enqueues the deps.install supervised job (ensureDep in a detached child) from a request. The daily deps.sweep is its sweep sub-plugin.",
  register: [depsInstallJob],
} satisfies ServerPluginDefinition;
