import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { costConfig } from "../shared/config";
import {
  costDailyServed,
  costDistributionServed,
  costSessionsDailyServed,
  costTopSessionsServed,
  sessionConversationsServed,
} from "./internal/served";
import { costUsageWarmup, costUsageWatcher } from "./internal/load-usage";

// The price table, for a plugin that prices token buckets (`priceBucket`,
// `foldUsageEntry` in `../core`) itself and stores the result.
export { currentPriceTable, onPriceTableUpdated } from "./internal/load-usage";
import {
  archiveShrinkKind,
  unpricedModelKind,
} from "./internal/cost-report-kinds";
import { costRefreshJob } from "./internal/refresh-job";

export default {
  description:
    "Token usage and dollar cost across Claude Code sessions, priced from our own merge-only LiteLLM table and banked into a permanent year-sharded token archive so deleted transcripts stop rewriting the past.",
  contributions: [
    ConfigV2.Register({ descriptor: costConfig }),
    unpricedModelKind,
    archiveShrinkKind,
    ...costDailyServed.declare,
    ...costSessionsDailyServed.declare,
    ...costDistributionServed.declare,
    ...costTopSessionsServed.declare,
    ...sessionConversationsServed.declare,
  ],
  register: [costUsageWarmup, costUsageWatcher, costRefreshJob],
} satisfies ServerPluginDefinition;
