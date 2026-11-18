import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { grepIndexPruneJob } from "./internal/prune-job";

export default {
  description:
    "The daily checks.grep-index-prune job: on main, deletes the shared grep index's rows unread for 14 days — a page at a time, off every check run's path.",
  register: [grepIndexPruneJob],
} satisfies ServerPluginDefinition;
