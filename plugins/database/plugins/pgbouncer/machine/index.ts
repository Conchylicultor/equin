import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { convergePgbouncerConfig } from "./internal/converge";
export type { PgbouncerConvergence } from "./internal/converge";

export default {
  description:
    "Converges the running PgBouncer onto the lane table's config: rewrites pgbouncer.ini / userlist.txt when they differ from the rendering and sends the daemon SIGHUP (its reload) — called by every backend's database driver at boot, since the gateway re-runs PgBouncer's start script only at its own start.",
} satisfies MachinePluginDefinition;
