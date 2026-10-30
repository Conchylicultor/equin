import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { mandateDefinitionsServed } from "./internal/served";

export {
  MandateDefinitions,
  mandateDefinitionEntries,
} from "./internal/contribution";
export type {
  MandateDefinitionEntry,
  MandateDefinitionSourceEntry,
} from "./internal/contribution";

export default {
  portable: true,
  description:
    "The named-mandate registry: MandateDefinitions.Definition (what one named mandate grants) and MandateDefinitions.Source (a runtime family of them — one per automation), read at every resolution through mandateDefinitionEntries, and the mandate.definitions value (every named mandate's id and label).",
  contributions: [...mandateDefinitionsServed.declare],
} satisfies ServerPluginDefinition;
