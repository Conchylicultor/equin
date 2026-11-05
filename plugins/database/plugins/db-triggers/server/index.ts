import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  defineDbTriggers,
  type DbFunctionDdl,
  type DbTriggerDdl,
  type DbTriggerSet,
} from "./internal/define";
export { DbTrigger } from "./internal/contribution";
export {
  installDbTriggers,
  type DbTriggerInstall,
  type InstallDbTriggersOptions,
} from "./internal/install";

export default {
  description:
    "The one trigger installer: defineDbTriggers names a set of plpgsql functions and the triggers that call them (asserted at module eval to create what they are named, schema included), contributed as DbTrigger; installDbTriggers installs every declared set — a plugin's invariants, the derived updatedAt triggers, the rollups' maintain triggers, graphile's superseded trigger — by one protocol: a per-object stamp in each COMMENT (DDL hash + catalog-definition hash, so an out-of-band replacement is seen), only stale objects re-run, every table in one fixed order one savepoint each, owned-but-undeclared objects dropped (a whole removed set under sweep), advisory-locked, asserted after.",
} satisfies ServerPluginDefinition;
