import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { verifyRecordsJob } from "./internal/verify-job";

export default {
  description:
    "The daily plugin-records.verify job: on main, recomputes every plugin record a tree check pass reads (`./equin check --verify-records`) and fails when one disagrees with the shared store under the same key.",
  register: [verifyRecordsJob],
} satisfies ServerPluginDefinition;
