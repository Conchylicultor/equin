import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { mandateDefinitionsServed } from "./internal/served";

export {
  MandateDefinitions,
  mandateDefinitionEntries,
  mandateIsKindOf,
} from "./internal/contribution";
export type {
  MandateDefinitionEntry,
  MandateDefinitionSourceEntry,
} from "./internal/contribution";

export default {
  description:
    "The named-mandate registry: MandateDefinitions.Definition (what one named mandate grants) and MandateDefinitions.Source (a runtime family of them — one per automation), read at every resolution through mandateDefinitionEntries, mandateIsKindOf (is a stored mandate id a kind of a base mandate — its lineage, declared by defineMandate extends), and the mandate.definitions value (every named mandate's id, label and the mandates it is a kind of).",
  contributions: [...mandateDefinitionsServed.declare],
} satisfies ServerPluginDefinition;
