import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { databaseForkedAt } from "./internal/forked-at";

export default {
  description:
    "Reads when this database was forked from another (databaseForkedAt): the instant the fork stamped on it, or null for a database never forked.",
  portable: true,
} satisfies ServerPluginDefinition;
