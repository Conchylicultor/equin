import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { runsServed } from "./internal/served";

export { defineRunKind, getRunKinds } from "./internal/registry";
export type {
  RunArmBase,
  RunArmRefs,
  RunFieldBinding,
  RunKind,
  RunKindSpec,
} from "./internal/registry";

export default {
  description:
    "The run-kind registry and the merged run space as ONE routed union window: defineRunKind binds a domain's own ledger into the `runs` collection as an arm (base fields typed against the row, its own fields against its liveArm; id and duration derived), and serveUnionCollection serves the window, its `:rows` point read (useRun) and `:groups` from every registered arm — a write to one ledger refills only the rows it changed. Names no run kind.",
  contributions: [...runsServed.declare],
} satisfies ServerPluginDefinition;
