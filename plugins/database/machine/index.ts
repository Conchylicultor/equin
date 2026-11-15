import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { DatabaseDriver } from "@plugins/database/server";
import { pgDriver } from "./internal/pg-driver";

// The serving entry point claims the schema-owner boot marker before it boots
// (server-core's `serve`): see `./internal/owner-boot.ts`.
export { claimSchemaOwnerBoot } from "./internal/owner-boot";

export default {
  description:
    "The desktop's database driver: the per-worktree interactive and background lane pools (each its own PgBouncer pool, under its own role) behind the lane gates, the deadlock retry and read-set capture, every connection under the query deadline.",
  loadBearing: true,
  contributions: [DatabaseDriver.provide(pgDriver)],
} satisfies MachinePluginDefinition;
