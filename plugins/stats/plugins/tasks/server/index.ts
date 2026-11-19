import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { DerivedTable } from "@plugins/database/plugins/derived-tables/server";
import { tasksHistoryServed } from "./internal/history";
import { taskHistoryDays, taskHistoryFacts } from "./internal/rollups";

export default {
  contributions: [
    ...tasksHistoryServed.declare,
    DerivedTable(taskHistoryFacts),
    DerivedTable(taskHistoryDays),
  ],
} satisfies ServerPluginDefinition;
