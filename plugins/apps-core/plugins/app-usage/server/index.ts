import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { flushAppUsageEndpoint } from "../core";
import { handleFlushAppUsage } from "./internal/routes";
import { appUsageSummaryServed } from "./internal/resource";

export { _appUsageDaily } from "./internal/tables";

export default {
  portable: true,
  description:
    "Owns app_usage_daily: per (local day, app) opens and active milliseconds, added to by one batched upsert from the browser tracker's flush endpoint, served as the live per-app summary (7-day and all-time); swept after two years by the machine half.",
  httpRoutes: {
    [flushAppUsageEndpoint.route]: handleFlushAppUsage,
  },
  contributions: [...appUsageSummaryServed.declare],
} satisfies ServerPluginDefinition;
