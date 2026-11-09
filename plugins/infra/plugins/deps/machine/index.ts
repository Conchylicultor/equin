import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { installDepEndpoint, removeDepEndpoint } from "../core";
import { handleInstallDep, handleRemoveDep } from "./internal/handlers";
import { depsCacheWatcher, depsStatesServed } from "./internal/live";

export default {
  description:
    "On-demand dependencies, desktop half (needsMachine: they are installed on this computer): the pushed deps.states live value says absent / installing / ready / failed for every declared dependency, watched from the cache dir, and the install/remove endpoints back Debug → Dependencies.",
  httpRoutes: {
    [installDepEndpoint.route]: handleInstallDep,
    [removeDepEndpoint.route]: handleRemoveDep,
  },
  register: [depsCacheWatcher],
  contributions: [...depsStatesServed.declare],
} satisfies MachinePluginDefinition;
