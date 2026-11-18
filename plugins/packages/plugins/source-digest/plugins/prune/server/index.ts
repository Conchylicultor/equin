import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { pruneSourceFactsJob } from "./internal/prune-job";

export default {
  description:
    "The daily source-digest.prune job: on main, deletes the shared source-facts store's rows unread for 14 days — a page at a time, off every reader's path.",
  register: [pruneSourceFactsJob],
} satisfies ServerPluginDefinition;
