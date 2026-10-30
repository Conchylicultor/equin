import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

// A demo's seed writes its Deploy state through this; the fixture's shape is
// the `core` barrel's.
export { writeDeployFixture } from "./internal/write";

export default {
  description:
    "Writes a Deploy fixture (servers, their last check, deployments and finished runs) into this instance through the rows the app's own handlers write. Contributes nothing: a host boots it for the seed that imports it.",
} satisfies ServerPluginDefinition;
