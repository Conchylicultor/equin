import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { DatabaseDriver } from "@plugins/database/server";
import { pgDriver } from "./internal/pg-driver";

export default {
  description:
    "The desktop's database driver: the per-worktree pg.Pool behind the interactive/background lane gates, the deadlock retry and read-set capture, every connection under the query deadline.",
  loadBearing: true,
  contributions: [DatabaseDriver.provide(pgDriver)],
} satisfies MachinePluginDefinition;
