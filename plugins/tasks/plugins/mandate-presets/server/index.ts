import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { MandateDefinitions } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/definitions/server";
import { interactiveMandate, supervisorMandate } from "../core";
import { interactivePolicy, supervisorPolicy } from "../shared/policies";

export { supervisorPolicy } from "../shared/policies";
export type { SupervisorExtraGrants } from "../shared/policies";

export default {
  description:
    "Defines the named presets: what the interactive and supervisor mandates grant (MandateDefinitions.Definition), computed at every resolution — so a capability added here reaches every tree under them, running ones included. Exports supervisorPolicy(extra) for a mandate that inherits the supervisor preset (a supervisor role's).",
  contributions: [
    MandateDefinitions.Definition({
      mandate: interactiveMandate,
      policy: interactivePolicy,
    }),
    MandateDefinitions.Definition({
      mandate: supervisorMandate,
      policy: () => supervisorPolicy(),
    }),
  ],
} satisfies ServerPluginDefinition;
