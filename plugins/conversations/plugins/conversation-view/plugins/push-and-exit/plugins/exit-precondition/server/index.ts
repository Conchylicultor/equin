import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { ExitClean, exitCleanRefusals } from "./internal/exit-precondition";
export type { ExitCleanPreconditionEntry } from "./internal/exit-precondition";

export default {
  description:
    "What must hold before an agent may close with exit_clean: the ExitClean.Precondition collection (each owning plugin contributes its check) and exitCleanRefusals, which exit_clean runs before closing. A leaf, so contributors need not import push-and-exit.",
} satisfies ServerPluginDefinition;
