import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  defineDbTriggers,
  type DbFunctionDdl,
  type DbTriggerDdl,
  type DbTriggerSet,
} from "./internal/define";
export { DbTrigger } from "./internal/contribution";
export { installDbTriggers, type DbTriggerInstall } from "./internal/install";

export default {
  description:
    "Declared database triggers: defineDbTriggers names a set of plpgsql functions and the triggers that call them (asserted at module eval to create what they are named), contributed as DbTrigger and installed by the boot schema layer after the migrations — signature-in-COMMENT, advisory-locked, a no-op when current, asserted after — so an invariant a plugin needs the database itself to keep (a write that must always come with another) holds for every writer.",
} satisfies ServerPluginDefinition;
