import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { runsServed } from "./internal/served";

export { runsServed } from "./internal/served";

export default {
  description:
    "The merged run space as ONE routed union window (a Meta-DataView): runsServed serves the `runs` collection's window, its `:rows` point read (useRun) and `:groups` from every arm bound through runsServed.arm — a domain's own ledger typed against the base row and its liveArm, the ledger id and the duration derived by the union — so a write to one ledger refills only the rows it changed. Names no run kind.",
  contributions: [...runsServed.declare],
} satisfies ServerPluginDefinition;
