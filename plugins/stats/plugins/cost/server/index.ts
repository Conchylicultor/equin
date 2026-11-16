import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { DbTrigger } from "@plugins/database/plugins/db-triggers/server";
import { costConfig } from "../shared/config";
import {
  costDailyServed,
  costDistributionServed,
  costSessionsDailyServed,
  costTopSessionsServed,
  costConversationsServed,
} from "./internal/served";
import { costRollupTriggers, costRollupWarmup } from "./internal/rollups";

export default {
  description:
    "Stats → Cost: token usage and dollar cost of every Claude Code session, conversation and one-shot call, read from the priced token ledger (claude_spend_hours_v — each hour at the price in force then) through two database-maintained rollups (claude_spend_days per UTC day, model and repo flag; claude_spend_sources per source), served as the stats.cost.* live values.",
  contributions: [
    ConfigV2.Register({ descriptor: costConfig }),
    // The two rollups, derived from the priced ledger by the database itself.
    DbTrigger(costRollupTriggers),
    ...costDailyServed.declare,
    ...costSessionsDailyServed.declare,
    ...costDistributionServed.declare,
    ...costTopSessionsServed.declare,
    ...costConversationsServed.declare,
  ],
  register: [costRollupWarmup],
} satisfies ServerPluginDefinition;
