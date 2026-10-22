import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { handleRestoreBatch } from "./internal/handle-restore-batch";
import { restoreBatch } from "../shared/endpoints";

export default {
  description:
    "Batch-restore recently-closed conversations that were killed by a crash.",
  httpRoutes: {
    [restoreBatch.route]: handleRestoreBatch,
  },
} satisfies MachinePluginDefinition;
