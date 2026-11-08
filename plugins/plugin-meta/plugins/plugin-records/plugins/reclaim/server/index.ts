import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { reclaimRecordsJob } from "./internal/reclaim-job";

export default {
  description:
    "The daily plugin-records.reclaim job: on main, deletes the shared record store's key rows unread for 7 days and the values only they named, then returns the freed pages — a page at a time, off every build's path.",
  register: [reclaimRecordsJob],
} satisfies ServerPluginDefinition;
